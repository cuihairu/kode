//! C-18 KBEngine 官方 def MD5(`EntityDef::md5()`)重放器。
//!
//! 目标:与引擎对同一资产计算出的复合 md5 **逐字节一致**。引擎在 def 装载
//! 管线中把结构化字节流喂入静态 `KBE_MD5`(entitydef.cpp:32/243),字符串=
//! 裸字节无定界、数值=原生小端;本模块按引擎执行序重放同一字节流。
//!
//! 溯源(本地 kbengine HEAD 732b389):
//! - 内建类型构造序:datatypes.cpp:53-83(21 项,uid 计数器 1 起:datatype.cpp:24);
//! - DataType 构造=aliasName(构造期恒空,0 字节)+uid u16:datatype.cpp:86-97
//!   ——别名注册后置(`aliasName(name)` 不再入流),标量别名不构造新类型;
//! - FixedArrayType::initialize=[元素 uid u16]+[元素 strType]:datatype.cpp:1715-1717;
//! - FixedDictType 每键=[uid u16]+[strType]+[键名]+[persistent 1B]+[databaseLength u32]
//!   (ARRAY 键同形,先入嵌套构造字节):datatype.cpp:2096-2149;
//!   implementedBy(非空才):datatype.cpp:2183-2184;
//! - PropertyDescription 构造=[name]+[Default]+[Type 裸文本]+[utype u16]+[flags u32]
//!   +[persistent 1B]+[identifier 1B]+[databaseLength u32]+[detailLevel i8]+[类型 uid u16]
//!   :property.cpp:53-64;ENTITYCALL 持久覆盖:property.cpp:48;
//! - MethodDescription 构造=[name]+[utype 恒 0(setUType 不再入流:method.inl:16-19)]+
//!   [exposedType 4B]:method.cpp:28-30;每实参=[uid u16]+[exposedType 4B]:method.cpp:65-67;
//!   `<Exposed/>`→[exposedType 4B]:method.cpp:50(文档序决定实参带的 exposed 值;
//!   ClientMethods 无 Exposed 分支:entitydef.cpp:1602-1666);
//! - ScriptDefModule 构造=模块名:scriptdef_module.cpp:60(uType 不入流);
//! - 装载序=loadAllDefDescriptions(Properties→Cell→Base→Client:entitydef.cpp:927-964)
//!   →loadInterfaces(递归,非 message_table 单层:entitydef.cpp:551-639)
//!   →loadComponents(未注册过才 registerNewScriptDefModule:entitydef.cpp:642-818;
//!   组件属性字节=[EntityComponentType uid]+PropertyDescription("EntityComponent"),
//!   flags 由组件 hasBase/hasCell/hasClient 推导:entitydef.cpp:793-808/821-843)
//!   →loadParentClass(递归 loadDefInfo:entitydef.cpp:890-924)
//!   →autoMatchCompOwn(entities.xml 条目存在才追 3×int32 hasClient/hasCell/hasBase,
//!   缺省 -1、有值 1/0:scriptdef_module.cpp:341-397;组件模块早退:304-331);
//! - 属性 utype 自动计数器 g_propertyUtypeAuto(1 起,占用即前进,显式 `<Utype>`
//!   入 g_propertyUtypes 占号):entitydef.cpp:45/1018-1093;
//! - MD5 输出大写 32hex:md5.cpp:65-72(`"%2.2X"`)。
//!
//! IDE 内部 sha256/semanticHash 双轨(hotReloadDefHash/hotReloadStructure)是
//! 另一套体系,本模块不触碰;引擎互通只此一份实现(Rust 权威,无 TS 镜像)。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use kode_parser::xml::{parse as parse_xml, Document, NodeData};
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

// ===========================================================================
// MD5(RFC 1321,手写:无新依赖红线)
// ===========================================================================

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/// RFC 1321 MD5(镜像引擎 OpenSSL MD5;输出小端 digest)。
#[derive(Clone, Debug)]
pub struct Md5 {
    state: [u32; 4],
    buffer: [u8; 64],
    buffered: usize,
    total: u64,
}

impl Md5 {
    pub fn new() -> Self {
        Md5 {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            buffer: [0u8; 64],
            buffered: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        if self.buffered > 0 {
            let need = 64 - self.buffered;
            let take = need.min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.process_block(&block);
                self.buffered = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.process_block(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buffer[self.buffered..self.buffered + data.len()].copy_from_slice(data);
            self.buffered += data.len();
        }
    }

    pub fn finalize(mut self) -> [u8; 16] {
        let bit_len = self.total.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffered != 56 {
            self.update(&[0x00]);
        }
        self.update(&bit_len.to_le_bytes());
        let mut out = [0u8; 16];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        out
    }

    fn process_block(&mut self, block: &[u8; 64]) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) =
            (self.state[0], self.state[1], self.state[2], self.state[3]);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let sum = a
                .wrapping_add(f)
                .wrapping_add(MD5_K[i])
                .wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(MD5_S[i]));
            a = tmp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }
}

impl Default for Md5 {
    fn default() -> Self {
        Self::new()
    }
}

// ===========================================================================
// 字节流构建器(带溯源踪迹,golden 可审计)
// ===========================================================================

/// 单段 append 的溯源记录(字段名+引擎 file:line+字节 hex)。
#[derive(Clone, Debug)]
pub struct TraceEntry {
    pub field: String,
    pub source: String,
    pub bytes_hex: String,
}

/// def MD5 字节流:喂 MD5 的同时镜像留痕。
#[derive(Clone, Debug)]
pub struct DefMd5Stream {
    md5: Md5,
    bytes: Vec<u8>,
    trace: Vec<TraceEntry>,
}

impl DefMd5Stream {
    pub fn new() -> Self {
        DefMd5Stream {
            md5: Md5::new(),
            bytes: Vec::new(),
            trace: Vec::new(),
        }
    }

    fn append(&mut self, field: &str, source: &str, data: &[u8]) {
        self.md5.update(data);
        self.bytes.extend_from_slice(data);
        self.trace.push(TraceEntry {
            field: field.to_string(),
            source: source.to_string(),
            bytes_hex: to_hex(data),
        });
    }

    /// 引擎裸字符串(无长度前缀无 NUL)。
    pub fn append_str(&mut self, field: &str, source: &str, s: &str) {
        self.append(field, source, s.as_bytes());
    }

