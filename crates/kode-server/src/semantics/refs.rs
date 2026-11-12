//! KSEM-RPC-01 角色化引用类型。
//!
//! 引擎事实(kbe/src,行号锚定本地工作区 `../kbengine`):
//! - **EntityCall = 远程句柄**,携带 `(componentID, 实体 id, 调用类型)`,
//!   不持有目标对象、不保活、无失效通知(`lib/entitydef/entity_call.h:15`);
//!   仅可调 `.def` 声明方法,引擎方法/属性不可达(api-core-concepts §1.1);
//! - **七种调用类型**(`lib/common/common.h:283-291`):CELL/BASE/CLIENT +
//!   路由变体 CELL_VIA_BASE/BASE_VIA_CELL/CLIENT_VIA_CELL/CLIENT_VIA_BASE;
//!   via 只描述**传输路径**,方法表仍按目标面查(`entity_call.cpp:85-115`
//!   switch:CELL_VIA_BASE 同样 findCellMethodDescription);
//! - **面跳规则**(`entity_call.cpp:136-168`):在 EntityCall 上读
//!   `.cell`/`.base`/`.client`,服务端构造**新 EntityCall**(同模块→同实体
//!   类型,`:166`;仅 base 的自身 `cellEntityCall_` 迁移时原地改写——见
//!   knowledge/entity-migration-and-cross-process-references.md §规则2);
//!   自名闸先挡(`:136 strcmp(ccattr, TO_NAME_TABLE[type_])`:cell 上再取
//!   `.cell` 空转被拒);client/bots 组件侧原样返回自身句柄(`:171`);
//! - **本地 Entity 与 EntityCall 的区分**:同进程引用持实体对象本身
//!   (引擎 API + 全 def 方法面可用);跨进程只能持 EntityCall;
//! - **ENTITYCALL 字段类型的取值接受规则**(`lib/entitydef/datatype.cpp:1484`
//!   `EntityCallType::isSameType`):EntityCall 实例、None、实际 Entity 实例
//!   三者接受,其余 OUT_TYPE_ERROR;字段默认值 None(`:1506-1508`
//!   parseDefaultStr Py_RETURN_NONE);
//! - **具体类未知不猜**:def 的 ENTITYCALL 字段类型本身不指定 Avatar 等
//!   具体实体(设计 §2「ENTITYCALL 类型」行),[`EntityRef`] 的 class 一律
//!   Option,None 保持 None,绝不伪造具体类名。
//!
//! 纯库面(无 RPC/无 TS 消费):方法/组件槽落点归 KSEM-RPC-04;self 角色
//! 绑定见 [`bind_self_role`](RPC-02)。

use super::id::Facet;

/// 七种 ENTITYCALL_TYPE(`lib/common/common.h:283-291`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CallType {
    Cell,
    Base,
    Client,
    CellViaBase,
    BaseViaCell,
    ClientViaCell,
    ClientViaBase,
}

impl CallType {
    /// 方法表归属(`entity_call.cpp:85-115`):VIA 变体同样查目标面表。
    pub fn target_facet(self) -> Facet {
        match self {
            CallType::Cell | CallType::CellViaBase => Facet::Cell,
            CallType::Base | CallType::BaseViaCell => Facet::Base,
            CallType::Client | CallType::ClientViaCell | CallType::ClientViaBase => Facet::Client,
        }
    }

    /// 单字面属性名(`common.h:321` ENTITYCALL_TYPE_TO_NAME_TABLE;EX 表
    /// `:333` 是显示面,不参与自名闸)。
    pub fn table_name(self) -> &'static str {
        match self {
            CallType::Cell | CallType::CellViaBase => "cell",
            CallType::Base | CallType::BaseViaCell => "base",
            CallType::Client | CallType::ClientViaCell | CallType::ClientViaBase => "client",
        }
    }

    /// 面跳(`entity_call.cpp:136-168`,服务端语义):自名闸挡同面空转;
    /// 其余按源码三分支;无源码规则的组合 → None(不猜)。
    pub fn hop(self, attr: &str) -> Option<CallType> {
        if attr == self.table_name() {
            return None;
        }
        match (self, attr) {
            (CallType::Cell, "base") => Some(CallType::BaseViaCell),
            (CallType::Cell, "client") => Some(CallType::ClientViaCell),
            (CallType::Base, "cell") => Some(CallType::CellViaBase),
            (CallType::Base, "client") => Some(CallType::ClientViaBase),
            // 去直连:CELL_VIA_BASE 取 .base → 直连 BASE;BASE_VIA_CELL 取
            // .cell → 直连 CELL(`:146-150` 的去 via 分支)。
            (CallType::CellViaBase, "base") => Some(CallType::Base),
            (CallType::BaseViaCell, "cell") => Some(CallType::Cell),
            // CLIENT 句柄取面:cell/base 分支的默认臂(`:144/:149` else)。
            (CallType::Client, "cell") => Some(CallType::CellViaBase),
            (CallType::Client, "base") => Some(CallType::BaseViaCell),
            // CLIENT_VIA_* 复用同一三分支(非 BASE 非 CELL 走默认臂)。
            (CallType::ClientViaCell, "cell") | (CallType::ClientViaBase, "cell") => {
                Some(CallType::CellViaBase)
            }
            (CallType::ClientViaCell, "base") | (CallType::ClientViaBase, "base") => {
                Some(CallType::BaseViaCell)
            }
            // CELL_VIA_BASE 取 .client / BASE_VIA_CELL 取 .client:client 分支
            // 只认 BASE/CELL(`:151-156`)→ mbtype=-1,回落属性错误尾(`:177`)。
            _ => None,
        }
    }
}

