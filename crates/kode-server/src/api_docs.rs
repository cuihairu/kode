//! C-21:嵌入式 KBEngine Python API 文档库(kbengine Python API hover/查询面)。
//!
//! 正本 = `assets/api-docs.json`,由 `scripts/generate-api-docs.mjs` 从
//! `docs/knowledge/api-*.md`(KB-API 批次已做 kbe/src file:line grounding)
//! 抽取;`src/generated/apiDocs.ts` 是它的 TS 镜像(hover 消费面),
//! `tests/apiDocsParity.test.ts` 锁两份一致。本模块只装载与查询,不解析
//! markdown,不改写条目。
//!
//! 查询语义(与 TS 面 `lookupApiDoc` 同口径):
//! - `domain` 给定时精确优先,域内唯一命中即返回;
//! - 域未命中/未给时,全库唯一(或唯一 owner)命中返回;
//! - 多域多 owner 歧义返回 `ambiguous` 候选列表,绝不静默挑一个;
//! - `locale = "zh-cn"` 时摘要在 `summaryZh` 非空时本地化,缺失回退
//!   `summaryEn`(回退条目带 `localized: false` 如实标注)。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiDocEntry {
    pub member: String,
    pub owner: String,
    pub domain: String,
    pub kind: String,
    pub signature: String,
    #[serde(default)]
    pub qualifier: String,
    #[serde(default)]
    #[serde(rename = "summaryEn")]
    pub summary_en: String,
    #[serde(default)]
    #[serde(rename = "summaryZh")]
    pub summary_zh: String,
    #[serde(default)]
    pub source_refs: Vec<String>,
    #[serde(default)]
    pub page: String,
}

#[derive(Debug, Deserialize)]
struct ApiDocManifest {
    #[serde(default)]
    version: i64,
    entries: Vec<ApiDocEntry>,
}

#[derive(Debug)]
pub struct ApiDocLibrary {
    pub version: i64,
    pub entries: Vec<ApiDocEntry>,
}

fn library() -> &'static ApiDocLibrary {
    static LIBRARY: OnceLock<ApiDocLibrary> = OnceLock::new();
    LIBRARY.get_or_init(|| match serde_json::from_str::<ApiDocManifest>(include_str!(
        "../assets/api-docs.json"
    )) {
        Ok(manifest) => ApiDocLibrary {
            version: manifest.version,
            entries: manifest.entries,
        },
        Err(error) => {
            eprintln!("api_docs: 嵌入 json 解析失败(不应发生,生成物受 --check 门禁): {error}");
            ApiDocLibrary {
                version: 0,
                entries: Vec::new(),
            }
        }
    })
}

fn entry_json(entry: &ApiDocEntry, locale: &str) -> Value {
    let use_zh = locale == "zh-cn";
    let localized = use_zh && !entry.summary_zh.is_empty();
    let summary = if localized {
        entry.summary_zh.clone()
    } else {
        entry.summary_en.clone()
    };
    json!({
        "member": entry.member,
        "owner": entry.owner,
        "domain": entry.domain,
        "kind": entry.kind,
        "signature": entry.signature,
        "summary": summary,
        "localized": localized,
        "sourceRefs": entry.source_refs,
        "page": entry.page,
    })
}

/// 查询:name 精确匹配 member;domain 可选;locale `en`/`zh-cn`。
pub fn api_docs_lookup(name: &str, domain: Option<&str>, locale: &str) -> Value {
    let lib = library();
    let by_name: Vec<&ApiDocEntry> = lib
        .entries
        .iter()
        .filter(|entry| entry.member == name)
        .collect();
    if by_name.is_empty() {
        return Value::Null;
    }
    if let Some(domain) = domain {
        if !domain.is_empty() {
            let in_domain: Vec<&&ApiDocEntry> = by_name
                .iter()
                .filter(|entry| entry.domain == domain)
                .collect();
            if in_domain.len() == 1 {
                return entry_json(in_domain[0], locale);
            }
            let owners: Vec<&str> = in_domain.iter().map(|e| e.owner.as_str()).collect();
            if !owners.is_empty() && owners.iter().all(|o| *o == owners[0]) {
                return entry_json(in_domain[0], locale);
            }
        }
    }
    let owners: Vec<&str> = by_name.iter().map(|e| e.owner.as_str()).collect();
    if by_name.len() == 1 || owners.iter().all(|o| *o == owners[0]) {
        return entry_json(by_name[0], locale);
    }
    json!({
        "ambiguous": by_name
            .iter()
            .map(|entry| json!({
                "domain": entry.domain,
                "owner": entry.owner,
                "signature": entry.signature,
            }))
            .collect::<Vec<_>>()
    })
}

