//! 版本兼容检查(todo PA-002「版本兼容检查」+ KSEM-SER-13「wire 布局兼容变化」)。
//!
//! [`check`]:判定为**不兼容**的变更(旧端解码新流会错位):
//! - 消息固定 ID 漂移 / 长度形状改变 / 参数线类型改变 / 消息消失;
//! - 别名线类型布局改变(展开后不相等);
//! - 实体属性线类型改变 / 增删 / 声明序漂移 / 旗标漂移;
//! - 实体方法增删 / 参数表漂移(三段各自比对,SER-13 补齐「Arg 布局」)。
//!
//! 判定为**兼容**的变更:新增消息 / 新增实体 / 新增别名 / 新增属性。
//!
//! [`check_classified`](SER-13):在 [`check`] 之上给每条变更挂
//! [`EngineGate`]——变更面是否进入引擎 defs-md5 聚合流决定分类:
//! **引擎握手实际拒绝**(md5 可见,混合部署 digest 不匹配即 shutDown,
//! 含纯新增——digest 是内容等值闸,不理解「兼容演进」)vs **静态不兼容
//! 风险**(md5 盲区,引擎不拦截,字节按旧布局静默重释)vs 无闸加性;
//! 并附 [`WireDiff`] 字段顺序/类型/参数位细节。两个布尔维度语义正交:
//! `wire_compatible`(full-redeploy 下旧端解码新流不破位)≠
//! `handshake_safe`(内部通道 digest 等值)。

use serde::{Deserialize, Serialize};

use crate::schema::Schema;
use crate::wire::WireType;

/// 实体方法段(SER-13:三段参数表各自比对)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MethodSegment {
    Base,
    Cell,
    Client,
}

