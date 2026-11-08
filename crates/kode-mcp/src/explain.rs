//! KB-001/MCP explain:回答「XX API 怎么用 / XX 机制怎么运作」。
//!
//! 两个面,同源不复制:
//! - **API 面**:直调 kode-server 的 C-21 嵌入库 `api_docs_lookup`(与 hover、
//!   `$/kode/apiDocs/lookup` RPC 同一份 `assets/api-docs.json`)。
//! - **机制面**:本模块内嵌 docs/knowledge 机制文章(编译期 include_str!,
//!   与仓库文件零漂移),按关键词索引匹配,返回标题/双语文件/锚定提交/
//!   摘要/章节标题。索引条目手工策展,只指向真实存在的文章。
//!
//! 两面都未命中时如实返回空列表 + 提示,绝不编造解释。

use serde_json::{json, Value};

/// 一篇机制文章的索引条目(text = 编译期内嵌全文,标题运行时抽取)。
struct KnowledgeArticle {
    file: &'static str,
    zh_file: &'static str,
    title: &'static str,
    grounding: &'static str,
    keywords: &'static [&'static str],
    summary: &'static str,
    text: &'static str,
}

/// 机制文章索引(仅 ② 桶机制文档;API 页走 API 面,不入此索引)。
const ARTICLES: &[KnowledgeArticle] = &[
    KnowledgeArticle {
        file: "docs/knowledge/entity-lifecycle-reference.md",
        zh_file: "docs/zh/knowledge/entity-lifecycle-reference.md",
        title: "Entity lifecycle & object reference release",
        grounding: "kbengine@c2a3b8f",
        keywords: &[
            "lifecycle",
            "life cycle",
            "destroy",
            "garbages",
            "entities",
            "entity registry",
            "reference",
            "release",
            "leak",
            "refcount",
            "onDestroy",
            "isDestroyed",
            "timer",
            "addTimer",
            "delTimer",
            "onTimer",
            "生命周期",
            "销毁",
            "引用",
            "泄漏",
            "定时器",
        ],
        summary: "Live registry strong reference; destroy flow into garbages; \
                  post-destroy reference semantics; 3600s leak detection; destroy guards; \
                  onDestroy callScript gating and cell-data backup; timers hold no strong ref.",
        text: include_str!("../../../docs/knowledge/entity-lifecycle-reference.md"),
    },
    KnowledgeArticle {
        file: "docs/knowledge/entity-migration-and-cross-process-references.md",
        zh_file: "docs/zh/knowledge/entity-migration-and-cross-process-references.md",
        title: "Entity teleport, cross-cellapp migration & cross-process references",
        grounding: "kbengine@3082ab5",
        keywords: &[
            "teleport",
            "migration",
            "migrate",
            "celldata",
            "cellentitycall",
            "entitycall",
            "ghost",
            "real",
            "witness",
            "ongetcell",
            "onlosecell",
            "onteleportsuccess",
            "onteleportfailure",
            "cross-process",
            "cross cellapp",
            "cell/base",
            "base/cell",
            "trap",
            "onmigrationcellappstart",
            "传送",
            "迁移",
            "跨进程",
            "快照",
        ],
        summary: "Three addressable faces and EntityCall as a (component,id) handle; \
                  cellData is a stale-by-design snapshot; teleport routing and guards; \
                  the cross-cellapp message flow (ghost transition, base buffering, \
                  cellEntityCall_ retarget, rebuild, restore); which callbacks fire at HEAD.",
        text: include_str!(
            "../../../docs/knowledge/entity-migration-and-cross-process-references.md"
        ),
    },
    KnowledgeArticle {
        file: "docs/knowledge/startup-flow-and-stack.md",
        zh_file: "docs/zh/knowledge/startup-flow-and-stack.md",
        title: "Startup flow and stack",
        grounding: "kbengine@c2a3b8f",
        keywords: &[
            "startup",
            "boot",
            "phase",
            "frame",
            "mainloop",
            "initialize",
            "启动",
            "启动流程",
        ],
        summary: "KBEngine server startup phase order and the per-frame mainloop stack, \
                  grounded line by line.",
        text: include_str!("../../../docs/knowledge/startup-flow-and-stack.md"),
    },
    KnowledgeArticle {
        file: "docs/knowledge/entry-script-spi-methods.md",
        zh_file: "docs/zh/knowledge/entry-script-spi-methods.md",
        title: "Entry script SPI methods",
        grounding: "kbengine@c2a3b8f",
        keywords: &[
            "entry script",
            "entry",
            "spi",
            "oninit",
            "onfinish",
            "entrymodule",
            "入口脚本",
            "入口模块",
        ],
        summary: "The complete method table the engine calls on the entry module \
                  (getEntryScript interface).",
        text: include_str!("../../../docs/knowledge/entry-script-spi-methods.md"),
    },
    KnowledgeArticle {
        file: "docs/knowledge/fixed-directories-and-path-resolution.md",
        zh_file: "docs/zh/knowledge/fixed-directories-and-path-resolution.md",
        title: "Fixed directories and the path resolution chain",
        grounding: "kbengine@c2a3b8f",
        keywords: &[
            "directory",
            "directories",
            "path",
            "paths",
            "resolution",
            "respath",
            "kbenginepath",
            "usr",
            "目录",
            "路径",
            "路径解析",
        ],
        summary: "Which directories the engine treats as fixed and the full path \
                  resolution chain from config to disk.",
        text: include_str!("../../../docs/knowledge/fixed-directories-and-path-resolution.md"),
    },
    KnowledgeArticle {
        file: "docs/kbengine-wire-protocol.md",
        zh_file: "docs/zh/kbengine-wire-protocol.md",
        title: "Wire protocol specification",
        grounding: "kbengine@bf1a9cd6",
        keywords: &[
            "protocol",
            "wire",
            "frame",
            "message",
            "packet",
            "serialization",
            "协议",
            "帧",
            "报文",
            "网络",
        ],
        summary: "The on-wire packet format forensics: framing, message types, \
                  per-type serialization and the engine-source citations. The \
                  protocol_frame tool draws a frame's structure; this article \
                  grounds the format itself.",
        text: include_str!("../../../docs/kbengine-wire-protocol.md"),
    },
];

