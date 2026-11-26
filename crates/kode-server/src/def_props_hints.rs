//! defPropsInlayHints decision core (read-only view inlay for def properties, isomorphic with src/defPropsInlayHints.ts):
//! comment anchor extraction (whole-line comments + exact token) / root-level property filtering (component slots and FIXED_DICT
//! sub-keys do not enter the overview) / single-anchor inlay assembly (header section + per-property section, with built-in direct lookup in the annotation chain). Pure library,
//! zero RPC; the text coordinate domain is UTF-16 code units; honest boundary = the entity ownership chain (python file ->
//! the runtime index of the def property list) and the provider wiring layer stay in TS; this core only consumes the corpus-ized property list.

use serde::{Deserialize, Serialize};

/// Exact marker token inside the anchor comment (same string as TS DEF_PROPS_ANCHOR_TOKEN).
pub const DEF_PROPS_ANCHOR_TOKEN: &str = "kode:props-from-def";

/// Anchor (pure data): anchor comment line (0-based) + line text length (the hint anchors at end of line).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefPropsAnchorSite {
    pub line: usize,
    pub character: usize,
}

/// One inlay part (label part): text + hover origin (key absent when there is no origin).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefPropsHintPart {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

/// One anchor inlay (pure data; the provider layer converts to vscode.InlayHint).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefPropsHintItem {
    pub position: super::def_param_hints::InlayPosition,
    pub parts: Vec<DefPropsHintPart>,
    pub kind: String,
}

/// Property-declaration corpus face (the consumed sub-shape of PropertyDefinitionInfo; absent optional-field keys match TS
/// undefined).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefFace {
    pub def_file: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    pub domains: Vec<String>,
    pub persistent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_path: Option<String>,
    pub symbol_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_slot_name: Option<String>,
}

/// Line splitting (isomorphic with TS split(/\r?\n/); both \r\n and \n split, a lone \r does not form its own line).
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut current = text;
    while let Some(pos) = current.find('\n') {
        let mut line = &current[..pos];
        if line.ends_with('\r') {
            line = &line[..line.len() - 1];
        }
        lines.push(line);
        current = &current[pos + 1..];
    }
    lines.push(current);
    lines
}

/// Extract comment anchors: only the whole-line comment form is recognized (starts with # after trim); end-of-line comments in code / the same word inside string
/// literals do not trigger. Pure function (text input).
pub fn find_def_props_anchor_sites(text: &str) -> Vec<DefPropsAnchorSite> {
    let lines = split_lines(text);
    let mut sites = Vec::new();
    for (index, line_text) in lines.iter().enumerate() {
        if !line_text.trim().starts_with('#') {
            continue;
        }
        if !line_text.contains(DEF_PROPS_ANCHOR_TOKEN) {
            continue;
        }
        // TS lineText.length is a UTF-16 length
        sites.push(DefPropsAnchorSite {
            line: index,
            character: line_text.encode_utf16().count(),
        });
    }
    sites
}

/// Root-level declaration filter: component-slot members and FIXED_DICT sub-keys (paths containing .) do not enter the overview.
fn is_root_level_property(property: &PropertyDefFace) -> bool {
    if property.component_slot_name.is_some() {
        return false;
    }
    let property_path = property
        .property_path
        .clone()
        .unwrap_or_else(|| property.symbol_name.clone());
    !property_path.contains('.')
}

/// Section hover: declaration origin (file:line) + domain + persistence; with no domain and no persistence only the origin remains.
fn part_tooltip_of(property: &PropertyDefFace) -> String {
    // TS defFile.split(/[\\/]/).pop() ?? defFile: last-segment basename (both slash kinds)
    let file_name = match property.def_file.rfind(['/', '\\']) {
        Some(pos) => property.def_file[pos + 1..].to_string(),
        None => property.def_file.clone(),
    };
    let mut details = vec![format!("{}:{}", file_name, property.line)];
    if !property.domains.is_empty() {
        details.push(property.domains.join("/"));
    }
    if property.persistent {
        details.push("持久化".to_string());
    }
    details.join(" · ")
}

