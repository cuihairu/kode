//! 创建 API 初始化参数字典检查(KSEM-CREATE-05)。
//!
//! params 字典逐键分诊,键路径按引擎 createNamespace 三路真值(entity_macro.h
//! :391-508,逐行核过):
//!
//! - **特殊键 "cellData"**(:417-432):值必须 dict,合并进实体 cellData;
//!   非 dict 字面量 → 确定错误面(ERROR「cellData is not a dict」);
//! - **def 声明属性**(:442-468 HasAttr 臂):普通属性路径,直接 setattr;
//!   cell 段属性经 cellData dict 通道(:470-485);
//! - **def 未声明键**(:486-502):PyObject_SetAttr 动态造实例属性,引擎
//!   **不拦**——`UndeclaredDynamicAttr` 为提示级,不是错误(多键规则按
//!   源码定:不报错);
//! - **缺键规则按源码定**:属性先经 `initProperty` 落默认值
//!   (entity_macro.h:1614-1623 newDefaultVal),params 缺键即用默认,
//!   引擎无必填概念——**不报缺键**;
//! - **类型对拍是静态纪律非引擎错误预测**:创建面 createNamespace 原样
//!   setattr,不查 def 类型(类型纪律在同步流);字面量值与字段型家族
//!   相容 → Ok,不相容 → `Suspicious`(提示级);动态值/未知型 → Unknown
//!   不判;
//! - 动态键不对拍不猜;目录未就绪 → `IndexMissing`,**绝不判「def 未声明」**
//!   (验收红线,与 CREATE-02/RPC-09 同纪律)。
//!
//! 查无目录给不出键路径分诊;嵌套 cellData 内部键面归消费批次(本批形态级)。

use super::types::SemType;

/// params 字典条目形态(消费方从调用点 AST 折叠)。
#[derive(Debug, Clone, PartialEq)]
pub enum ParamEntry {
    /// 字面量键 + 值形态。
    Named { key: String, value: ValueArg },
    /// 动态键(变量/**展开)——不对拍不猜。
    DynamicKey,
}

/// params 值形态。
#[derive(Debug, Clone, PartialEq)]
pub enum ValueArg {
    /// 可折叠字面量(消费方折叠后传入)。
    Literal(ParamLiteral),
    /// 动态表达式——不对拍。
    Dynamic,
}

/// 字面量值形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamLiteral {
    Str,
    Int,
    Float,
    Bool,
    None,
    List,
    Dict,
    Set,
    Tuple,
}

/// 字段通道(entity_macro.h 两路:HasAttr setattr / cellData dict)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldChannel {
    /// 普通属性路径(:442-468)。
    Property,
    /// cell 段属性,经 cellData dict 通道(:470-485)。
    CellData,
}

/// def 字段信息(消费方从快照给)。
#[derive(Debug, Clone, PartialEq)]
pub struct FieldInfo {
    pub ty: SemType,
    pub channel: FieldChannel,
}

/// params 字段目录(消费方从实体快照实现;库面不持索引)。
pub trait ParamFields {
    /// 键 → def 声明字段;None = def 未声明(目录就绪才有资格下此结论)。
    fn field_of(&self, key: &str) -> Option<FieldInfo>;
}

/// 值类型对拍结论(静态纪律,提示级;非引擎错误预测——创建面不校验)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueCheck {
    /// 字面量值与字段型家族相容(元素/嵌套键面不展开)。
    Ok,
    /// 家族不相容——提示级。
    Suspicious { reason: String },
    /// 动态值/字段型未知——不判。
    Unknown,
}

/// 单键检查结论。
#[derive(Debug, Clone, PartialEq)]
pub enum KeyCheck {
    /// def 普通属性路径(:442-468)。
    PropertyPath { value: ValueCheck },
    /// cell 段属性经 cellData 通道(:470-485)。
    CellDataPath { value: ValueCheck },
    /// 特殊键 "cellData"(:417-432):值必须 dict;`Some(false)` = 非 dict
    /// 字面量,确定错误面;`None` = 动态值不判。
    CellDataDict { is_dict_literal: Option<bool> },
    /// def 未声明:动态属性,引擎不拦(提示级,不是错误)。
    UndeclaredDynamicAttr,
    /// 目录未就绪——键路径分诊不可下,绝不判「def 未声明」。
    IndexMissing,
}