/// 脚本值形态(`datatype.cpp:1484` isSameType 的判别对象)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptValue {
    /// EntityCall 实例(任意调用类型)。
    EntityCall,
    /// 实际 Entity 实例(PyObject_IsInstance "Entity")。
    LocalEntity,
    /// Py_None。
    NoneLiteral,
    /// 其余(int/str/dict/...)。
    Other,
}

/// 角色化实体引用(Python 侧可持引用的三种形态)。
#[derive(Debug, Clone, PartialEq)]
pub enum EntityRef {
    /// 本地实体对象(同进程;引擎 API + 全 def 方法面可用)。
    Local { class: Option<String> },
    /// 远程 EntityCall 句柄(仅可调 def 声明方法;class Option,None 不猜)。
    Remote { class: Option<String>, call: CallType },
    /// 引擎交出的确定 None(未绑定面如 `self.cell` 无 cell 时;
    /// ENTITYCALL 字段默认值 `datatype.cpp:1506-1508`)。
    None,
}

/// ENTITYCALL 字段类型的取值接受(`datatype.cpp:1484-1505`):EntityCall、
/// None、实际 Entity 三者接受;其余 OUT_TYPE_ERROR。
pub fn entity_call_field_accepts(value: ScriptValue) -> bool {
    matches!(
        value,
        ScriptValue::EntityCall | ScriptValue::LocalEntity | ScriptValue::NoneLiteral
    )
}

/// 实体脚本面(布局 `scripts/{base,cell,client}/<Name>.py`,KR-AUD-74;
/// 同一实体类型的三面脚本各自可见的角色属性不同)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptFace {
    Base,
    Cell,
    Client,
}

/// `self.<attr>` 角色绑定结果(getter 表存在才有值;面无此属性 → None,不猜)。
#[derive(Debug, Clone, PartialEq)]
pub struct SelfRoleBinding {
    pub reference: EntityRef,
    /// 源码可证 None:所有角色 getter 对 NULL → S_Return(Py None)——
    /// 绑定存在 ≠ 当前已绑定面(KSEM-CELL-11 同口径:一次异步创建≠已持有)。
    pub none_possible: bool,
    /// 构造点/守卫注记(证据用;行号锚定 `../kbengine`)。
    pub note: &'static str,
}

/// 绑定 `self.<attr>` 角色引用(逐面逐属性查引擎,RPC-02)。
///
/// getter 表(SCRIPT_GET_DECLARE):baseapp/entity.cpp:36-37(`.cell`/`.client`,
/// **无 `.base`**——自身即 base 面);cellapp/entity.cpp:74-75(`.base`/`.client`,
/// **无 `.cell`**);lib/client_lib/entity.cpp:41-43(`.base`/`.cell`/`.clientapp`,
/// **无 `.client`**——`.clientapp` 是客户端应用对象,非角色引用)。
///
/// 调用类型构造点:
/// - base `.cell` = CELL(baseapp/entity.cpp:1028 onGetCell;:1059 onLoseCell
///   释放回 None);base `.client` = CLIENT(proxy.cpp:411 onGiveClientTo;
///   **仅 Proxy 系实体**有客户端绑定——baseapp/entity.cpp:157 注「有
///   clientEntityCall_ 必定是 proxy」;两 getter :752/:802 destroyed 读
///   AssertionError,cell/client 面 getter 无此守卫);
/// - cell `.base` = BASE(cellapp/entity.cpp:4105,无 base 部件实体 → NULL);
///   cell `.client` = **CLIENT_VIA_BASE**——onGetWitness 经
///   `baseEntityCall()` 读 `.client` 构造(:2104-2110),客户端连在 baseapp,
///   cellapp 侧调用必经 base 路由;断连清 NULL(:2211);
/// - client `.base` = BASE / `.cell` = CELL(lib/client_lib/clientobjectbase.cpp
///   :787/:860/:903,直连类型)。
///
/// 其余属性名不是角色引用(组件槽/方法/内建属性归各自批次),None 不猜。
pub fn bind_self_role(face: ScriptFace, attr: &str, class: Option<&str>) -> Option<SelfRoleBinding> {
    let bind = |call: CallType, note: &'static str| {
        Some(SelfRoleBinding {
            reference: EntityRef::Remote { class: class.map(str::to_string), call },
            none_possible: true,
            note,
        })
    };
    match (face, attr) {
        (ScriptFace::Base, "cell") => bind(
            CallType::Cell,
            "getter baseapp/entity.cpp:750;onGetCell :1028 构造 CELL,onLoseCell :1059 释放回 None;destroyed 读 AssertionError :752",
        ),
        (ScriptFace::Base, "client") => bind(
            CallType::Client,
            "getter baseapp/entity.cpp:800;proxy.cpp:411 onGiveClientTo 构造 CLIENT;仅 Proxy 系实体有绑定(baseapp/entity.cpp:157 注);destroyed 读 AssertionError :802",
        ),
        (ScriptFace::Cell, "base") => bind(
            CallType::Base,
            "getter cellapp/entity.cpp:391;:4105 构造 BASE;无 base 部件实体 → NULL;getter 无 destroyed 守卫",
        ),
        (ScriptFace::Cell, "client") => bind(
            CallType::ClientViaBase,
            "getter cellapp/entity.cpp:573;onGetWitness 经 baseEntityCall() 读 .client 构造 :2104-2110 → CLIENT_VIA_BASE(客户端连在 baseapp,经 base 路由);断连清 NULL :2211",
        ),
        (ScriptFace::Client, "base") => bind(
            CallType::Base,
            "getter lib/client_lib/entity.cpp:104;clientobjectbase.cpp:787 构造 BASE",
        ),
        (ScriptFace::Client, "cell") => bind(
            CallType::Cell,
            "getter lib/client_lib/entity.cpp:115;clientobjectbase.cpp:860/:903 构造 CELL",
        ),
        // base.base / cell.cell / client.client:同面无此属性(自身即该面);
        // client 面同名为 .clientapp(客户端应用对象,非角色引用)。
        // 其余属性名(方法/组件槽/内建属性)不是角色引用,归各自批次。
        _ => None,
    }
}

