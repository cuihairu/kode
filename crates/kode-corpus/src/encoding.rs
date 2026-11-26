//! Encoding detection and decoding for Python source files.
//!
//! Rule order matches CPython/PEP 263:
//! 1. UTF-8 / UTF-16 LE / UTF-16 BE BOM takes priority;
//! 2. otherwise read the `# ... coding[:=] <name>` cookie from the first two physical lines;
//! 3. with no BOM/cookie the default is UTF-8; BOM-less UTF-16 is only recognized by
//!    heuristic when the NUL distribution is unambiguous (so plain UTF-8 is not misread as UTF-16).
//!
//! Detection and decoding are separated: even when this crate cannot decode a declared codec
//! (e.g. GBK), the caller still gets [`Encoding::Other`] plus the raw declaration, so the
//! index layer can record an explicit failure instead of silently producing mojibake.

use std::fmt;

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM: &[u8] = &[0xFE, 0xFF];
const UTF32LE_BOM: &[u8] = &[0xFF, 0xFE, 0x00, 0x00];
const UTF32BE_BOM: &[u8] = &[0x00, 0x00, 0xFE, 0xFF];

/// A recognized source file encoding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Encoding {
    Utf8,
    /// UTF-8 with BOM (the BOM is already counted in [`EncodingDetection::bom_len`]).
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Latin1,
    Cp1252,
    Ascii,
    /// A codec that was detected/declared but is not decoded by this crate (normalized name kept).
    Other(String),
}

impl Encoding {
    /// Stable literal used by golden output and logs (not the user's raw declaration).
    pub fn canonical_name(&self) -> &str {
        match self {
            Encoding::Utf8 => "utf-8",
            Encoding::Utf8Bom => "utf-8-sig",
            Encoding::Utf16Le => "utf-16-le",
            Encoding::Utf16Be => "utf-16-be",
            Encoding::Latin1 => "latin-1",
            Encoding::Cp1252 => "cp1252",
            Encoding::Ascii => "ascii",
            Encoding::Other(name) => name,
        }
    }

    fn from_cookie(name: &str) -> Encoding {
        let normalized = name.to_ascii_lowercase().replace('_', "-");
        match normalized.as_str() {
            "utf-8" | "utf8" | "utf-8-sig" | "utf8-sig" => Encoding::Utf8,
            "ascii" | "us-ascii" | "646" => Encoding::Ascii,
            "latin-1" | "latin1" | "iso-8859-1" | "iso8859-1" | "l1" | "cp819" => Encoding::Latin1,
            "cp1252" | "windows-1252" => Encoding::Cp1252,
            "utf-16" | "utf16" => Encoding::Utf16Le,
            "utf-16-le" | "utf16-le" => Encoding::Utf16Le,
            "utf-16-be" | "utf16-be" => Encoding::Utf16Be,
            other => Encoding::Other(other.to_string()),
        }
    }
}

/// The source of a detection conclusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodingSource {
    Bom,
    Cookie,
    Heuristic,
    Default,
}

/// The result of encoding detection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodingDetection {
    pub encoding: Encoding,
    pub source: EncodingSource,
    /// Number of BOM bytes (0 when there is no BOM); stripped before decoding.
    pub bom_len: usize,
    /// The raw cookie declaration (kept when present, even if the BOM takes priority).
    pub declared: Option<String>,
    /// Physical line holding the cookie (0-based).
    pub cookie_line: Option<usize>,
}

/// The text after a successful decode, plus the detection conclusion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedSource {
    pub text: String,
    pub detection: EncodingDetection,
}

