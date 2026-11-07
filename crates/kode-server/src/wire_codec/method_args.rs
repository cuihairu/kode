// ---------------------------------------------------------------------------
// 方法调用参数(client_lib/entity.cpp:155-248;entitydef/method.cpp:146-176)
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

use super::bytes::push_le_u16;
use super::cursor::WireCursor;
use super::errors::WireError;
use super::property_stream::PropertyMode;
use super::types::{WireLayout, WireValue};
use super::values::{decode_value, encode_value};

// ---------------------------------------------------------------------------
// 方法调用参数(client_lib/entity.cpp:155-248;entitydef/method.cpp:146-176)
// ---------------------------------------------------------------------------

/// 方法 id 编码:别名=u8;utype=u16。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MethodRef {
    Alias(u8),
    Utype(u16),
}

/// 调用方法体(实体 id 由调用方读,本帧 = [componentAliasID?]+methodID+实参)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MethodCall {
    /// 别名模式:u8 componentPropertyAliasID(>0=组件方法);utype 模式不读(恒 0)。
    pub component_alias: Option<u8>,
    pub method: MethodRef,
    pub args: Vec<WireValue>,
    pub arg_layouts: Vec<WireLayout>,
}

/// 编码方法调用实参帧:别名=u8 componentAliasID+u8 methodAliasID+args;
/// utype=u16 methodUtype+args(component uid 不写)。
pub fn encode_method_args(
    call: &MethodCall,
    mode: PropertyMode,
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    if call.arg_layouts.len() != call.args.len() {
        return Err(WireError::ArgumentCountMismatch {
            expected: call.arg_layouts.len(),
            actual: call.args.len(),
        });
    }
    if !matches!(
        (mode, call.method),
        (PropertyMode::Alias, MethodRef::Alias(_)) | (PropertyMode::Utype, MethodRef::Utype(_))
    ) {
        return Err(WireError::MethodModeMismatch);
    }
    match mode {
        PropertyMode::Alias => {
            out.push(call.component_alias.unwrap_or(0));
            let alias = match call.method {
                MethodRef::Alias(a) => a,
                MethodRef::Utype(u) => u as u8,
            };
            out.push(alias);
        }
        PropertyMode::Utype => {
            let utype = match call.method {
                MethodRef::Alias(a) => u16::from(a),
                MethodRef::Utype(u) => u,
            };
            push_le_u16(out, utype);
        }
    }
    for (layout, value) in call.arg_layouts.iter().zip(call.args.iter()) {
        encode_value(layout, value, out)?;
    }
    Ok(())
}

/// 解码方法调用实参帧:别名=u8 componentAliasID(0=本实体)+u8 methodAliasID+args;
/// utype=u16 methodUtype+args。args 布局经闭包按 method id 解析。
pub fn decode_method_args<F>(
    data: &[u8],
    mode: PropertyMode,
    arg_layouts_of: F,
) -> Result<MethodCall, WireError>
where
    F: Fn(Option<u8>, MethodRef) -> Result<Vec<WireLayout>, WireError>,
{
    let mut cur = WireCursor::new(data);
    let (component_alias, method) = match mode {
        PropertyMode::Alias => {
            let comp = cur.read_u8()?;
            let comp = if comp > 0 { Some(comp) } else { None };
            let alias = cur.read_u8()?;
            (comp, MethodRef::Alias(alias))
        }
        PropertyMode::Utype => {
            let utype = cur.read_u16()?;
            (None, MethodRef::Utype(utype))
        }
    };
    let arg_layouts = arg_layouts_of(component_alias, method)?;
    let mut args = Vec::with_capacity(arg_layouts.len());
    for layout in &arg_layouts {
        args.push(decode_value(layout, &mut cur)?);
    }
    Ok(MethodCall {
        component_alias,
        method,
        args,
        arg_layouts,
    })
}