impl MethodSegment {
    fn label(self) -> &'static str {
        match self {
            MethodSegment::Base => "base",
            MethodSegment::Cell => "cell",
            MethodSegment::Client => "client",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    MessageRemoved {
        name: String,
        old_id: u16,
    },
    MessageAdded {
        name: String,
        new_id: u16,
    },
    MessageIdChanged {
        name: String,
        old_id: u16,
        new_id: u16,
    },
    MessageLengthChanged {
        name: String,
    },
    MessageArgsChanged {
        name: String,
    },
    AliasChanged {
        name: String,
    },
    AliasRemoved {
        name: String,
    },
    EntityRemoved {
        name: String,
    },
    EntityAdded {
        name: String,
    },
    PropertyTypeChanged {
        entity: String,
        property: String,
    },
    PropertyAdded {
        entity: String,
        property: String,
        index: usize,
    },
    PropertyRemoved {
        entity: String,
        property: String,
        old_index: usize,
    },
    /// 声明序漂移(声明序 = wire 序,SER-02 §2;旧 check 按名匹配无视次序,
    /// SER-13 补齐验收「字段顺序」)。
    PropertyReordered {
        entity: String,
        property: String,
        old_index: usize,
        new_index: usize,
    },
    /// 同步旗标漂移(BASE_AND_CLIENT / ALL_CLIENTS / ...;md5 可见
    /// property.cpp:57 flags feed,且决定同步面)。
    PropertyFlagsChanged {
        entity: String,
        property: String,
        old: Vec<String>,
        new: Vec<String>,
    },
    MethodAdded {
        entity: String,
        segment: MethodSegment,
        method: String,
    },
    MethodRemoved {
        entity: String,
        segment: MethodSegment,
        method: String,
    },
    /// 方法参数表漂移(三段各自;md5 可见 method.cpp:66-67 逐参数 feed)。
    MethodArgsChanged {
        entity: String,
        segment: MethodSegment,
        method: String,
    },
    ConfigChanged {
        key: String,
        old: String,
        new: String,
    },
}

impl std::fmt::Display for Change {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Change::MessageRemoved { name, old_id } => {
                write!(f, "message removed: {name} (was id {old_id})")
            }
            Change::MessageAdded { name, new_id } => {
                write!(f, "message added: {name} (id {new_id})")
            }
            Change::MessageIdChanged {
                name,
                old_id,
                new_id,
            } => {
                write!(f, "message id changed: {name} {old_id} -> {new_id}")
            }
            Change::MessageLengthChanged { name } => {
                write!(f, "message length shape changed: {name}")
            }
            Change::MessageArgsChanged { name } => write!(f, "message args changed: {name}"),
            Change::AliasChanged { name } => write!(f, "alias layout changed: {name}"),
            Change::AliasRemoved { name } => write!(f, "alias removed: {name}"),
            Change::EntityRemoved { name } => write!(f, "entity removed: {name}"),
            Change::EntityAdded { name } => write!(f, "entity added: {name}"),
            Change::PropertyTypeChanged { entity, property } => {
                write!(f, "property type changed: {entity}.{property}")
            }
            Change::PropertyAdded {
                entity,
                property,
                index,
            } => {
                write!(f, "property added: {entity}.{property} (index {index})")
            }
            Change::PropertyRemoved {
                entity,
                property,
                old_index,
            } => {
                write!(
                    f,
                    "property removed: {entity}.{property} (was index {old_index})"
                )
            }
            Change::PropertyReordered {
                entity,
                property,
                old_index,
                new_index,
            } => {
                write!(
                    f,
                    "property reordered: {entity}.{property} (index {old_index} -> {new_index})"
                )
            }
            Change::PropertyFlagsChanged {
                entity,
                property,
                old,
                new,
            } => {
                write!(
                    f,
                    "property flags changed: {entity}.{property} {old:?} -> {new:?}"
                )
            }
            Change::MethodAdded {
                entity,
                segment,
                method,
            } => {
                write!(f, "method added: {}.{}.{}", entity, segment.label(), method)
            }
            Change::MethodRemoved {
                entity,
                segment,
                method,
            } => {
                write!(
                    f,
                    "method removed: {}.{}.{}",
                    entity,
                    segment.label(),
                    method
                )
            }
            Change::MethodArgsChanged {
                entity,
                segment,
                method,
            } => {
                write!(
                    f,
                    "method args changed: {}.{}.{}",
                    entity,
                    segment.label(),
                    method
                )
            }
            Change::ConfigChanged { key, old, new } => {
                write!(f, "config changed: {key} {old} -> {new}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompatReport {
    pub compatible: bool,
    pub old_hash: String,
    pub new_hash: String,
    pub changes: Vec<Change>,
}

/// old = 已发布 schema,new = 重算 schema。
pub fn check(old: &Schema, new: &Schema) -> CompatReport {
    let mut changes: Vec<Change> = Vec::new();

    if old.packet_always_contain_length != new.packet_always_contain_length {
        changes.push(Change::ConfigChanged {
            key: "packetAlwaysContainLength".into(),
            old: old.packet_always_contain_length.to_string(),
            new: new.packet_always_contain_length.to_string(),
        });
    }

    for m in &old.messages.entries {
        match new.messages.find(&m.name) {
            None => changes.push(Change::MessageRemoved {
                name: m.name.clone(),
                old_id: m.id,
            }),
            Some(nm) => {
                if nm.id != m.id {
                    changes.push(Change::MessageIdChanged {
                        name: m.name.clone(),
                        old_id: m.id,
                        new_id: nm.id,
                    });
                }
                if nm.length != m.length {
                    changes.push(Change::MessageLengthChanged {
                        name: m.name.clone(),
                    });
                }
                if nm.args != m.args {
                    changes.push(Change::MessageArgsChanged {
                        name: m.name.clone(),
                    });
                }
            }
        }
    }
    for m in &new.messages.entries {
        if old.messages.find(&m.name).is_none() {
            changes.push(Change::MessageAdded {
                name: m.name.clone(),
                new_id: m.id,
            });
        }
    }

    for (name, ty) in &old.aliases {
        match new.aliases.get(name) {
            None => changes.push(Change::AliasRemoved { name: name.clone() }),
            Some(n) if n != ty => changes.push(Change::AliasChanged { name: name.clone() }),
            _ => {}
        }
    }

    for (name, ent) in &old.entities {
        match new.entities.get(name) {
            None => changes.push(Change::EntityRemoved { name: name.clone() }),
            Some(ne) => {
                // 属性面:按名匹配;声明序即 wire 序(SER-02 §2),次序/旗标/
                // 增删逐项落账(md5 可见:property.cpp:53-64,SER-13)。
                for (oi, p) in ent.properties.iter().enumerate() {
                    match ne.properties.iter().position(|q| q.name == p.name) {
                        None => changes.push(Change::PropertyRemoved {
                            entity: name.clone(),
                            property: p.name.clone(),
                            old_index: oi,
                        }),
                        Some(ni) => {
                            let np = &ne.properties[ni];
                            if ni != oi {
                                changes.push(Change::PropertyReordered {
                                    entity: name.clone(),
                                    property: p.name.clone(),
                                    old_index: oi,
                                    new_index: ni,
                                });
                            }
                            if np.ty != p.ty {
                                changes.push(Change::PropertyTypeChanged {
                                    entity: name.clone(),
                                    property: p.name.clone(),
                                });
                            }
                            if np.flags != p.flags {
                                changes.push(Change::PropertyFlagsChanged {
                                    entity: name.clone(),
                                    property: p.name.clone(),
                                    old: p.flags.clone(),
                                    new: np.flags.clone(),
                                });
                            }
                        }
                    }
                }
                for (ni, np) in ne.properties.iter().enumerate() {
                    if !ent.properties.iter().any(|q| q.name == np.name) {
                        changes.push(Change::PropertyAdded {
                            entity: name.clone(),
                            property: np.name.clone(),
                            index: ni,
                        });
                    }
                }

                // 方法三段:参数表逐段比对(md5 可见:method.cpp:28-30/:66-67;
                // 旧 check 不比方法面,SER-13 补齐验收「Arg 布局」)。
                for (old_ms, new_ms, segment) in [
                    (
                        ent.base_methods.as_slice(),
                        ne.base_methods.as_slice(),
                        MethodSegment::Base,
                    ),
                    (
                        ent.cell_methods.as_slice(),
                        ne.cell_methods.as_slice(),
                        MethodSegment::Cell,
                    ),
                    (
                        ent.client_methods.as_slice(),
                        ne.client_methods.as_slice(),
                        MethodSegment::Client,
                    ),
                ] {
                    for om in old_ms {
                        match new_ms.iter().find(|m| m.name == om.name) {
                            None => changes.push(Change::MethodRemoved {
                                entity: name.clone(),
                                segment,
                                method: om.name.clone(),
                            }),
                            Some(nm) => {
                                if nm.args != om.args {
                                    changes.push(Change::MethodArgsChanged {
                                        entity: name.clone(),
                                        segment,
                                        method: om.name.clone(),
                                    });
                                }
                            }
                        }
                    }
                    for nm in new_ms {
                        if !old_ms.iter().any(|m| m.name == nm.name) {
                            changes.push(Change::MethodAdded {
                                entity: name.clone(),
                                segment,
                                method: nm.name.clone(),
                            });
                        }
                    }
                }
            }
        }
    }
    for name in new.entities.keys() {
        if !old.entities.contains_key(name) {
            changes.push(Change::EntityAdded { name: name.clone() });
        }
    }

    let compatible = changes.iter().all(|c| {
        matches!(
            c,
            Change::MessageAdded { .. } | Change::EntityAdded { .. } | Change::EntityRemoved { .. }
        )
    });

    CompatReport {
        compatible,
        old_hash: old.hash_hex(),
        new_hash: new.hash_hex(),
        changes,
    }
}

// ---------------------------------------------------------------------------
// SER-13:引擎握手分类(静态不兼容风险 vs 引擎握手实际拒绝)+ wire 细节
// ---------------------------------------------------------------------------

/// 变更落入的引擎面(SER-13 验收:区分静态不兼容风险和引擎握手实际拒绝条件)。
///
/// 判据 = 变更面是否进入引擎 defs-md5 聚合流(feed 锚,KBEngine bf1a9cd6):
/// - 属性:property.cpp:53-64(名/默认串/类型名/utype/flags/persistent/
///   identifier/databaseLength/detailLevel/datatype uid);
/// - 方法:method.cpp:28-30(名/utype/exposed)+ :50(setExposed 追加)
///   + :66-67(逐参数 datatype uid,**追加序 = 参数序**);
/// - 数据类型:datatype.cpp:95-96(注册名/uid)、:1716/:1782/:2097
///   (FIXED_DICT/FixedArray 逐字段 uid+型名,**追加序 = 声明序**);
/// - final:entitydef.cpp:243;握手:entity_app.h:1250-1257——digest 不匹配
///   即 ERROR_MSG + `shutDown()`,仅内部通道(isExternal 早退),digest 由
///   dbmgr 分发(sync_app_datas_handler.cpp:97,含 3 秒注册等待闸)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineGate {
    /// defs-md5 可见:混合部署必被握手拒绝——**含纯新增**(digest 是内容
    /// 等值闸,不理解「兼容演进」;旧 `compatible` 把 EntityAdded/Removed
    /// 记为兼容是 wire 维度,不是握手维度)。full-redeploy 下另看
    /// `wire_compatible` 维度。
    HandshakeRejected,
    /// md5 盲区但 wire 可见:引擎不拦截,混合部署照常启动,字节按旧布局
    /// 重释(固定消息表 id/长度/参数、引擎配置属 config 层,不入 defs
    /// 聚合流)——**最危险类:无任何运行时防线**。
    SilentRisk,
    /// md5 盲区且 wire 加性:新增固定消息,旧端不认识新 id,不重释旧字节。
    UnGated,
}

impl std::fmt::Display for EngineGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineGate::HandshakeRejected => write!(f, "handshake-rejected"),
            EngineGate::SilentRisk => write!(f, "silent-risk"),
            EngineGate::UnGated => write!(f, "ungated"),
        }
    }
}