/// Assemble one anchor inlay: header section `def 属性(N)` (hover = read-only view explanation) + per-property sections
/// `name: 注解` (Any falls back to the bare name), sections separated by ` · `. The annotation chain shares its source with hover/stub
/// -- this core carries TS resolveEntityAnnotationType's empty-workspace-root chain (built-in direct lookup +
/// aliases by name); the registry-snapshot chain does not sink down (honest boundary batch 3). Zero root-level properties -> None
/// (zero inlays on the anchor line).
pub fn build_def_props_inlay_items(
    site: &DefPropsAnchorSite,
    properties: &[PropertyDefFace],
) -> Option<DefPropsHintItem> {
    let root_properties: Vec<&PropertyDefFace> = properties
        .iter()
        .filter(|p| is_root_level_property(p))
        .collect();
    if root_properties.is_empty() {
        return None;
    }
    let mut parts = vec![DefPropsHintPart {
        text: format!("def 属性({}) ", root_properties.len()),
        tooltip: Some(
            "def 声明属性只读视图(纯渲染,非代码)。事实源: .def;跳转: 属性上 F12 直达声明行"
                .to_string(),
        ),
    }];
    for property in &root_properties {
        if parts.len() > 1 {
            parts.push(DefPropsHintPart {
                text: " · ".to_string(),
                tooltip: None,
            });
        }
        let name = property
            .property_path
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| property.symbol_name.clone());
        // TS: typeName ? resolveEntityAnnotationType(root, typeName) : FALLBACK;
        // result === FALLBACK('Any') -> bare name. Both branches merge into the direct-lookup chain.
        let annotation = property
            .type_name
            .as_ref()
            .and_then(|type_name| super::def_param_hints::resolve_annotation_direct(type_name))
            // TS criterion = result === FALLBACK('Any') -> bare name (ENTITYCALL/PYTHON
            // table values Any, along with unknown/ALIAS, all fall to the bare name; no fabricated types)
            .filter(|annotation| annotation != "Any");
        let text = match annotation {
            Some(annotation) => format!("{}: {}", name, annotation),
            None => name,
        };
        parts.push(DefPropsHintPart {
            text,
            tooltip: Some(part_tooltip_of(property)),
        });
    }
    Some(DefPropsHintItem {
        position: super::def_param_hints::InlayPosition {
            line: site.line,
            character: site.character,
        },
        parts,
        kind: "Type".to_string(),
    })
}

// ---------------------------------------------------------------------------
// golden (corpus + authoritative probe face + outputs; TS mirror tests/kodeDefPropsParity.test.ts)
// ---------------------------------------------------------------------------

/// Corpus entry: py source (anchor face) + corpus-ized property list (honest boundary with the entity ownership chain left in TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefPropsCorpusEntry {
    pub name: String,
    pub text: String,
    pub properties: Vec<PropertyDefFace>,
}

/// Probe face: anchor extraction / single-anchor assembly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum DefPropsProbe {
    Anchors { corpus: String },
    Items { corpus: String, anchor_index: usize },
}

/// Output face (one-to-one with Probe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum DefPropsProbeOutcome {
    Anchors { sites: Vec<DefPropsAnchorSite> },
    Items { item: Option<DefPropsHintItem> },
}

/// Golden file shape.
#[derive(Debug, Serialize, Deserialize)]
pub struct DefPropsGolden {
    pub generator: String,
    pub corpus: Vec<DefPropsCorpusEntry>,
    pub probes: Vec<DefPropsProbe>,
    pub outcomes: Vec<DefPropsProbeOutcome>,
}

pub const DEF_PROPS_GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/def-props-parity.json";

