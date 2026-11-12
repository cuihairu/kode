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
//! - **组件另建 Cell 数据**(CELL-03):每组件槽在 cellData 下成键,值 =
//!   组件 def 的 **Cell 侧字段** 子字典(仅 cell 域;BASE/CLIENT 不纳入);
//!   嵌套组件段递归展开(环安全+深度界);槽声明跳转面保留
//!   ([`ComponentCellData::file`/`line`]);
//! - **内建键**(CELL-02):position/direction 以独立引擎来源登记
//!   ([`builtin_cell_fields`],不能要求 def 声明);其余 cellapp 内建属性
//!   (spaceID/controlledBy/topSpeed 等)未核对为 cellData 键 → 不入表;
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

impl CellDataStatus {
    /// RPC/显示面稳定字符串(契约面,消费方按此判型)。
    pub fn as_str(&self) -> &'static str {
        match self {
            CellDataStatus::Ready => "ready",
            CellDataStatus::NoCellPart => "no-cell-part",
            CellDataStatus::CellScriptMissing => "cell-script-missing",
            CellDataStatus::ScriptUnknown => "script-unknown",
        }
    }
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

/// 引擎内建键初始形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuiltinShape {
    /// 三轴浮点;position 轴序 x/y/z,direction 轴序 roll/pitch/yaw
    /// (引擎建表六列同源:sm_0/1/2_position → position.x/y/z,
    /// sm_0/1/2_direction → direction.roll/pitch/yaw;脚本可见类型
    /// Vector3Like = Union[Tuple[float, float, float], Sequence[float]],
    /// 修正版 pyi _KBEngine_common.pyi:22)。
    Vector3 { axes: [&'static str; 3] },
}

impl BuiltinShape {
    /// 脚本可见类型显示文本(与 TS entityBuiltinProperties 同标签)。
    pub fn type_label(&self) -> &'static str {
        match self {
            BuiltinShape::Vector3 { .. } => "Vector3Like",
        }
    }
}

/// 引擎内建键(独立引擎来源;不是 def 声明,不能要求 def)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinField {
    pub name: &'static str,
    pub shape: BuiltinShape,
    /// 引擎取证(file:line;createCellData 把该键塞进 cellData 的引擎面)。
    pub source: &'static str,
}

/// 已核对为 cellData 键的引擎内建键(**封闭表**,新增须引擎源码核对后入)。
///
/// 核对链:design §2(kbe/src/server/baseapp/entity.cpp:238/250
/// `Entity::createCellData` 额外加入 position/direction)+ 引擎建表六列
/// (EntityTableMysql,position x/y/z + direction roll/pitch/yaw)。
/// 其余 cellapp 内建属性(spaceID/controlledBy/topSpeed/topSpeedY/layer/
/// volatileInfo/allClients/otherClients/isWitnessed/hasWitness/isOnGround,
/// TS entityBuiltinProperties.ts 已核为 **Entity 属性**)未核对为
/// **cellData 键** → 一律不入表(不猜;核对后按 CELL-02 口径增补)。
pub fn builtin_cell_fields() -> &'static [BuiltinField] {
    &[
        BuiltinField {
            name: "position",
            shape: BuiltinShape::Vector3 { axes: ["x", "y", "z"] },
            source: "server/baseapp/entity.cpp:250",
        },
        BuiltinField {
            name: "direction",
            shape: BuiltinShape::Vector3 { axes: ["roll", "pitch", "yaw"] },
            source: "server/baseapp/entity.cpp:250",
        },
    ]
}

