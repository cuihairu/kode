//! defPropsInlayHints 决策核(def 属性只读视图 inlay,src/defPropsInlayHints.ts
//! 同构):注释锚提取(整行注释+精确 token)/根级属性过滤(组件槽与 FIXED_DICT
//! 子键不进总览)/单锚点 inlay 组装(头部段+逐属性段,注解链内建直查)。纯库
//! 零 RPC;文本坐标域 UTF-16 code unit;诚实边界=实体归属链(python 文件→
//! def 属性清单的运行时索引)与 provider 装配面留 TS,本核只消费语料化清单。

use serde::{Deserialize, Serialize};

/// 锚注释里的精确标记 token(与 TS DEF_PROPS_ANCHOR_TOKEN 同串)。
pub const DEF_PROPS_ANCHOR_TOKEN: &str = "kode:props-from-def";

/// 锚点(纯数据):锚注释行(0 起)+ 行文本长度(hint 锚在行尾)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefPropsAnchorSite {
    pub line: usize,
    pub character: usize,
}

/// inlay 单段(label part):文本 + 悬停出处(无出处键缺席)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefPropsHintPart {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

/// 一条锚点 inlay(纯数据;provider 层转 vscode.InlayHint)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefPropsHintItem {
    pub position: super::def_param_hints::InlayPosition,
    pub parts: Vec<DefPropsHintPart>,
    pub kind: String,
}

/// 属性声明语料面(PropertyDefinitionInfo 消费子形;可选字段键缺席与 TS
/// undefined 同形)。
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

/// 行切分(与 TS split(/\r?\n/) 同构;\r\n 与 \n 都切,\r 不独立成行)。
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

/// 提取注释锚:只认整行注释形态(trim 后以 # 起);代码行尾注释/字符串
/// 字面量里的同词不触发。纯函数(文本输入)。
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
        // TS lineText.length 是 UTF-16 长度
        sites.push(DefPropsAnchorSite {
            line: index,
            character: line_text.encode_utf16().count(),
        });
    }
    sites
}

/// 根级声明过滤器:组件槽成员与 FIXED_DICT 子键(路径带 .)不进总览。
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

/// 段悬停:声明出处(文件名:行)+ 域 + 持久化,无域无持久化只剩出处。
fn part_tooltip_of(property: &PropertyDefFace) -> String {
    // TS defFile.split(/[\\/]/).pop() ?? defFile:末段 basename(两种斜杠)
    let file_name = match property
        .def_file
        .rfind(['/', '\\'])
    {
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

/// 组装单锚点 inlay:头部段 `def 属性(N)`(悬停=只读视图说明)+ 逐属性段
/// `name: 注解`(Any 落名裸显),段间 ` · ` 分隔。注解链与 hover/stub 同源
/// ——本核承载 TS resolveEntityAnnotationType 的空工作区根链(内建直查+
/// 别名按名);注册表快照链不下沉(诚实边界批 3)。根级属性为零 → None
/// (锚行零 inlay)。
pub fn build_def_props_inlay_items(
    site: &DefPropsAnchorSite,
    properties: &[PropertyDefFace],
) -> Option<DefPropsHintItem> {
    let root_properties: Vec<&PropertyDefFace> =
        properties.iter().filter(|p| is_root_level_property(p)).collect();
    if root_properties.is_empty() {
        return None;
    }
    let mut parts = vec![DefPropsHintPart {
        text: format!("def 属性({}) ", root_properties.len()),
        tooltip: Some(
            "def 声明属性只读视图(纯渲染,非代码)。事实源: .def;跳转: 属性上 F12 直达声明行".to_string(),
        ),
    }];
    for property in &root_properties {
        if parts.len() > 1 {
            parts.push(DefPropsHintPart { text: " · ".to_string(), tooltip: None });
        }
        let name = property
            .property_path
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| property.symbol_name.clone());
        // TS: typeName ? resolveEntityAnnotationType(root, typeName) : FALLBACK;
        // 结果 === FALLBACK('Any') → 裸名。两分支合一直查链。
        let annotation = property
            .type_name
            .as_ref()
            .and_then(|type_name| super::def_param_hints::resolve_annotation_direct(type_name))
            // TS 判据 = 结果 === FALLBACK('Any') → 裸名(ENTITYCALL/PYTHON
            // 表值 Any 与未知/ALIAS 同落裸名,不伪造类型)
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
// golden(语料+权威探测面+产出;TS 镜像 tests/kodeDefPropsParity.test.ts)
// ---------------------------------------------------------------------------

/// 语料条目:py 源(锚面)+ 语料化属性清单(实体归属链留 TS 的诚实边界)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefPropsCorpusEntry {
    pub name: String,
    pub text: String,
    pub properties: Vec<PropertyDefFace>,
}

/// 探测面:锚提取 / 单锚组装。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum DefPropsProbe {
    Anchors { corpus: String },
    Items { corpus: String, anchor_index: usize },
}

/// 产出面(与 Probe 一一对应)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum DefPropsProbeOutcome {
    Anchors { sites: Vec<DefPropsAnchorSite> },
    Items { item: Option<DefPropsHintItem> },
}