/// 单键发现。
#[derive(Debug, Clone, PartialEq)]
pub enum KeyFinding {
    Named { key: String, check: KeyCheck },
    /// 动态键不对拍不猜。
    Dynamic,
}

/// 缺键规则(源码钉死):不报。def 属性先经 initProperty 落默认值
/// (entity_macro.h:1614-1623),params 缺键即用默认,引擎无必填概念。
pub const MISSING_KEYS_RULE: &str = "缺键不报:def 属性先经 initProperty 落默认值(newDefaultVal),params 缺键即用默认值,引擎无必填概念";

/// 多键规则(源码钉死):不报错。createNamespace 对 def 未声明键走
/// PyObject_SetAttr 动态造实例属性(entity_macro.h:486-502),引擎不拦;
/// UndeclaredDynamicAttr 为提示级。
pub const EXTRA_KEYS_RULE: &str = "多键不报错:def 未声明键走 PyObject_SetAttr 动态造属性,引擎不拦;UndeclaredDynamicAttr 为提示级";

/// 字面量值家族。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValueFamily {
    Numeric,
    Text,
    NoneLike,
    Seq,
    Mapping,
    SetLike,
    TupleLike,
}

fn literal_family(lit: ParamLiteral) -> ValueFamily {
    match lit {
        ParamLiteral::Str => ValueFamily::Text,
        ParamLiteral::Int | ParamLiteral::Float | ParamLiteral::Bool => ValueFamily::Numeric,
        ParamLiteral::None => ValueFamily::NoneLike,
        ParamLiteral::List => ValueFamily::Seq,
        ParamLiteral::Dict => ValueFamily::Mapping,
        ParamLiteral::Set => ValueFamily::SetLike,
        ParamLiteral::Tuple => ValueFamily::TupleLike,
    }
}

/// 引擎 datatype 名 → 字段家族(Builtin 名表:INT*/UINT*/FLOAT/DOUBLE/
/// DBID=数值;STRING/UNICODE=文本;VECTOR*=元组形态;其余 None=不对拍)。
fn builtin_family(name: &str) -> Option<ValueFamily> {
    const NUMERIC: &[&str] = &[
        "INT8", "INT16", "INT32", "INT64", "UINT8", "UINT16", "UINT32", "UINT64", "FLOAT",
        "DOUBLE", "DBID",
    ];
    if NUMERIC.contains(&name) {
        Some(ValueFamily::Numeric)
    } else if name == "STRING" || name == "UNICODE" {
        Some(ValueFamily::Text)
    } else if name.starts_with("VECTOR") {
        Some(ValueFamily::TupleLike)
    } else {
        None
    }
}

/// 字段 SemType → 家族(递归 Alias/Range/Nullable;Union/嵌套结构交给
/// 对拍器特判;Entity/Component/Unknown → None 不对拍)。
fn field_family(ty: &SemType) -> Option<ValueFamily> {
    match ty {
        SemType::Builtin(name) => builtin_family(name),
        SemType::Alias(_, inner) | SemType::Nullable(inner) => field_family(inner),
        SemType::Range { base, .. } => field_family(base),
        SemType::Array(_) => Some(ValueFamily::Seq),
        SemType::FixedDict { .. } => Some(ValueFamily::Mapping),
        _ => None,
    }
}

/// 单值对拍(元素/嵌套键面不展开——形态级)。
fn check_value(value: &ValueArg, field: &FieldInfo) -> ValueCheck {
    let ValueArg::Literal(lit) = value else {
        return ValueCheck::Unknown;
    };
    check_literal(*lit, &field.ty)
}