/// 组件槽 cellData 展开面(CELL-03:递归解析 `cellData[组件槽][字段]` 的结构层)。
///
/// 引擎事实(design §2:组件另建 Cell 数据):每槽在 cellData 下成键,值 =
/// 组件 def 的 **Cell 侧字段** 子字典(BASE/CLIENT 域不纳入);组件 def 的
/// 组件段再递归(嵌套槽)。声明跳转面(槽名所在 def/行)保留——验收
/// 「保留组件声明跳转」。
#[derive(Debug, Clone)]
pub struct ComponentCellData {
    /// 槽名(cellData 的键;def 组件段标签名)。
    pub slot: String,
    /// 组件类型名(声明面 component_type;缺 → None,字段不猜)。
    pub component_type: Option<String>,
    /// 声明跳转面(组件声明所在 def/行)。
    pub file: String,
    pub line: Option<usize>,
    /// 组件 def 的 Cell 侧字段(仅 cell 域;展开序同 BAS-05;同名多来源
    /// 逐条保留,不任取)。
    pub fields: Vec<PropertyView>,
    /// 嵌套组件槽的 cell 数据(组件 def 的组件段,递归展开)。
    pub nested: Vec<ComponentCellData>,
    /// 展开事实(环/深度溢出/组件 def 侧缺失;与快照 issues 同族)。
    pub issues: Vec<Fact>,
}

/// 组件递归深度界(环安全双保险:visited 路径为主,深度界兜底绝不 hang)。
const COMPONENT_CELL_MAX_DEPTH: usize = 8;

fn expand_component_cell(
    slot: &ComponentView,
    resolve: &dyn super::snapshot::DefResolver,
    graph: &TypeGraph,
    root_id: kode_vfs::store::RootId,
    path: &mut Vec<String>,
    depth: usize,
) -> ComponentCellData {
    let mut issues = Vec::new();
    let (fields, nested) = match &slot.component_type {
        None => (Vec::new(), Vec::new()),
        Some(ct) if path.contains(ct) => {
            issues.push(issue_fact(&format!("component-cell-cycle:{ct}"), root_id, ct));
            (Vec::new(), Vec::new())
        }
        Some(ct) if depth >= COMPONENT_CELL_MAX_DEPTH => {
            issues.push(issue_fact("component-cell-depth-overflow", root_id, ct));
            (Vec::new(), Vec::new())
        }
        Some(ct) => match resolve.resolve(ct) {
            None => {
                // 类型不在场:槽面保留,字段不造(owner 级 missing-component-type
                // 已在 shape.issues,不重复记账)。
                (Vec::new(), Vec::new())
            }
            Some(component_def) => {
                let snap = EntitySnapshot::build(component_def, resolve, graph, root_id, ct);
                let fields: Vec<PropertyView> = snap
                    .properties
                    .iter()
                    .filter(|p| p.domains.contains(&"cell"))
                    .cloned()
                    .collect();
                issues.extend(snap.issues);
                path.push(ct.clone());
                let nested: Vec<ComponentCellData> = snap
                    .components
                    .iter()
                    .map(|c| expand_component_cell(c, resolve, graph, root_id, path, depth + 1))
                    .collect();
                path.pop();
                (fields, nested)
            }
        },
    };
    ComponentCellData {
        slot: slot.name.clone(),
        component_type: slot.component_type.clone(),
        file: slot.file.clone(),
        line: slot.line,
        fields,
        nested,
        issues,
    }
}

/// cellData 键来源面(补全/跳转消费:哪个面提供的键)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CellDataKeyKind {
    /// def 字段(cell 域;含继承/接口展开来源)。
    DefField,
    /// 引擎内建键(CELL-02;position/direction)。
    Builtin,
    /// 组件槽(cellData[槽] 下再嵌字段,CELL-03)。
    ComponentSlot,
}

/// cellData 键视图(键补全/跳转/类型消费面)。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDataKeyView {
    pub key: String,
    pub kind: CellDataKeyKind,
    /// 类型显示文本(def 字段类型 / Vector3Like / 组件槽 None)。
    pub type_label: Option<String>,
    /// 跳转目标(def 声明 `{from}.def` / 引擎取证 / 组件声明 `{entity}.def`)。
    pub source_file: Option<String>,
    pub source_line: Option<usize>,
}