    pub fn append_u16(&mut self, field: &str, source: &str, v: u16) {
        self.append(field, source, &v.to_le_bytes());
    }

    pub fn append_u32(&mut self, field: &str, source: &str, v: u32) {
        self.append(field, source, &v.to_le_bytes());
    }

    pub fn append_i32(&mut self, field: &str, source: &str, v: i32) {
        self.append(field, source, &v.to_le_bytes());
    }

    pub fn append_bool(&mut self, field: &str, source: &str, v: bool) {
        // C++ sizeof(bool)=1。
        self.append(field, source, &[v as u8]);
    }

    pub fn stream_hex(&self) -> String {
        to_hex(&self.bytes)
    }

    pub fn finish(self) -> DefMd5Result {
        let digest = self.md5.clone().finalize();
        DefMd5Result {
            md5_hex: to_hex(&digest).to_uppercase(),
            stream_hex: to_hex(&self.bytes),
            trace: self.trace,
        }
    }
}

impl Default for DefMd5Stream {
    fn default() -> Self {
        Self::new()
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

// ===========================================================================
// 重放器
// ===========================================================================

/// 内建类型构造序(datatypes.cpp:56-79)。
pub const BUILTIN_TYPE_ORDER: [&str; 21] = [
    "UINT8", "UINT16", "UINT64", "UINT32", "INT8", "INT16", "INT32", "INT64", "STRING", "UNICODE",
    "FLOAT", "DOUBLE", "PYTHON", "PY_DICT", "PY_TUPLE", "PY_LIST", "ENTITYCALL", "BLOB", "VECTOR2",
    "VECTOR3", "VECTOR4",
];

/// Flags 字符串→原始位掩码(entitydef.cpp:161-174,输入先 toUpper)。
pub fn flags_value(name_upper: &str) -> Option<u32> {
    match name_upper {
        "CELL" => Some(0x0000_0001),
        "CELL_PUBLIC" => Some(0x0000_0001),
        "CELL_PRIVATE" => Some(0x0000_0002),
        "CELL_AND_CLIENT" => Some(0x0000_0008),
        "CELL_AND_CLIENTS" => Some(0x0000_0004),
        "CELL_AND_OTHER_CLIENTS" => Some(0x0000_0080),
        "CELL_PUBLIC_AND_OWN" => Some(0x0000_0008),
        "ALL_CLIENTS" => Some(0x0000_0004),
        "OTHER_CLIENTS" => Some(0x0000_0080),
        "OWN_CLIENT" => Some(0x0000_0010),
        "BASE_AND_CLIENT" => Some(0x0000_0020),
        "BASE" => Some(0x0000_0040),
        _ => None,
    }
}

const ENTITY_BASE_DATA_FLAGS: u32 = 0x0060; // BASE | BASE_AND_CLIENT
const ENTITY_CELL_DATA_FLAGS: u32 = 0x009f;
const ENTITY_CLIENT_DATA_FLAGS: u32 = 0x00bc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TypeKind {
    Builtin,
    Array,
    Dict,
    EntityComponent,
}

#[derive(Clone, Debug)]
struct TypeInfo {
    /// 最后一次注册名(getName();别名注册会覆盖,datatypes.cpp:194)。
    alias_name: String,
    kind: TypeKind,
    /// Array 的元素类型 id(FixedArrayType::getDataType)。
    element: Option<u16>,
}

#[derive(Default)]
struct DataTypesState {
    /// _g_dataTypeUID(datatype.cpp:24,1 起;finalise 重置:108)。
    next_uid: u16,
    by_name: HashMap<String, u16>,
    info: HashMap<u16, TypeInfo>,
}

impl DataTypesState {
    fn new() -> Self {
        DataTypesState {
            next_uid: 1,
            by_name: HashMap::new(),
            info: HashMap::new(),
        }
    }

    /// DataType 构造:aliasName 构造期恒空(0 字节)+uid u16(datatype.cpp:86-97)。
    fn construct(&mut self, stream: &mut DefMd5Stream, kind: TypeKind, field: &str) -> u16 {
        let id = self.next_uid;
        self.next_uid += 1;
        stream.append_u16(field, "datatype.cpp:95-96 (DataType ctor)", id);
        self.info.insert(
            id,
            TypeInfo {
                alias_name: String::new(),
                kind,
                element: None,
            },
        );
        id
    }

    /// addDataType(name, dt):别名注册(aliasName 后置,不入流;datatypes.cpp:190-218)。
    fn register(&mut self, name: &str, id: u16) {
        self.by_name.insert(name.to_string(), id);
        if let Some(info) = self.info.get_mut(&id) {
            info.alias_name = name.to_string();
        }
    }

    fn lookup(&self, name: &str) -> Option<u16> {
        self.by_name.get(name).copied()
    }

    /// 该类型是否(或其数组元素链是否)ENTITYCALL(datatype.cpp:2104/2141 的判定)。
    fn is_entitycall(&self, id: u16) -> bool {
        match self.info.get(&id) {
            Some(info) => match info.kind {
                TypeKind::Array => {
                    info.element.map(|e| self.is_entitycall(e)).unwrap_or(false)
                }
                _ => info.alias_name == "ENTITYCALL" && info.kind == TypeKind::Builtin,
            },
            None => false,
        }
    }
}

/// 模块的域位与 exposed 计数(组件 flags 推导用,entitydef.cpp:793-808)。
#[derive(Clone, Default)]
struct ModuleState {
    has_base: bool,
    has_cell: bool,
    has_client: bool,
    base_exposed_methods: usize,
    cell_exposed_methods: usize,
    /// isComponentModule(scriptdef_module.cpp:304 早退判定)。
    is_component: bool,
}

/// 计算入参(镜像 message_table 输入形态;componentScripts 为可选的
/// `{"base:Name","cell:Name"}` 存在集——组件 autoMatchCompOwn 的脚本探测面,
/// 对应引擎 scripts/{base,cell}/components/<Name>.py 存在性)。
#[derive(Clone, Debug, Default)]
pub struct DefMd5Params {
    pub types_xml: String,
    pub entities_xml: String,
    /// 实体/接口/组件名→def 原文(接口/组件按名取,目录结构不参与)。
    pub defs: HashMap<String, String>,
    pub alias_xml: String,
    pub component_scripts: HashSet<String>,
}

#[derive(Debug)]
pub struct DefMd5Result {
    pub md5_hex: String,
    pub stream_hex: String,
    pub trace: Vec<TraceEntry>,
}

impl DefMd5Result {
    pub fn to_json(&self) -> Value {
        json!({
            "md5": self.md5_hex,
            "algorithm": "md5",
            "streamHex": self.stream_hex,
            "trace": self.trace.iter().map(|t| json!({
                "field": t.field,
                "source": t.source,
                "bytes": t.bytes_hex,
            })).collect::<Vec<_>>(),
        })
    }
}

/// XML 助手:引擎 getValStr=首文本子节点 kbe_trim(xml.cpp:121-128)。
fn first_text(doc: &Document, el: usize) -> String {
    let element = doc.element(el);
    for &child in &element.children {
        if let NodeData::Text { decoded, .. } = &doc.nodes[child].data {
            return decoded
                .trim_matches(|c: char| c.is_ascii_whitespace())
                .to_string();
        }
    }
    String::new()
}

/// 引擎 enterNode(node,key)≈父元素的具名子元素(xml.cpp:60-88)。
fn child_el(doc: &Document, parent: usize, key: &str) -> Option<usize> {
    doc.child_elements(parent)
        .into_iter()
        .find(|&c| doc.element(c).name == key)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MethodDomain {
    Cell,
    Base,
    Client,
}

struct Replayer {
    stream: DefMd5Stream,
    types: DataTypesState,
    types_xml_text: String,
    entities_text: String,
    defs: HashMap<String, String>,
    component_scripts: HashSet<String>,
    /// entities.xml 条目名→(hasClient,hasCell,hasBase)属性值(缺省 -1)。
    entities_attrs: HashMap<String, (i32, i32, i32)>,
    /// 已完成 def 装载的模块名(loadComponents 的 findScriptModule 判定)。
    loaded_modules: HashSet<String>,
    modules: HashMap<String, ModuleState>,
    /// g_propertyUtypeAuto/g_propertyUtypes(entitydef.cpp:45/1018-1093)。
    prop_utype_auto: u16,
    prop_utypes: Vec<u16>,
}

impl Replayer {
    fn new(params: DefMd5Params) -> Result<Self, String> {
        let mut entities_attrs = HashMap::new();
        if !params.entities_xml.trim().is_empty() {
            let doc = parse_xml(&params.entities_xml, false);
            let root = doc
                .root()
                .ok_or("entities.xml: no root element".to_string())?;
            for el in doc.child_elements(root) {
                let name = doc.element(el).name.clone();
                let attr = |key: &str| -> i32 {
                    match doc.element(el).attribute(key) {
                        Some(a) if a.value.trim().eq_ignore_ascii_case("true") => 1,
                        Some(_) => 0,
                        None => -1,
                    }
                };
                entities_attrs.insert(name, (attr("hasClient"), attr("hasCell"), attr("hasBase")));
            }
        }
        Ok(Replayer {
            stream: DefMd5Stream::new(),
            types: DataTypesState::new(),
            types_xml_text: params.types_xml,
            entities_text: params.entities_xml,
            defs: params.defs,
            component_scripts: params.component_scripts,
            entities_attrs,
            loaded_modules: HashSet::new(),
            modules: HashMap::new(),
            prop_utype_auto: 1,
            prop_utypes: Vec::new(),
        })
    }

    fn module(&mut self, name: &str) -> &mut ModuleState {
        self.modules.entry(name.to_string()).or_default()
    }

    // ------------------------------------------------------------------
    // Phase1:DataTypes::initialize(datatypes.cpp:53-83 + loadTypes:94-187)
    // ------------------------------------------------------------------

    fn replay_builtin_types(&mut self) {
        for name in BUILTIN_TYPE_ORDER {
            let id = self
                .types
                .construct(&mut self.stream, TypeKind::Builtin, "builtin-uid");
            self.types.register(name, id);
        }
    }

    fn replay_types_xml(&mut self) -> Result<(), String> {
        if self.types_xml_text.trim().is_empty() {
            return Ok(());
        }
        let text = self.types_xml_text.clone();
        let doc = parse_xml(&text, false);
        let root = match doc.root() {
            Some(r) => r,
            None => return Ok(()),
        };
        for el in doc.child_elements(root) {
            let alias_name = doc.element(el).name.clone();
            let type_text = first_text(&doc, el);
            if type_text == "FIXED_DICT" {
                let id = self
                    .types
                    .construct(&mut self.stream, TypeKind::Dict, "type-uid");
                self.replay_fixed_dict(&doc, el, &alias_name)?;
                self.types.register(&alias_name, id);
            } else if type_text == "ARRAY" {
                let id = self
                    .types
                    .construct(&mut self.stream, TypeKind::Array, "type-uid");
                let element = self.replay_array(&doc, el)?;
                if let Some(info) = self.types.info.get_mut(&id) {
                    info.element = Some(element);
                }
                self.types.register(&alias_name, id);
            } else if !type_text.is_empty() {
                let target = self.types.lookup(&type_text).ok_or_else(|| {
                    format!("types.xml: alias [{alias_name}] target [{type_text}] not found")
                })?;
                self.types.register(&alias_name, target);
            }
        }
        Ok(())
    }

    /// FixedArrayType::initialize:追加 [元素 uid u16]+[元素 strType]
    /// (datatype.cpp:1715-1717;嵌套 ARRAY 先入内层构造+初始化字节)。
    /// 返回元素类型 id(供调用方回填 ArrayTypeInfo.element)。
    fn replay_array(&mut self, doc: &Document, of_parent_el: usize) -> Result<u16, String> {
        let of_el = child_el(doc, of_parent_el, "of")
            .ok_or_else(|| "FixedArrayType::initialize: not found \"of\"".to_string())?;
        let str_type = first_text(doc, of_el);
        if str_type == "ARRAY" {
            let inner = self
                .types
                .construct(&mut self.stream, TypeKind::Array, "array-uid");
            let inner_element = self.replay_array(doc, of_el)?;
            if let Some(info) = self.types.info.get_mut(&inner) {
                info.element = Some(inner_element);
            }
            self.stream
                .append_u16("array-element-uid", "datatype.cpp:1715-1716", inner);
            self.stream
                .append_str("array-element-type", "datatype.cpp:1717", "ARRAY");
            Ok(inner)
        } else {
            let element = self.types.lookup(&str_type).ok_or_else(|| {
                format!("FixedArrayType::initialize: element type [{str_type}] not found")
            })?;
            self.stream
                .append_u16("array-element-uid", "datatype.cpp:1715-1716", element);
            self.stream
                .append_str("array-element-type", "datatype.cpp:1717", &str_type);
            Ok(element)
        }
    }

    /// FixedDictType::initialize(XML):逐键 + implementedBy(datatype.cpp:2050-2196)。
    fn replay_fixed_dict(
        &mut self,
        doc: &Document,
        dict_el: usize,
        parent_name: &str,
    ) -> Result<(), String> {
        let props_el = child_el(doc, dict_el, "Properties")
            .ok_or_else(|| "FixedDictType::initialize: not found \"Properties\"".to_string())?;
        let key_els: Vec<usize> = doc.child_elements(props_el);
        for key_el in key_els {
            let type_name = doc.element(key_el).name.clone();
            let type_el = match child_el(doc, key_el, "Type") {
                Some(t) => t,
                None => continue, // 无 Type 键被忽略(datatype.cpp:2161-2165)
            };
            let str_type = first_text(doc, type_el);
            let mut persistent = true;
            if let Some(p) = child_el(doc, key_el, "Persistent") {
                if first_text(doc, p) == "false" {
                    persistent = false;
                }
            }
            let mut database_length: u32 = 0;
            if let Some(d) = child_el(doc, key_el, "DatabaseLength") {
                database_length = first_text(doc, d).trim().parse().unwrap_or(0);
            }

            if str_type == "ARRAY" {
                let array_id =
                    self
                        .types
                        .construct(&mut self.stream, TypeKind::Array, "dict-array-uid");
                let element = self.replay_array(doc, type_el)?;
                if let Some(info) = self.types.info.get_mut(&array_id) {
                    info.element = Some(element);
                }
                // dataType->getDataType()->type()==ENTITYCALL(datatype.cpp:2104)。
                if self.types.is_entitycall(element) {
                    persistent = false;
                }
                let _ = parent_name; // childName 不入流(datatype.cpp:2093)
                self.stream
                    .append_u16("dict-key-uid", "datatype.cpp:2096-2097", array_id);
                self.stream
                    .append_str("dict-key-type", "datatype.cpp:2098", "ARRAY");
                self.stream
                    .append_str("dict-key-name", "datatype.cpp:2099", &type_name);
                self.stream.append_bool(
                    "dict-key-persistent",
                    "datatype.cpp:2111",
                    persistent,
                );
                self.stream
                    .append_u32("dict-key-db-length", "datatype.cpp:2112", database_length);
            } else {
                let target = self.types.lookup(&str_type).ok_or_else(|| {
                    format!(
                        "FixedDictType::initialize: key [{type_name}] type [{str_type}] not found"
                    )
                })?;
                // dataType->type()==ENTITYCALL(datatype.cpp:2141)。
                if self.types.is_entitycall(target) {
                    persistent = false;
                }
                self.stream
                    .append_u16("dict-key-uid", "datatype.cpp:2133-2134", target);
                self.stream
                    .append_str("dict-key-type", "datatype.cpp:2135", &str_type);
                self.stream
                    .append_str("dict-key-name", "datatype.cpp:2136", &type_name);
                self.stream.append_bool(
                    "dict-key-persistent",
                    "datatype.cpp:2148",
                    persistent,
                );
                self.stream
                    .append_u32("dict-key-db-length", "datatype.cpp:2149", database_length);
            }
        }
        if let Some(impl_el) = child_el(doc, dict_el, "implementedBy") {
            let str_type = first_text(doc, impl_el);
            if !str_type.is_empty() {
                self.stream
                    .append_str("dict-implementedBy", "datatype.cpp:2184", &str_type);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Phase2:entities.xml 逐实体重放(entitydef.cpp:199-237)
    // ------------------------------------------------------------------

    fn replay_entities(&mut self) -> Result<(), String> {
        if self.entities_text.trim().is_empty() {
            return Ok(());
        }
        let text = self.entities_text.clone();
        let doc = parse_xml(&text, false);
        let root = match doc.root() {
            Some(r) => r,
            None => return Ok(()),
        };
        // 文档序快照(借用冲突:先收集名)。
        let names: Vec<String> = doc
            .child_elements(root)
            .iter()
            .map(|&el| doc.element(el).name.clone())
            .collect();
        for name in names {
            self.register_new_script_module(&name);
            self.load_def_info(&name, &name, false)?;
        }
        Ok(())
    }

    /// registerNewScriptDefModule:未注册过才构造(名字入流;entitydef.cpp:253-265)。
    fn register_new_script_module(&mut self, name: &str) {
        if self.modules.contains_key(name) {
            return;
        }
        self.stream
            .append_str("module-name", "scriptdef_module.cpp:60", name);
        self.modules.insert(name.to_string(), ModuleState::default());
    }

    /// loadDefInfo(entitydef.cpp:339-400):装载序闭包。
    /// `interfaces_ignore_components` 仅组件分支为 true(entitydef.cpp:765)。
    fn load_def_info(
        &mut self,
        file_name: &str,
        module_name: &str,
        interfaces_ignore_components: bool,
    ) -> Result<(), String> {
        let def_text = self
            .defs
            .get(file_name)
            .cloned()
            .ok_or_else(|| format!("def not found: {file_name}.def"))?;
        let doc = parse_xml(&def_text, false);
        let root = doc
            .root()
            .ok_or_else(|| format!("{file_name}.def: no root element"))?;
        self.load_all_def_descriptions(&doc, root, module_name)?;
        self.load_interfaces(&doc, root, module_name, interfaces_ignore_components)?;
        self.load_components(&doc, root, module_name)?;
        self.load_parent_class(&doc, root, module_name)?;
        // loadDetailLevelInfo/loadVolatileInfo 不入流(已核:无 md5 追加)。
        self.auto_match_comp_own(module_name);
        self.loaded_modules.insert(file_name.to_string());
        Ok(())
    }

    /// loadAllDefDescriptions(entitydef.cpp:927-964):Properties→Cell→Base→Client。
    fn load_all_def_descriptions(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
    ) -> Result<(), String> {
        if let Some(props_el) = child_el(doc, root, "Properties") {
            self.load_def_properties(doc, props_el, module_name)?;
        }
        if let Some(el) = child_el(doc, root, "CellMethods") {
            self.load_def_methods(doc, el, module_name, MethodDomain::Cell)?;
        }
        if let Some(el) = child_el(doc, root, "BaseMethods") {
            self.load_def_methods(doc, el, module_name, MethodDomain::Base)?;
        }
        if let Some(el) = child_el(doc, root, "ClientMethods") {
            self.load_def_methods(doc, el, module_name, MethodDomain::Client)?;
        }
        Ok(())
    }

    /// loadDefPropertys(entitydef.cpp:1097-1311)。
    fn load_def_properties(
        &mut self,
        doc: &Document,
        props_el: usize,
        module_name: &str,
    ) -> Result<(), String> {
        for prop_el in doc.child_elements(props_el) {
            let name = doc.element(prop_el).name.clone();
            let flags: u32 = match child_el(doc, prop_el, "Flags") {
                Some(f) => {
                    let str_flags = first_text(doc, f).to_uppercase();
                    let v = flags_value(&str_flags).ok_or_else(|| {
                        format!("loadDefPropertys: unknown flags [{str_flags}] {module_name}.{name}")
                    })?;
                    if v & ENTITY_BASE_DATA_FLAGS > 0 {
                        self.module(module_name).has_base = true;
                    }
                    if v & ENTITY_CELL_DATA_FLAGS > 0 {
                        self.module(module_name).has_cell = true;
                    }
                    if v & ENTITY_CLIENT_DATA_FLAGS > 0 {
                        self.module(module_name).has_client = true;
                    }
                    v
                }
                None => {
                    // 引擎缺 Flags 报错终止(entitydef.cpp:1162-1176);kode 夹具
                    // 存在缺 Flags 属性,按 flags=0 宽容重放(trace 留痕)。
                    0
                }
            };

            let mut is_persistent = false;
            if let Some(p) = child_el(doc, prop_el, "Persistent") {
                if first_text(doc, p) == "true" {
                    is_persistent = true;
                }
            }

            let type_el = child_el(doc, prop_el, "Type")
                .ok_or_else(|| format!("loadDefPropertys: no Type {module_name}.{name}"))?;
            let str_type = first_text(doc, type_el);
            let data_type = self.resolve_datatype(doc, type_el, &str_type, module_name, &name)?;

            let is_identifier = match child_el(doc, prop_el, "Identifier") {
                Some(i) => first_text(doc, i) == "true",
                None => false,
            };
            let mut database_length: u32 = 0;
            if let Some(d) = child_el(doc, prop_el, "DatabaseLength") {
                database_length = first_text(doc, d).trim().parse().unwrap_or(0);
            }
            let default_str = match child_el(doc, prop_el, "Default") {
                Some(d) => first_text(doc, d),
                None => String::new(),
            };
            let detail_level: i8 = match child_el(doc, prop_el, "DetailLevel") {
                Some(d) => match first_text(doc, d).as_str() {
                    "NEAR" => 0,
                    "MEDIUM" => 1,
                    _ => 2, // FAR 及未知缺省(entitydef.cpp:1116/1261-1268)
                },
                None => 2,
            };
            let i_utype = match child_el(doc, prop_el, "Utype") {
                Some(u) => first_text(doc, u).trim().parse::<i64>().unwrap_or(-1),
                None => -1,
            };
            let utype = self.calc_property_utype(i_utype)?;

            // PropertyDescription 构造字节(property.cpp:53-64;顺序严格)。
            self.stream
                .append_str("property-name", "property.cpp:53", &name);
            self.stream
                .append_str("property-default", "property.cpp:54", &default_str);
            self.stream
                .append_str("property-type", "property.cpp:55", &str_type);
            self.stream
                .append_u16("property-utype", "property.cpp:56", utype);
            self.stream.append_u32("property-flags", "property.cpp:57", flags);
            if is_persistent && self.types.is_entitycall(data_type) {
                is_persistent = false; // property.cpp:48-51 ENTITYCALL 覆盖
            }
            self.stream
                .append_bool("property-persistent", "property.cpp:58", is_persistent);
            self.stream
                .append_bool("property-identifier", "property.cpp:59", is_identifier);
            self.stream
                .append_u32("property-db-length", "property.cpp:60", database_length);
            self.stream.append(
                "property-detail-level",
                "property.cpp:61",
                &[detail_level as u8],
            );
            self.stream
                .append_u16("property-type-uid", "property.cpp:63-64", data_type);
        }
        Ok(())
    }

    /// 属性/实参的 <Type> 解析:ARRAY 内联构造(嵌套字节先入流),其余查表
    /// (entitydef.cpp:1190-1212 / 1340-1353)。
    fn resolve_datatype(
        &mut self,
        doc: &Document,
        type_el: usize,
        str_type: &str,
        module_name: &str,
        member_name: &str,
    ) -> Result<u16, String> {
        if str_type == "ARRAY" {
            let id =
                self
                    .types
                    .construct(&mut self.stream, TypeKind::Array, "inline-array-uid");
            let element = self.replay_array(doc, type_el)?;
            if let Some(info) = self.types.info.get_mut(&id) {
                info.element = Some(element);
            }
            let _ = (module_name, member_name); // childName 不入流
            Ok(id)
        } else {
            self.types.lookup(str_type).ok_or_else(|| {
                format!("dataType [{str_type}] not found ({module_name}.{member_name})")
            })
        }
    }

    /// calcDefPropertyUType(entitydef.cpp:1018-1093)。
    fn calc_property_utype(&mut self, i_utype: i64) -> Result<u16, String> {
        let futype: u16;
        if i_utype > 0 {
            futype =
                u16::try_from(i_utype).map_err(|_| format!("'Utype' overflowed: {i_utype}"))?;
            if self.prop_utypes.contains(&futype) {
                return Err(format!("'Utype' conflict: {futype}"));
            }
            self.prop_utypes.push(futype);
        } else {
            let mut candidate = self.prop_utype_auto;
            self.prop_utype_auto += 1;
            while self.prop_utypes.contains(&candidate) {
                candidate = self.prop_utype_auto;
                self.prop_utype_auto += 1;
            }
            self.prop_utypes.push(candidate);
            futype = candidate;
        }
        Ok(futype)
    }

    /// loadDef{Cell,Base,Client}Methods(entitydef.cpp:1314+/1440+/1602+):
    /// 构造=[name]+[utype 恒 0]+[exposedType 4B];子节点文档序处理
    /// (Exposed→[exposed 4B];Arg→内联 ARRAY 字节+[uid]+[exposed 4B];
    /// Utype 无字节:setUType 不追加)。ClientMethods 无 Exposed 分支。
    fn load_def_methods(
        &mut self,
        doc: &Document,
        methods_el: usize,
        module_name: &str,
        domain: MethodDomain,
    ) -> Result<(), String> {
        for method_el in doc.child_elements(methods_el) {
            let name = doc.element(method_el).name.clone();
            self.stream.append_str("method-name", "method.cpp:28", &name);
            self.stream.append_u16("method-utype(=0)", "method.cpp:29", 0);
            let mut exposed: i32 = 0; // NO_EXPOSED(method.h:30)
            self.stream.append_i32("method-exposed", "method.cpp:30", exposed);
            for child in doc.child_elements(method_el) {
                let key = doc.element(child).name.clone();
                match key.as_str() {
                    "Exposed" if domain != MethodDomain::Client => {
                        exposed = 1; // EXPOSED(method.h:33)
                        self.stream
                            .append_i32("method-set-exposed", "method.cpp:50", exposed);
                    }
                    "Arg" => {
                        // 引擎:typeNode = argNode->FirstChild();getValStr(typeNode)
                        // (entitydef.cpp:1486-1488/1620-1622)= **Arg 元素自身文本**,
                        // 非 `<Type>` 子元素;内联 ARRAY 用 `<of>`(Arg 的子元素)导航。
                        let str_type = first_text(doc, child);
                        let data_type =
                            self.resolve_datatype(doc, child, &str_type, module_name, &name)?;
                        self.stream
                            .append_u16("method-arg-uid", "method.cpp:66", data_type);
                        // pushArgType 带的是当时的 exposedType_(method.cpp:67)。
                        self.stream
                            .append_i32("method-arg-exposed", "method.cpp:67", exposed);
                    }
                    _ => {} // Utype 等无字节
                }
            }
            // addMethodDescription 不入流;utype 自动分配也不入流(setUType 不追加)。
            let m = self.module(module_name);
            match domain {
                MethodDomain::Cell => {
                    m.has_cell = true;
                    if exposed == 1 {
                        m.cell_exposed_methods += 1;
                    }
                }
                MethodDomain::Base => {
                    m.has_base = true;
                    if exposed == 1 {
                        m.base_exposed_methods += 1;
                    }
                }
                MethodDomain::Client => {
                    m.has_client = true;
                }
            }
        }
        Ok(())
    }

    /// loadInterfaces(entitydef.cpp:551-639,递归;内容并入当前模块,接口名不入流)。
    fn load_interfaces(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
        ignore_components: bool,
    ) -> Result<(), String> {
        let interfaces_el = match child_el(doc, root, "Interfaces") {
            Some(i) => i,
            None => return Ok(()),
        };
        for if_entry in doc.child_elements(interfaces_el) {
            let interface_el = ["Interface", "interface", "Type", "type"]
                .iter()
                .find_map(|k| child_el(doc, if_entry, k));
            let interface_el = match interface_el {
                Some(e) => e,
                None => continue,
            };
            let interface_name = doc.element(interface_el).name.clone();
            let text = self
                .defs
                .get(&interface_name)
                .cloned()
                .ok_or_else(|| format!("interface def not found: {interface_name}.def"))?;
            let idoc = parse_xml(&text, false);
            let iroot = idoc
                .root()
                .ok_or_else(|| format!("{interface_name}.def: no root"))?;
            self.load_all_def_descriptions(&idoc, iroot, module_name)?;
            if !ignore_components {
                self.load_components(&idoc, iroot, module_name)?;
            }
            self.load_interfaces(&idoc, iroot, module_name, ignore_components)?;
        }
        Ok(())
    }

    /// loadComponents(entitydef.cpp:642-818)。
    fn load_components(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
    ) -> Result<(), String> {
        let components_el = match child_el(doc, root, "Components") {
            Some(c) => c,
            None => return Ok(()),
        };
        for comp_entry in doc.child_elements(components_el) {
            let component_name = doc.element(comp_entry).name.clone();
            // enterNode(implementsNode, componentName)(entitydef.cpp:656)。
            let comp_el = match child_el(doc, comp_entry, &component_name) {
                Some(c) => c,
                None => continue,
            };
            let type_el = child_el(doc, comp_el, "Type")
                .ok_or_else(|| format!("component name is NULL: {component_name}"))?;
            let component_type_name = doc.element(type_el).name.clone();

            let mut is_persistent = true;
            if let Some(p) = child_el(doc, comp_el, "Persistent") {
                if first_text(doc, p) == "false" {
                    is_persistent = false;
                }
            }
            let i_utype = match child_el(doc, comp_el, "Utype") {
                Some(u) => first_text(doc, u).trim().parse::<i64>().unwrap_or(-1),
                None => -1,
            };
            let utype = self.calc_property_utype(i_utype)?;

            if !self.loaded_modules.contains(&component_type_name) {
                // 新组件:注册(名字入流)+装 def(接口忽略组件:765)
                // +父类(components/ 目录)+autoMatchCompOwn(791)。
                self.register_new_script_module(&component_type_name);
                self.module(&component_type_name).is_component = true;
                // 组件脚本存在性→域位(scriptdef_module.cpp:306-320)。
                if self
                    .component_scripts
                    .contains(&format!("base:{component_type_name}"))
                {
                    self.module(&component_type_name).has_base = true;
                }
                if self
                    .component_scripts
                    .contains(&format!("cell:{component_type_name}"))
                {
                    self.module(&component_type_name).has_cell = true;
                }
                self.load_def_info(&component_type_name, &component_type_name, true)?;
            }

            // flags 由组件 hasBase/hasCell/hasClient 推导(entitydef.cpp:793-808)。
            let flags = {
                let m = self.module(&component_type_name);
                let mut f = 0u32;
                if m.has_base {
                    f |= 0x0040; // ED_FLAG_BASE
                }
                if m.has_cell {
                    f |= 0x0001; // ED_FLAG_CELL_PUBLIC
                }
                if m.has_client {
                    if m.has_base {
                        f |= 0x0020; // ED_FLAG_BASE_AND_CLIENT
                    } else {
                        f |= 0x009c; // ALL_CLIENTS|CELL_PUBLIC_AND_OWN|OTHER_CLIENTS|OWN_CLIENT
                    }
                }
                f
            };

            // addComponentProperty(entitydef.cpp:821-843):EntityComponentType
            // 构造 uid(非 types 已知名才新建)+PropertyDescription("EntityComponent")。
            let ec_id = match self.types.lookup(&component_type_name) {
                Some(id) => id,
                None => {
                    let id = self.types.construct(
                        &mut self.stream,
                        TypeKind::EntityComponent,
                        "entity-component-uid",
                    );
                    self.types.register(&component_type_name, id);
                    id
                }
            };
            self.stream
                .append_str("component-prop-name", "property.cpp:53", &component_name);
            self.stream
                .append_str("component-prop-default", "property.cpp:54", "");
            self.stream
                .append_str("component-prop-type", "property.cpp:55", "EntityComponent");
            self.stream
                .append_u16("component-prop-utype", "property.cpp:56", utype);
            self.stream
                .append_u32("component-prop-flags", "property.cpp:57", flags);
            self.stream.append_bool(
                "component-prop-persistent",
                "property.cpp:58",
                is_persistent,
            );
            self.stream
                .append_bool("component-prop-identifier", "property.cpp:59", false);
            self.stream
                .append_u32("component-prop-db-length", "property.cpp:60", 0);
            self.stream.append(
                "component-prop-detail-level",
                "property.cpp:61",
                &[2u8], // DETAIL_LEVEL_FAR
            );
            self.stream
                .append_u16("component-prop-type-uid", "property.cpp:63-64", ec_id);

            // 组件属性置宿主域位(entitydef.cpp:851-861)。
            if flags & ENTITY_BASE_DATA_FLAGS > 0 {
                self.module(module_name).has_base = true;
            }
            if flags & ENTITY_CELL_DATA_FLAGS > 0 {
                self.module(module_name).has_cell = true;
            }
            if flags & ENTITY_CLIENT_DATA_FLAGS > 0 {
                self.module(module_name).has_client = true;
            }
        }
        Ok(())
    }

    /// loadParentClass(entitydef.cpp:890-924):父 def 并入当前模块
    /// (不注册父模块名;父的 autoMatchCompOwn 按 entities.xml 条目追 int32)。
    fn load_parent_class(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
    ) -> Result<(), String> {
        let parent_el = match child_el(doc, root, "Parent") {
            Some(p) => p,
            None => return Ok(()),
        };
        // 引擎:parentClassName = getKey(enterNode("Parent")) = <Parent> 文本
        // (entitydef.cpp:897-899),非元素名。
        let parent_name = first_text(doc, parent_el);
        let text = self
            .defs
            .get(&parent_name)
            .cloned()
            .ok_or_else(|| format!("parent def not found: {parent_name}.def"))?;
        let pdoc = parse_xml(&text, false);
        let proot = pdoc
            .root()
            .ok_or_else(|| format!("{parent_name}.def: no root"))?;
        self.load_all_def_descriptions(&pdoc, proot, module_name)?;
        self.load_interfaces(&pdoc, proot, module_name, false)?;
        self.load_components(&pdoc, proot, module_name)?;
        self.load_parent_class(&pdoc, proot, module_name)?;
        // 引擎 loadDefInfo 每递归层尾部都调 pScriptModule->autoMatchCompOwn()
        // (entitydef.cpp:398),其内部用模块自身 name_(子模块)查 entities.xml
        // → 父链每层重复追子模块 3×int32(引擎怪癖,重放照实镜像)。
        self.auto_match_comp_own(module_name);
        Ok(())
    }

    /// autoMatchCompOwn(scriptdef_module.cpp:302-530):
    /// - 组件模块早退(304-331),exposed 方法可补 hasClient(322-328);
    /// - 实体模块仅 entities.xml 有该名条目时追 3×int32(缺省 -1、有值 1/0)。
    fn auto_match_comp_own(&mut self, name: &str) {
        let m = self.modules.get(name).cloned().unwrap_or_default();
        if m.is_component {
            if !m.has_client
                && ((m.has_base && m.base_exposed_methods > 0)
                    || (m.has_cell && m.cell_exposed_methods > 0))
            {
                self.module(name).has_client = true;
            }
            return;
        }
        if let Some(&(has_client, has_cell, has_base)) = self.entities_attrs.get(name) {
            self.stream
                .append_i32("assertionHasClient", "scriptdef_module.cpp:375", has_client);
            self.stream
                .append_i32("assertionHasCell", "scriptdef_module.cpp:386", has_cell);
            self.stream
                .append_i32("assertionHasBase", "scriptdef_module.cpp:397", has_base);
        }
    }
}

/// 计算复合 def md5(Phase1 types.xml + Phase2 entities.xml,引擎执行序)。
pub fn compute_def_md5(params: DefMd5Params) -> Result<DefMd5Result, String> {
    let mut replayer = Replayer::new(params)?;
    replayer.replay_builtin_types();
    replayer.replay_types_xml()?;
    replayer.replay_entities()?;
    Ok(replayer.stream.finish())
}

// ===========================================================================
// RPC
// ===========================================================================

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/def/md5", md5_handler);
}

fn md5_handler(params: Value) -> Result<Value, String> {
    let types_xml = params
        .get("typesXml")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let entities_xml = params
        .get("entitiesXml")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut defs = HashMap::new();
    if let Some(map) = params.get("defs").and_then(|v| v.as_object()) {
        for (k, v) in map {
            if let Some(text) = v.as_str() {
                defs.insert(k.clone(), text.to_string());
            }
        }
    }
    let alias_xml = params
        .get("aliasXml")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut component_scripts = HashSet::new();
    if let Some(list) = params.get("componentScripts").and_then(|v| v.as_array()) {
        for v in list {
            if let Some(s) = v.as_str() {
                component_scripts.insert(s.to_string());
            }
        }
    }
    let result = compute_def_md5(DefMd5Params {
        types_xml,
        entities_xml,
        defs,
        alias_xml,
        component_scripts,
    })?;
    Ok(result.to_json())
}

// ===========================================================================
// Golden
// ===========================================================================

/// 单个黄金样本(params+期望)。手造样本的字节流为手推规范推导锚点。
#[derive(Debug)]
pub struct GoldenSample {
    pub name: &'static str,
    pub params: DefMd5Params,
}

fn fixture_params(root: &Path, sub: &str) -> Option<DefMd5Params> {
    let scripts = root.join(sub).join("scripts");
    let entity_defs = scripts.join("entity_defs");
    let read = |p: std::path::PathBuf| std::fs::read_to_string(p).ok();
    let mut defs = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&entity_defs) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("def") {
                if let (Some(name), Some(text)) = (
                    path.file_stem().and_then(|s| s.to_str()),
                    read(path.clone()),
                ) {
                    defs.insert(name.to_string(), text);
                }
            }
        }
    }
    for sub_dir in ["interfaces", "components"] {
        if let Ok(entries) = std::fs::read_dir(entity_defs.join(sub_dir)) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("def") {
                    if let (Some(name), Some(text)) = (
                        path.file_stem().and_then(|s| s.to_str()),
                        read(path.clone()),
                    ) {
                        defs.insert(name.to_string(), text);
                    }
                }
            }
        }
    }
    // 组件脚本存在性(kbengine-demo-assets 的 scripts/{base,cell}/components/)。
    let mut component_scripts = HashSet::new();
    for side in ["base", "cell"] {
        if let Ok(entries) = std::fs::read_dir(scripts.join(side).join("components")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("py") {
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        component_scripts.insert(format!("{side}:{name}"));
                    }
                }
            }
        }
    }
    Some(DefMd5Params {
        types_xml: read(entity_defs.join("types.xml")).unwrap_or_default(),
        entities_xml: read(scripts.join("entities.xml")).unwrap_or_default(),
        defs,
        alias_xml: read(entity_defs.join("alias.xml")).unwrap_or_default(),
        component_scripts,
    })
}

