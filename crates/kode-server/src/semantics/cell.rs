//! KSEM-CELL-01 cellData 字段集。
//!
//! 引擎事实(docs/design/kbengine-semantic-precision-and-process-flow.md §2,
//! kbe/src/server/baseapp/entity.cpp:238/250 `Entity::createCellData`):
//! - **有 Cell 部件才创建**:实体没有 cell 面(无 cell 域属性、无 cell 方法、
//!   无组件槽)则引擎不建 cellData——状态 [`CellDataStatus::NoCellPart`],
//!   字段表恒空,不伪造;
//! - **字段取 Cell 属性描述**:域位真值 = [`kode_parser::model::flag_domains`]
//!   (common.h 真值表,与 TS 生成镜像同源;含 KR-AUD-87 OWN_CLIENT/
//!   OTHER_CLIENTS);
//! - **组件另建 Cell 数据**:组件槽是 cellData 的嵌套槽面——本批只登记槽,
//!   递归展开属 CELL-03;
//! - **内建键不在本批**:position/direction 是引擎自塞键,CELL-02 以独立
//!   引擎来源登记(不能要求 def 声明);
//! - **脚本面**(KR-AUD-74 布局):引擎按 `scripts/cell/<Name>.py` 装载 cell
//!   部件脚本——脚本宇宙由调用方提供(TS 已知工作区脚本集);未提供时脚本面
//!   [`CellDataStatus::ScriptUnknown`](诚实,不猜存在与否)。
//!
//! 继承/接口展开复用 BAS-05 [`super::snapshot::EntitySnapshot`](展开序
//! 自身→父链→接口;同名多来源进 conflicts,不任取一个),本模块只按域位
//! 过滤出 cell 面。

use kode_parser::model::DefFile;

use super::facts::{Evidence, Fact, Origin};
use super::snapshot::{ComponentView, EntitySnapshot, PropertyView};
use kode_types::TypeGraph;

/// cellData 结构状态(缺 Cell 脚本 / 无 Cell 部件分别成态,不混装)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CellDataStatus {
    /// 有 Cell 部件且 cell 脚本在:字段表即当前 def 面(组件槽展开待 CELL-03)。
    Ready,
    /// 无 Cell 部件:引擎不创建 cellData(entity.cpp createCellData 有部件才建)。
    NoCellPart,
    /// 有 Cell 部件但 `scripts/cell/<Name>.py` 缺失(KR-AUD-74 布局)。
    CellScriptMissing,
    /// 脚本宇宙未提供:脚本面无法判定(诚实降级,不猜存在与否)。
    ScriptUnknown,
}

/// 实体脚本可用面(调用方供工作区已知脚本集;引擎不重读盘)。
pub trait ScriptUniverse {
    /// cell 部件脚本是否在(`scripts/cell/<Name>.py`,KR-AUD-74 布局)。
    fn has_cell_script(&self, entity_name: &str) -> bool;
}

/// 脚本名集合([`ScriptUniverse`] 的最简实现;名字 = 实体名,大小写敏感)。
#[derive(Debug, Clone, Default)]
pub struct ScriptNameSet {
    names: std::collections::BTreeSet<String>,
}

impl ScriptNameSet {
    pub fn from_names<I: IntoIterator<Item = String>>(names: I) -> Self {
        Self { names: names.into_iter().collect() }
    }
}

impl ScriptUniverse for ScriptNameSet {
    fn has_cell_script(&self, entity_name: &str) -> bool {
        self.names.contains(entity_name)
    }
}

/// 有效 cellData 结构(def 面;CELL-02 内建键与 CELL-03 组件槽展开前的形态)。
#[derive(Debug, Clone)]
pub struct CellDataShape {
    pub entity: String,
    pub status: CellDataStatus,
    /// 引擎有效 Cell 属性表(展开序自身→父链→接口;仅 cell 域;同名冲突项
    /// 仍逐条保留——不任取一个,裁决面看 [`Self::conflict_names`])。
    pub fields: Vec<PropertyView>,
    /// 同名多来源的 cell 字段名(冲突保留候选)。
    pub conflict_names: Vec<String>,
    /// 组件槽(CELL-03 递归展开前的槽面;槽在即 cellData 有嵌套面)。
    pub component_slots: Vec<ComponentView>,
    /// 判定事实(cell 部件依据/脚本面;与快照 issues 同族)。
    pub issues: Vec<Fact>,
}

