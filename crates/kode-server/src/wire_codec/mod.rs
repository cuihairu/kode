//! def 驱动线格式编解码器(KBEngine 逐字节兼容,C-15)。
//!
//! message_table.rs 只给消息/属性/方法的 **编号表**(utype/别名 id/组件槽);
//! 本模块补 **字节级编解码**:Datatype 全集、属性更新流、方法调用参数、
//! 消息帧,全部小端(非网络序,memorystream_converter.h:43-48),与 KBEngine
//! 线格式逐字节兼容。黄金样本(`tests/golden/wire-parity.json`)为规范推导并
//! 带 `kbengine` 源 file:line provenance,`dump_wire_golden` 内置往返自校验。
//!
//! 分层:
//! - 纯位置编解码层 [`encode_value`]/[`decode_value`] + [`WireCursor`]:零 def 耦合,
//!   只按 [`WireLayout`] 走字节。标量定宽无 varint(memorystream.h L221-333);
//!   STRING=NUL 结尾无长度前缀(L224-229/L319-330,解码遇 NUL 或**非 ASCII** 停);
//!   UNICODE/BLOB/PYTHON*=uint32 LE 长度+字节(appendBlob memorystream.h:551)。
//! - def 名称解析层 [`WireSchema`]:结构重解析 `types.xml`/`alias.xml` 恢复
//!   FIXED_DICT 字段名与声明序(模型 `TypeNode::FixedDict.field_refs` 丢名折平
//!   <of> 不可用),[`WireSchema::resolve`] 按名取布局 + 环守卫。
//! - 高层入口:属性更新流、方法调用参数、消息帧(见各函数头注)。
//!
//! **PYTHON/PY_DICT/PY_TUPLE/PY_LIST 是不透明字节透传**:u32 长度框架,载荷是
//! `script::Pickler::pickle` 产物(datatype.cpp:1225/1288/1288,PyDict/Tuple/List
//! 继承 PythonType::addToStream 同一 pickle 路径)。kode 非 Python 运行时,
//! pickle 协议版本随嵌入 Python 构建而异(跨语言真实注意点)——本模块对
//! **u32 长度框架**逐字节负责,pickle 字节本身不透明透传。
//!
//! 全小端。`.def` schema 不上线(线上只有 utype/别名引用,entitydef.cpp 装配);
//! 畸形流一律 `Err`(不 panic),ARRAY 解码容忍流尽早停(datatype.cpp:1876-1884)。

mod bytes;
mod cursor;
mod errors;
mod golden;
mod hex;
mod message_frame;
mod method_args;
mod property_stream;
mod schema;
mod types;
mod values;

pub use cursor::WireCursor;
pub use errors::WireError;
pub use golden::{dump_wire_golden, GOLDEN_REL_PATH, SCHEMA_FIXTURE_XML};
pub use hex::{from_hex, to_hex};
pub use message_frame::{decode_message_frame, encode_message_frame};
pub use method_args::{decode_method_args, encode_method_args, MethodCall, MethodRef};
pub use property_stream::{
    decode_property_stream, encode_property_stream, BasePropUtype, EntityRef, EntityRefKind,
    PropKind, PropertyEntry, PropertyMode,
};
pub use schema::WireSchema;
pub use types::{EntityCallValue, WireField, WireLayout, WireValue};
pub use values::{decode_value, encode_value};