fn def_props_corpus() -> Vec<DefPropsCorpusEntry> {
    vec![
        DefPropsCorpusEntry {
            name: "anchored_multiline".into(),
            text: concat!(
                "# kode:props-from-def\n",
                "class Avatar:\n",
                "    pass  # kode:props-from-def\n",
                "x = \"kode:props-from-def\"\n",
                "\n",
                "#   kode:props-from-def  带前导空格与尾注\n",
            )
            .into(),
            properties: vec![PropertyDefFace {
                def_file: "/p/entities/avatar.def".into(),
                line: 3,
                type_name: Some("UINT32".into()),
                domains: vec!["base".into()],
                persistent: true,
                property_path: None,
                symbol_name: "hp".into(),
                component_slot_name: None,
            }],
        },
        DefPropsCorpusEntry {
            name: "base_props".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![
                PropertyDefFace {
                    def_file: "/p/entities/mailbox.def".into(),
                    line: 5,
                    type_name: Some("UINT32".into()),
                    domains: vec!["base".into(), "cell".into()],
                    persistent: true,
                    property_path: None,
                    symbol_name: "count".into(),
                    component_slot_name: None,
                },
                PropertyDefFace {
                    def_file: "/p/entities/mailbox.def".into(),
                    line: 9,
                    type_name: None,
                    domains: vec![],
                    persistent: false,
                    property_path: None,
                    symbol_name: "tags".into(),
                    component_slot_name: None,
                },
            ],
        },
        DefPropsCorpusEntry {
            name: "component_slots".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![
                PropertyDefFace {
                    def_file: "/p/entities/team.def".into(),
                    line: 4,
                    type_name: None,
                    domains: vec![],
                    persistent: false,
                    property_path: None,
                    symbol_name: "rootProp".into(),
                    component_slot_name: None,
                },
                PropertyDefFace {
                    def_file: "/p/entities/team.def".into(),
                    line: 8,
                    type_name: None,
                    domains: vec![],
                    persistent: false,
                    property_path: None,
                    symbol_name: "mover".into(),
                    component_slot_name: Some("mover".into()),
                },
            ],
        },
        DefPropsCorpusEntry {
            name: "fixed_dict_children".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![
                PropertyDefFace {
                    def_file: "/p/entities/bag.def".into(),
                    line: 6,
                    type_name: Some("PY_DICT".into()),
                    domains: vec!["client".into()],
                    persistent: false,
                    property_path: None,
                    symbol_name: "bag".into(),
                    component_slot_name: None,
                },
                PropertyDefFace {
                    def_file: "/p/entities/bag.def".into(),
                    line: 7,
                    type_name: None,
                    domains: vec![],
                    persistent: false,
                    property_path: Some("bag.coins".into()),
                    symbol_name: "coins".into(),
                    component_slot_name: None,
                },
            ],
        },
        DefPropsCorpusEntry {
            name: "no_props".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![],
        },
        DefPropsCorpusEntry {
            name: "any_annotations".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![
                PropertyDefFace {
                    def_file: "/p/entities/x.def".into(),
                    line: 2,
                    type_name: Some("UNKNOWN_X".into()),
                    domains: vec![],
                    persistent: false,
                    property_path: None,
                    symbol_name: "mystery".into(),
                    component_slot_name: None,
                },
                PropertyDefFace {
                    def_file: "/p/entities/x.def".into(),
                    line: 3,
                    type_name: Some("ENTITYCALL".into()),
                    domains: vec![],
                    persistent: false,
                    property_path: None,
                    symbol_name: "remote".into(),
                    component_slot_name: None,
                },
                PropertyDefFace {
                    def_file: "/p/entities/x.def".into(),
                    line: 4,
                    type_name: Some("ALIAS".into()),
                    domains: vec![],
                    persistent: false,
                    property_path: None,
                    symbol_name: "aliased".into(),
                    component_slot_name: None,
                },
            ],
        },
        DefPropsCorpusEntry {
            name: "cjk_names".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![PropertyDefFace {
                def_file: "/p/entities/\u{4ed3}\u{5e93}.def".into(),
                line: 12,
                type_name: Some("UINT16".into()),
                domains: vec!["cell".into()],
                persistent: true,
                property_path: None,
                symbol_name: "\u{6570}\u{91cf}".into(),
                component_slot_name: None,
            }],
        },
        DefPropsCorpusEntry {
            name: "windows_def_file".into(),
            text: "# kode:props-from-def\n".into(),
            properties: vec![PropertyDefFace {
                def_file: "C:\\\\p\\\\entities\\\\win.def".into(),
                line: 1,
                type_name: Some("VECTOR3".into()),
                domains: vec![],
                persistent: false,
                property_path: None,
                symbol_name: "pos".into(),
                component_slot_name: None,
            }],
        },
    ]
}