/// Reason for a failed decode (with offsets, so the index layer can record a reproducible failure point).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    InvalidUtf8 { offset: usize },
    InvalidUtf16 { offset: usize },
    InvalidAscii { offset: usize },
    InvalidCp1252 { offset: usize, byte: u8 },
    UnsupportedEncoding(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::InvalidUtf8 { offset } => {
                write!(f, "invalid UTF-8 at byte offset {offset}")
            }
            DecodeError::InvalidUtf16 { offset } => {
                write!(f, "invalid UTF-16 sequence at byte offset {offset}")
            }
            DecodeError::InvalidAscii { offset } => {
                write!(f, "non-ASCII byte at offset {offset}")
            }
            DecodeError::InvalidCp1252 { offset, byte } => {
                write!(f, "undefined CP1252 byte 0x{byte:02x} at offset {offset}")
            }
            DecodeError::UnsupportedEncoding(name) => {
                write!(f, "unsupported source encoding: {name}")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

/// Detect a BOM, a PEP 263 cookie, and the conservative BOM-less UTF-16 heuristic.
pub fn detect_encoding(bytes: &[u8]) -> EncodingDetection {
    let bom = bom_encoding(bytes);
    let cookie_bytes = bom.as_ref().map(|(_, len)| &bytes[*len..]).unwrap_or(bytes);
    let (declared, cookie_line) = find_coding_cookie(cookie_bytes)
        .map(|(name, line)| (Some(name), Some(line)))
        .unwrap_or((None, None));
    if let Some((encoding, bom_len)) = bom {
        return EncodingDetection {
            encoding,
            source: EncodingSource::Bom,
            bom_len,
            declared,
            cookie_line,
        };
    }
    if let Some(name) = declared.as_deref() {
        return EncodingDetection {
            encoding: Encoding::from_cookie(name),
            source: EncodingSource::Cookie,
            bom_len: 0,
            declared,
            cookie_line,
        };
    }
    if let Some(encoding) = bomless_utf16(bytes) {
        return EncodingDetection {
            encoding,
            source: EncodingSource::Heuristic,
            bom_len: 0,
            declared,
            cookie_line,
        };
    }
    EncodingDetection {
        encoding: Encoding::Utf8,
        source: EncodingSource::Default,
        bom_len: 0,
        declared,
        cookie_line,
    }
}

/// Decode according to the detection result. When BOM and cookie conflict the BOM wins (as in CPython).
pub fn decode_source(bytes: &[u8]) -> Result<DecodedSource, DecodeError> {
    let detection = detect_encoding(bytes);
    let body = &bytes[detection.bom_len.min(bytes.len())..];
    let decoded = match &detection.encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => decode_utf8(body),
        Encoding::Utf16Le => decode_utf16(body, true),
        Encoding::Utf16Be => decode_utf16(body, false),
        Encoding::Latin1 => Ok(body.iter().map(|byte| char::from(*byte)).collect()),
        Encoding::Cp1252 => decode_cp1252(body),
        Encoding::Ascii => decode_ascii(body),
        Encoding::Other(name) => Err(DecodeError::UnsupportedEncoding(name.clone())),
    };
    let text = match decoded {
        Ok(text) => text,
        Err(err) => return Err(err.shifted(detection.bom_len)),
    };
    Ok(DecodedSource { text, detection })
}

impl DecodeError {
    fn shifted(self, offset: usize) -> DecodeError {
        match self {
            DecodeError::InvalidUtf8 { offset: at } => DecodeError::InvalidUtf8 {
                offset: at + offset,
            },
            DecodeError::InvalidUtf16 { offset: at } => DecodeError::InvalidUtf16 {
                offset: at + offset,
            },
            DecodeError::InvalidAscii { offset: at } => DecodeError::InvalidAscii {
                offset: at + offset,
            },
            DecodeError::InvalidCp1252 { offset: at, byte } => DecodeError::InvalidCp1252 {
                offset: at + offset,
                byte,
            },
            DecodeError::UnsupportedEncoding(name) => DecodeError::UnsupportedEncoding(name),
        }
    }
}

fn bom_encoding(bytes: &[u8]) -> Option<(Encoding, usize)> {
    if bytes.starts_with(UTF32LE_BOM) {
        Some((Encoding::Other("utf-32-le".to_string()), 4))
    } else if bytes.starts_with(UTF32BE_BOM) {
        Some((Encoding::Other("utf-32-be".to_string()), 4))
    } else if bytes.starts_with(UTF8_BOM) {
        Some((Encoding::Utf8Bom, 3))
    } else if bytes.starts_with(UTF16LE_BOM) {
        Some((Encoding::Utf16Le, 2))
    } else if bytes.starts_with(UTF16BE_BOM) {
        Some((Encoding::Utf16Be, 2))
    } else {
        None
    }
}

fn bomless_utf16(bytes: &[u8]) -> Option<Encoding> {
    if bytes.len() < 4 {
        return None;
    }
    let sample = &bytes[..bytes.len().min(128)];
    let pairs = sample.len() / 2;
    if pairs == 0 {
        return None;
    }
    let mut even_zeros = 0;
    let mut odd_zeros = 0;
    for pair in sample.as_chunks::<2>().0 {
        even_zeros += usize::from(pair[0] == 0);
        odd_zeros += usize::from(pair[1] == 0);
    }
    if even_zeros == 0 && odd_zeros * 4 >= pairs * 3 {
        Some(Encoding::Utf16Le)
    } else if odd_zeros == 0 && even_zeros * 4 >= pairs * 3 {
        Some(Encoding::Utf16Be)
    } else {
        None
    }
}

fn find_coding_cookie(bytes: &[u8]) -> Option<(String, usize)> {
    for (line_index, line) in first_two_lines(bytes).into_iter().enumerate() {
        let chars: Vec<char> = line.iter().map(|byte| char::from(*byte)).collect();
        if let Some(name) = parse_cookie_line(&chars) {
            return Some((name, line_index));
        }
    }
    None
}

fn first_two_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::with_capacity(2);
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            let end = if index > start && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            lines.push(&bytes[start..end]);
            start = index + 1;
            if lines.len() == 2 {
                return lines;
            }
        }
    }
    if lines.len() < 2 {
        let end = bytes.len();
        let end = if end > start && bytes[end - 1] == b'\r' {
            end - 1
        } else {
            end
        };
        lines.push(&bytes[start..end]);
    }
    lines
}