// ---- RPC-03 引用别名传播 ----

/// 局部名携带的引用值。
#[derive(Debug, Clone, PartialEq)]
pub enum AliasValue {
    /// 确定引用(单条)。
    Ref(EntityRef),
    /// 合流多候选(分支异值;顺序=分支序,去重保序;消费面不得任取一个
    /// 当确定对象——不按同名方法猜)。
    Candidates(Vec<EntityRef>),
    /// 未知来源(重绑定到非引用形态/推导不出/合流含未知分支)——
    /// **不保留旧值**,不猜(重绑定即遮蔽,与流面「最近写点胜」同语义)。
    Unknown(String),
}

/// 赋值来源形态(AST 归类归 BAS-07 expr.rs;此处是归约后的消费面)。
#[derive(Debug, Clone, PartialEq)]
pub enum AliasSource {
    /// `self.<attr>`。
    SelfRole { attr: String },
    /// `<name>`(别名复制)。
    LocalName { name: String },
    /// `<name>.<attr>`(别名后取面)。
    LocalHop { name: String, attr: String },
    /// 字面量/调用/其他形态(原因)——推导不出即未知。
    NonReference(String),
}

/// 局部别名表:名字 → 最近绑定。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AliasTable {
    latest: std::collections::HashMap<String, AliasValue>,
    order: Vec<String>,
}

impl AliasTable {
    /// 重绑定即遮蔽:旧值被替换(含替换成 Unknown),不回看。
    pub fn assign(&mut self, name: impl Into<String>, value: AliasValue) {
        let name = name.into();
        if !self.latest.contains_key(&name) {
            self.order.push(name.clone());
        }
        self.latest.insert(name, value);
    }

    /// 最近绑定;未绑定名 → None(调用方诚实处理,不猜)。
    pub fn lookup(&self, name: &str) -> Option<&AliasValue> {
        self.latest.get(name)
    }

    /// `dst = <src>` 传播(self 角色/别名复制/别名取面/非引用形态)。
    pub fn apply(&mut self, dst: &str, src: AliasSource, face: ScriptFace, self_class: Option<&str>) {
        let value = match src {
            AliasSource::SelfRole { attr } => match bind_self_role(face, &attr, self_class) {
                Some(binding) => AliasValue::Ref(binding.reference),
                None => AliasValue::Unknown(format!("self.{attr}:该面无此角色属性")),
            },
            AliasSource::LocalName { name } => match self.lookup(&name) {
                Some(v) => v.clone(),
                None => AliasValue::Unknown(format!("{name}:未绑定,不猜")),
            },
            AliasSource::LocalHop { name, attr } => match self.lookup(&name) {
                Some(AliasValue::Ref(r)) => match r.hop_attr(&attr) {
                    Some(hopped) => AliasValue::Ref(hopped),
                    None => AliasValue::Unknown(format!(
                        "{name}({}).{attr}:面跳无源码规则",
                        r.display()
                    )),
                },
                Some(AliasValue::Candidates(cands)) => {
                    let mut hopped: Vec<EntityRef> = Vec::new();
                    for c in cands {
                        if let Some(h) = c.hop_attr(&attr) {
                            if !hopped.contains(&h) {
                                hopped.push(h);
                            }
                        }
                    }
                    match hopped.len() {
                        1 => AliasValue::Ref(hopped.pop().expect("len==1")),
                        2.. => AliasValue::Candidates(hopped),
                        // 全候选面跳失败 → 未知,不造具体调用类型。
                        0 => AliasValue::Unknown(format!("{name}.{attr}:全候选面跳无源码规则")),
                    }
                }
                Some(AliasValue::Unknown(reason)) => AliasValue::Unknown(reason.clone()),
                None => AliasValue::Unknown(format!("{name}:未绑定,不猜")),
            },
            AliasSource::NonReference(reason) => AliasValue::Unknown(reason),
        };
        self.assign(dst, value);
    }