impl CellDataShape {
    /// 从实体自身 def + 解析器构建(BAS-05 展开语义,cell 域过滤)。
    pub fn build(
        own: &DefFile,
        resolve: &dyn super::snapshot::DefResolver,
        graph: &TypeGraph,
        root_id: kode_vfs::store::RootId,
        entity_name: &str,
        scripts: Option<&dyn ScriptUniverse>,
    ) -> CellDataShape {
        let snap = EntitySnapshot::build(own, resolve, graph, root_id, entity_name);

        let fields: Vec<PropertyView> = snap
            .properties
            .iter()
            .filter(|p| p.domains.contains(&"cell"))
            .cloned()
            .collect();
        let conflict_names: Vec<String> = snap
            .conflicts
            .iter()
            .filter(|c| fields.iter().any(|f| f.name == c.name))
            .map(|c| c.name.clone())
            .collect();

        // Cell 部件判定(def 面):cell 字段 / cell 方法任一即有;组件槽
        // 「另建 Cell 数据」(entity.cpp),槽在即潜在嵌套面(字段归 CELL-03)。
        let has_cell_part = !fields.is_empty()
            || !snap.cell_methods.is_empty()
            || !snap.components.is_empty();

        let mut issues = snap.issues;
        let status = if !has_cell_part {
            // 状态即结论:无部件时字段表恒空,判定事实仍要留痕。
            issues.push(issue_fact("no-cell-part", root_id, entity_name));
            CellDataStatus::NoCellPart
        } else {
            match scripts {
                Some(u) => {
                    if u.has_cell_script(entity_name) {
                        CellDataStatus::Ready
                    } else {
                        issues.push(issue_fact(
                            &format!("missing-cell-script:{entity_name}"),
                            root_id,
                            entity_name,
                        ));
                        CellDataStatus::CellScriptMissing
                    }
                }
                None => CellDataStatus::ScriptUnknown,
            }
        };

        CellDataShape {
            entity: entity_name.to_string(),
            status,
            fields,
            conflict_names,
            component_slots: snap.components,
            issues,
        }
    }
}