/// 手造最小资产(规范推导锚点):单实体单属性单方法,字节流手推对拍。
fn minimal_params() -> DefMd5Params {
    let types_xml = "<root></root>".to_string();
    let entities_xml = "<root><Gate hasCell=\"true\"></Gate></root>".to_string();
    let gate_def = "<root>\
        <Properties>\
            <level>\
                <Type> UINT32 </Type>\
                <Flags> BASE </Flags>\
                <Persistent> true </Persistent>\
            </level>\
        </Properties>\
        <CellMethods>\
            <respawn>\
            </respawn>\
        </CellMethods>\
        <BaseMethods>\
            <reqUpgrade>\
                <Exposed> true </Exposed>\
                <Arg> UINT32 </Arg>\
            </reqUpgrade>\
        </BaseMethods>\
        <ClientMethods>\
            <onLevelUp>\
                <Arg> UINT32 </Arg>\
            </onLevelUp>\
        </ClientMethods>\
    </root>"
        .to_string();
    let mut defs = HashMap::new();
    defs.insert("Gate".to_string(), gate_def);
    DefMd5Params {
        types_xml,
        entities_xml,
        defs,
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    }
}

/// 黄金样本集(demo-assets 全实体 + parity-project + 最小锚点)。
pub fn golden_samples(repo_root: &Path) -> Vec<GoldenSample> {
    let fixtures = repo_root.join("tests/fixtures");
    let mut samples = Vec::new();
    if let Some(mut params) = fixture_params(&fixtures, "kbengine-demo-assets") {
        // demo-assets 夹具非引擎可装载(缺 Flags/Monster.onAggro 用未定义的
        // ENTITY_ID);这里仅 md5 侧补充 ENTITY_ID 别名使可计算(回归锁用途,
        // 非 parity 权威);types.xml 是共享夹具,不动文件避免级联其他 golden。
        if !params.types_xml.contains("ENTITY_ID") {
            params.types_xml = params.types_xml.replace(
                "</root>",
                "  <ENTITY_ID> UINT32 </ENTITY_ID>\n</root>",
            );
        }
        samples.push(GoldenSample {
            name: "kbengine-demo-assets",
            params,
        });
    }
    if let Some(params) = fixture_params(&fixtures, "parity-project") {
        samples.push(GoldenSample {
            name: "parity-project",
            params,
        });
    }
    samples.push(GoldenSample {
        name: "minimal-single-entity",
        params: minimal_params(),
    });
    samples
}