fn parse_cookie_line(line: &[char]) -> Option<String> {
    let mut cursor = 0;
    while cursor < line.len() && matches!(line[cursor], ' ' | '\t' | '\u{000c}') {
        cursor += 1;
    }
    if line.get(cursor) != Some(&'#') {
        return None;
    }
    cursor += 1;
    while cursor < line.len() {
        let rest: String = line[cursor..].iter().collect();
        let found = rest.find("coding")?;
        cursor += found + "coding".len();
        while cursor < line.len() && matches!(line[cursor], ' ' | '\t') {
            cursor += 1;
        }
        if !matches!(line.get(cursor), Some(':') | Some('=')) {
            continue;
        }
        cursor += 1;
        while cursor < line.len() && matches!(line[cursor], ' ' | '\t') {
            cursor += 1;
        }
        let start = cursor;
        while cursor < line.len()
            && (line[cursor].is_ascii_alphanumeric() || matches!(line[cursor], '-' | '_' | '.'))
        {
            cursor += 1;
        }
        if cursor > start {
            return Some(line[start..cursor].iter().collect());
        }
    }
    None
}

fn decode_utf8(bytes: &[u8]) -> Result<String, DecodeError> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|err| DecodeError::InvalidUtf8 {
            offset: err.valid_up_to(),
        })
}