fn check_literal(lit: ParamLiteral, ty: &SemType) -> ValueCheck {
    // Union 任一成员相容即 Ok;全不相容才 Suspicious。
    if let SemType::Union(items) = ty {
        for member in items {
            if check_literal(lit, member) == ValueCheck::Ok {
                return ValueCheck::Ok;
            }
        }
        return ValueCheck::Suspicious {
            reason: "字面量与联合所有成员均不相容".to_string(),
        };
    }
    // Nullable 接受 None(RPC-01 真值:可空通道)。
    if let SemType::Nullable(inner) = ty {
        if lit == ParamLiteral::None {
            return ValueCheck::Ok;
        }
        return check_literal(lit, inner);
    }
    let Some(field_f) = field_family(ty) else {
        // ENTITYCALL 接受 None(RPC-01:ENTITYCALL 取值接受 EntityCall/None/Entity)。
        if lit == ParamLiteral::None && matches!(ty, SemType::Builtin(n) if n == "ENTITYCALL") {
            return ValueCheck::Ok;
        }
        return ValueCheck::Unknown;
    };
    let value_f = literal_family(lit);
    let ok = match (value_f, field_f) {
        (ValueFamily::Numeric, ValueFamily::Numeric) => true, // bool 是 int 子类,数值互认
        (ValueFamily::Text, ValueFamily::Text) => true,
        (ValueFamily::Seq, ValueFamily::Seq) => true,        // 形态级,元素不展开
        (ValueFamily::TupleLike, ValueFamily::TupleLike) => true, // VECTOR 以 tuple 传
        (ValueFamily::Mapping, ValueFamily::Mapping) => true, // FIXED_DICT 键面嵌套不展开
        _ => false,
    };
    if ok {
        ValueCheck::Ok
    } else {
        ValueCheck::Suspicious {
            reason: format!(
                "值家族 {value_f:?} 与字段型家族 {field_f:?} 不相容(静态纪律提示;创建面引擎不校验)"
            ),
        }
    }
}