    /// 分支合流:同名同值保留;异值 → Candidates(去重保序);任一侧含
    /// Unknown → Unknown 吞并(候选∪任意=任意,不假装仍确定);单侧缺 →
    /// 另一侧;双侧缺 → 缺。
    pub fn merge(left: &AliasTable, right: &AliasTable) -> AliasTable {
        let mut out = AliasTable::default();
        for name in &left.order {
            if let Some(rv) = right.lookup(name) {
                let lv = left.lookup(name).expect("order 与 latest 同步");
                out.assign(name.clone(), merge_value(lv, rv));
            } else {
                out.assign(name.clone(), left.latest.get(name).expect("order 同步").clone());
            }
        }
        for name in &right.order {
            if left.lookup(name).is_none() {
                out.assign(name.clone(), right.latest.get(name).expect("order 同步").clone());
            }
        }
        out
    }
}

fn merge_value(left: &AliasValue, right: &AliasValue) -> AliasValue {
    use AliasValue::{Candidates, Ref, Unknown};
    if left == right {
        return left.clone();
    }
    match (left, right) {
        (Unknown(reason), _) | (_, Unknown(reason)) => Unknown(reason.clone()),
        (Ref(a), Ref(b)) => Candidates(vec![a.clone(), b.clone()]),
        (Ref(a), Candidates(bs)) | (Candidates(bs), Ref(a)) => {
            // or 模式下 bs 恒为 Candidates 侧的候选表,seed 后补另一侧。
            let mut all = bs.clone();
            if !all.contains(a) {
                all.push(a.clone());
            }
            Candidates(all)
        }
        (Candidates(as_), Candidates(bs)) => {
            let mut all = as_.clone();
            for b in bs {
                if !all.contains(b) {
                    all.push(b.clone());
                }
            }
            Candidates(all)
        }
    }
}

impl EntityRef {
    /// 面跳属性读(`.cell`/`.base`/`.client`):服务端新 EntityCall 同模块
    /// 构造(`entity_call.cpp:166`)→ **class 原样保留,未知保持未知**;
    /// client/bots 组件侧原样返回自身句柄(`:171`,调用类型不变,对本模型
    /// 等价于引用不变——注释记录,不另立形态)。本地引用/None 不发生
    /// EntityCall 面跳(本地 `self.base` 等逐面绑定归 RPC-02)。
    pub fn hop_attr(&self, attr: &str) -> Option<EntityRef> {
        match self {
            EntityRef::Remote { class, call } => call
                .hop(attr)
                .map(|c| EntityRef::Remote { class: class.clone(), call: c }),
            _ => None,
        }
    }

