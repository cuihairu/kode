//! C-21: embedded KBEngine Python API documentation library (kbengine Python
//! API hover/query surface).
//!
//! Canonical source = `assets/api-docs.json`, extracted by
//! `scripts/generate-api-docs.mjs` from `docs/knowledge/api-*.md` (the KB-API
//! batch already did kbe/src file:line grounding); `src/generated/apiDocs.ts`
//! is its TS mirror (the hover consumer face), and
//! `tests/apiDocsParity.test.ts` locks the two copies in agreement. This module
//! only loads and queries: it does not parse markdown and does not rewrite
//! entries.
//!
//! Query semantics (same criteria as the TS face `lookupApiDoc`):
//! - when `domain` is given, exact match wins; a unique hit inside the domain
//!   is returned;
//! - when the domain misses / is not given, a unique hit over the whole
//!   library (or one with a unique owner) is returned;
//! - ambiguity across multiple domains and owners returns the `ambiguous`
//!   candidate list, never silently picking one;
//! - with `locale = "zh-cn"` the summary is localized when `summaryZh` is
//!   non-empty, otherwise it falls back to `summaryEn` (fallback entries are
//!   honestly annotated with `localized: false`).

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
    #[serde(rename = "sourceRefs")]
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
    LIBRARY.get_or_init(|| {
        match serde_json::from_str::<ApiDocManifest>(include_str!("../assets/api-docs.json")) {
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

/// Query: name matches member exactly; domain is optional; locale `en`/`zh-cn`.
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
            if in_domain.is_empty() {
                return Value::Null;
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
        assert!(
            lib.entries.len() >= 120,
            "条目数异常: {}",
            lib.entries.len()
        );
        for entry in &lib.entries {
            assert!(!entry.member.is_empty());
            assert!(!entry.signature.is_empty());
        }
    }

    #[test]
    fn lookup_prefers_domain_then_unique() {
        // fireEvent has multiple owners (entity/KBEngine faces): exact domain -> the base entity face;
        // createEntity is a single owner across multiple domains: no domain -> unique-owner fallback hit
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
    fn explicit_process_never_falls_back_to_another_process() {
        assert!(api_docs_lookup("createEntity", Some("logger"), "en").is_null());
        assert!(api_docs_lookup("charge", Some("cell"), "en").is_null());
    }

    #[test]
    fn ambiguous_reports_candidates_not_guess() {
        // fireEvent has multiple owners (entity method / KBEngine module function): a
        // domain-less query must honestly return the candidates, never silently
        // picking one
        let result = api_docs_lookup("fireEvent", None, "en");
        assert!(
            result.get("ambiguous").is_some(),
            "fireEvent 应歧义: {result}"
        );
    }

    #[test]
    fn locale_zh_falls_back_honestly() {
        let lib = library();
        let any_zh = lib.entries.iter().find(|e| !e.summary_zh.is_empty());
        let any_en_only = lib
            .entries
            .iter()
            .find(|e| e.summary_zh.is_empty() && !e.summary_en.is_empty());
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
    #[test]
    fn domain_filter_miss_returns_null_not_ambiguous() {
        // addTimer is in the library (across 4 domains), but querying a nonexistent
        // domain: zero entries inside the domain -> Null,
        // never falling back to the whole-library ambiguous (domain filtering is
        // narrowing, not a suggestion).
        let v = api_docs_lookup("addTimer", Some("nonesuch-domain"), "en");
        assert_eq!(v, Value::Null);
        // An empty domain string = no domain given (whole-library path), distinct from zero entries inside a domain.
        let all = api_docs_lookup("addTimer", Some(""), "en");
        assert!(all.get("ambiguous").is_some(), "空域退化为全库歧义面");
    }
}