/// params 字典逐键检查;`fields = None` 表示目录未就绪(键路径分诊不可下)。
pub fn check_params(entries: &[ParamEntry], fields: Option<&dyn ParamFields>) -> Vec<KeyFinding> {
    entries
        .iter()
        .map(|entry| match entry {
            ParamEntry::DynamicKey => KeyFinding::Dynamic,
            ParamEntry::Named { key, value } => {
                // 特殊键 "cellData":结构化通道,不依赖目录(:417-432)。
                if key == "cellData" {
                    let is_dict_literal = match value {
                        ValueArg::Literal(ParamLiteral::Dict) => Some(true),
                        ValueArg::Literal(l) => Some(matches!(l, ParamLiteral::Dict)),
                        ValueArg::Dynamic => None,
                    };
                    return KeyFinding::Named {
                        key: key.clone(),
                        check: KeyCheck::CellDataDict { is_dict_literal },
                    };
                }
                let Some(catalog) = fields else {
                    return KeyFinding::Named {
                        key: key.clone(),
                        check: KeyCheck::IndexMissing,
                    };
                };
                let check = match catalog.field_of(key) {
                    None => KeyCheck::UndeclaredDynamicAttr,
                    Some(info) => {
                        let value_check = check_value(value, &info);
                        match info.channel {
                            FieldChannel::Property => KeyCheck::PropertyPath { value: value_check },
                            FieldChannel::CellData => KeyCheck::CellDataPath { value: value_check },
                        }
                    }
                };
                KeyFinding::Named {
                    key: key.clone(),
                    check,
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Catalog {
        fields: Vec<(String, FieldInfo)>,
    }

    impl ParamFields for Catalog {
        fn field_of(&self, key: &str) -> Option<FieldInfo> {
            self.fields
                .iter()
                .find(|(n, _)| n == key)
                .map(|(_, f)| f.clone())
        }
    }

    fn catalog() -> Catalog {
        Catalog {
            fields: vec![
                (
                    "level".to_string(),
                    FieldInfo { ty: SemType::Builtin("INT32".into()), channel: FieldChannel::Property },
                ),
                (
                    "name".to_string(),
                    FieldInfo { ty: SemType::Builtin("STRING".into()), channel: FieldChannel::Property },
                ),
                (
                    "hp".to_string(),
                    FieldInfo {
                        ty: SemType::Nullable(Box::new(SemType::Builtin("UINT32".into()))),
                        channel: FieldChannel::Property,
                    },
                ),
                (
                    "movSpeed".to_string(),
                    FieldInfo { ty: SemType::Builtin("FLOAT".into()), channel: FieldChannel::CellData },
                ),
                (
                    "position".to_string(),
                    FieldInfo { ty: SemType::Builtin("VECTOR3".into()), channel: FieldChannel::CellData },
                ),
                (
                    "equipment".to_string(),
                    FieldInfo {
                        ty: SemType::Array(Box::new(SemType::Builtin("INT32".into()))),
                        channel: FieldChannel::Property,
                    },
                ),
                (
                    "tags".to_string(),
                    FieldInfo {
                        ty: SemType::FixedDict {
                            name: None,
                            fields: vec![],
                        },
                        channel: FieldChannel::Property,
                    },
                ),
                (
                    "mailbox".to_string(),
                    FieldInfo { ty: SemType::Builtin("ENTITYCALL".into()), channel: FieldChannel::Property },
                ),
                (
                    "mode".to_string(),
                    FieldInfo {
                        ty: SemType::Union(vec![
                            SemType::Builtin("STRING".into()),
                            SemType::Builtin("INT32".into()),
                        ]),
                        channel: FieldChannel::Property,
                    },
                ),
            ],
        }
    }

    fn named(key: &str, lit: ParamLiteral) -> ParamEntry {
        ParamEntry::Named { key: key.to_string(), value: ValueArg::Literal(lit) }
    }

    #[test]
    fn declared_property_compatible_literal_is_ok() {
        let findings = check_params(&[named("level", ParamLiteral::Int)], Some(&catalog()));
        assert_eq!(
            findings,
            vec![KeyFinding::Named {
                key: "level".to_string(),
                check: KeyCheck::PropertyPath { value: ValueCheck::Ok },
            }]
        );
    }

    #[test]
    fn declared_property_incompatible_literal_is_suspicious_not_engine_error() {
        // 静态纪律提示级:创建面引擎原样 setattr,不查类型。
        let findings = check_params(&[named("level", ParamLiteral::Str)], Some(&catalog()));
        match &findings[0] {
            KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Suspicious { .. } }, .. } => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn numeric_cross_family_int_vs_float_is_ok() {
        let findings = check_params(&[named("movSpeed", ParamLiteral::Int)], Some(&catalog()));
        match &findings[0] {
            KeyFinding::Named { check: KeyCheck::CellDataPath { value: ValueCheck::Ok }, .. } => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn cell_data_channel_routes_via_cell_data_path() {
        let findings = check_params(&[named("movSpeed", ParamLiteral::Float)], Some(&catalog()));
        assert!(matches!(
            &findings[0],
            KeyFinding::Named { check: KeyCheck::CellDataPath { value: ValueCheck::Ok }, .. }
        ));
    }

    #[test]
    fn cell_data_special_key_with_dict_is_structural_ok() {
        let findings = check_params(&[named("cellData", ParamLiteral::Dict)], Some(&catalog()));
        assert_eq!(
            findings,
            vec![KeyFinding::Named {
                key: "cellData".to_string(),
                check: KeyCheck::CellDataDict { is_dict_literal: Some(true) },
            }]
        );
    }

    #[test]
    fn cell_data_special_key_non_dict_is_definite_error_face() {
        // 非 dict 字面量 → 引擎 ERROR「cellData is not a dict」(entity_macro.h:426-428)。
        let findings = check_params(&[named("cellData", ParamLiteral::List)], Some(&catalog()));
        assert_eq!(
            findings,
            vec![KeyFinding::Named {
                key: "cellData".to_string(),
                check: KeyCheck::CellDataDict { is_dict_literal: Some(false) },
            }]
        );
    }

    #[test]
    fn cell_data_special_key_dynamic_value_not_judged() {
        let findings = check_params(
            &[ParamEntry::Named {
                key: "cellData".to_string(),
                value: ValueArg::Dynamic,
            }],
            Some(&catalog()),
        );
        assert_eq!(
            findings,
            vec![KeyFinding::Named {
                key: "cellData".to_string(),
                check: KeyCheck::CellDataDict { is_dict_literal: None },
            }]
        );
    }

    #[test]
    fn undeclared_key_is_advisory_not_error() {
        // 多键规则按源码定:动态 setattr 不拦,提示级。
        let findings = check_params(&[named("customField", ParamLiteral::Int)], Some(&catalog()));
        assert_eq!(
            findings,
            vec![KeyFinding::Named {
                key: "customField".to_string(),
                check: KeyCheck::UndeclaredDynamicAttr,
            }]
        );
    }

    #[test]
    fn missing_catalog_never_reports_undeclared() {
        // 验收红线:目录未就绪绝不判「def 未声明」。
        let findings = check_params(&[named("customField", ParamLiteral::Int), named("level", ParamLiteral::Int)], None);
        for f in &findings {
            assert!(
                matches!(f, KeyFinding::Named { check: KeyCheck::IndexMissing, .. }),
                "{f:?}"
            );
        }
    }

    #[test]
    fn dynamic_key_and_value_not_judged() {
        let findings = check_params(
            &[ParamEntry::DynamicKey, ParamEntry::Named {
                key: "level".to_string(),
                value: ValueArg::Dynamic,
            }],
            Some(&catalog()),
        );
        assert!(matches!(findings[0], KeyFinding::Dynamic));
        assert!(matches!(
            &findings[1],
            KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Unknown }, .. }
        ));
    }

    #[test]
    fn nullable_and_union_and_entitycall_null_acceptance() {
        // Nullable 接受 None。
        let f = check_params(&[named("hp", ParamLiteral::None)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Ok }, .. }));
        // None 对标量 → Suspicious。
        let f = check_params(&[named("level", ParamLiteral::None)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Suspicious { .. } }, .. }));
        // ENTITYCALL 接受 None(RPC-01 真值)。
        let f = check_params(&[named("mailbox", ParamLiteral::None)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Ok }, .. }));
        // Union 任一成员相容即 Ok。
        let f = check_params(&[named("mode", ParamLiteral::Int)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Ok }, .. }));
    }

    #[test]
    fn shape_level_containers() {
        // List vs Array 形态级 Ok(元素不展开)。
        let f = check_params(&[named("equipment", ParamLiteral::List)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Ok }, .. }));
        // Tuple vs VECTOR3 Ok(引擎 VECTOR 以 tuple 传)。
        let f = check_params(&[named("position", ParamLiteral::Tuple)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::CellDataPath { value: ValueCheck::Ok }, .. }));
        // Dict vs FIXED_DICT 形态级 Ok(键面嵌套不展开)。
        let f = check_params(&[named("tags", ParamLiteral::Dict)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Ok }, .. }));
        // Set 无引擎 datatype → Suspicious。
        let f = check_params(&[named("level", ParamLiteral::Set)], Some(&catalog()));
        assert!(matches!(&f[0], KeyFinding::Named { check: KeyCheck::PropertyPath { value: ValueCheck::Suspicious { .. } }, .. }));
    }

    #[test]
    fn rules_are_pinned() {
        // 缺键/多键规则按源码钉死,常量非空(消费方文案锚)。
        assert!(!MISSING_KEYS_RULE.is_empty());
        assert!(!EXTRA_KEYS_RULE.is_empty());
        assert!(MISSING_KEYS_RULE.contains("默认值"));
        assert!(EXTRA_KEYS_RULE.contains("不报错"));
    }
}