/// 黄金 JSON(规范推导为权威;streamHex+trace 供逐字节审计)。
pub fn dump_def_md5_golden(repo_root: &Path) -> String {
    let mut samples = Vec::new();
    for sample in golden_samples(repo_root) {
        let result = compute_def_md5(sample.params).expect("compute def md5 golden sample");
        samples.push(json!({
            "name": sample.name,
            "md5": result.md5_hex,
            "streamHex": result.stream_hex,
        }));
    }
    let value = json!({
        "generator": "kode-server dump-def-md5-golden",
        "algorithm": "engine EntityDef::md5() replay (kbengine 732b389)",
        "provenance": {
            "builtins": "datatypes.cpp:53-83",
            "dataTypeCtor": "datatype.cpp:86-97",
            "arrayInit": "datatype.cpp:1715-1717",
            "dictKeys": "datatype.cpp:2096-2149",
            "dictImplementedBy": "datatype.cpp:2184",
            "propertyCtor": "property.cpp:53-64",
            "methodCtor": "method.cpp:28-30",
            "methodArg": "method.cpp:65-67",
            "methodExposed": "method.cpp:50",
            "moduleName": "scriptdef_module.cpp:60",
            "loadOrder": "entitydef.cpp:339-400",
            "autoMatchCompOwn": "scriptdef_module.cpp:341-397",
            "outputFormat": "md5.cpp:65-72 uppercase 32hex",
        },
        "samples": samples,
    });
    serde_json::to_string(&value).expect("serialize def md5 golden")
}

/// 黄金文件相对路径(与 flag-domains/wire 同目录惯例)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/def-md5-parity.json";
