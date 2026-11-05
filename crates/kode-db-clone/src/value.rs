//! 有类型行编码(PDC-0203):归档记录是带类型的值,不是 SQL dump。
//!
//! 覆盖 NULL/BLOB/64-bit/DECIMAL/UTF-8 时间与时区:64-bit 与 DECIMAL 以精确
//! 形态保留(不受 JSON number 精度限制),BLOB 十六进制,时间带可选时区偏移。
//! 编码面可 serde 序列化(归档帧内容),解码面供导入(Phase 3)重建类型。

use serde::{Deserialize, Serialize};

/// 单元格的有类型值。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "kebab-case")]
pub enum TypedValue {
    Null,
    /// 有符号整型(TINYINT/SMALLINT/INT/signed BIGINT)。
    Int(i64),
    /// 无符号整型(unsigned 非扩位族)。
    UInt(u64),
    /// 无符号 64-bit(bigint unsigned 全域,精确)。
    BigUInt(u64),
    /// 浮点(float 列)。
    Float(f32),
    /// 双精度(double 列)。
    Double(f64),
    /// 精确小数(DECIMAL),字符串保真,不做浮点转换。
    Decimal(String),
    /// 二进制(BLOB/BINARY),十六进制编码。
    Bytes(String),
    /// UTF-8 文本(VARCHAR/CHAR/TEXT)。
    Text(String),
    /// 时间(DATETIME/TIMESTAMP/DATE/TIME);offset_minutes 为相对 UTC 的时区
    /// 偏移,None 表示行源未给出显式偏移(字符串行源形态)。
    DateTime { value: String, offset_minutes: Option<i32> },
}

/// 一行:值序与计划查询的列序一一对应。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedRow {
    pub table: String,
    pub values: Vec<TypedValue>,
}

impl TypedValue {
    /// 由字符串单元格 + 物理列型解析(RowSource 形态的行源)。
    /// 列型按 resolveDbTypeLabel 输出比对;未知列型按文本保真(Text)。
    pub fn parse(cell: Option<&str>, column_type: &str) -> TypedValue {
        let Some(raw) = cell else {
            return TypedValue::Null;
        };
        let ty = column_type.trim().to_ascii_lowercase();
        let unsigned = ty.contains("unsigned");
        // 去 unsigned 前缀后取类型基名(如 `bigint(20) unsigned` → `bigint`)。
        let normalized: String = ty.replace("unsigned", "");
        let base = normalized
            .split_once('(')
            .map_or(normalized.as_str(), |(h, _)| h)
            .trim();
        match base {
            "tinyint" | "smallint" | "mediumint" | "int" => {
                if unsigned {
                    raw.parse::<u64>().map(TypedValue::UInt).unwrap_or_else(|_| TypedValue::Text(raw.to_string()))
                } else {
                    raw.parse::<i64>().map(TypedValue::Int).unwrap_or_else(|_| TypedValue::Text(raw.to_string()))
                }
            }
            "bigint" => {
                if unsigned {
                    raw.parse::<u64>()
                        .map(TypedValue::BigUInt)
                        .unwrap_or_else(|_| TypedValue::Text(raw.to_string()))
                } else {
                    raw.parse::<i64>()
                        .map(TypedValue::Int)
                        .unwrap_or_else(|_| TypedValue::Text(raw.to_string()))
                }
            }
            "float" => raw.parse::<f32>().map(TypedValue::Float).unwrap_or(TypedValue::Text(raw.to_string())),
            "double" => raw.parse::<f64>().map(TypedValue::Double).unwrap_or(TypedValue::Text(raw.to_string())),
            "decimal" | "numeric" => TypedValue::Decimal(raw.to_string()),
            "blob" | "binary" | "varbinary" | "tinyblob" | "mediumblob" | "longblob" => {
                TypedValue::Bytes(hex_encode(raw.as_bytes()))
            }
            "datetime" | "timestamp" | "date" | "time" | "year" => TypedValue::DateTime {
                value: raw.to_string(),
                offset_minutes: None,
            },
            _ => TypedValue::Text(raw.to_string()),
        }
    }
}

/// 小写十六进制(无第三方依赖)。
pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// 十六进制解码(配对校验,奇数长度报错)。
pub fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let bytes = s.as_bytes();
    let (pairs, rem) = bytes.as_chunks::<2>();
    if !rem.is_empty() {
        return Err(format!("odd hex length {}", bytes.len()));
    }
    let mut out = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let hi = hex_val(pair[0]).ok_or_else(|| format!("bad hex char {}", pair[0] as char))?;
        let lo = hex_val(pair[1]).ok_or_else(|| format!("bad hex char {}", pair[1] as char))?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_integer_families() {
        assert_eq!(TypedValue::parse(Some("42"), "int"), TypedValue::Int(42));
        assert_eq!(TypedValue::parse(Some("-7"), "int"), TypedValue::Int(-7));
        assert_eq!(TypedValue::parse(Some("9"), "tinyint unsigned"), TypedValue::UInt(9));
        // bigint unsigned 全域(u64::MAX 不经 f64 精度损失)。
        let max = u64::MAX.to_string();
        assert_eq!(TypedValue::parse(Some(&max), "bigint(20) unsigned"), TypedValue::BigUInt(u64::MAX));
        assert_eq!(TypedValue::parse(Some("-1"), "bigint"), TypedValue::Int(-1));
    }

    #[test]
    fn parses_decimal_and_blob_and_time() {
        assert_eq!(
            TypedValue::parse(Some("12345678901234567890.123456"), "decimal(26,6)"),
            TypedValue::Decimal("12345678901234567890.123456".into())
        );
        match TypedValue::parse(Some("hi"), "blob") {
            TypedValue::Bytes(h) => assert_eq!(hex_decode(&h).unwrap(), b"hi"),
            v => panic!("expected bytes, got {v:?}"),
        }
        assert_eq!(
            TypedValue::parse(Some("2026-11-05 12:00:00"), "datetime"),
            TypedValue::DateTime {
                value: "2026-11-05 12:00:00".into(),
                offset_minutes: None
            }
        );
    }

    #[test]
    fn null_and_unparseable_fall_closed_to_text() {
        assert_eq!(TypedValue::parse(None, "int"), TypedValue::Null);
        assert_eq!(
            TypedValue::parse(Some("not-a-number"), "int"),
            TypedValue::Text("not-a-number".into())
        );
    }

    #[test]
    fn serde_roundtrip_preserves_precision() {
        let values = vec![
            TypedValue::Null,
            TypedValue::Int(i64::MIN),
            TypedValue::BigUInt(u64::MAX),
            TypedValue::Decimal("99999999999999999999.999999".into()),
            TypedValue::Bytes(hex_encode(&[0u8, 1, 254, 255])),
            TypedValue::DateTime {
                value: "2026-11-05T12:00:00+08:00".into(),
                offset_minutes: Some(480),
            },
        ];
        let json = serde_json::to_string(&values).unwrap();
        let back: Vec<TypedValue> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, values);
        // JSON number 精度不损失:BigUInt 以字符串数字形态序列化后仍逐位相等。
        assert!(json.contains("18446744073709551615"));
    }

    #[test]
    fn hex_helpers() {
        assert_eq!(hex_encode(&[]), "");
        assert_eq!(hex_encode(&[0x0f, 0xf0]), "0ff0");
        assert_eq!(hex_decode("0ff0").unwrap(), vec![0x0f, 0xf0]);
        assert!(hex_decode("0f0").is_err());
        assert!(hex_decode("zz").is_err());
    }
}