/// 单条变更 → 引擎握手面分类(判据见 [`EngineGate`] 模块锚)。
pub fn classify(change: &Change) -> EngineGate {
    match change {
        Change::PropertyTypeChanged { .. }
        | Change::PropertyAdded { .. }
        | Change::PropertyRemoved { .. }
        | Change::PropertyReordered { .. }
        | Change::PropertyFlagsChanged { .. }
        | Change::MethodAdded { .. }
        | Change::MethodRemoved { .. }
        | Change::MethodArgsChanged { .. }
        | Change::AliasChanged { .. }
        | Change::AliasRemoved { .. }
        | Change::EntityRemoved { .. }
        | Change::EntityAdded { .. } => EngineGate::HandshakeRejected,
        Change::MessageRemoved { .. }
        | Change::MessageIdChanged { .. }
        | Change::MessageLengthChanged { .. }
        | Change::MessageArgsChanged { .. }
        | Change::ConfigChanged { .. } => EngineGate::SilentRisk,
        Change::MessageAdded { .. } => EngineGate::UnGated,
    }
}

/// wire 细节差异(SER-13 验收:字段顺序 / 类型 / Arg 布局逐位落账)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireDiff {
    /// FIXED_DICT 同名字段声明序漂移(声明序 = wire 序,SER-02 §2):
    /// 即使各字段类型全同,字节重读也错位。
    FieldReordered {
        path: String,
        field: String,
        old_index: usize,
        new_index: usize,
    },
    /// 叶子线类型漂移(display_name 计;path = 别名或 `别名.字段` 叶位)。
    FieldTypeChanged {
        path: String,
        old: String,
        new: String,
    },
    FieldAdded {
        path: String,
        field: String,
        index: usize,
    },
    FieldRemoved {
        path: String,
        field: String,
        old_index: usize,
    },
    /// 参数按位比较:同位线类型漂移(位置即语义)。
    ArgChanged {
        path: String,
        index: usize,
        old: String,
        new: String,
    },
    ArgAdded {
        path: String,
        index: usize,
    },
    ArgRemoved {
        path: String,
        index: usize,
    },
}

