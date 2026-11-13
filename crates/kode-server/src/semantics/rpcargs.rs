//! RPC-06 普通 RPC 参数类型校验(纯库面,无 RPC/无 TS 消费)。
//!
//! 以 def 方法声明的 `<Arg>` 类型逐位置检查调用实参(字面量 + 可推导变量),
//! 报告调用点/期望/实际/声明。兼容语义按引擎 `isSameType` 源码
//! (`../kbengine kbe/src/lib/entitydef/datatype.cpp`):
//! - 整型族(INT8..INT64/UINT8..UINT64):`PyLong_Check` + 逐宽转换
//!   (`:130/:260/:381` 系;UINT 族负数拒,:279-289)→ bool 字面量同为
//!   PyLong 子类,接受;
//! - **FLOAT/DOUBLE:`PyFloat_Check` 单查(`:497/:587`)——整数字面量
//!   不接受**(引擎真值,非直觉转换语义);
//! - STRING/UNICODE:`PyUnicode_Check`(`:988/:1093`);BLOB:`PyBytes_Check`
//!   (`:1423`);PY_DICT/PY_TUPLE/PY_LIST:各自容器查(`:1255/:1311/:1367`);
//!   PYTHON:可 pickle 即接受(`:1177`);
//! - ENTITYCALL:EntityCall/None/Entity 三形态(RPC-01 已钉,`datatype.cpp:1484`);
//! - FixedArray:序列 + 逐元素 `isSameType`(`:1794-1812`)。
//!
//! 验收红线:动态 `*args` 保留未知(展开数不可知 → 逐位与位数都不判)。

use super::types::SemType;

/// 调用实参形态(消费方从 ruff AST 归约;本模块只做归约后检查)。
#[derive(Debug, Clone, PartialEq)]
pub enum CallArg {
    /// 字面量(形态 + 值;Int 用 i128 防 UINT64 边界溢出)。
    Literal(LiteralValue),
    /// 变量(name 证据用;derived = 已推导类型,None = 推不出)。
    Variable {
        name: String,
        derived: Option<SemType>,
    },
    /// `*args` 动态展开(保留未知,不判位数不判逐位)。
    StarArgs,
    /// `**kwargs` 动态展开(同上)。
    KwArgs,
    /// 其余表达式(调用结果/属性链/复杂式;推导不出 = 未知)。
    Opaque { reason: String },
}

/// Python 字面量值形态(容器只记形态,元素深入不在位置层面)。
#[derive(Debug, Clone, PartialEq)]
pub enum LiteralValue {
    Int(i128),
    Float(f64),
    Str(String),
    Bool(bool),
    NoneLiteral,
    Bytes,
    List,
    Dict,
    Set,
    Tuple,
}

