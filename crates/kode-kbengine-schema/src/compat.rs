//! 版本兼容检查(todo PA-002「版本兼容检查」)。
//!
//! 判定为**不兼容**的变更(旧端解码新流会错位):
//! - 消息固定 ID 漂移 / 长度形状改变 / 参数线类型改变 / 消息消失;
//! - 别名线类型布局改变(展开后不相等);
//! - 实体属性线类型改变(同名属性类型不一致)。
//!
//! 判定为**兼容**的变更:新增消息 / 新增实体 / 新增别名 / 新增属性。

use serde::{Deserialize, Serialize};

use crate::schema::Schema;

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
                for p in &ent.properties {
                    if let Some(np) = ne.properties.iter().find(|q| q.name == p.name) {
                        if np.ty != p.ty {
                            changes.push(Change::PropertyTypeChanged {
                                entity: name.clone(),
                                property: p.name.clone(),
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