/// explain 主入口:topic 必填;domain 供 API 面消歧(base/cell/client/...);
/// locale `en`/`zh-cn`(API 面本地化,机制面始终双语双路径)。
pub fn explain(topic: &str, domain: Option<&str>, locale: &str) -> Value {
    let api = kode_server::api_docs::api_docs_lookup(topic, domain, locale);
    let knowledge = match_knowledge(topic);
    let hint = if api.is_null() && knowledge.is_empty() {
        format!(
            "no API entry or knowledge article matched {topic:?}; \
             try an exact member name (e.g. fireEvent) with optional domain, \
             or a mechanism keyword (e.g. teleport, celldata, lifecycle)"
        )
    } else {
        String::new()
    };
    json!({
        "topic": topic,
        "api": api,
        "knowledge": knowledge,
        "hint": hint,
    })
}

/// 关键词匹配:小写化后精确等值 3 分、互为子串 2 分;按分排序,取前 5。
fn match_knowledge(topic: &str) -> Vec<Value> {
    let needle = topic.trim().to_lowercase();
    if needle.len() < 2 {
        return Vec::new();
    }
    let mut scored: Vec<(i32, &KnowledgeArticle)> = Vec::new();
    for article in ARTICLES {
        let mut best = 0;
        for keyword in article.keywords {
            let keyword = keyword.to_lowercase();
            let score = if keyword == needle {
                3
            } else if keyword.contains(&needle) || needle.contains(&keyword) {
                2
            } else {
                0
            };
            if score > best {
                best = score;
            }
        }
        if best > 0 {
            scored.push((best, article));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.file.cmp(b.1.file)));
    scored
        .into_iter()
        .take(5)
        .map(|(score, article)| {
            json!({
                "title": article.title,
                "file": article.file,
                "zhFile": article.zh_file,
                "grounding": article.grounding,
                "summary": article.summary,
                "headings": headings_of(article.text),
                "score": score,
            })
        })
        .collect()
}

/// 抽取 `## ` 章节标题(去掉前导井号与空白)。
fn headings_of(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            trimmed.strip_prefix("## ").map(|rest| rest.trim())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_face_hits_shared_library() {
        let out = explain("fireEvent", Some("base"), "en");
        assert_eq!(out["api"]["member"], "fireEvent");
        assert_eq!(out["api"]["domain"], "base");
        assert!(out["hint"].as_str().unwrap().is_empty());
    }

    #[test]
    fn api_face_reports_ambiguity_not_guess() {
        let out = explain("fireEvent", None, "en");
        assert!(out["api"]["ambiguous"].is_array());
    }

    #[test]
    fn knowledge_face_matches_migration_article() {
        let out = explain("teleport", None, "en");
        let matches = out["knowledge"].as_array().unwrap();
        assert_eq!(
            matches[0]["file"],
            "docs/knowledge/entity-migration-and-cross-process-references.md"
        );
        assert_eq!(matches[0]["grounding"], "kbengine@3082ab5");
        let headings = matches[0]["headings"].as_array().unwrap();
        assert!(headings
            .iter()
            .any(|h| h.as_str().unwrap().contains("teleport")));
    }

    #[test]
    fn knowledge_face_matches_by_compound_keyword() {
        // cellData 命中迁移文关键词 celldata(小写化归一)。
        let out = explain("cellData", None, "en");
        assert!(!out["knowledge"].as_array().unwrap().is_empty());
    }

    #[test]
    fn knowledge_face_matches_wire_protocol_article() {
        // 协议帧/报文面:explain 命中线协议规范文(承载 protocol_frame 接地)。
        let out = explain("protocol frame", None, "en");
        let matches = out["knowledge"].as_array().unwrap();
        assert!(matches
            .iter()
            .any(|m| m["file"] == "docs/kbengine-wire-protocol.md"));
    }

    #[test]
    fn miss_is_honest_with_hint() {
        let out = explain("__no_such_thing__", None, "en");
        assert!(out["api"].is_null());
        assert!(out["knowledge"].as_array().unwrap().is_empty());
        assert!(!out["hint"].as_str().unwrap().is_empty());
    }

    #[test]
    fn embedded_articles_exist_and_index_files_resolve() {
        for article in ARTICLES {
            assert!(
                article.text.starts_with('#'),
                "{} missing title",
                article.file
            );
            assert!(
                !headings_of(article.text).is_empty(),
                "{} no headings",
                article.file
            );
        }
    }

    #[test]
    fn short_topic_matches_no_article() {
        // 单字符/空白主题不做关键词匹配(防全量误命中)。
        assert!(match_knowledge("x").is_empty());
        assert!(match_knowledge("  ").is_empty());
    }
}