/// 单位置检查报告。
#[derive(Debug, Clone, PartialEq)]
pub struct ArgReport {
    pub position: usize,
    /// 调用点行(消费方给的调用行,原样回填)。
    pub call_line: usize,
    /// 声明行(def 方法行;无则 None)。
    pub decl_line: Option<usize>,
    /// 期望(声明类型 display)。
    pub expected: String,
    /// 实际(字面量形态/推导类型 display;未知位「不可推导」)。
    pub actual: String,
    pub verdict: ArgVerdict,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ArgVerdict {
    Compatible,
    DefiniteMismatch,
    Unknown(String),
}

/// 检查一次调用的全部实参位置。
///
/// - `declared`:声明参数类型(消费方对 `MethodView.args` 逐个
///   `SemType::from_type_graph` 解析后传入;def `<Arg>` 文本为匿名位类型);
/// - 少传(缺位)与多传(超声明)都逐位报告(引擎 MethodDescription
///   定参 mailed,位数固定);调用实参含 StarArgs/KwArgs → 位数不可知,
///   逐位与位数都不判(验收红线)。
pub fn check_rpc_args(
    declared: &[SemType],
    decl_line: Option<usize>,
    call_line: usize,
    call_args: &[CallArg],
) -> Vec<ArgReport> {
    if call_args
        .iter()
        .any(|a| matches!(a, CallArg::StarArgs | CallArg::KwArgs))
    {
        return (0..declared.len().max(call_args.len()))
            .map(|position| ArgReport {
                position,
                call_line,
                decl_line,
                expected: declared
                    .get(position)
                    .map(|t| t.display())
                    .unwrap_or_else(|| "无此声明位".into()),
                actual: "动态 *args/**kwargs".into(),
                verdict: ArgVerdict::Unknown("动态展开,保留未知".into()),
            })
            .collect();
    }

    let mut reports = Vec::new();
    let positions = declared.len().max(call_args.len());
    for position in 0..positions {
        let declared_ty = declared.get(position);
        let actual_arg = call_args.get(position);
        let report = match (declared_ty, actual_arg) {
            (Some(ty), Some(arg)) => ArgReport {
                position,
                call_line,
                decl_line,
                expected: ty.display(),
                actual: describe_arg(arg),
                verdict: check_one(ty, arg),
            },
            // 声明有、调用没传(全字面量/变量调用缺位)。
            (Some(ty), None) => ArgReport {
                position,
                call_line,
                decl_line,
                expected: ty.display(),
                actual: "未传(缺位)".into(),
                verdict: ArgVerdict::DefiniteMismatch,
            },
            // 调用传了、声明没有(超声明位)。
            (None, Some(arg)) => ArgReport {
                position,
                call_line,
                decl_line,
                expected: "无此声明位".into(),
                actual: describe_arg(arg),
                verdict: ArgVerdict::DefiniteMismatch,
            },
            (None, None) => unreachable!("positions = max(两长),必有一侧"),
        };
        reports.push(report);
    }
    reports
}

/// 单位置兼容判定(引擎 isSameType 源码语义)。
fn check_one(declared: &SemType, arg: &CallArg) -> ArgVerdict {
    match arg {
        CallArg::Variable { derived: None, name } => {
            return ArgVerdict::Unknown(format!("变量 {name} 类型推不出,保留未知"));
        }
        CallArg::StarArgs | CallArg::KwArgs => {
            return ArgVerdict::Unknown("动态展开,保留未知".into());
        }
        CallArg::Opaque { reason } => {
            return ArgVerdict::Unknown(format!("表达式推导不出({reason}),保留未知"));
        }
        _ => {}
    }

    // None 字面量特例:EntityRef 三形态(datatype.cpp:1484)与 Nullable
    // 接受;其余 isSameType 对 NULL 一律拒。
    if matches!(arg, CallArg::Literal(LiteralValue::NoneLiteral)) {
        return if none_accepts(declared) {
            ArgVerdict::Compatible
        } else {
            ArgVerdict::DefiniteMismatch
        };
    }

    let (actual, actual_is_any) = match arg {
        CallArg::Literal(v) => (literal_shape(v), false),
        CallArg::Variable {
            derived: Some(t), ..
        } => match variable_shape(t) {
            Ok(VarShape::One(s)) => (s, false),
            Ok(VarShape::Any) => (PyShape::Int, true),
            Err(reason) => return ArgVerdict::Unknown(reason),
        },
        _ => unreachable!("前置臂已处理"),
    };

    // 声明形态展开(Alias/Range/Nullable 穿透;Union 任意分支兼容即通过;
    // 不可识别分支 → 保留未知,不猜)。
    let mut expected = Vec::new();
    let mut any_flag = false;
    let mut unrecognized = false;
    collect_declared_shapes(declared, &mut expected, &mut any_flag, &mut unrecognized);
    if unrecognized && expected.is_empty() && !any_flag {
        return ArgVerdict::Unknown("声明类型形态不可识别,保留未知".into());
    }
    if any_flag || actual_is_any || expected.contains(&actual) {
        // 整型族声明 + 整数字面量:值域精查(族界 + 显式 Range 界)。
        if let CallArg::Literal(LiteralValue::Int(v)) = arg {
            if let Some((lo, hi)) = int_bounds(declared) {
                if *v < lo || *v > hi {
                    return ArgVerdict::DefiniteMismatch;
                }
            }
            if let Some((lo, hi)) = range_bounds(declared) {
                if *v < lo || *v > hi {
                    return ArgVerdict::DefiniteMismatch;
                }
            }
        }
        ArgVerdict::Compatible
    } else if unrecognized {
        ArgVerdict::Unknown("联合含不可识别分支,保留未知".into())
    } else {
        ArgVerdict::DefiniteMismatch
    }
}

/// 声明类型 → 接受的 Python 形态集(展开到 `expected`;`any` = PYTHON
/// 任意形态;`unrecognized` = 有不可识别分支)。
fn collect_declared_shapes(
    ty: &SemType,
    expected: &mut Vec<PyShape>,
    any: &mut bool,
    unrecognized: &mut bool,
) {
    match ty {
        SemType::Alias(_, inner) | SemType::Range { base: inner, .. } => {
            collect_declared_shapes(inner, expected, any, unrecognized)
        }
        SemType::Nullable(inner) => {
            collect_declared_shapes(inner, expected, any, unrecognized)
        }
        SemType::Union(ts) => {
            for t in ts {
                collect_declared_shapes(t, expected, any, unrecognized);
            }
        }
        SemType::Unknown(_) => *unrecognized = true,
        SemType::Builtin(n) if n == "PYTHON" => *any = true,
        _ => match single_shape(ty) {
            Some(s) => expected.push(s),
            None => *unrecognized = true,
        },
    }
}

/// 声明类型 → 单一形态(容器/标量/引用;Union/Unknown 在外层展开)。
fn single_shape(ty: &SemType) -> Option<PyShape> {
    match ty {
        SemType::Builtin(n) => builtin_shape(n),
        SemType::Alias(_, inner) | SemType::Range { base: inner, .. } => single_shape(inner),
        SemType::Nullable(inner) => single_shape(inner),
        SemType::Array(_) => Some(PyShape::List),
        SemType::FixedDict { .. } => Some(PyShape::Dict),
        SemType::Entity(_) | SemType::Component(_) => Some(PyShape::EntityRef),
        SemType::Union(_) | SemType::Unknown(_) => None,
    }
}

/// 变量推导出的实际形态(One=单一形态;Any=PYTHON 任意形态)。
enum VarShape {
    One(PyShape),
    Any,
}

/// 变量已推导类型 → 实际形态(联合变量取分支集;不可识别 → 未知)。
fn variable_shape(ty: &SemType) -> Result<VarShape, String> {
    let mut expected = Vec::new();
    let mut any = false;
    let mut unrecognized = false;
    collect_declared_shapes(ty, &mut expected, &mut any, &mut unrecognized);
    if any {
        return Ok(VarShape::Any);
    }
    if expected.is_empty() {
        return Err("变量推导类型形态不可识别,保留未知".into());
    }
    let first = expected[0];
    if expected.iter().all(|s| *s == first) {
        Ok(VarShape::One(first))
    } else {
        // 联合变量:不任取分支(与 RPC-03 候选不任取同纪律)。
        Err("变量推导类型为联合,不任取分支,保留未知".into())
    }
}

fn builtin_shape(name: &str) -> Option<PyShape> {
    match name {
        "INT8" | "INT16" | "INT32" | "INT64" | "UINT8" | "UINT16" | "UINT32" | "UINT64" => {
            Some(PyShape::Int)
        }
        "FLOAT" | "DOUBLE" => Some(PyShape::Float),
        "STRING" | "UNICODE" => Some(PyShape::Str),
        "BLOB" => Some(PyShape::Bytes),
        "PY_DICT" | "FIXED_DICT" => Some(PyShape::Dict),
        "PY_LIST" => Some(PyShape::List),
        "PY_TUPLE" => Some(PyShape::Tuple),
        "PY_SET" => Some(PyShape::Set),
        "VECTOR2" | "VECTOR3" | "VECTOR4" => Some(PyShape::Vector),
        // PYTHON 在 collect_declared_shapes 前置拦为 any,不经此表。
        "ENTITYCALL" | "ENTITYCALL_COMPONENT" => Some(PyShape::EntityRef),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PyShape {
    Int,
    Float,
    Str,
    Bytes,
    Dict,
    List,
    Tuple,
    Set,
    Vector,
    /// ENTITYCALL/Entity/Component 引用形态。
    EntityRef,
}

/// 字面量 → Python 形态。
fn literal_shape(v: &LiteralValue) -> PyShape {
    match v {
        // bool 是 PyLong 子类(int 族 PyLong_Check 接受,datatype.cpp:130 系)。
        LiteralValue::Int(_) | LiteralValue::Bool(_) => PyShape::Int,
        LiteralValue::Float(_) => PyShape::Float,
        LiteralValue::Str(_) => PyShape::Str,
        LiteralValue::NoneLiteral => PyShape::EntityRef,
        LiteralValue::Bytes => PyShape::Bytes,
        LiteralValue::List => PyShape::List,
        LiteralValue::Dict => PyShape::Dict,
        LiteralValue::Set => PyShape::Set,
        LiteralValue::Tuple => PyShape::Tuple,
    }
}

/// None 字面量接受面:EntityRef 三形态(datatype.cpp:1484)与 Nullable
/// (可空定义即接受 None;Alias 穿透)。
fn none_accepts(ty: &SemType) -> bool {
    match ty {
        SemType::Alias(_, inner) => none_accepts(inner),
        SemType::Nullable(_) => true,
        SemType::Entity(_) | SemType::Component(_) => true,
        SemType::Builtin(n) => {
            matches!(n.as_str(), "ENTITYCALL" | "ENTITYCALL_COMPONENT" | "PYTHON")
        }
        SemType::Union(ts) => ts.iter().any(none_accepts),
        _ => false,
    }
}

/// 整型族声明 → 值域(逐宽转换界,datatype.cpp:130-587 系;非整型族 → None)。
fn int_bounds(ty: &SemType) -> Option<(i128, i128)> {
    let n = match ty {
        SemType::Builtin(n) => n.as_str(),
        SemType::Alias(_, inner) | SemType::Range { base: inner, .. } => {
            return int_bounds(inner)
        }
        _ => return None,
    };
    match n {
        "INT8" => Some((-(1 << 7), (1 << 7) - 1)),
        "UINT8" => Some((0, (1 << 8) - 1)),
        "INT16" => Some((-(1 << 15), (1 << 15) - 1)),
        "UINT16" => Some((0, (1 << 16) - 1)),
        "INT32" => Some((-(1 << 31), (1 << 31) - 1)),
        "UINT32" => Some((0, (1 << 32) - 1)),
        "INT64" => Some((-(1 << 63), (1 << 63) - 1)),
        "UINT64" => Some((0, (1 << 64) - 1)),
        _ => None,
    }
}

/// 显式 Range 数值界(min/max 可解析为 i128 才比)。
fn range_bounds(ty: &SemType) -> Option<(i128, i128)> {
    match ty {
        SemType::Range { min, max, .. } => Some((
            min.as_ref().and_then(|s| s.trim().parse::<i128>().ok()).unwrap_or(i128::MIN),
            max.as_ref().and_then(|s| s.trim().parse::<i128>().ok()).unwrap_or(i128::MAX),
        )),
        SemType::Alias(_, inner) => range_bounds(inner),
        _ => None,
    }
}

/// 实参证据文本(报告 actual 面)。
fn describe_arg(arg: &CallArg) -> String {
    match arg {
        CallArg::Literal(v) => match v {
            LiteralValue::Int(i) => format!("int 字面量 {i}"),
            LiteralValue::Float(f) => format!("float 字面量 {f}"),
            LiteralValue::Str(s) => format!("str 字面量 \"{s}\""),
            LiteralValue::Bool(b) => format!("bool 字面量 {b}"),
            LiteralValue::NoneLiteral => "None 字面量".into(),
            LiteralValue::Bytes => "bytes 字面量".into(),
            LiteralValue::List => "list 字面量".into(),
            LiteralValue::Dict => "dict 字面量".into(),
            LiteralValue::Set => "set 字面量".into(),
            LiteralValue::Tuple => "tuple 字面量".into(),
        },
        CallArg::Variable {
            name,
            derived: Some(t),
        } => format!("变量 {name}:{}", t.display()),
        CallArg::Variable { name, derived: None } => format!("变量 {name}(类型推不出)"),
        CallArg::StarArgs => "*args".into(),
        CallArg::KwArgs => "**kwargs".into(),
        CallArg::Opaque { reason } => format!("不可推导表达式({reason})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bt(n: &str) -> SemType {
        SemType::Builtin(n.into())
    }

    #[test]
    fn int_literal_within_family_bounds() {
        let r = check_rpc_args(&[bt("INT32")], Some(10), 42, &[CallArg::Literal(LiteralValue::Int(5))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        assert_eq!(r[0].call_line, 42);
        assert_eq!(r[0].decl_line, Some(10));
        assert_eq!(r[0].expected, "INT32");
        assert_eq!(r[0].actual, "int 字面量 5");
        // 值域精查:INT8 装 300 不行。
        let r = check_rpc_args(&[bt("INT8")], None, 7, &[CallArg::Literal(LiteralValue::Int(300))]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
        // UINT 族负数拒(datatype.cpp:279-289)。
        let r = check_rpc_args(&[bt("UINT32")], None, 7, &[CallArg::Literal(LiteralValue::Int(-1))]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
        // UINT64 上界不溢 i128。
        let r = check_rpc_args(&[bt("UINT64")], None, 7, &[CallArg::Literal(LiteralValue::Int(u64::MAX as i128))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
    }

    #[test]
    fn int_literal_to_float_is_mismatch_engine_truth() {
        // 引擎真值陷阱:FLOAT/DOUBLE 只 PyFloat_Check(:497/:587),
        // int 字面量不接受——不是直觉的「数值可转」。
        let r = check_rpc_args(&[bt("FLOAT")], None, 7, &[CallArg::Literal(LiteralValue::Int(5))]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
        let r = check_rpc_args(&[bt("FLOAT")], None, 7, &[CallArg::Literal(LiteralValue::Float(1.5))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
    }

    #[test]
    fn bool_literal_is_int_family_not_float() {
        // bool ⊂ PyLong(PyLong_Check 接受)。
        let r = check_rpc_args(&[bt("INT8")], None, 7, &[CallArg::Literal(LiteralValue::Bool(true))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        // 但 bool 不是 PyFloat → FLOAT 拒。
        let r = check_rpc_args(&[bt("FLOAT")], None, 7, &[CallArg::Literal(LiteralValue::Bool(true))]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
    }

    #[test]
    fn str_and_container_shapes() {
        let r = check_rpc_args(
            &[bt("STRING"), bt("UNICODE"), bt("BLOB"), bt("PY_DICT"), bt("PY_TUPLE")],
            None,
            7,
            &[
                CallArg::Literal(LiteralValue::Str("x".into())),
                CallArg::Literal(LiteralValue::Str("y".into())),
                CallArg::Literal(LiteralValue::Bytes),
                CallArg::Literal(LiteralValue::Dict),
                CallArg::Literal(LiteralValue::Tuple),
            ],
        );
        assert!(r.iter().all(|x| x.verdict == ArgVerdict::Compatible));
        // str → INT32 不符。
        let r = check_rpc_args(&[bt("INT32")], None, 7, &[CallArg::Literal(LiteralValue::Str("1".into()))]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
    }

    #[test]
    fn none_literal_entity_and_nullable() {
        // EntityRef 三形态含 None(datatype.cpp:1484,RPC-01 已钉)。
        let r = check_rpc_args(&[SemType::Entity("Avatar".into())], None, 7, &[CallArg::Literal(LiteralValue::NoneLiteral)]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        let r = check_rpc_args(&[SemType::Nullable(Box::new(bt("INT32")))], None, 7, &[CallArg::Literal(LiteralValue::NoneLiteral)]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        // None → INT32 不符(NULL 一律拒)。
        let r = check_rpc_args(&[bt("INT32")], None, 7, &[CallArg::Literal(LiteralValue::NoneLiteral)]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
    }

    #[test]
    fn variable_with_derived_type() {
        let r = check_rpc_args(
            &[bt("STRING")],
            None,
            7,
            &[CallArg::Variable { name: "s".into(), derived: Some(bt("STRING")) }],
        );
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        assert_eq!(r[0].actual, "变量 s:STRING");
        // 推导类型与声明族不符。
        let r = check_rpc_args(
            &[bt("INT32")],
            None,
            7,
            &[CallArg::Variable { name: "s".into(), derived: Some(bt("STRING")) }],
        );
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
        // 推不出 = 未知,绝不硬判。
        let r = check_rpc_args(
            &[bt("INT32")],
            None,
            7,
            &[CallArg::Variable { name: "x".into(), derived: None }],
        );
        assert!(matches!(r[0].verdict, ArgVerdict::Unknown(_)));
    }

    #[test]
    fn union_variable_not_picking_branch() {
        // 联合变量:不任取分支(RPC-03 同纪律)。
        let u = SemType::Union(vec![bt("INT32"), bt("STRING")]);
        let r = check_rpc_args(
            &[bt("INT32")],
            None,
            7,
            &[CallArg::Variable { name: "x".into(), derived: Some(u) }],
        );
        assert!(matches!(r[0].verdict, ArgVerdict::Unknown(_)));
        // 联合声明:任一分支兼容即通过。
        let d = SemType::Union(vec![bt("FLOAT"), bt("STRING")]);
        let r = check_rpc_args(&[d], None, 7, &[CallArg::Literal(LiteralValue::Str("a".into()))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
    }

    #[test]
    fn star_args_keeps_everything_unknown() {
        // 验收红线:动态 *args 保留未知(逐位与位数都不判)。
        let declared = vec![bt("INT32"), bt("STRING"), bt("FLOAT")];
        let r = check_rpc_args(&declared, Some(20), 9, &[CallArg::StarArgs]);
        assert_eq!(r.len(), 3);
        assert!(r.iter().all(|x| matches!(x.verdict, ArgVerdict::Unknown(_))));
        // **kwargs 同。
        let r = check_rpc_args(&declared, None, 9, &[CallArg::KwArgs]);
        assert!(r.iter().all(|x| matches!(x.verdict, ArgVerdict::Unknown(_))));
    }

    #[test]
    fn opaque_expression_is_unknown() {
        let r = check_rpc_args(
            &[bt("INT32")],
            None,
            7,
            &[CallArg::Opaque { reason: "调用结果".into() }],
        );
        assert!(matches!(r[0].verdict, ArgVerdict::Unknown(_)));
    }

    #[test]
    fn arity_extra_and_missing_positions() {
        // 多传:超声明位 → 不符。
        let r = check_rpc_args(
            &[bt("INT32")],
            Some(10),
            7,
            &[CallArg::Literal(LiteralValue::Int(1)), CallArg::Literal(LiteralValue::Int(2))],
        );
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        assert_eq!(r[1].verdict, ArgVerdict::DefiniteMismatch);
        assert_eq!(r[1].expected, "无此声明位");
        // 缺传:声明位没给 → 不符。
        let r = check_rpc_args(
            &[bt("INT32"), bt("STRING")],
            Some(10),
            7,
            &[CallArg::Literal(LiteralValue::Int(1))],
        );
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].verdict, ArgVerdict::DefiniteMismatch);
        assert_eq!(r[1].actual, "未传(缺位)");
    }

    #[test]
    fn python_type_accepts_anything() {
        // PYTHON:可 pickle 即接受(:1177)。
        let r = check_rpc_args(&[bt("PYTHON")], None, 7, &[CallArg::Literal(LiteralValue::Dict)]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
    }

    #[test]
    fn container_declaration_shape_level() {
        // ARRAY/FIXED_DICT 声明:位置层面查容器形态;元素/字段深入归
        // types 面既有诊断族(CELL-08/09/10),不在本批。
        let arr = SemType::Array(Box::new(bt("INT32")));
        let r = check_rpc_args(&[arr], None, 7, &[CallArg::Literal(LiteralValue::List)]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        let fd = SemType::FixedDict { name: Some("D".into()), fields: Vec::new() };
        let r = check_rpc_args(std::slice::from_ref(&fd), None, 7, &[CallArg::Literal(LiteralValue::Dict)]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
        // list → FIXED_DICT 不符。
        let r = check_rpc_args(std::slice::from_ref(&fd), None, 7, &[CallArg::Literal(LiteralValue::List)]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
    }

    #[test]
    fn unknown_declaration_and_alias_recurse() {
        // 未知声明 → 保留未知,不判。
        let r = check_rpc_args(&[SemType::Unknown("未注册类型".into())], None, 7, &[CallArg::Literal(LiteralValue::Int(1))]);
        assert!(matches!(r[0].verdict, ArgVerdict::Unknown(_)));
        // 别名穿透。
        let alias = SemType::Alias("HP".into(), Box::new(bt("INT32")));
        let r = check_rpc_args(&[alias], None, 7, &[CallArg::Literal(LiteralValue::Int(5))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
    }

    #[test]
    fn range_bounds_checked_when_parseable() {
        // 显式 Range:值界可解析才比(base 兼容 + 界外不符)。
        let ranged = SemType::Range {
            base: Box::new(bt("INT32")),
            min: Some("1".into()),
            max: Some("100".into()),
        };
        let r = check_rpc_args(&[ranged], None, 7, &[CallArg::Literal(LiteralValue::Int(150))]);
        assert_eq!(r[0].verdict, ArgVerdict::DefiniteMismatch);
        let ranged_ok = SemType::Range {
            base: Box::new(bt("INT32")),
            min: Some("1".into()),
            max: Some("100".into()),
        };
        let r = check_rpc_args(&[ranged_ok], None, 7, &[CallArg::Literal(LiteralValue::Int(50))]);
        assert_eq!(r[0].verdict, ArgVerdict::Compatible);
    }
}