fn issue_fact(reason: &str, _root: kode_vfs::store::RootId, entity: &str) -> Fact {
    Fact::new(reason.to_string(), Origin::unknown(reason)).with_evidence(Evidence::new(
        format!("{entity}.def"),
        None,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_parser::model::{ComponentDef, MethodDef, PropertyDef};

    /// 旗标直接给规范化 token(与 parser 归一化产物同面)。
    fn prop(name: &str, ty: &str, flags: &[&str]) -> PropertyDef {
        PropertyDef {
            name: name.into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 1,
            type_name: Some(ty.into()),
            type_refs: vec![ty.into()],
            flags_raw: None,
            flags: flags.iter().map(|s| s.to_string()).collect(),
            default_value: None,
            detail_level: None,
            database_length: None,
            identifier: None,
            persistent: None,
            sensitive: false,
            extra_tags: vec![],
        }
    }

    fn method(name: &str) -> MethodDef {
        MethodDef { name: name.into(), name_span: kode_parser::Span::new(0, 0), line: 2, args: vec![], exposed: false }
    }

    fn def(parent: Option<&str>, interfaces: Vec<&str>, props: Vec<PropertyDef>) -> DefFile {
        DefFile {
            root_tag: Some("root".into()),
            parent: parent.map(|s| s.to_string()),
            interfaces: interfaces.into_iter().map(|s| s.to_string()).collect(),
            volatile: false,
            properties: props,
            components: vec![],
            base_methods: vec![],
            cell_methods: vec![],
            client_methods: vec![],
            extra_sections: vec![],
            diagnostics: vec![],
        }
    }

    struct DefMap(Vec<(&'static str, DefFile)>);

    impl super::super::snapshot::DefResolver for DefMap {
        fn resolve(&self, name: &str) -> Option<&DefFile> {
            self.0.iter().find(|(n, _)| *n == name).map(|(_, d)| d)
        }
    }

    fn build(
        own: &DefFile,
        map: &DefMap,
        scripts: Option<&dyn ScriptUniverse>,
    ) -> CellDataShape {
        let g = TypeGraph::new();
        CellDataShape::build(own, map, &g, kode_vfs::store::RootId(1), "Avatar", scripts)
    }

    #[test]
    fn cell_fields_only_own_def() {
        let own = def(
            None,
            vec![],
            vec![
                prop("hp", "UINT16", &["CELL_PUBLIC"]),
                prop("level", "UINT8", &["BASE"]),
                prop("name", "STRING", &[]),
            ],
        );
        let map = DefMap(vec![]);
        let shape = build(&own, &map, None);
        let names: Vec<&str> = shape.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["hp"], "仅 cell 域进字段表");
        assert!(shape.fields[0].domains.contains(&"cell"));
        assert_eq!(shape.status, CellDataStatus::ScriptUnknown, "脚本宇宙未供 → 诚实未知");
    }

    #[test]
    fn own_client_flags_count_as_cell() {
        // KR-AUD-87:OWN_CLIENT/OTHER_CLIENTS 都在 ENTITY_CELL_DATA_FLAGS。
        let own = def(None, vec![], vec![prop("gold", "UINT32", &["OWN_CLIENT"])]);
        let map = DefMap(vec![]);
        let shape = build(&own, &map, None);
        assert_eq!(shape.fields.len(), 1, "OWN_CLIENT 属 cell 面");
    }

    #[test]
    fn parent_and_interface_cell_fields_expanded() {
        let own = def(Some("Monster"), vec!["Mixin"], vec![prop("hp", "UINT16", &["CELL_PUBLIC"])]);
        let monster = def(None, vec![], vec![prop("speed", "FLOAT32", &["CELL_PRIVATE"])]);
        let mixin = def(None, vec![], vec![prop("soul", "INT32", &["CELL_PUBLIC"])]);
        let map = DefMap(vec![("Monster", monster), ("Mixin", mixin)]);
        let shape = build(&own, &map, None);
        let names: Vec<&str> = shape.fields.iter().map(|f| f.name.as_str()).collect();
        // 展开序:自身 hp → 父 speed → 接口 soul;来源保留。
        assert_eq!(names, ["hp", "speed", "soul"]);
        assert!(shape.fields[1].inherited);
        assert_eq!(shape.fields[1].from, "Monster");
        assert_eq!(shape.fields[2].from, "Mixin");
    }

    #[test]
    fn base_only_entity_has_no_cell_part() {
        let mut own = def(None, vec![], vec![prop("level", "UINT8", &["BASE"])]);
        own.base_methods = vec![method("tp")];
        let map = DefMap(vec![]);
        let shape = build(&own, &map, Some(&ScriptNameSet::from_names(vec!["Avatar".into()])));
        assert_eq!(shape.status, CellDataStatus::NoCellPart, "无 cell 面 → 引擎不建 cellData");
        assert!(shape.fields.is_empty());
        assert!(shape.issues.iter().any(|f| f.value == "no-cell-part"), "判定事实留痕");
    }

    #[test]
    fn inherited_cell_method_counts_as_cell_part() {
        let own = def(Some("Monster"), vec![], vec![]);
        let mut monster = def(None, vec![], vec![]);
        monster.cell_methods = vec![method("tick")];
        let map = DefMap(vec![("Monster", monster)]);
        let shape = build(&own, &map, None);
        assert_ne!(shape.status, CellDataStatus::NoCellPart, "继承的 cell 方法即部件");
    }

    #[test]
    fn component_slot_is_cell_face_fields_pending() {
        let mut own = def(None, vec![], vec![]);
        own.components = vec![ComponentDef {
            name: "weapon".into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 3,
            component_type: Some("Weapon".into()),
            persistent: Some(false),
        }];
        let map = DefMap(vec![]);
        let shape = build(&own, &map, None);
        assert_ne!(shape.status, CellDataStatus::NoCellPart, "组件另建 Cell 数据 → 非「无部件」");
        assert_eq!(shape.component_slots.len(), 1, "槽面登记,字段展开归 CELL-03");
        assert!(shape.fields.is_empty());
    }

    #[test]
    fn missing_cell_script_is_its_own_status() {
        let own = def(None, vec![], vec![prop("hp", "UINT16", &["CELL_PUBLIC"])]);
        let map = DefMap(vec![]);
        // 脚本宇宙存在但无 Avatar → 缺 Cell 脚本(不是 Ready,也不是未知)。
        let scripts = ScriptNameSet::from_names(vec!["Other".into()]);
        let shape = build(&own, &map, Some(&scripts));
        assert_eq!(shape.status, CellDataStatus::CellScriptMissing);
        assert!(!shape.fields.is_empty(), "def 面字段表仍构建,状态另记");
        assert!(shape.issues.iter().any(|f| f.value == "missing-cell-script:Avatar"));
    }

    #[test]
    fn ready_when_cell_script_present() {
        let own = def(None, vec![], vec![prop("hp", "UINT16", &["CELL_PUBLIC"])]);
        let map = DefMap(vec![]);
        let scripts = ScriptNameSet::from_names(vec!["Avatar".into()]);
        let shape = build(&own, &map, Some(&scripts));
        assert_eq!(shape.status, CellDataStatus::Ready);
    }

    #[test]
    fn cell_field_conflict_keeps_all_candidates() {
        let own = def(None, vec!["Mixin"], vec![prop("x", "INT32", &["CELL_PUBLIC"])]);
        let mixin = def(None, vec![], vec![prop("x", "STRING", &["CELL_PUBLIC"])]);
        let map = DefMap(vec![("Mixin", mixin)]);
        let shape = build(&own, &map, None);
        assert_eq!(shape.fields.len(), 2, "同名冲突项逐条保留,不任取");
        assert_eq!(shape.conflict_names, ["x"]);
    }
}