/// 两条线类型的布局差异:FIXED_DICT 按名匹配(序差 = [`WireDiff::FieldReordered`],
/// 类型差递归下钻);ARRAY 元素差下钻 `path[]`;叶子按 [`WireType::display_name`]。
pub fn diff_wire_type(path: &str, old: &WireType, new: &WireType) -> Vec<WireDiff> {
    let mut out = Vec::new();
    diff_type(path, old, new, &mut out);
    out
}

fn diff_type(path: &str, old: &WireType, new: &WireType, out: &mut Vec<WireDiff>) {
    if old == new {
        return;
    }
    match (old, new) {
        (
            WireType::FixedDict {
                fields: of,
                module: _,
            },
            WireType::FixedDict {
                fields: nf,
                module: _,
            },
        ) => {
            for (oi, f) in of.iter().enumerate() {
                match nf.iter().position(|g| g.name == f.name) {
                    None => out.push(WireDiff::FieldRemoved {
                        path: path.to_string(),
                        field: f.name.clone(),
                        old_index: oi,
                    }),
                    Some(ni) => {
                        if ni != oi {
                            out.push(WireDiff::FieldReordered {
                                path: path.to_string(),
                                field: f.name.clone(),
                                old_index: oi,
                                new_index: ni,
                            });
                        }
                        diff_type(&format!("{path}.{}", f.name), &f.ty, &nf[ni].ty, out);
                    }
                }
            }
            for (ni, g) in nf.iter().enumerate() {
                if !of.iter().any(|f| f.name == g.name) {
                    out.push(WireDiff::FieldAdded {
                        path: path.to_string(),
                        field: g.name.clone(),
                        index: ni,
                    });
                }
            }
        }
        (WireType::Array { of: oe }, WireType::Array { of: ne }) => {
            diff_type(&format!("{path}[]"), oe, ne, out);
        }
        _ => out.push(WireDiff::FieldTypeChanged {
            path: path.to_string(),
            old: old.display_name(),
            new: new.display_name(),
        }),
    }
}