/// golden 文件形态。
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
        probes.push(DefPropsProbe::Anchors { corpus: entry.name.clone() });
    }
    // anchored_multiline 有 2 锚(行 0/5),其余语料各 1 锚
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
            probes.push(DefPropsProbe::Items { corpus: corpus.into(), anchor_index });
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
        DefPropsProbe::Items { corpus, anchor_index } => {
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
    let outcomes: Vec<DefPropsProbeOutcome> =
        list.iter().map(|probe| run_def_props_probe(&table, probe)).collect();
    let golden = DefPropsGolden {
        generator: "dump-def-props-golden".into(),
        corpus: def_props_corpus(),
        probes: list,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

// ---------------------------------------------------------------------------
// 单元钉(防 golden 自洽同义反复)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_only_full_line_comments() {
        let text = "# kode:props-from-def\nclass A:  # kode:props-from-def\nx = \"kode:props-from-def\"\n   # kode:props-from-def\n";
        let sites = find_def_props_anchor_sites(text);
        assert_eq!(sites.len(), 2, "行尾注释与字符串内同词不触发;带前导空格整行注释触发");
        assert_eq!(sites[0].line, 0);
        assert_eq!(sites[0].character, "# kode:props-from-def".encode_utf16().count());
        assert_eq!(sites[1].line, 3);
        // CJK 注释锚:character 按 UTF-16 单元
        let cjk = find_def_props_anchor_sites("# \u{6ce8}\u{91ca} kode:props-from-def\n");
        assert_eq!(cjk[0].character, 24, "# +空格+两 CJK(各 1 单元)+空格+19 字符 token");
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
        let site = DefPropsAnchorSite { line: 0, character: 5 };
        let item = build_def_props_inlay_items(&site, &props).expect("根级 1 条应出");
        assert_eq!(item.parts.len(), 2, "单属性:头部段+属性段(间隔段自第 2 属性起)");
        assert_eq!(item.parts[1].text, "root");
        // 全部非根级 → None
        let filtered: Vec<PropertyDefFace> = vec![make(Some("m"), None, "m"), make(None, Some("a.b"), "b")];
        assert_eq!(build_def_props_inlay_items(&site, &filtered), None);
        // 空清单 → None
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
        let site = DefPropsAnchorSite { line: 0, character: 3 };
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
            &DefPropsAnchorSite { line: 0, character: 1 },
            &[property],
        )
        .unwrap();
        assert_eq!(item.parts[0].text, "def 属性(1) ");
        assert!(item.parts[0].tooltip.as_deref().unwrap().contains("只读视图"));
        assert_eq!(item.parts[1].text, "n: int");
        // Windows 反斜杠 basename + 域 + 持久化
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
            &DefPropsAnchorSite { line: 0, character: 1 },
            &[win],
        )
        .unwrap();
        assert_eq!(item.parts[1].tooltip.as_deref(), Some("win.def:2 · client"));
    }
}