fn def_props_probes() -> Vec<DefPropsProbe> {
    let mut probes = Vec::new();
    for entry in def_props_corpus() {
        probes.push(DefPropsProbe::Anchors {
            corpus: entry.name.clone(),
        });
    }
    // anchored_multiline has 2 anchors (lines 0/5); the other corpora have 1 each
    for (corpus, count) in [
        ("anchored_multiline", 2usize),
        ("base_props", 1),
        ("component_slots", 1),
        ("fixed_dict_children", 1),
        ("no_props", 1),
        ("any_annotations", 1),
        ("cjk_names", 1),
        ("windows_def_file", 1),
    ] {
        for anchor_index in 0..count {
            probes.push(DefPropsProbe::Items {
                corpus: corpus.into(),
                anchor_index,
            });
        }
    }
    probes
}

fn run_def_props_probe(
    table: &std::collections::HashMap<String, DefPropsCorpusEntry>,
    probe: &DefPropsProbe,
) -> DefPropsProbeOutcome {
    match probe {
        DefPropsProbe::Anchors { corpus } => {
            let entry = table.get(corpus).expect("corpus 名必在表");
            DefPropsProbeOutcome::Anchors {
                sites: find_def_props_anchor_sites(&entry.text),
            }
        }
        DefPropsProbe::Items {
            corpus,
            anchor_index,
        } => {
            let entry = table.get(corpus).expect("corpus 名必在表");
            let sites = find_def_props_anchor_sites(&entry.text);
            let item = sites
                .get(*anchor_index)
                .and_then(|site| build_def_props_inlay_items(site, &entry.properties));
            DefPropsProbeOutcome::Items { item }
        }
    }
}