/// 参数表按位差异(位置即语义;path = 消息名或 `实体.段.方法`)。
fn diff_args(path: &str, old: &[WireType], new: &[WireType], out: &mut Vec<WireDiff>) {
    for i in 0..old.len().min(new.len()) {
        if old[i] != new[i] {
            out.push(WireDiff::ArgChanged {
                path: path.to_string(),
                index: i,
                old: old[i].display_name(),
                new: new[i].display_name(),
            });
        }
    }
    for i in old.len().min(new.len())..new.len() {
        out.push(WireDiff::ArgAdded {
            path: path.to_string(),
            index: i,
        });
    }
    for i in new.len().min(old.len())..old.len() {
        out.push(WireDiff::ArgRemoved {
            path: path.to_string(),
            index: i,
        });
    }
}

/// 实体指定段的方法参数表(不存在实体/方法 → None)。
fn method_args<'a>(
    entity: Option<&'a crate::schema::EntityWireInfo>,
    segment: MethodSegment,
    method: &str,
) -> Option<&'a [WireType]> {
    let e = entity?;
    let m = match segment {
        MethodSegment::Base => e.base_methods.iter().find(|m| m.name == method),
        MethodSegment::Cell => e.cell_methods.iter().find(|m| m.name == method),
        MethodSegment::Client => e.client_methods.iter().find(|m| m.name == method),
    }?;
    Some(&m.args)
}

/// 带分类的单条变更:变更本体 + 引擎握手面 + wire 细节。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClassifiedChange {
    pub change: Change,
    pub gate: EngineGate,
    pub wire_diffs: Vec<WireDiff>,
}