// ===========================================================================
// RPC
// ===========================================================================

pub fn register(reg: &mut crate::rpc::RpcRegistry) {
    reg.register("$/kode/apiDocs/lookup", api_docs_handler);
}

fn api_docs_handler(params: Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing `name`".to_string())?;
    let domain = params.get("domain").and_then(Value::as_str);
    let locale = params.get("locale").and_then(Value::as_str).unwrap_or("en");
    Ok(api_docs_lookup(name, domain, locale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_loads_with_expected_floor() {
        let lib = library();
        assert!(lib.version >= 1, "manifest version 异常: {}", lib.version);
        assert!(lib.entries.len() >= 120, "条目数异常: {}", lib.entries.len());
        for entry in &lib.entries {
            assert!(!entry.member.is_empty());
            assert!(!entry.signature.is_empty());
        }
    }

    #[test]
    fn lookup_prefers_domain_then_unique() {
        // fireEvent 多 owner(entity/KBEngine 两面):域精确 → base entity 面;
        // createEntity 单 owner 多域:无域 → owner 唯一回退命中
        let hit = api_docs_lookup("fireEvent", Some("base"), "en");
        assert_eq!(hit.get("domain").and_then(Value::as_str), Some("base"));
        assert_eq!(hit.get("owner").and_then(Value::as_str), Some("entity"));
        let fallback = api_docs_lookup("createEntity", None, "en");
        assert!(
            fallback.get("signature").is_some(),
            "唯一 owner 应回退命中: {fallback}"
        );
    }

    #[test]
    fn ambiguous_reports_candidates_not_guess() {
        // fireEvent 多 owner(entity 方法 / KBEngine 模块函数):无域查询必须
        // 如实返回候选,绝不静默挑一个
        let result = api_docs_lookup("fireEvent", None, "en");
        assert!(result.get("ambiguous").is_some(), "fireEvent 应歧义: {result}");
    }

    #[test]
    fn locale_zh_falls_back_honestly() {
        let lib = library();
        let any_zh = lib.entries.iter().find(|e| !e.summary_zh.is_empty());
        let any_en_only = lib.entries.iter().find(|e| e.summary_zh.is_empty() && !e.summary_en.is_empty());
        if let (Some(zh), Some(en_only)) = (any_zh, any_en_only) {
            let hit = api_docs_lookup(&zh.member, Some(&zh.domain), "zh-cn");
            assert_eq!(hit.get("localized").and_then(Value::as_bool), Some(true));
            let miss = api_docs_lookup(&en_only.member, Some(&en_only.domain), "zh-cn");
            assert_eq!(miss.get("localized").and_then(Value::as_bool), Some(false));
            assert_eq!(
                miss.get("summary").and_then(Value::as_str),
                Some(en_only.summary_en.as_str()),
                "zh 缺失必须回退 en 原文"
            );
        }
    }

    #[test]
    fn unknown_name_returns_null() {
        assert!(api_docs_lookup("__no_such_member__", None, "en").is_null());
    }

    #[test]
    fn handler_validates_params() {
        assert!(api_docs_handler(json!({})).is_err());
        let ok = api_docs_handler(json!({"name": "onTimer", "domain": "base", "locale": "en"}))
            .expect("合法参数必须成功");
        assert!(ok.get("member").is_some());
    }
}
