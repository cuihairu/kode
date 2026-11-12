//! Process-specific Python module API. The same manifest is consumed by TS and
//! generated from typings/processes, so neither backend invents a merged API.
use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
pub struct ProcessApi {
    pub component: String,
    pub symbols: Vec<ProcessSymbol>,
}

#[derive(Debug, Deserialize)]
pub struct ProcessSymbol {
    pub name: String,
    pub kind: String,
    pub signature: String,
}

pub fn catalog() -> &'static BTreeMap<String, ProcessApi> {
    static CATALOG: OnceLock<BTreeMap<String, ProcessApi>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../typings/process-api.json"))
            .expect("committed process API manifest must be valid")
    })
}

pub fn process_from_path(path: &str) -> Option<&'static str> {
    let normalized = path.replace('\\', "/");
    let (_, tail) = normalized.rsplit_once("/scripts/")?;
    let directory = tail.split('/').next()?;
    let role = match directory {
        "baseapp" => "base",
        "cellapp" => "cell",
        other => other,
    };
    catalog().get_key_value(role).map(|(key, _)| key.as_str())
}

fn module_aliases(text: &str) -> Vec<String> {
    let symbols = kode_python::symbols::parse_ast_symbols(text).symbols;
    symbols
        .imports
        .into_iter()
        .filter(|entry| {
            entry.symbol.is_none() && matches!(entry.module.as_str(), "KBEngine" | "kbe")
        })
        .map(|entry| entry.binding)
        .collect()
}

pub fn completion(
    path: &str,
    text: &str,
    prefix: &str,
) -> Option<crate::completion::CompletionResponse> {
    let process = process_from_path(path)?;
    let (head, fragment) = prefix.rsplit_once('.')?;
    if !fragment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    let alias = head
        .rsplit(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '.')
        .next()?;
    if !module_aliases(text).iter().any(|name| name == alias) {
        return None;
    }
    let needle = fragment.to_ascii_lowercase();
    Some(crate::completion::CompletionResponse {
        context: crate::completion::CompletionContextFace {
            kind: "module",
            section: "KBEngine",
            facet: Some(process),
            entity: None,
            fragment: fragment.to_string(),
        },
        items: catalog()[process]
            .symbols
            .iter()
            .filter(|entry| entry.name.to_ascii_lowercase().starts_with(&needle))
            .map(|entry| crate::completion::CompletionItemFace {
                label: entry.name.clone(),
                kind: match entry.kind.as_str() {
                    "class" => "class",
                    "function" => "function",
                    _ => "variable",
                },
                facet: Some(process),
                detail: Some(entry.signature.clone()),
                inherited_from: None,
            })
            .collect(),
    })
}

pub fn hover(path: &str, text: &str, line0: u32, character: u32) -> Option<Value> {
    let process = process_from_path(path)?;
    let line = text.lines().nth(line0 as usize)?;
    let mut end = 0;
    let mut column = 0;
    for (index, ch) in line.char_indices() {
        if column > character {
            break;
        }
        if column == character && !(ch.is_ascii_alphanumeric() || ch == '_') {
            break;
        }
        end = index + ch.len_utf8();
        column += ch.len_utf16() as u32;
    }
    while end < line.len() {
        let ch = line[end..].chars().next()?;
        if !ch.is_ascii_alphanumeric() && ch != '_' {
            break;
        }
        end += ch.len_utf8();
    }
    let response = completion(path, text, &line[..end])?;
    let name = line[..end].rsplit('.').next()?;
    let entry = response.items.iter().find(|entry| entry.label == name)?;
    Some(
        json!({"contents": {"kind": "markdown", "value": format!("```python\n{}\n```\n\nKBEngine · {}", entry.detail.as_deref().unwrap_or(name), process)}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_names_map_to_engine_components_without_ancestor_false_positives() {
        assert_eq!(
            process_from_path("C:\\repo\\scripts\\base\\Avatar.py"),
            Some("base")
        );
        assert_eq!(
            process_from_path("/repo/scripts/cell/nested/Avatar.py"),
            Some("cell")
        );
        assert_eq!(process_from_path("/base/repo/scripts/common/util.py"), None);
        assert_eq!(catalog()["base"].component, "baseapp");
        assert_eq!(catalog()["cell"].component, "cellapp");
    }

    #[test]
    fn signatures_and_members_are_isolated() {
        let text = "import KBEngine as k\nk.";
        let base = completion("/p/scripts/base/a.py", text, "k.").unwrap();
        let cell = completion("/p/scripts/cell/a.py", text, "k.").unwrap();
        let bots = completion("/p/scripts/bots/a.py", text, "k.").unwrap();
        let item = |items: &crate::completion::CompletionResponse, name: &str| {
            items
                .items
                .iter()
                .find(|s| s.label == name)
                .map(|s| s.detail.clone())
        };
        assert!(item(&base, "createEntity")
            .unwrap()
            .unwrap()
            .contains("params"));
        assert!(!item(&base, "createEntity")
            .unwrap()
            .unwrap()
            .contains("spaceID"));
        assert!(item(&cell, "createEntity")
            .unwrap()
            .unwrap()
            .contains("spaceID"));
        assert!(item(&base, "addSpaceGeometryMapping").is_none());
        assert!(item(&cell, "Proxy").is_none());
        assert!(item(&bots, "createEntity").is_none());
        assert!(item(&bots, "addBots").is_some());
        assert!(completion("/p/scripts/base/a.py", text, "self.k.").is_none());
        assert!(completion(
            "/p/scripts/base/a.py",
            "# import KBEngine\nKBEngine.",
            "KBEngine."
        )
        .is_none());
    }
}