/// 有效 cellData 结构(def 字段面 + 引擎内建键面 + 组件槽展开面)。
#[derive(Debug, Clone)]
pub struct CellDataShape {
    pub entity: String,
    pub status: CellDataStatus,
    /// 引擎有效 Cell 属性表(展开序自身→父链→接口;仅 cell 域;同名冲突项
    /// 仍逐条保留——不任取一个,裁决面看 [`Self::conflict_names`])。
    pub fields: Vec<PropertyView>,
    /// 同名多来源的 cell 字段名(冲突保留候选)。
    pub conflict_names: Vec<String>,
    /// 引擎内建键(有 Cell 部件即有;引擎自塞,与 def 字段面分账不混装)。
    pub builtins: Vec<&'static BuiltinField>,
    /// 组件槽(平槽面:声明序,与 [`Self::component_cells`] 同序对应)。
    pub component_slots: Vec<ComponentView>,
    /// 组件槽展开面(CELL-03;`cellData[组件槽][字段]` 结构)。
    pub component_cells: Vec<ComponentCellData>,
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

        // 内建键:有 Cell 部件才创建 cellData(entity.cpp:238/250),故
        // 无部件 → 无内建键;有部件 → 引擎自塞键恒在(与脚本面无关——脚本
        // 缺失不影响引擎行为,只影响分析可用面)。
        let builtins: Vec<&'static BuiltinField> = if has_cell_part {
            builtin_cell_fields().iter().collect()
        } else {
            Vec::new()
        };

        // 组件槽展开(CELL-03):槽在 cellData 下成键,值 = 组件 def 的
        // cell 侧字段子字典;嵌套组件段递归(环安全 + 深度界)。
        let mut path: Vec<String> = vec![entity_name.to_string()];
        let component_cells: Vec<ComponentCellData> = snap
            .components
            .iter()
            .map(|c| expand_component_cell(c, resolve, graph, root_id, &mut path, 0))
            .collect();

        CellDataShape {
            entity: entity_name.to_string(),
            status,
            fields,
            conflict_names,
            builtins,
            component_slots: snap.components,
            component_cells,
            issues,
        }
    }

    /// 键宇宙视图(键补全/跳转消费面):def 字段 → 内建键 → 组件槽,
    /// 各自声明序,确定性;来源面不混装(kind 区分)。
    pub fn key_views(&self) -> Vec<CellDataKeyView> {
        let mut views = Vec::new();
        for f in &self.fields {
            views.push(CellDataKeyView {
                key: f.name.clone(),
                kind: CellDataKeyKind::DefField,
                type_label: Some(f.ty.display()),
                source_file: Some(f.file.clone()),
                source_line: f.line,
            });
        }
        for b in &self.builtins {
            views.push(CellDataKeyView {
                key: b.name.to_string(),
                kind: CellDataKeyKind::Builtin,
                type_label: Some(b.shape.type_label().to_string()),
                source_file: Some(b.source.to_string()),
                source_line: None,
            });
        }
        for c in &self.component_cells {
            views.push(CellDataKeyView {
                key: c.slot.clone(),
                kind: CellDataKeyKind::ComponentSlot,
                type_label: c.component_type.clone(),
                source_file: Some(c.file.clone()),
                source_line: c.line,
            });
        }
        views
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

    #[test]
    fn builtin_registry_is_verified_closed_set() {
        let reg = builtin_cell_fields();
        let names: Vec<&str> = reg.iter().map(|b| b.name).collect();
        assert_eq!(names, ["position", "direction"], "封闭表=已核对集;其余内建未核对不入");
        assert!(reg.iter().all(|b| b.source.contains("entity.cpp")), "内建键带引擎取证");
    }

    #[test]
    fn builtin_axes_pin_engine_column_truth() {
        let reg = builtin_cell_fields();
        let pos = reg.iter().find(|b| b.name == "position").unwrap();
        let dir = reg.iter().find(|b| b.name == "direction").unwrap();
        assert_eq!(pos.shape, BuiltinShape::Vector3 { axes: ["x", "y", "z"] });
        assert_eq!(dir.shape, BuiltinShape::Vector3 { axes: ["roll", "pitch", "yaw"] });
        assert_eq!(pos.shape.type_label(), "Vector3Like");
    }

    #[test]
    fn builtins_present_only_with_cell_part() {
        let cell_own = def(None, vec![], vec![prop("hp", "UINT16", &["CELL_PUBLIC"])]);
        let map = DefMap(vec![]);
        let with = build(&cell_own, &map, None);
        assert_eq!(with.builtins.len(), 2, "有部件 → 引擎自塞键恒在(与脚本面无关)");

        let mut base_own = def(None, vec![], vec![prop("level", "UINT8", &["BASE"])]);
        base_own.base_methods = vec![method("tp")];
        let without = build(&base_own, &map, Some(&ScriptNameSet::from_names(vec!["Avatar".into()])));
        assert_eq!(without.status, CellDataStatus::NoCellPart);
        assert!(without.builtins.is_empty(), "无部件 → 引擎不建 cellData,无内建键");
    }

    #[test]
    fn builtins_stay_engine_face_not_def_fields() {
        let own = def(None, vec![], vec![prop("hp", "UINT16", &["CELL_PUBLIC"])]);
        let map = DefMap(vec![]);
        let shape = build(&own, &map, None);
        assert!(shape.fields.iter().all(|f| f.name != "position"), "def 字段面不含内建键");
        assert!(shape.builtins.iter().all(|b| b.name != "hp"), "内建键面不含 def 字段");
    }

    fn component(name: &str, component_type: Option<&str>, line: usize) -> ComponentDef {
        ComponentDef {
            name: name.into(),
            name_span: kode_parser::Span::new(0, 0),
            line,
            component_type: component_type.map(|s| s.to_string()),
            persistent: None,
        }
    }

    #[test]
    fn component_slot_expands_only_cell_fields() {
        let mut weapon = def(None, vec![], vec![
            prop("ammo", "UINT16", &["CELL_PUBLIC"]),
            prop("skin", "STRING", &["BASE"]),
            prop("uid", "UINT64", &["BASE_AND_CLIENT"]),
        ]);
        weapon.base_methods = vec![method("onAttach")];
        let mut own = def(None, vec![], vec![]);
        own.components = vec![component("weapon", Some("Weapon"), 3)];
        let map = DefMap(vec![("Weapon", weapon)]);
        let shape = build(&own, &map, None);
        assert_eq!(shape.component_cells.len(), 1);
        let cell = &shape.component_cells[0];
        // 仅组件 Cell 侧字段进子字典:ammo 进,skin/uid(BASE 域)不进;
        // 组件 def 的 base 方法不参与(cell 方法才算部件)。
        let names: Vec<&str> = cell.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["ammo"], "仅组件 Cell 侧字段");
        assert_eq!(cell.slot, "weapon");
        assert_eq!(cell.component_type.as_deref(), Some("Weapon"));
    }

    #[test]
    fn component_declaration_jump_face_preserved() {
        let mut own = def(None, vec![], vec![]);
        own.components = vec![component("weapon", Some("Weapon"), 7)];
        let map = DefMap(vec![]);
        let shape = build(&own, &map, None);
        let cell = &shape.component_cells[0];
        assert_eq!(cell.file, "Avatar.def", "槽声明跳转=组件声明 def");
        assert_eq!(cell.line, Some(7));
    }

    #[test]
    fn nested_component_recursion() {
        // Weapon 组件段再挂 Sight → cellData["weapon"]["sight"] 递归。
        let mut sight = def(None, vec![], vec![prop("zoom", "FLOAT32", &["CELL_PUBLIC"])]);
        sight.cell_methods = vec![method("track")];
        let mut weapon = def(None, vec![], vec![prop("ammo", "UINT16", &["CELL_PUBLIC"])]);
        weapon.components = vec![component("sight", Some("Sight"), 5)];
        let mut own = def(None, vec![], vec![]);
        own.components = vec![component("weapon", Some("Weapon"), 3)];
        let map = DefMap(vec![("Weapon", weapon), ("Sight", sight)]);
        let shape = build(&own, &map, None);
        let weapon_cell = &shape.component_cells[0];
        assert_eq!(weapon_cell.nested.len(), 1, "嵌套槽递归展开");
        let sight_cell = &weapon_cell.nested[0];
        assert_eq!(sight_cell.slot, "sight");
        assert_eq!(sight_cell.fields[0].name, "zoom");
        assert_eq!(sight_cell.fields[0].from, "Sight", "来源=组件 def");
    }

    #[test]
    fn component_cycle_is_diagnosed_not_hang() {
        // Weapon 挂 Mount,Mount 挂 Weapon(组件段环)→ 记事实不 hang。
        let mut weapon = def(None, vec![], vec![prop("ammo", "UINT16", &["CELL_PUBLIC"])]);
        weapon.components = vec![component("mount", Some("Mount"), 4)];
        let mut mount = def(None, vec![], vec![]);
        mount.components = vec![component("weapon", Some("Weapon"), 4)];
        let mut own = def(None, vec![], vec![]);
        own.components = vec![component("weapon", Some("Weapon"), 3)];
        let map = DefMap(vec![("Weapon", weapon), ("Mount", mount)]);
        let shape = build(&own, &map, None);
        // 环在 Mount 段再挂 Weapon 处闭:path=[Avatar,Weapon,Mount],Weapon
        // 已在 → 环记在 weapon 槽展开(Avatar>weapon>mount>weapon)。
        let mount_cell = &shape.component_cells[0].nested[0];
        assert!(mount_cell.nested[0].issues.iter().any(|f| f.value.contains("component-cell-cycle")), "环记事实");
        assert!(mount_cell.nested[0].fields.is_empty(), "环内不 hang 不展开");
    }

    #[test]
    fn component_type_missing_or_untyped_no_fields_fabricated() {
        // 组件类型不在场/组件段无类型:槽面保留,字段不造。
        let mut own = def(None, vec![], vec![]);
        own.components = vec![
            component("weapon", Some("Ghost"), 3),
            component("raw", None, 4),
        ];
        let map = DefMap(vec![]);
        let shape = build(&own, &map, None);
        assert_eq!(shape.component_cells.len(), 2);
        assert!(shape.component_cells[0].fields.is_empty(), "类型缺 → 不造字段");
        assert!(shape.component_cells[1].fields.is_empty(), "无类型 → 不造字段");
        assert!(shape.component_cells[1].component_type.is_none());
    }

    #[test]
    fn component_fields_expand_parent_and_interfaces() {
        // 组件 def 的继承/接口 cell 字段同样展开(BAS-05 展开语义复用)。
        let mut weapon = def(Some("WeaponBase"), vec![], vec![prop("ammo", "UINT16", &["CELL_PUBLIC"])]);
        weapon.components = vec![];
        let mut weapon_base = def(None, vec![], vec![prop("durability", "UINT16", &["CELL_PUBLIC"])]);
        weapon_base.components = vec![];
        let mut own = def(None, vec![], vec![]);
        own.components = vec![component("weapon", Some("Weapon"), 3)];
        let map = DefMap(vec![("Weapon", weapon), ("WeaponBase", weapon_base)]);
        let shape = build(&own, &map, None);
        let names: Vec<&str> = shape.component_cells[0].fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["ammo", "durability"], "组件字段含继承面");
        assert!(shape.component_cells[0].fields[1].inherited);
    }
}
