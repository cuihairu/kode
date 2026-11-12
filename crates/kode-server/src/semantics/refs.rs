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
//! 纯库面(无 RPC/无 TS 消费):self 角色引用的逐面绑定归 KSEM-RPC-02,
//! 方法/组件槽落点归 RPC-04;本模块只定引用类型代数。

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
}
