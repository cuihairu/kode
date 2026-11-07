//! 消息 ID 映射:静态段(固定表)+ 项目覆盖段 + 动态导入段(PA-003
//! 「message ID 静态+动态映射」;PA-001 §5:三段合并模型,静态表在真实
//! 连接不成立——增量分配的 ID 只能从 onImportClientMessages 导入帧拿到)。

use kode_kbengine_schema::messages::{build_message_table, MessageLength, MessageTable};
use kode_kbengine_schema::wire::{builtin_wire_type, WireType};

use crate::codec::DecodeLimits;
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};

/// 单条消息规格(解码面)。
#[derive(Debug, Clone, PartialEq)]
pub struct MessageSpec {
    pub id: u16,
    pub name: String,
    pub length: MessageLength,
    pub args: Vec<WireType>,
}

/// id → 规格(含动态导入段;线程间传递用 owned 结构)。
#[derive(Debug, Clone, Default)]
pub struct MessageMap {
    by_id: std::collections::BTreeMap<u16, MessageSpec>,
    /// EntityDef 别名段(uid → 别名名;§6 步骤 10 alias section)。
    aliases: std::collections::BTreeMap<u16, String>,
}

impl MessageMap {
    /// 静态段:引擎固定默认表(+项目覆盖,由调用方在 MessageTable 已合并)。
    pub fn from_static(table: &MessageTable) -> Self {
        let mut map = MessageMap::default();
        for e in &table.entries {
            map.insert_spec(e.id, e.name.clone(), e.length);
            map.set_args(e.id, e.args.clone());
        }
        map
    }

    /// 从引擎固定默认 XML 直接构建(便捷入口)。
    pub fn from_defaults_xml(defaults_xml: &str, project_xml: Option<&str>) -> Self {
        Self::from_static(&build_message_table(defaults_xml, project_xml))
    }

    pub fn insert_spec(&mut self, id: u16, name: String, length: MessageLength) {
        let mut spec = MessageSpec {
            id,
            name,
            length,
            args: Vec::new(),
        };
        if let Some(old) = self.by_id.remove(&id) {
            spec.args = old.args;
        }
        self.by_id.insert(id, spec);
    }

    pub fn set_args(&mut self, id: u16, args: Vec<WireType>) {
        if let Some(spec) = self.by_id.get_mut(&id) {
            spec.args = args;
        }
    }

    pub fn by_id(&self, id: u16) -> Option<&MessageSpec> {
        self.by_id.get(&id)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// framing 用的(id → 长度规格)快照。
    pub fn clone_specs(&self) -> std::collections::BTreeMap<u16, MessageLength> {
        self.by_id.iter().map(|(id, s)| (*id, s.length)).collect()
    }

    /// EntityDef 导入的别名段(uid → 名;§6 步骤 10)。
    pub fn alias_by_uid(&self, uid: u16) -> Option<&str> {
        self.aliases.get(&uid).map(String::as_str)
    }

    /// 并入一条别名(onImportClientEntityDef alias section)。
    pub fn insert_alias(&mut self, uid: u16, name: String) {
        self.aliases.insert(uid, name);
    }
}

/// 动态导入摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSummary {
    pub count: u16,
    pub variable: u16,
    pub fixed: u16,
}

/// datatype2id(引擎 kbe/src/lib/server/common.cpp:20-70 实测表;
/// onImportClientMessages 的 argTypes 字段用)→ 线类型。
pub fn wire_type_from_datatype2id(id: u8) -> Option<WireType> {
    Some(match id {
        1 => WireType::String,
        2 => WireType::UInt8,
        3 => WireType::UInt16,
        4 => WireType::UInt32,
        5 => WireType::UInt64,
        6 => WireType::Int8,
        7 => WireType::Int16,
        8 => WireType::Int32,
        9 => WireType::Int64,
        10 => WireType::Python,
        11 => WireType::Blob,
        12 => WireType::Unicode,
        13 => WireType::Float,
        14 => WireType::Double,
        15 => WireType::Vector2,
        16 => WireType::Vector3,
        17 => WireType::Vector4,
        18 => WireType::Unresolved("FIXED_DICT (import-time shape unknown)".into()),
        19 => WireType::Unresolved("ARRAY (import-time element unknown)".into()),
        20 => WireType::EntityCall,
        _ => return None,
    })
}

/// 内建名 → datatype2id(构建测试/工具用)。
pub fn datatype2id_of(name: &str) -> Option<u8> {
    builtin_wire_type(name)?;
    Some(match name.to_ascii_uppercase().as_str() {
        "STRING" | "STD::STRING" => 1,
        "UINT8" => 2,
        "UINT16" => 3,
        "UINT32" => 4,
        "UINT64" => 5,
        "INT8" => 6,
        "INT16" => 7,
        "INT32" => 8,
        "INT64" => 9,
        "PYTHON" => 10,
        "BLOB" | "UINT8_ARRAY" => 11,
        "UNICODE" => 12,
        "FLOAT" => 13,
        "DOUBLE" => 14,
        "VECTOR2" => 15,
        "VECTOR3" => 16,
        "VECTOR4" => 17,
        _ => 0,
    })
}

impl MessageMap {
    /// 解析 onImportClientMessages 载荷并**并入本表**(§5.2;loginapp 返回
    /// ClientInterface+Loginapp exposed,baseapp 只返回 Baseapp exposed——
    /// 两进程表不同,所以按 Flow 各自应用一次)。
    ///
    /// 记录序(loginapp.cpp:1471-1481 写序 = JS kbengine.js:3841-3863 读序):
    /// `u16 count + count × { u16 msgID, i16 msgLen, str msgName,
    /// i8 argsType, u8 argsize, u8[argoutsize] }`。
    pub fn apply_import(
        &mut self,
        payload: &[u8],
        limits: &DecodeLimits,
    ) -> Result<ImportSummary, DecodeError> {
        let mut cur = Cursor::new(payload);
        let count = cur.read_u16()?;
        let mut summary = ImportSummary {
            count,
            variable: 0,
            fixed: 0,
        };
        for i in 0..count as usize {
            let path = format!("import[{i}]");
            let id = cur.read_u16()?;
            let msg_len = cur.read_i16()?;
            let name = cur.read_cstring()?;
            let _args_type = cur.read_i8()?;
            let arg_out_size = cur.read_u8()? as usize;
            let mut args = Vec::with_capacity(arg_out_size);
            for j in 0..arg_out_size {
                let tid = cur.read_u8()?;
                let _arg_path = format!("{path}.arg[{j}]");
                match wire_type_from_datatype2id(tid) {
                    Some(t) => args.push(t),
                    None => {
                        args.push(WireType::Unresolved(format!("datatype2id:{tid}")));
                    }
                }
            }
            let length = if msg_len < 0 {
                summary.variable += 1;
                MessageLength::Variable
            } else {
                summary.fixed += 1;
                MessageLength::Fixed(msg_len as u32)
            };
            self.insert_spec(id, name, length);
            self.set_args(id, args);
        }
        // 声明 count 有剩余未消费/中途断流:EOF 错误已由 read 抛出;此处
        // 额外哨兵——载荷必须恰好消费完(引擎定长块)。
        if !cur.at_end() {
            return Err(DecodeError::new(
                DecodeErrorKind::UnexpectedEof,
                cur.offset(),
                "import",
                format!("trailing {} bytes after {count} records", cur.remaining()),
            ));
        }
        let _ = limits;
        Ok(summary)
    }
}
