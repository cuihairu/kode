//! Typed row encoding (PDC-0203): archive records are typed values, not a SQL
//! dump.
//!
//! Covers NULL/BLOB/64-bit/DECIMAL/UTF-8 times and time zones: 64-bit and DECIMAL
//! are preserved in exact form (not subject to JSON number precision limits), BLOB
//! as hex, times carry an optional time-zone offset. The encoding face is serde
//! serializable (archive frame content); the decoding face lets import (Phase 3)
//! rebuild types.

use serde::{Deserialize, Serialize};

/// Typed value of a cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "kebab-case")]
pub enum TypedValue {
    Null,
    /// Signed integer (TINYINT/SMALLINT/INT/signed BIGINT).
    Int(#[serde(with = "json_i64")] i64),
    /// Unsigned integer (the unsigned non-widening family).
    UInt(#[serde(with = "json_u64")] u64),
    /// Unsigned 64-bit (the full bigint unsigned range, exact).
    BigUInt(#[serde(with = "json_u64")] u64),
    /// Floating point (float columns).
    Float(f32),
    /// Double precision (double columns).
    Double(f64),
    /// Exact decimal (DECIMAL), string-faithful, no float conversion.
    Decimal(String),
    /// Binary (BLOB/BINARY), hex encoded.
    Bytes(String),
    /// UTF-8 text (VARCHAR/CHAR/TEXT).
    Text(String),
    /// Time (DATETIME/TIMESTAMP/DATE/TIME); offset_minutes is the time-zone offset
    /// relative to UTC; None means the row source gave no explicit offset (string
    /// row-source form).
    DateTime {
        value: String,
        offset_minutes: Option<i32>,
    },
}

// JSON numbers above 2^53-1 lose precision in the VS Code extension's JS
// transport. Retain numeric encoding for old/small values, encode larger values
// as decimal strings, and accept both formats when reading older archives.
mod json_i64 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
        if v.unsigned_abs() <= 9_007_199_254_740_991 {
            s.serialize_i64(*v)
        } else {
            s.serialize_str(&v.to_string())
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Number(i64),
            Text(String),
        }
        match Wire::deserialize(d)? {
            Wire::Number(v) => Ok(v),
            Wire::Text(v) => v.parse().map_err(serde::de::Error::custom),
        }
    }
}

mod json_u64 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        if *v <= 9_007_199_254_740_991 {
            s.serialize_u64(*v)
        } else {
            s.serialize_str(&v.to_string())
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Number(u64),
            Text(String),
        }
        match Wire::deserialize(d)? {
            Wire::Number(v) => Ok(v),
            Wire::Text(v) => v.parse().map_err(serde::de::Error::custom),
        }
    }
}

/// One row: the value order corresponds one-to-one with the planned query's
/// column order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedRow {
    pub table: String,
    pub values: Vec<TypedValue>,
}

impl TypedValue {
    /// Parses from a string cell + physical column type (row source in the
    /// RowSource form). The column type is matched per resolveDbTypeLabel output;
    /// unknown column types stay text-faithful (Text).
    pub fn parse(cell: Option<&str>, column_type: &str) -> TypedValue {
        let Some(raw) = cell else {
            return TypedValue::Null;
        };
        let ty = column_type.trim().to_ascii_lowercase();
        let unsigned = ty.contains("unsigned");
        // Take the base type name after removing the unsigned word (e.g.
        // `bigint(20) unsigned` → `bigint`).
        let normalized: String = ty.replace("unsigned", "");
        let base = normalized
            .split_once('(')
            .map_or(normalized.as_str(), |(h, _)| h)
            .trim();
        match base {
            "tinyint" | "smallint" | "mediumint" | "int" => {
                if unsigned {
                    raw.parse::<u64>()
                        .map(TypedValue::UInt)
                        .unwrap_or_else(|_| TypedValue::Text(raw.to_string()))
                } else {
                    raw.parse::<i64>()
                        .map(TypedValue::Int)
                        .unwrap_or_else(|_| TypedValue::Text(raw.to_string()))
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
            "float" => raw
                .parse::<f32>()
                .map(TypedValue::Float)
                .unwrap_or(TypedValue::Text(raw.to_string())),
            "double" => raw
                .parse::<f64>()
                .map(TypedValue::Double)
                .unwrap_or(TypedValue::Text(raw.to_string())),
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

/// Lowercase hex (no third-party dependency).
pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Hex decode (pair validation, odd length is an error).
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
    fn large_integers_cross_json_without_precision_loss_and_read_legacy_numbers() {
        for value in [
            TypedValue::Int(i64::MIN),
            TypedValue::Int(i64::MAX),
            TypedValue::BigUInt(u64::MAX),
        ] {
            let encoded = serde_json::to_string(&value).unwrap();
            assert!(encoded.contains("\"v\":\""));
            assert_eq!(serde_json::from_str::<TypedValue>(&encoded).unwrap(), value);
        }
        let old = r#"{"t":"big-u-int","v":18446744073709551615}"#;
        assert_eq!(
            serde_json::from_str::<TypedValue>(old).unwrap(),
            TypedValue::BigUInt(u64::MAX)
        );
        assert_eq!(
            serde_json::to_string(&TypedValue::Int(5)).unwrap(),
            r#"{"t":"int","v":5}"#
        );
    }

    #[test]
    fn parses_integer_families() {
        assert_eq!(TypedValue::parse(Some("42"), "int"), TypedValue::Int(42));
        assert_eq!(TypedValue::parse(Some("-7"), "int"), TypedValue::Int(-7));
        assert_eq!(
            TypedValue::parse(Some("9"), "tinyint unsigned"),
            TypedValue::UInt(9)
        );
        // Full bigint unsigned range (u64::MAX without f64 precision loss).
        let max = u64::MAX.to_string();
        assert_eq!(
            TypedValue::parse(Some(&max), "bigint(20) unsigned"),
            TypedValue::BigUInt(u64::MAX)
        );
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
        // No JSON number precision loss: BigUInt serialized as a string digit form
        // still matches digit-for-digit.
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

    #[test]
    fn parses_float_and_double_with_fallback_to_text() {
        // float/double: parseable → number; unparseable → text fallback (never
        // swallowed into 0.0).
        assert_eq!(
            TypedValue::parse(Some("1.5"), "float"),
            TypedValue::Float(1.5)
        );
        assert_eq!(
            TypedValue::parse(Some("not-a-float"), "float"),
            TypedValue::Text("not-a-float".into())
        );
        assert_eq!(
            TypedValue::parse(Some("2.75"), "double"),
            TypedValue::Double(2.75)
        );
        assert_eq!(
            TypedValue::parse(Some("x"), "double"),
            TypedValue::Text("x".into())
        );
    }
}
