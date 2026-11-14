//! wire 布局解释(KSEM-SER-12):在既有编解码/跨度结果
//! ([`crate::codec::decode_spans`] 同读序、同限额、同错误语义)之上,
//! 产字段路径 / 类型标签 / 字节偏移树与首错位置。
//!
//! 红线(SER-12 验收③):跨度树只证明字节按 schema 可走读——**能解析字节
//! ≠ 业务对象类型正确**;PYTHON 桶体 = pickle 不透明 Raw(SER-11 同界),
//! EntityCall/Unresolved 不编造字段序(PA-001 TODO-2 同界)。
//!
//! 与 `decode_spans` 的分工:跨度树 = 数据面(Wireshark 插件按注册字段
//! 渲染);布局树 = 展示面(节点携带路径与类型标签,错误定位到
//! `arg1.members[2]` 粒度——`span_inner` 不线程化路径,本面自建同读序
//! 镜像,对拍由 `tests/layout_units.rs` 锁定:同语料同 Ok/Err、同消费
//! 字节数、Ok 树逐节点 start/len/kind 深等)。

use crate::codec::{min_element_size, Budget, DecodeLimits, SpanKind, MAX_DECODE_DEPTH};
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};
use kode_kbengine_schema::wire::WireType;

/// 布局解释节点:路径 + 类型标签 + 字节区间(相对载荷起点)+ 子项。
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutNode {
    /// 字段路径(`arg0` / `arg1.members[2]` / `arg0.cfg.hp` 风格)。
    pub path: String,
    /// 类型标签(schema [`WireType::display_name`];合成段为段标签)。
    pub type_label: String,
    /// 相对载荷起点的字节偏移。
    pub start: usize,
    pub len: usize,
    pub kind: SpanKind,
    pub children: Vec<LayoutNode>,
}

/// 一次布局解释:成功节点 + 首错(位置与路径)+ 首错后未解释剩余字节起点。
///
/// 首错即停:错后游标处于半读位,后续 arg 的字节解释不可靠——不编造
/// (引擎侧类型错即 OUT_TYPE_ERROR 整帧失败,同口径)。
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutExplanation {
    pub nodes: Vec<LayoutNode>,
    pub error: Option<DecodeError>,
    /// 首错处游标偏移;其后字节未解释。无错为 None。
    pub unresolved_tail_from: Option<usize>,
    /// 恒真:此树只证明字节按 schema 可走读,**不证明业务对象类型正确**
    /// (SER-12 验收红线;展示面必须携带此声明,消费端不得据此判定对象正确)。
    pub structural_only: bool,
}

/// 布局解释的诚实声明原文(展示面可直接引用)。
pub const LAYOUT_HONESTY_NOTE: &str =
    "布局解释只证明字节按 schema 可走读,不证明业务对象类型正确;pickle/EntityCall 段不透明。";

/// 按 schema 线类型解出布局解释树:与 [`crate::codec::decode_spans`] 同读序、
/// 同限额检查与错误语义;Ok 时逐 arg 一个顶层节点,Err 落 [`LayoutExplanation::error`]
/// (位置 = 失败读点的载荷偏移,路径 = 线程化字段路径)。
pub fn decode_layout(
    args: &[WireType],
    payload: &[u8],
    limits: &DecodeLimits,
) -> LayoutExplanation {
    let mut cur = Cursor::new(payload);
    let mut budget = Budget { values: 0 };
    let mut nodes = Vec::with_capacity(args.len());
    for (i, ty) in args.iter().enumerate() {
        match layout_inner(ty, &format!("arg{i}"), &mut cur, limits, 0, &mut budget) {
            Ok(node) => nodes.push(node),
            Err(err) => {
                let tail = cur.offset();
                return LayoutExplanation {
                    nodes,
                    error: Some(err),
                    unresolved_tail_from: Some(tail),
                    structural_only: true,
                };
            }
        }
    }
    LayoutExplanation {
        nodes,
        error: None,
        unresolved_tail_from: None,
        structural_only: true,
    }
}