pub fn dump_def_props_golden() -> String {
    let list = def_props_probes();
    let table: std::collections::HashMap<String, DefPropsCorpusEntry> = def_props_corpus()
        .into_iter()
        .map(|entry| (entry.name.clone(), entry))
        .collect();
    let outcomes: Vec<DefPropsProbeOutcome> = list
        .iter()
        .map(|probe| run_def_props_probe(&table, probe))
        .collect();
    let golden = DefPropsGolden {
        generator: "dump-def-props-golden".into(),
        corpus: def_props_corpus(),
        probes: list,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

// ---------------------------------------------------------------------------
// Unit pins (guard against golden self-consistent tautology)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_only_full_line_comments() {
        let text = "# kode:props-from-def\nclass A:  # kode:props-from-def\nx = \"kode:props-from-def\"\n   # kode:props-from-def\n";
        let sites = find_def_props_anchor_sites(text);
        assert_eq!(
            sites.len(),
            2,
            "行尾注释与字符串内同词不触发;带前导空格整行注释触发"
        );
        assert_eq!(sites[0].line, 0);
        assert_eq!(
            sites[0].character,
            "# kode:props-from-def".encode_utf16().count()
        );
        assert_eq!(sites[1].line, 3);
        // CJK comment anchor: character counted in UTF-16 units
        let cjk = find_def_props_anchor_sites("# \u{6ce8}\u{91ca} kode:props-from-def\n");
        assert_eq!(
            cjk[0].character, 24,
            "# +空格+两 CJK(各 1 单元)+空格+19 字符 token"
        );
    }

    #[test]
    fn root_level_filter() {
        let make = |slot: Option<&str>, path: Option<&str>, name: &str| PropertyDefFace {
            def_file: "/p/a.def".into(),
            line: 1,
            type_name: None,
            domains: vec![],
            persistent: false,
            property_path: path.map(|p| p.to_string()),
            symbol_name: name.to_string(),
            component_slot_name: slot.map(|s| s.to_string()),
        };
        let props = vec![
            make(Some("mover"), None, "mover"),
            make(None, Some("bag.coins"), "coins"),
            make(None, None, "root"),
        ];
        let site = DefPropsAnchorSite {
            line: 0,
            character: 5,
        };
        let item = build_def_props_inlay_items(&site, &props).expect("根级 1 条应出");
        assert_eq!(
            item.parts.len(),
            2,
            "单属性:头部段+属性段(间隔段自第 2 属性起)"
        );
        assert_eq!(item.parts[1].text, "root");
        // All non-root-level -> None
        let filtered: Vec<PropertyDefFace> =
            vec![make(Some("m"), None, "m"), make(None, Some("a.b"), "b")];
        assert_eq!(build_def_props_inlay_items(&site, &filtered), None);
        // Empty list -> None
        assert_eq!(build_def_props_inlay_items(&site, &[]), None);
    }

    #[test]
    fn any_falls_back_to_bare_name() {
        let make = |type_name: Option<&str>, name: &str| PropertyDefFace {
            def_file: "/p/a.def".into(),
            line: 1,
            type_name: type_name.map(|t| t.to_string()),
            domains: vec![],
            persistent: false,
            property_path: None,
            symbol_name: name.to_string(),
            component_slot_name: None,
        };
        let props = vec![
            make(None, "noType"),
            make(Some("UNKNOWN_X"), "mystery"),
            make(Some("ENTITYCALL"), "remote"),
            make(Some("ALIAS"), "aliased"),
            make(Some("UINT8"), "typed"),
        ];
        let site = DefPropsAnchorSite {
            line: 0,
            character: 3,
        };
        let item = build_def_props_inlay_items(&site, &props).expect("5 根级应出");
        let texts: Vec<&str> = item
            .parts
            .iter()
            .enumerate()
            .filter(|(index, _)| index % 2 == 1)
            .map(|(_, p)| p.text.as_str())
            .collect();
        assert_eq!(
            texts,
            vec!["noType", "mystery", "remote", "aliased", "typed: int"],
            " typeName 缺失/落 Any(未知/ENTITYCALL/ALIAS)→裸名;可解析→name: 注解"
        );
    }

    #[test]
    fn tooltip_composition() {
        let property = PropertyDefFace {
            def_file: "/p/entities/mail.def".into(),
            line: 7,
            type_name: Some("UINT8".into()),
            domains: vec!["base".into(), "cell".into()],
            persistent: true,
            property_path: None,
            symbol_name: "n".into(),
            component_slot_name: None,
        };
        let item = build_def_props_inlay_items(
            &DefPropsAnchorSite {
                line: 0,
                character: 1,
            },
            &[property],
        )
        .unwrap();
        assert_eq!(item.parts[0].text, "def 属性(1) ");
        assert!(item.parts[0]
            .tooltip
            .as_deref()
            .unwrap()
            .contains("只读视图"));
        assert_eq!(item.parts[1].text, "n: int");
        // Windows backslash basename + domain + persistence
        let win = PropertyDefFace {
            def_file: "C:\\\\p\\\\win.def".into(),
            line: 2,
            type_name: None,
            domains: vec!["client".into()],
            persistent: false,
            property_path: None,
            symbol_name: "w".into(),
            component_slot_name: None,
        };
        let item = build_def_props_inlay_items(
            &DefPropsAnchorSite {
                line: 0,
                character: 1,
            },
            &[win],
        )
        .unwrap();
        assert_eq!(item.parts[1].tooltip.as_deref(), Some("win.def:2 · client"));
    }
}