fn decode_ascii(bytes: &[u8]) -> Result<String, DecodeError> {
    for (offset, byte) in bytes.iter().enumerate() {
        if !byte.is_ascii() {
            return Err(DecodeError::InvalidAscii { offset });
        }
    }
    Ok(bytes.iter().map(|byte| char::from(*byte)).collect())
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, DecodeError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(DecodeError::InvalidUtf16 {
            offset: bytes.len() - 1,
        });
    }
    let units = bytes.as_chunks::<2>().0.iter().map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    let mut out = String::with_capacity(bytes.len() / 2);
    let mut offset = 0;
    let mut iter = units;
    while let Some(unit) = iter.next() {
        let current_offset = offset;
        offset += 2;
        let decoded = if (0xD800..=0xDBFF).contains(&unit) {
            let Some(low) = iter.next() else {
                return Err(DecodeError::InvalidUtf16 {
                    offset: current_offset,
                });
            };
            offset += 2;
            if !(0xDC00..=0xDFFF).contains(&low) {
                return Err(DecodeError::InvalidUtf16 {
                    offset: current_offset,
                });
            }
            let scalar = 0x1_0000 + ((u32::from(unit) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
            char::from_u32(scalar)
        } else if (0xDC00..=0xDFFF).contains(&unit) {
            None
        } else {
            char::from_u32(u32::from(unit))
        };
        let Some(decoded) = decoded else {
            return Err(DecodeError::InvalidUtf16 {
                offset: current_offset,
            });
        };
        out.push(decoded);
    }
    Ok(out)
}

fn decode_cp1252(bytes: &[u8]) -> Result<String, DecodeError> {
    let mut out = String::with_capacity(bytes.len());
    for (offset, byte) in bytes.iter().copied().enumerate() {
        let decoded = if (0x80..=0x9F).contains(&byte) {
            cp1252_punctuation(byte).ok_or(DecodeError::InvalidCp1252 { offset, byte })?
        } else {
            char::from(byte)
        };
        out.push(decoded);
    }
    Ok(out)
}

fn cp1252_punctuation(byte: u8) -> Option<char> {
    Some(match byte {
        0x80 => '\u{20AC}',
        0x82 => '\u{201A}',
        0x83 => '\u{0192}',
        0x84 => '\u{201E}',
        0x85 => '\u{2026}',
        0x86 => '\u{2020}',
        0x87 => '\u{2021}',
        0x88 => '\u{02C6}',
        0x89 => '\u{2030}',
        0x8A => '\u{0160}',
        0x8B => '\u{2039}',
        0x8C => '\u{0152}',
        0x8E => '\u{017D}',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '\u{2022}',
        0x96 => '\u{2013}',
        0x97 => '\u{2014}',
        0x98 => '\u{02DC}',
        0x99 => '\u{2122}',
        0x9A => '\u{0161}',
        0x9B => '\u{203A}',
        0x9C => '\u{0153}',
        0x9E => '\u{017E}',
        0x9F => '\u{0178}',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_and_strips_utf8_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"class Avatar:\n    pass\n");
        let decoded = decode_source(&bytes).unwrap();
        assert_eq!(decoded.detection.encoding, Encoding::Utf8Bom);
        assert_eq!(decoded.detection.source, EncodingSource::Bom);
        assert_eq!(decoded.detection.bom_len, 3);
        assert_eq!(decoded.text, "class Avatar:\n    pass\n");
    }

    #[test]
    fn detects_and_decodes_utf16_boms() {
        let text = "class 头像:\n    pass\n";
        let mut le = UTF16LE_BOM.to_vec();
        let mut be = UTF16BE_BOM.to_vec();
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_source(&le).unwrap().text, text);
        assert_eq!(decode_source(&be).unwrap().text, text);
    }

    #[test]
    fn reads_pep263_cookie_on_first_and_second_line() {
        let first = b"# -*- coding: latin-1 -*-\nclass A:\n    pass\n";
        let detected = detect_encoding(first);
        assert_eq!(detected.encoding, Encoding::Latin1);
        assert_eq!(detected.source, EncodingSource::Cookie);
        assert_eq!(detected.cookie_line, Some(0));
        assert_eq!(detected.declared.as_deref(), Some("latin-1"));

        let second = b"#!/usr/bin/env python\r\n# coding=cp1252\r\nclass A:\r\n";
        let detected = detect_encoding(second);
        assert_eq!(detected.encoding, Encoding::Cp1252);
        assert_eq!(detected.cookie_line, Some(1));
    }

    #[test]
    fn ignores_cookie_outside_comment_or_after_two_lines() {
        let code = b"coding: latin-1\nclass A:\n    pass\n";
        assert_eq!(detect_encoding(code).source, EncodingSource::Default);
        let third = b"# header\n# header\n# coding: latin-1\n";
        assert_eq!(detect_encoding(third).source, EncodingSource::Default);
    }

    #[test]
    fn bom_wins_but_declared_cookie_is_retained() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"# coding: latin-1\nclass A:\n    pass\n");
        let detected = detect_encoding(&bytes);
        assert_eq!(detected.encoding, Encoding::Utf8Bom);
        assert_eq!(detected.source, EncodingSource::Bom);
        assert_eq!(detected.declared.as_deref(), Some("latin-1"));
        assert_eq!(
            decode_source(&bytes).unwrap().text,
            "# coding: latin-1\nclass A:\n    pass\n"
        );
    }

    #[test]
    fn decodes_latin1_and_cp1252_cookies() {
        let latin1 = b"# coding: latin-1\n# caf\xe9\n";
        let decoded = decode_source(latin1).unwrap();
        assert_eq!(decoded.text, "# coding: latin-1\n# café\n");

        let cp1252 = b"# coding: cp1252\n# \x93quoted\x94 \x80\n";
        let decoded = decode_source(cp1252).unwrap();
        assert_eq!(decoded.text, "# coding: cp1252\n# “quoted” €\n");
    }

    #[test]
    fn strict_utf8_reports_valid_prefix_offset() {
        let err = decode_source(b"class A:\n# \xFF\n").unwrap_err();
        assert_eq!(err, DecodeError::InvalidUtf8 { offset: 11 });
        assert!(err.to_string().contains("byte offset 11"));
    }

    #[test]
    fn unsupported_codec_is_detected_but_not_decoded() {
        let bytes = b"# -*- coding: gbk -*-\nclass A:\n    pass\n";
        let detected = detect_encoding(bytes);
        assert_eq!(detected.encoding, Encoding::Other("gbk".to_string()));
        assert_eq!(detected.source, EncodingSource::Cookie);
        assert_eq!(
            decode_source(bytes).unwrap_err(),
            DecodeError::UnsupportedEncoding("gbk".to_string())
        );
    }

    #[test]
    fn recognizes_common_cookie_aliases() {
        for (name, expected) in [
            ("utf8", Encoding::Utf8),
            ("UTF_8", Encoding::Utf8),
            ("utf-8-sig", Encoding::Utf8),
            ("us-ascii", Encoding::Ascii),
            ("iso8859-1", Encoding::Latin1),
            ("windows-1252", Encoding::Cp1252),
            ("utf16-be", Encoding::Utf16Be),
        ] {
            assert_eq!(Encoding::from_cookie(name), expected, "alias {name}");
        }
    }

    #[test]
    fn heuristic_bomless_utf16_only_for_unambiguous_nul_distribution() {
        let mut le = Vec::new();
        for unit in "class Avatar: pass\n".encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
        }
        let detected = detect_encoding(&le);
        assert_eq!(detected.encoding, Encoding::Utf16Le);
        assert_eq!(detected.source, EncodingSource::Heuristic);
        assert_eq!(decode_source(&le).unwrap().text, "class Avatar: pass\n");

        let utf8 = b"class Avatar:\n    pass\n";
        assert_eq!(detect_encoding(utf8).source, EncodingSource::Default);
    }

    #[test]
    fn utf16_odd_length_and_lone_surrogate_fail() {
        assert_eq!(
            decode_source(&[0xFF, 0xFE, 0x41]).unwrap_err(),
            DecodeError::InvalidUtf16 { offset: 2 }
        );
        let mut lone = UTF16LE_BOM.to_vec();
        lone.extend_from_slice(&0xD800u16.to_le_bytes());
        assert_eq!(
            decode_source(&lone).unwrap_err(),
            DecodeError::InvalidUtf16 { offset: 2 }
        );
    }

    #[test]
    fn canonical_names_are_stable_literals() {
        assert_eq!(Encoding::Utf8.canonical_name(), "utf-8");
        assert_eq!(Encoding::Utf8Bom.canonical_name(), "utf-8-sig");
        assert_eq!(Encoding::Utf16Le.canonical_name(), "utf-16-le");
        assert_eq!(Encoding::Utf16Be.canonical_name(), "utf-16-be");
        assert_eq!(Encoding::Latin1.canonical_name(), "latin-1");
        assert_eq!(Encoding::Cp1252.canonical_name(), "cp1252");
        assert_eq!(Encoding::Ascii.canonical_name(), "ascii");
        assert_eq!(Encoding::Other("gbk".into()).canonical_name(), "gbk");
    }

    #[test]
    fn decode_error_display_names_offset_and_byte() {
        assert_eq!(
            DecodeError::InvalidUtf8 { offset: 3 }.to_string(),
            "invalid UTF-8 at byte offset 3"
        );
        assert_eq!(
            DecodeError::InvalidUtf16 { offset: 4 }.to_string(),
            "invalid UTF-16 sequence at byte offset 4"
        );
        assert_eq!(
            DecodeError::InvalidAscii { offset: 7 }.to_string(),
            "non-ASCII byte at offset 7"
        );
        assert_eq!(
            DecodeError::InvalidCp1252 {
                offset: 5,
                byte: 0x81
            }
            .to_string(),
            "undefined CP1252 byte 0x81 at offset 5"
        );
        assert_eq!(
            DecodeError::UnsupportedEncoding("gbk".into()).to_string(),
            "unsupported source encoding: gbk"
        );
    }

    #[test]
    fn ascii_cookie_decodes_and_rejects_non_ascii_with_shifted_offset() {
        let ok = b"# coding: ascii\nprint('ok')\n";
        let decoded = decode_source(ok).unwrap();
        assert_eq!(decoded.detection.encoding, Encoding::Ascii);
        assert_eq!(decoded.text, "# coding: ascii\nprint('ok')\n");
        // Non-ASCII byte: the offset is a whole-file offset (the BOM is 0 in the
        // cookie case, yet the shifted branch still runs).
        let err = decode_source(b"# coding: ascii\nx = '\xFF'\n").unwrap_err();
        assert_eq!(err, DecodeError::InvalidAscii { offset: 21 });
    }

    #[test]
    fn cp1252_undefined_byte_reports_offset_and_byte() {
        let err = decode_source(b"# coding: cp1252\n# \x81\x8d\n").unwrap_err();
        assert_eq!(
            err,
            DecodeError::InvalidCp1252 {
                offset: 19,
                byte: 0x81
            }
        );
    }

    #[test]
    fn cp1252_punctuation_table_maps_every_defined_byte() {
        // Every byte in 0x80..=0x9F has a mapping except the undefined slots
        // (0x81/0x8D/0x8F/0x90/0x9D).
        let undefined = [0x81u8, 0x8D, 0x8F, 0x90, 0x9D];
        let defined: Vec<u8> = (0x80..=0x9F).filter(|b| !undefined.contains(b)).collect();
        let mut body = b"# coding: cp1252\n".to_vec();
        body.extend_from_slice(&defined);
        let decoded = decode_source(&body).unwrap();
        // After the 17 prefix characters each defined byte yields exactly 1
        // character (no undefined-byte error).
        assert_eq!(decoded.text.chars().skip(17).count(), defined.len());
        // Spot-check the key mappings.
        assert!(decoded.text.contains('\u{20AC}')); // 0x80 → €
        assert!(decoded.text.contains('\u{2019}')); // 0x92 → ’
        assert!(decoded.text.contains('\u{2014}')); // 0x97 → —
                                                    // Undefined byte: 0x81 reports InvalidCp1252.
        let mut bad = b"# coding: cp1252\n".to_vec();
        bad.push(0x81);
        assert!(matches!(
            decode_source(&bad),
            Err(DecodeError::InvalidCp1252 { byte: 0x81, .. })
        ));
    }

    #[test]
    fn utf32_boms_are_detected_but_not_decoded() {
        let mut le = UTF32LE_BOM.to_vec();
        le.extend_from_slice(&0x41u32.to_le_bytes());
        let detected = detect_encoding(&le);
        assert_eq!(detected.encoding, Encoding::Other("utf-32-le".to_string()));
        assert_eq!(detected.bom_len, 4);
        assert_eq!(
            decode_source(&le).unwrap_err(),
            DecodeError::UnsupportedEncoding("utf-32-le".to_string())
        );
        let mut be = UTF32BE_BOM.to_vec();
        be.extend_from_slice(0x41u32.to_be_bytes().as_slice());
        assert_eq!(
            detect_encoding(&be).encoding,
            Encoding::Other("utf-32-be".to_string())
        );
    }

    #[test]
    fn bomless_heuristic_rejects_short_or_ambiguous_input() {
        // Fewer than 4 bytes: the heuristic is not enabled.
        assert_eq!(detect_encoding(b"ab").source, EncodingSource::Default);
        assert_eq!(detect_encoding(b"").source, EncodingSource::Default);
        // Even pairs but no NUL: plain text, not judged as UTF-16.
        assert_eq!(
            detect_encoding(b"class Avatar: pass").source,
            EncodingSource::Default
        );
        // All-zero leading bytes (high byte first) = BOM-less UTF-16 BE.
        let mut be = Vec::new();
        for unit in "class Monster: pass\n".encode_utf16() {
            be.extend_from_slice(&unit.to_be_bytes());
        }
        let detected = detect_encoding(&be);
        assert_eq!(detected.encoding, Encoding::Utf16Be);
        assert_eq!(detected.source, EncodingSource::Heuristic);
        assert_eq!(decode_source(&be).unwrap().text, "class Monster: pass\n");
    }

    #[test]
    fn cookie_without_separator_or_name_is_not_a_cookie() {
        // No :/= after "coding" -> not a cookie.
        assert_eq!(
            detect_encoding(b"# coding latin-1\nclass A:\n").source,
            EncodingSource::Default
        );
        // A separator with an empty declared name -> not a cookie.
        assert_eq!(
            detect_encoding(b"# coding:\nclass A:\n").source,
            EncodingSource::Default
        );
        // A declared name carrying legal characters such as dots and underscores.
        assert_eq!(
            detect_encoding(b"# coding: iso_8859-1.default\nclass A:\n").encoding,
            Encoding::Other("iso-8859-1.default".to_string())
        );
    }

    #[test]
    fn surrogate_pairs_decode_to_supplementary_chars() {
        let text = "class 胜利:\n    emoji = '🎉'\n";
        let mut le = UTF16LE_BOM.to_vec();
        let mut be = UTF16BE_BOM.to_vec();
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_source(&le).unwrap().text, text);
        assert_eq!(decode_source(&be).unwrap().text, text);
        // A high surrogate followed by a non-low surrogate -> the offset lands on
        // the surrogate start (2 after the BOM).
        let mut bad = UTF16LE_BOM.to_vec();
        bad.extend_from_slice(&0xD800u16.to_le_bytes());
        bad.extend_from_slice(&0x0041u16.to_le_bytes());
        assert_eq!(
            decode_source(&bad).unwrap_err(),
            DecodeError::InvalidUtf16 { offset: 2 }
        );
        // A lone low surrogate at the start -> invalid.
        let mut low = UTF16LE_BOM.to_vec();
        low.extend_from_slice(&0xDC00u16.to_le_bytes());
        assert_eq!(
            decode_source(&low).unwrap_err(),
            DecodeError::InvalidUtf16 { offset: 2 }
        );
    }

    #[test]
    fn cookie_line_ending_edge_cases() {
        // Second line ends with \r and has no newline: the cookie is still recognized.
        let cr_end = b"#!/usr/bin/env python\r\n# coding: latin-1\r";
        let detected = detect_encoding(cr_end);
        assert_eq!(detected.encoding, Encoding::Latin1);
        assert_eq!(detected.cookie_line, Some(1));
        // A single line without a newline.
        let one_line = b"# coding: cp1252";
        assert_eq!(detect_encoding(one_line).encoding, Encoding::Cp1252);
        // A utf-16 cookie (no BOM) decodes as LE; an odd total byte count -> an
        // odd-length error (offset at the last byte).
        let mut odd = b"# coding: utf-16\n".to_vec();
        odd.extend_from_slice(&0x41u16.to_le_bytes());
        odd.push(0x41);
        odd.push(0x42);
        assert_eq!(
            decode_source(&odd).unwrap_err(),
            DecodeError::InvalidUtf16 { offset: 20 }
        );
    }
}