/// `span_inner` 的布局镜像:同一 Cursor 读序、同一限额检查与错误文本;
/// 差异 = 路径线程贯穿 + 节点携带路径/类型标签。本级产生的错误重写路径为
/// 线程化路径(保留 kind/offset/message);子级错误原样上传(最深路径即真位)。
fn layout_inner(
    ty: &WireType,
    path: &str,
    cur: &mut Cursor,
    limits: &DecodeLimits,
    depth: usize,
    budget: &mut Budget,
) -> Result<LayoutNode, DecodeError> {
    if depth > MAX_DECODE_DEPTH {
        return Err(DecodeError::new(
            DecodeErrorKind::DepthLimit,
            cur.offset(),
            path,
            format!("recursion over {MAX_DECODE_DEPTH}"),
        ));
    }
    budget.take(limits, path)?;
    let start = cur.offset();
    let type_label = ty.display_name();
    let node = |kind: SpanKind, end: usize, children: Vec<LayoutNode>| LayoutNode {
        path: path.to_string(),
        type_label: type_label.clone(),
        start,
        len: end - start,
        kind,
        children,
    };
    Ok(match ty {
        WireType::Bool => {
            cur.read_u8().map_err(|e| with_path(e, path))?;
            node(SpanKind::Bool, cur.offset(), Vec::new())
        }
        WireType::UInt8 => {
            cur.read_u8().map_err(|e| with_path(e, path))?;
            node(SpanKind::U8, cur.offset(), Vec::new())
        }
        WireType::Int8 => {
            cur.read_i8().map_err(|e| with_path(e, path))?;
            node(SpanKind::I8, cur.offset(), Vec::new())
        }
        WireType::UInt16 => {
            cur.read_u16().map_err(|e| with_path(e, path))?;
            node(SpanKind::U16, cur.offset(), Vec::new())
        }
        WireType::Int16 => {
            cur.read_i16().map_err(|e| with_path(e, path))?;
            node(SpanKind::I16, cur.offset(), Vec::new())
        }
        WireType::UInt32 => {
            cur.read_u32().map_err(|e| with_path(e, path))?;
            node(SpanKind::U32, cur.offset(), Vec::new())
        }
        WireType::Int32 => {
            cur.read_i32().map_err(|e| with_path(e, path))?;
            node(SpanKind::I32, cur.offset(), Vec::new())
        }
        WireType::UInt64 => {
            cur.read_u64().map_err(|e| with_path(e, path))?;
            node(SpanKind::U64, cur.offset(), Vec::new())
        }
        WireType::Int64 => {
            cur.read_i64().map_err(|e| with_path(e, path))?;
            node(SpanKind::I64, cur.offset(), Vec::new())
        }
        WireType::Float => {
            cur.read_f32().map_err(|e| with_path(e, path))?;
            node(SpanKind::F32, cur.offset(), Vec::new())
        }
        WireType::Double => {
            cur.read_f64().map_err(|e| with_path(e, path))?;
            node(SpanKind::F64, cur.offset(), Vec::new())
        }
        WireType::String => {
            let _ = cur.read_cstring();
            node(SpanKind::Str, cur.offset(), Vec::new())
        }
        // 带 u32 长度前缀的族:前缀 4B + 体,两层(体 Str/Bytes/Raw)。
        WireType::Unicode | WireType::Blob | WireType::Python => {
            let body_start = start + 4;
            cur.read_blob(limits).map_err(|e| with_path(e, path))?;
            let (body_kind, body_label) = match ty {
                WireType::Python => (SpanKind::Raw, "pickle body (opaque)"),
                WireType::Unicode => (SpanKind::Str, "utf-8 body"),
                _ => (SpanKind::Bytes, "bytes body"),
            };
            node(
                SpanKind::Group,
                cur.offset(),
                vec![
                    LayoutNode {
                        path: format!("{path}.len"),
                        type_label: "u32 length".to_string(),
                        start,
                        len: 4,
                        kind: SpanKind::U32,
                        children: Vec::new(),
                    },
                    LayoutNode {
                        path: format!("{path}.body"),
                        type_label: body_label.to_string(),
                        start: body_start,
                        len: cur.offset() - body_start,
                        kind: body_kind,
                        children: Vec::new(),
                    },
                ],
            )
        }
        WireType::Vector2 | WireType::Vector3 | WireType::Vector4 => {
            let n = match ty {
                WireType::Vector2 => 2,
                WireType::Vector3 => 3,
                _ => 4,
            };
            for _ in 0..n {
                cur.read_f32().map_err(|e| with_path(e, path))?;
            }
            let children = (0..n)
                .map(|i| LayoutNode {
                    path: format!("{path}[{i}]"),
                    type_label: "f32".to_string(),
                    start: start + i * 4,
                    len: 4,
                    kind: SpanKind::F32,
                    children: Vec::new(),
                })
                .collect();
            node(SpanKind::Group, cur.offset(), children)
        }
        WireType::Array { of } => {
            let count = cur.read_u32().map_err(|e| with_path(e, path))? as usize;
            if count > limits.max_array_len {
                return Err(DecodeError::new(
                    DecodeErrorKind::MemoryLimit,
                    cur.offset(),
                    path,
                    format!("declared {count} > cap {}", limits.max_array_len),
                ));
            }
            let min_elem = min_element_size(of);
            if min_elem > 0 && count.saturating_mul(min_elem) > cur.remaining() {
                return Err(DecodeError::new(
                    DecodeErrorKind::UnexpectedEof,
                    cur.offset(),
                    path,
                    format!("declared {count} elements, {} bytes left", cur.remaining()),
                ));
            }
            let mut children = Vec::with_capacity(count.min(4096));
            for i in 0..count {
                children.push(layout_inner(
                    of,
                    &format!("{path}[{i}]"),
                    cur,
                    limits,
                    depth + 1,
                    budget,
                )?);
            }
            node(SpanKind::Group, cur.offset(), children)
        }
        WireType::FixedDict { fields, .. } => {
            let mut children = Vec::with_capacity(fields.len());
            for f in fields {
                children.push(layout_inner(
                    &f.ty,
                    &format!("{path}.{}", f.name),
                    cur,
                    limits,
                    depth + 1,
                    budget,
                )?);
            }
            node(SpanKind::Group, cur.offset(), children)
        }
        // EntityCall/Unresolved:同 span_inner 不推进游标,Raw 覆盖剩余。
        WireType::EntityCall | WireType::Unresolved(_) => {
            let len = cur.rest().len();
            node(SpanKind::Raw, start + len, Vec::new())
        }
    })
}

/// 错误路径重写:保留 kind/offset/message,路径换线程化字段路径。
fn with_path(err: DecodeError, path: &str) -> DecodeError {
    DecodeError::new(err.kind, err.offset, path, err.message)
}