/// SER-13 面向报告:[`check`] 之上加引擎握手分类与 wire 细节。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutCompatReport {
    /// [`check`] 的 `compatible` 同口径:full-redeploy 语义下旧端解码新流
    /// 不破位。**不是**握手判定——见 `handshake_safe`。
    pub wire_compatible: bool,
    /// 引擎内部通道握手面:任何 [`EngineGate::HandshakeRejected`] 变更即
    /// false(含纯新增);零差异才 true。客户端/bots 走外部通道不吃此闸
    /// (isExternal 早退),静态比对是那侧唯一防线。
    pub handshake_safe: bool,
    /// 版本维度:canonical JSON SHA-256 工具指纹(旧/新)——相同指纹
    /// ⇔ canonical 内容字节级一致;**不是**引擎 defs-md5(见 `note`)。
    pub old_hash: String,
    pub new_hash: String,
    pub classified: Vec<ClassifiedChange>,
    pub note: String,
}

/// 报告诚实声明:分类判据锚 + hash 性质 + 外部通道口径。
pub const COMPAT_HONESTY_NOTE: &str = "分类依据引擎 defs-md5 聚合流(feed 锚:property.cpp:53-64 / method.cpp:28-30,50,66-67 / datatype.cpp:95-96,1716,1782,2097;final entitydef.cpp:243;握手 entity_app.h:1250-1257 仅内部通道,digest 由 dbmgr 分发 sync_app_datas_handler.cpp:97)。hash 为 canonical JSON SHA-256 工具指纹,非引擎 defs-md5,握手以引擎自身聚合为准;客户端走外部通道不吃此闸,静态比对是那侧唯一防线。";

/// old = 已发布 schema,new = 重算 schema。
pub fn check_classified(old: &Schema, new: &Schema) -> LayoutCompatReport {
    let report = check(old, new);
    let mut classified = Vec::with_capacity(report.changes.len());
    for change in &report.changes {
        let wire_diffs = match change {
            Change::AliasChanged { name } => match (old.aliases.get(name), new.aliases.get(name)) {
                (Some(o), Some(n)) => diff_wire_type(name, o, n),
                _ => Vec::new(),
            },
            Change::PropertyTypeChanged { entity, property } => {
                let old_ty = old
                    .entities
                    .get(entity)
                    .and_then(|e| e.properties.iter().find(|p| p.name == property.as_str()))
                    .map(|p| &p.ty);
                let new_ty = new
                    .entities
                    .get(entity)
                    .and_then(|e| e.properties.iter().find(|p| p.name == property.as_str()))
                    .map(|p| &p.ty);
                match (old_ty, new_ty) {
                    (Some(o), Some(n)) => diff_wire_type(&format!("{entity}.{property}"), o, n),
                    _ => Vec::new(),
                }
            }
            Change::MethodArgsChanged {
                entity,
                segment,
                method,
            } => {
                match (
                    method_args(old.entities.get(entity), *segment, method),
                    method_args(new.entities.get(entity), *segment, method),
                ) {
                    (Some(o), Some(n)) => {
                        let mut out = Vec::new();
                        diff_args(
                            &format!("{entity}.{}.{}", segment.label(), method),
                            o,
                            n,
                            &mut out,
                        );
                        out
                    }
                    _ => Vec::new(),
                }
            }
            Change::MessageArgsChanged { name } => {
                match (old.messages.find(name), new.messages.find(name)) {
                    (Some(o), Some(n)) => {
                        let mut out = Vec::new();
                        diff_args(name, &o.args, &n.args, &mut out);
                        out
                    }
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        };
        let gate = classify(change);
        classified.push(ClassifiedChange {
            change: change.clone(),
            gate,
            wire_diffs,
        });
    }
    let handshake_safe = !classified
        .iter()
        .any(|c| c.gate == EngineGate::HandshakeRejected);
    LayoutCompatReport {
        wire_compatible: report.compatible,
        handshake_safe,
        old_hash: old.hash_hex(),
        new_hash: new.hash_hex(),
        classified,
        note: COMPAT_HONESTY_NOTE.to_string(),
    }
}