    /// 人类可读(诊断/证据;非身份键)。类未知以 `?` 诚实标注,不伪造。
    pub fn display(&self) -> String {
        fn cls(c: &Option<String>) -> &str {
            c.as_deref().unwrap_or("?")
        }
        match self {
            EntityRef::Local { class } => format!("Entity<{}>", cls(class)),
            EntityRef::Remote { class, call } => {
                format!("EntityCall<{}@{}>", cls(class), call.table_name())
            }
            EntityRef::None => "None".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_facet_via_routes_to_target_table() {
        // via 只描述传输路径,方法表按目标面查(entity_call.cpp:85-115)。
        assert_eq!(CallType::Cell.target_facet(), Facet::Cell);
        assert_eq!(CallType::CellViaBase.target_facet(), Facet::Cell);
        assert_eq!(CallType::Base.target_facet(), Facet::Base);
        assert_eq!(CallType::BaseViaCell.target_facet(), Facet::Base);
        assert_eq!(CallType::Client.target_facet(), Facet::Client);
        assert_eq!(CallType::ClientViaCell.target_facet(), Facet::Client);
        assert_eq!(CallType::ClientViaBase.target_facet(), Facet::Client);
    }

    #[test]
    fn table_name_matches_common_h() {
        // common.h:321 TO_NAME_TABLE 逐位对拍(CELL_VIA_BASE="cell" 等)。
        assert_eq!(CallType::Cell.table_name(), "cell");
        assert_eq!(CallType::Base.table_name(), "base");
        assert_eq!(CallType::Client.table_name(), "client");
        assert_eq!(CallType::CellViaBase.table_name(), "cell");
        assert_eq!(CallType::BaseViaCell.table_name(), "base");
        assert_eq!(CallType::ClientViaCell.table_name(), "client");
        assert_eq!(CallType::ClientViaBase.table_name(), "client");
    }

    /// 7×3 全矩阵(entity_call.cpp:136-168 逐分支;None=无源码规则/自名闸)。
    #[test]
    fn hop_full_matrix_pinned() {
        type Row = [(CallType, &'static str, Option<CallType>); 3];
        let cell: Row = [
            (CallType::Cell, "cell", None),                     // 自名闸(:136)
            (CallType::Cell, "base", Some(CallType::BaseViaCell)),
            (CallType::Cell, "client", Some(CallType::ClientViaCell)),
        ];
        let base: Row = [
            (CallType::Base, "cell", Some(CallType::CellViaBase)),
            (CallType::Base, "base", None),                     // 自名闸
            (CallType::Base, "client", Some(CallType::ClientViaBase)),
        ];
        let client: Row = [
            (CallType::Client, "cell", Some(CallType::CellViaBase)),   // 默认臂
            (CallType::Client, "base", Some(CallType::BaseViaCell)),   // 默认臂
            (CallType::Client, "client", None),                        // 自名闸+分支 -1
        ];
        let cell_via_base: Row = [
            (CallType::CellViaBase, "cell", None),              // 自名闸(TO 表="cell")
            (CallType::CellViaBase, "base", Some(CallType::Base)),     // 去直连
            (CallType::CellViaBase, "client", None),            // client 分支只认 BASE/CELL
        ];
        let base_via_cell: Row = [
            (CallType::BaseViaCell, "cell", Some(CallType::Cell)),     // 去直连
            (CallType::BaseViaCell, "base", None),              // 自名闸(TO 表="base")
            (CallType::BaseViaCell, "client", None),            // client 分支只认 BASE/CELL
        ];
        let client_via_cell: Row = [
            (CallType::ClientViaCell, "cell", Some(CallType::CellViaBase)),
            (CallType::ClientViaCell, "base", Some(CallType::BaseViaCell)),
            (CallType::ClientViaCell, "client", None),          // 自名闸
        ];
        let client_via_base: Row = [
            (CallType::ClientViaBase, "cell", Some(CallType::CellViaBase)),
            (CallType::ClientViaBase, "base", Some(CallType::BaseViaCell)),
            (CallType::ClientViaBase, "client", None),          // 自名闸
        ];
        for row in [cell, base, client, cell_via_base, base_via_cell, client_via_cell, client_via_base] {
            for (from, attr, expected) in row {
                assert_eq!(from.hop(attr), expected, "{from:?}.{attr}");
            }
        }
    }

    #[test]
    fn hop_preserves_class_and_unknown_stays_unknown() {
        // 同模块构造(entity_call.cpp:166)→ 类型保留;类未知保持未知,不猜。
        let known = EntityRef::Remote { class: Some("Avatar".into()), call: CallType::Cell };
        match known.hop_attr("base") {
            Some(EntityRef::Remote { class, call }) => {
                assert_eq!(class.as_deref(), Some("Avatar"));
                assert_eq!(call, CallType::BaseViaCell);
            }
            other => panic!("expected Remote, got {other:?}"),
        }
        let unknown = EntityRef::Remote { class: None, call: CallType::Base };
        assert_eq!(
            unknown.hop_attr("client"),
            Some(EntityRef::Remote { class: None, call: CallType::ClientViaBase }),
            "类未知必须保持 None,绝不伪造具体实体类(RPC-01 验收)"
        );
    }

    #[test]
    fn hop_only_on_remote() {
        // 本地引用/None 不发生 EntityCall 面跳(本地 self 角色绑定归 RPC-02)。
        let local = EntityRef::Local { class: Some("Avatar".into()) };
        assert_eq!(local.hop_attr("cell"), None);
        assert_eq!(EntityRef::None.hop_attr("cell"), None);
    }

    #[test]
    fn entity_call_field_acceptance_per_source() {
        // datatype.cpp:1484-1505:EntityCall/None/Entity 三者接受,其余拒。
        assert!(entity_call_field_accepts(ScriptValue::EntityCall));
        assert!(entity_call_field_accepts(ScriptValue::NoneLiteral));
        assert!(entity_call_field_accepts(ScriptValue::LocalEntity));
        assert!(!entity_call_field_accepts(ScriptValue::Other));
    }

    #[test]
    fn display_honest_unknown_class() {
        assert_eq!(
            EntityRef::Local { class: Some("Avatar".into()) }.display(),
            "Entity<Avatar>"
        );
        assert_eq!(
            EntityRef::Remote { class: Some("Avatar".into()), call: CallType::CellViaBase }
                .display(),
            "EntityCall<Avatar@cell>"
        );
        assert_eq!(
            EntityRef::Remote { class: None, call: CallType::ClientViaBase }.display(),
            "EntityCall<?@client>",
            "类未知以 ? 标注,不伪造具体类"
        );
        assert_eq!(EntityRef::None.display(), "None");
    }

    // ---- RPC-02:self 角色引用绑定 ----

    #[test]
    fn self_role_table_pinned_per_face() {
        let class = || Some("Avatar".to_string());
        // base 面:.cell=CELL / .client=CLIENT / .base 无(自身即 base 面)。
        assert_eq!(
            bind_self_role(ScriptFace::Base, "cell", Some("Avatar")),
            Some(SelfRoleBinding {
                reference: EntityRef::Remote { class: class(), call: CallType::Cell },
                none_possible: true,
                note: bind_self_role(ScriptFace::Base, "cell", Some("Avatar")).unwrap().note,
            })
        );
        assert_eq!(
            bind_self_role(ScriptFace::Base, "client", Some("Avatar"))
                .unwrap()
                .reference,
            EntityRef::Remote { class: class(), call: CallType::Client }
        );
        assert_eq!(bind_self_role(ScriptFace::Base, "base", Some("Avatar")), None);
        // cell 面:.base=BASE / .client=CLIENT_VIA_BASE(经 base 路由的陷阱钉)/
        // .cell 无(自身即 cell 面)。
        assert_eq!(
            bind_self_role(ScriptFace::Cell, "base", Some("Avatar")).unwrap().reference,
            EntityRef::Remote { class: class(), call: CallType::Base }
        );
        assert_eq!(
            bind_self_role(ScriptFace::Cell, "client", Some("Avatar")).unwrap().reference,
            EntityRef::Remote { class: class(), call: CallType::ClientViaBase },
            "cellapp 的 self.client 必是 CLIENT_VIA_BASE(onGetWitness 经 baseEntityCall() 读 .client 构造),不是直连 CLIENT"
        );
        assert_eq!(bind_self_role(ScriptFace::Cell, "cell", Some("Avatar")), None);
        // client 面:.base=BASE / .cell=CELL / .client 无(.clientapp 另物)。
        assert_eq!(
            bind_self_role(ScriptFace::Client, "base", Some("Avatar")).unwrap().reference,
            EntityRef::Remote { class: class(), call: CallType::Base }
        );
        assert_eq!(
            bind_self_role(ScriptFace::Client, "cell", Some("Avatar")).unwrap().reference,
            EntityRef::Remote { class: class(), call: CallType::Cell }
        );
        assert_eq!(bind_self_role(ScriptFace::Client, "client", Some("Avatar")), None);
    }

    #[test]
    fn self_role_non_role_attr_not_guessed() {
        // 非角色属性(方法/组件槽/内建)不产绑定,不猜。
        assert_eq!(bind_self_role(ScriptFace::Cell, "addObject", None), None);
        assert_eq!(bind_self_role(ScriptFace::Base, "weapon", None), None);
        assert_eq!(bind_self_role(ScriptFace::Client, "clientapp", None), None);
    }

    #[test]
    fn self_role_binding_none_possible_everywhere() {
        // 所有角色 getter 对 NULL → S_Return(None):绑定存在≠当前已绑定。
        for (face, attr) in [
            (ScriptFace::Base, "cell"),
            (ScriptFace::Base, "client"),
            (ScriptFace::Cell, "base"),
            (ScriptFace::Cell, "client"),
            (ScriptFace::Client, "base"),
            (ScriptFace::Client, "cell"),
        ] {
            let b = bind_self_role(face, attr, None).unwrap();
            assert!(b.none_possible, "{:?}.{}", face, attr);
            assert!(!b.note.is_empty(), "{:?}.{} 必须带构造点注记", face, attr);
        }
    }

    #[test]
    fn proven_forward_chains() {
        // 已证明转发链 = self 绑定(构造点)+ EntityCall 面跳(entity_call.cpp)复合。
        // cellapp:self.client(CLIENT_VIA_BASE).base → BASE_VIA_CELL(:149 else 臂)。
        let cell_client = bind_self_role(ScriptFace::Cell, "client", Some("Avatar")).unwrap();
        assert_eq!(
            cell_client.reference.hop_attr("base"),
            Some(EntityRef::Remote { class: Some("Avatar".into()), call: CallType::BaseViaCell })
        );
        // cellapp:self.client(CLIENT_VIA_BASE).cell → CELL_VIA_BASE("cell" 分支
        // 默认臂;TO 表[CLIENT_VIA_BASE]="client" 不挡 .cell——挡的是 .client)。
        assert_eq!(
            cell_client.reference.hop_attr("cell"),
            Some(EntityRef::Remote { class: Some("Avatar".into()), call: CallType::CellViaBase })
        );
        // 同句柄 .client → 自名闸(TO 表[CLIENT_VIA_BASE]="client")拒 → None。
        assert_eq!(cell_client.reference.hop_attr("client"), None);
        // baseapp:self.cell(CELL).client → CLIENT_VIA_CELL(:151-156 CELL 臂)。
        let base_cell = bind_self_role(ScriptFace::Base, "cell", Some("Avatar")).unwrap();
        assert_eq!(
            base_cell.reference.hop_attr("client"),
            Some(EntityRef::Remote { class: Some("Avatar".into()), call: CallType::ClientViaCell })
        );
        // baseapp:self.client(CLIENT).cell → CELL_VIA_BASE(:144 else 臂)。
        let base_client = bind_self_role(ScriptFace::Base, "client", Some("Avatar")).unwrap();
        assert_eq!(
            base_client.reference.hop_attr("cell"),
            Some(EntityRef::Remote { class: Some("Avatar".into()), call: CallType::CellViaBase })
        );
        // 不存在的链:baseapp self.cell 是 CELL,无 .cell(自名闸)。
        assert_eq!(base_cell.reference.hop_attr("cell"), None);
    }

    #[test]
    fn self_role_class_unknown_preserved() {
        let b = bind_self_role(ScriptFace::Cell, "client", None).unwrap();
        assert_eq!(
            b.reference,
            EntityRef::Remote { class: None, call: CallType::ClientViaBase },
            "脚本面在但实体类未知 → class 保持 None 不猜"
        );
        assert_eq!(b.reference.display(), "EntityCall<?@client>");
    }

    // ---- RPC-03:引用别名传播 ----

    fn cell_face() -> ScriptFace {
        ScriptFace::Cell
    }


    #[test]
    fn alias_keeps_entity_and_role() {
        // peer = self.cell 后保留实体/角色(RPC-03 验收首句;base 面 self.cell=CELL)。
        let mut t = AliasTable::default();
        t.apply("peer", AliasSource::SelfRole { attr: "cell".into() }, ScriptFace::Base, Some("Avatar"));
        assert_eq!(
            t.lookup("peer"),
            Some(&AliasValue::Ref(EntityRef::Remote {
                class: Some("Avatar".into()),
                call: CallType::Cell
            })),
            "别名必须保留实体与角色"
        );
    }

    #[test]
    fn alias_keeps_role_cellapp_client_via_base() {
        // cellapp 面的 peer = self.client → CLIENT_VIA_BASE 原样保留。
        let mut t = AliasTable::default();
        t.apply("peer", AliasSource::SelfRole { attr: "client".into() }, cell_face(), Some("Avatar"));
        assert_eq!(
            t.lookup("peer"),
            Some(&AliasValue::Ref(EntityRef::Remote {
                class: Some("Avatar".into()),
                call: CallType::ClientViaBase
            }))
        );
    }

    #[test]
    fn rebind_shadows_old_ref() {
        // 重绑定(含非引用形态)即遮蔽:旧引用不得再被查到。
        let mut t = AliasTable::default();
        t.apply("peer", AliasSource::SelfRole { attr: "client".into() }, cell_face(), Some("Avatar"));
        assert!(matches!(t.lookup("peer"), Some(AliasValue::Ref(_))));
        t.apply("peer", AliasSource::NonReference("字面量赋值:42".into()), cell_face(), Some("Avatar"));
        assert_eq!(
            t.lookup("peer"),
            Some(&AliasValue::Unknown("字面量赋值:42".into())),
            "重绑定后必须查到新值(未知),绝不回落旧引用"
        );
    }

    #[test]
    fn alias_copy_and_hop() {
        let mut t = AliasTable::default();
        t.apply("peer", AliasSource::SelfRole { attr: "client".into() }, cell_face(), Some("Avatar"));
        // p2 = peer → 同引用。
        t.apply("p2", AliasSource::LocalName { name: "peer".into() }, cell_face(), Some("Avatar"));
        assert_eq!(t.lookup("p2"), t.lookup("peer"));
        // base2 = peer.base → CLIENT_VIA_BASE + base → BASE_VIA_CELL(已证明链经别名)。
        t.apply("base2", AliasSource::LocalHop { name: "peer".into(), attr: "base".into() }, cell_face(), Some("Avatar"));
        assert_eq!(
            t.lookup("base2"),
            Some(&AliasValue::Ref(EntityRef::Remote {
                class: Some("Avatar".into()),
                call: CallType::BaseViaCell
            }))
        );
        // hop2 = p2.client → 自名闸(TO 表[CLIENT_VIA_BASE]="client")拒 → Unknown。
        t.apply("hop2", AliasSource::LocalHop { name: "p2".into(), attr: "client".into() }, cell_face(), Some("Avatar"));
        assert!(matches!(t.lookup("hop2"), Some(AliasValue::Unknown(_))), "面跳被闸拒 → 未知,不造调用类型");
    }

    #[test]
    fn unknown_receiver_not_guessed() {
        // 未知接收者不按同名方法猜对象:未绑定名/非引用来源 → Unknown。
        let mut t = AliasTable::default();
        t.apply("x", AliasSource::LocalName { name: "never_bound".into() }, cell_face(), None);
        assert_eq!(t.lookup("x"), Some(&AliasValue::Unknown("never_bound:未绑定,不猜".into())));
        // Unknown 上的取面传播保持 Unknown(原因不丢)。
        t.apply("y", AliasSource::LocalHop { name: "x".into(), attr: "base".into() }, cell_face(), None);
        assert_eq!(t.lookup("y"), Some(&AliasValue::Unknown("never_bound:未绑定,不猜".into())));
    }

    #[test]
    fn self_role_absent_on_face_is_unknown_not_ref() {
        // cell 面 self.cell 无此属性 → Unknown(该面无此角色属性),不是引用。
        let mut t = AliasTable::default();
        t.apply("peer", AliasSource::SelfRole { attr: "cell".into() }, cell_face(), Some("Avatar"));
        assert_eq!(
            t.lookup("peer"),
            Some(&AliasValue::Unknown("self.cell:该面无此角色属性".into()))
        );
    }

    #[test]
    fn merge_same_keeps_different_candidates() {
        // 合流:同值保留为 Ref;异值 → Candidates(顺序=分支序)。
        let mut a = AliasTable::default();
        let mut b = AliasTable::default();
        a.apply("peer", AliasSource::SelfRole { attr: "client".into() }, cell_face(), Some("Avatar"));
        b.apply("peer", AliasSource::SelfRole { attr: "client".into() }, cell_face(), Some("Avatar"));
        let m = AliasTable::merge(&a, &b);
        assert!(matches!(m.lookup("peer"), Some(AliasValue::Ref(_))), "同值合流保持 Ref 不升级候选");
        // 异值:peer=cell 面 self.client(CLIENT_VIA_BASE) vs base 面 self.cell(CELL)。
        let mut c = AliasTable::default();
        c.apply("peer", AliasSource::SelfRole { attr: "cell".into() }, ScriptFace::Base, Some("Avatar"));
        let m2 = AliasTable::merge(&a, &c);
        match m2.lookup("peer") {
            Some(AliasValue::Candidates(v)) => {
                assert_eq!(v.len(), 2);
                assert_eq!(v[0], EntityRef::Remote { class: Some("Avatar".into()), call: CallType::ClientViaBase });
                assert_eq!(v[1], EntityRef::Remote { class: Some("Avatar".into()), call: CallType::Cell });
            }
            other => panic!("异值合流必须成候选,got {other:?}"),
        }
    }

    #[test]
    fn merge_unknown_dominates_and_single_side_passes() {
        // 任一侧 Unknown → Unknown 吞并(候选∪任意=任意,不假装确定)。
        let mut a = AliasTable::default();
        let mut b = AliasTable::default();
        a.apply("peer", AliasSource::SelfRole { attr: "client".into() }, cell_face(), Some("Avatar"));
        b.apply("peer", AliasSource::NonReference("分支内重绑定为调用结果".into()), cell_face(), Some("Avatar"));
        let m = AliasTable::merge(&a, &b);
        assert_eq!(
            m.lookup("peer"),
            Some(&AliasValue::Unknown("分支内重绑定为调用结果".into()))
        );
        // 单侧绑定:另一侧未出现 → 原值通过(不因别的分支没绑而丢)。
        let m2 = AliasTable::merge(&a, &AliasTable::default());
        assert_eq!(m2.lookup("peer"), a.lookup("peer"));
    }

    #[test]
    fn candidates_hop_collects_per_candidate() {
        // 候选构造:分支 a(base 面)peer=self.cell → CELL;分支 b(cell 面)
        // peer=self.base → BASE,再 peer=peer.cell → CELL_VIA_BASE(BASE.cell
        // 路由臂)。合流双候选 [CELL, CELL_VIA_BASE]。
        let mut a = AliasTable::default();
        a.apply("peer", AliasSource::SelfRole { attr: "cell".into() }, ScriptFace::Base, Some("Avatar"));
        let mut b = AliasTable::default();
        b.apply("peer", AliasSource::SelfRole { attr: "base".into() }, ScriptFace::Cell, Some("Avatar"));
        b.apply("peer", AliasSource::LocalHop { name: "peer".into(), attr: "cell".into() }, ScriptFace::Cell, Some("Avatar"));
        let mut t = AliasTable::merge(&a, &b);
        match t.lookup("peer") {
            Some(AliasValue::Candidates(v)) => assert_eq!(v.len(), 2, "合流必须双候选"),
            other => panic!("期望合流双候选,got {other:?}"),
        }
        // 取面 .base:CELL.base → BASE_VIA_CELL、CELL_VIA_BASE.base → BASE(去直连):
        // 异值 → 保持双候选,不合并。
        t.apply("hop", AliasSource::LocalHop { name: "peer".into(), attr: "base".into() }, ScriptFace::Base, Some("Avatar"));
        match t.lookup("hop") {
            Some(AliasValue::Candidates(v)) => {
                assert_eq!(v.len(), 2);
                assert!(v.contains(&EntityRef::Remote { class: Some("Avatar".into()), call: CallType::Base }));
                assert!(v.contains(&EntityRef::Remote { class: Some("Avatar".into()), call: CallType::BaseViaCell }));
            }
            other => panic!("异 hop 结果必须保持候选,got {other:?}"),
        }
        // 单候选成功收敛:.client 上 CLIENT_VIA_BASE 自名闸拒、CELL.client →
        // CLIENT_VIA_CELL → 仅一路成功 → 确定 Ref。
        let mut c = AliasTable::default();
        let mut d = AliasTable::default();
        c.apply("peer", AliasSource::SelfRole { attr: "client".into() }, ScriptFace::Cell, Some("Avatar"));
        d.apply("peer", AliasSource::SelfRole { attr: "cell".into() }, ScriptFace::Base, Some("Avatar"));
        let mut t2 = AliasTable::merge(&c, &d);
        t2.apply("hop3", AliasSource::LocalHop { name: "peer".into(), attr: "client".into() }, ScriptFace::Cell, Some("Avatar"));
        assert_eq!(
            t2.lookup("hop3"),
            Some(&AliasValue::Ref(EntityRef::Remote {
                class: Some("Avatar".into()),
                call: CallType::ClientViaCell
            })),
            "全候选仅一路 hop 成功 → 收敛 Ref"
        );
    }
}
