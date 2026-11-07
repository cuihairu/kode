// ---------------------------------------------------------------------------
// 属性更新流(client_lib/entity.cpp:259-442;entity_macro.h:69-137)
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

use super::bytes::{push_le_u16, push_le_u32};
use super::cursor::WireCursor;
use super::errors::WireError;
use super::types::{WireLayout, WireValue};
use super::values::{decode_value, encode_value};

// ---------------------------------------------------------------------------
// 属性更新流(client_lib/entity.cpp:259-442;entity_macro.h:69-137)
// ---------------------------------------------------------------------------

/// 实体 id 编码:Full=i32(非别名/视图>255/entityAliasID 关);Alias=u8 视图别名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityRef {
    Full(i32),
    Alias(u8),
}

/// 实体 id 编码格式(与属性 id 模式**正交**;引擎由 `entityAliasID()` +
/// 视图大小决定,clientobjectbase.cpp:399-432)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityRefKind {
    Full,
    Alias,
}

impl EntityRefKind {
    pub fn of(r: &EntityRef) -> Self {
        match r {
            EntityRef::Full(_) => EntityRefKind::Full,
            EntityRef::Alias(_) => EntityRefKind::Alias,
        }
    }
}

/// 属性 id 编码模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PropertyMode {
    /// alias: parent/child 各 u8。
    Alias,
    /// utype: parent/child 各 u16。
    Utype,
}

/// 特殊基础属性 **utype 模式** id(alias 模式恒 1/2/3,本结构被忽略)。
/// 默认值来自 `messages_fixed_defaults.xml:387-402`(Property::position/
/// direction/spaceID → 40000/40001/40002);引擎经
/// `FixedMessages::isFixed("Property::...")` 读取(entity_macro.h:1503-1520)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasePropUtype {
    pub position: u16,
    pub direction: u16,
    pub space_id: u16,
}

impl Default for BasePropUtype {
    fn default() -> Self {
        BasePropUtype {
            position: 40000,
            direction: 40001,
            space_id: 40002,
        }
    }
}

/// 特殊基础属性 id 三元组(alias 模式固定 1/2/3 忽略 base;utype 模式用 base)。
fn special_ids(mode: PropertyMode, base: &BasePropUtype) -> (u16, u16, u16) {
    match mode {
        // ENTITY_BASE_PROPERTY_ALIASID_POSITION_XYZ/DIRECTION/SPACEID(common.h:118-120)。
        PropertyMode::Alias => (1, 2, 3),
        PropertyMode::Utype => (base.position, base.direction, base.space_id),
    }
}

/// 属性更新条目的载荷。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PropKind {
    /// POSITION(x,y,z 3×f32)。
    Position { x: f32, y: f32, z: f32 },
    /// DIRECTION(roll,pitch,yaw 3×f32)。
    Direction { roll: f32, pitch: f32, yaw: f32 },
    /// SPACEID(u32)。
    SpaceId(u32),
    /// 普通属性(布局 + 值)。
    Regular {
        layout: WireLayout,
        value: WireValue,
    },
}

/// 属性更新条目(parent/child id + 载荷)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyEntry {
    pub parent: u16,
    pub child: u16,
    pub kind: PropKind,
}

/// 编码属性更新流:ENTITY_ID + 各条目。条目的 parent/child id 与特殊属性载荷
/// 由调用方给出(special 条目须 parent==0 且 child=对应特殊 id)。
pub fn encode_property_stream(
    entity: EntityRef,
    mode: PropertyMode,
    entries: &[PropertyEntry],
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    match entity {
        EntityRef::Full(id) => push_le_u32(out, id as u32),
        EntityRef::Alias(alias) => out.push(alias),
    }
    for entry in entries {
        write_prop_ref(out, mode, entry.parent, entry.child)?;
        match &entry.kind {
            PropKind::Position { x, y, z } => {
                out.extend_from_slice(&x.to_le_bytes());
                out.extend_from_slice(&y.to_le_bytes());
                out.extend_from_slice(&z.to_le_bytes());
            }
            PropKind::Direction { roll, pitch, yaw } => {
                out.extend_from_slice(&roll.to_le_bytes());
                out.extend_from_slice(&pitch.to_le_bytes());
                out.extend_from_slice(&yaw.to_le_bytes());
            }
            PropKind::SpaceId(v) => push_le_u32(out, *v),
            PropKind::Regular { layout, value } => encode_value(layout, value, out)?,
        }
    }
    Ok(())
}

/// 解码属性更新流:ENTITY_ID + 各条目(parent==0&&child 特殊 → 隐式布局)。
/// 实体 id 格式由 [`EntityRefKind`] 独立给出(与属性 id 模式正交)。
pub fn decode_property_stream<F>(
    data: &[u8],
    entity_kind: EntityRefKind,
    mode: PropertyMode,
    base: &BasePropUtype,
    layout_of_child: F,
) -> Result<(EntityRef, Vec<PropertyEntry>), WireError>
where
    F: Fn(u16, u16) -> Result<WireLayout, WireError>,
{
    let mut cur = WireCursor::new(data);
    let entity = match entity_kind {
        EntityRefKind::Full => EntityRef::Full(cur.read_i32()?),
        EntityRefKind::Alias => EntityRef::Alias(cur.read_u8()?),
    };
    let mut entries = Vec::new();
    let (pos_id, dir_id, space_id) = special_ids(mode, base);
    while cur.remaining() > 0 {
        let (parent, child) = read_prop_ref(&mut cur, mode)?;
        let kind = if parent == 0 {
            match child {
                c if c == pos_id => PropKind::Position {
                    x: cur.read_f32()?,
                    y: cur.read_f32()?,
                    z: cur.read_f32()?,
                },
                c if c == dir_id => PropKind::Direction {
                    roll: cur.read_f32()?,
                    pitch: cur.read_f32()?,
                    yaw: cur.read_f32()?,
                },
                c if c == space_id => PropKind::SpaceId(cur.read_u32()?),
                c => {
                    let layout = layout_of_child(parent, c)?;
                    let value = decode_value(&layout, &mut cur)?;
                    PropKind::Regular { layout, value }
                }
            }
        } else {
            // 组件子属性(parent≠0):子属性 id → 布局由调用方经闭包映射。
            let layout = layout_of_child(parent, child)?;
            let value = decode_value(&layout, &mut cur)?;
            PropKind::Regular { layout, value }
        };
        entries.push(PropertyEntry {
            parent,
            child,
            kind,
        });
    }
    Ok((entity, entries))
}

fn write_prop_ref(
    out: &mut Vec<u8>,
    mode: PropertyMode,
    parent: u16,
    child: u16,
) -> Result<(), WireError> {
    match mode {
        PropertyMode::Alias => {
            if parent > u8::MAX as u16 || child > u8::MAX as u16 {
                return Err(WireError::AliasIdOverflow(parent.max(child)));
            }
            out.push(parent as u8);
            out.push(child as u8);
        }
        PropertyMode::Utype => {
            push_le_u16(out, parent);
            push_le_u16(out, child);
        }
    }
    Ok(())
}

fn read_prop_ref(cur: &mut WireCursor, mode: PropertyMode) -> Result<(u16, u16), WireError> {
    match mode {
        PropertyMode::Alias => Ok((u16::from(cur.read_u8()?), u16::from(cur.read_u8()?))),
        PropertyMode::Utype => Ok((cur.read_u16()?, cur.read_u16()?)),
    }
}
