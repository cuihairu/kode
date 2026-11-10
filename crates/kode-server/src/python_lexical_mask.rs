//! Python 词法掩码(AUDIT-005 B2 车道批 2;TS 源 =
//! src/backend/pythonLexicalMask.ts,逐语义忠实移植)。
//!
//! 一次全文扫描:注释与字符串字面量(普通/三引号/原始/字节前缀)替换为
//! 同长度空白,f-string 的 `{...}` 表达式部分保留为可见代码、字面量部分
//! 掩掉。掩码保长保行(换行不掩),所有列偏移不变。词元 = ASCII `[A-Za-z0-9_]`
//! (JS `\w` 无 u 标志 = ASCII;Rust regex 默认 Unicode 语义不同,故手写)。
//!
//! 产物为 UTF-16 码元(`Vec<u16>`):TS 的 `match.index` 是 UTF-16 码元列
//! (JS 字符串按码元索引,`split('')` 亦按码元),对拍需同基底;非 ASCII
//! 字符(中文注释/字符串)按码元掩空白(码元 ≥0x80 非词元非点,不影响
//! `self.` 匹配,只作边界),字节计数不可用(多字节漂移)。

/// ASCII 词元(JS `\w`;trap 族共用判定,单源语义;码元常量 = a-z/A-Z/0-9/_)
pub(crate) fn is_word(code: u16) -> bool {
    matches!(code, 0x61..=0x7A | 0x41..=0x5A | 0x30..=0x39 | 0x5F)
}

fn is_quote(code: u16) -> bool {
    code == b'"' as u16 || code == b'\'' as u16
}

/// text[at..] 是否以 `quote` 重复 `count` 次开头(含边界)
fn quote_run_at(text: &[u16], at: usize, quote: u16, count: usize) -> bool {
    at + count <= text.len() && text[at..at + count].iter().all(|&code| code == quote)
}

/// 引号前的字符串前缀(如 r/f/rb/fr;非前缀字母串(如标识符)返回空串)
fn string_prefix_before(text: &[u16], quote_index: usize) -> &[u16] {
    let mut start = quote_index;
    while start > 0 && is_word(text[start - 1]) {
        start -= 1;
    }
    let run = &text[start..quote_index];
    let valid = run.len() <= 2
        && run
            .iter()
            .all(|&code| matches!((code as u8).to_ascii_lowercase(), b'r' | b'b' | b'f' | b'u'));
    if valid {
        run
    } else {
        &[]
    }
}

/// f-string 判定(TS `/f/i.test(prefix)`;无前缀 = 非 f)
fn is_fstring(text: &[u16], quote_index: usize) -> bool {
    string_prefix_before(text, quote_index)
        .iter()
        .any(|&code| (code as u8).to_ascii_lowercase() == b'f')
}

/// 掩掉 text[start..] 起的一个字符串字面量(含引号),返回结束后的下标。
/// f-string:字面量部分掩掉,遇 `{`(非 `{{`)进入表达式段——表达式段保持
/// 可见,内嵌字符串/注释递归掩掉,配对 `}` 回到字面量段。
fn mask_string_at(text: &[u16], out: &mut [u16], start: usize) -> usize {
    let n = text.len();
    let quote = text[start];
    let fstring = is_fstring(text, start);
    let triple = quote_run_at(text, start, quote, 3);
    let open_len = if triple { 3 } else { 1 };
    blank(text, out, start, start + open_len);
    let mut i = start + open_len;
    let mut fexpr_depth = 0usize;
    while i < n {
        let code = text[i];
        if fexpr_depth > 0 {
            if code == b'{' as u16 {
                fexpr_depth += 1;
                i += 1;
                continue;
            }
            if code == b'}' as u16 {
                fexpr_depth -= 1;
                i += 1;
                continue;
            }
            if code == b'#' as u16 {
                i = mask_comment_at(text, out, i);
                continue;
            }
            if is_quote(code) {
                i = mask_string_at(text, out, i);
                continue;
            }
            i += 1;
            continue;
        }
        if fstring {
            if code == quote && (!triple || quote_run_at(text, i, quote, 3)) {
                let close_len = if triple { 3 } else { 1 };
                blank(text, out, i, i + close_len);
                return i + close_len;
            }
            if code == b'{' as u16 && text.get(i + 1) == Some(&(b'{' as u16)) {
                blank(text, out, i, i + 2);
                i += 2;
                continue;
            }
            if code == b'{' as u16 {
                fexpr_depth = 1;
                i += 1;
                continue;
            }
            if code == b'\\' as u16 {
                blank(text, out, i, i + 2);
                i += 2;
                continue;
            }
            blank(text, out, i, i + 1);
            i += 1;
            continue;
        }
        // 普通字符串:掩到结束引号/行尾(转义成对跳过)
        if code == b'\\' as u16 {
            blank(text, out, i, i + 2);
            i += 2;
            continue;
        }
        if code == quote {
            if triple && !quote_run_at(text, i, quote, 3) {
                blank(text, out, i, i + 1); // 三引号串内的单引号,掩 1 字符继续
                i += 1;
                continue;
            }
            blank(text, out, i, i + open_len);
            return i + open_len;
        }
        if !triple && (code == b'\n' as u16 || code == b'\r' as u16) {
            return i; // 未闭合单引号串终止于行尾(换行不掩)
        }
        blank(text, out, i, i + 1);
        i += 1;
    }
    n
}

/// 掩 [from..to)(换行/回车不掩,保行)
fn blank(text: &[u16], out: &mut [u16], from: usize, to: usize) {
    let end = to.min(text.len());
    for k in from..end {
        if text[k] != b'\n' as u16 && text[k] != b'\r' as u16 {
            out[k] = b' ' as u16;
        }
    }
}

/// 顶层代码段掩一行内注释(到行尾)
fn mask_comment_at(text: &[u16], out: &mut [u16], start: usize) -> usize {
    let n = text.len();
    let mut j = start;
    while j < n {
        let code = text[j];
        if code == b'\n' as u16 || code == b'\r' as u16 {
            break;
        }
        out[j] = b' ' as u16;
        j += 1;
    }
    j
}

/// 全文一次扫描产出掩码(UTF-16 码元,与输入等码元长,换行原样保留)。
pub fn mask_python_non_code(text: &str) -> Vec<u16> {
    let original: Vec<u16> = text.encode_utf16().collect();
    let mut out = original.clone();
    let n = out.len();
    let mut i = 0usize;
    let mut fexpr_depth = 0usize;
    while i < n {
        let code = original[i];
        if fexpr_depth > 0 {
            if code == b'{' as u16 {
                fexpr_depth += 1;
                i += 1;
                continue;
            }
            if code == b'}' as u16 {
                fexpr_depth -= 1;
                i += 1;
                continue;
            }
            if code == b'#' as u16 {
                i = mask_comment_at(&original, &mut out, i);
                continue;
            }
            if is_quote(code) {
                i = mask_string_at(&original, &mut out, i);
                continue;
            }
            i += 1;
            continue;
        }
        if code == b'#' as u16 {
            i = mask_comment_at(&original, &mut out, i);
            continue;
        }
        if is_quote(code) {
            i = mask_string_at(&original, &mut out, i);
            continue;
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_string(masked: &[u16]) -> String {
        String::from_utf16(masked).unwrap()
    }

    #[test]
    fn masks_comments_and_strings_preserving_length() {
        let text = "x = 1 # comment\nname = 'a,b#c'\nd = f\"{value}, lit\"\n";
        let masked = mask_python_non_code(text);
        assert_eq!(masked.len(), text.encode_utf16().count());
        let masked = to_string(&masked);
        assert!(masked.contains("x = 1 "));
        assert!(!masked.contains("comment"));
        assert!(!masked.contains("a,b"));
        // f-string 表达式段可见
        assert!(masked.contains("value"));
        assert!(!masked.contains("lit"));
    }

    #[test]
    fn masks_triple_quoted_strings() {
        let text = "x = '''line1\nline2'''\ny = 1\n";
        let masked = to_string(&mask_python_non_code(text));
        assert!(masked.contains("y = 1"));
        assert!(!masked.contains("line1"));
    }

    #[test]
    fn masks_non_ascii_without_panic_and_preserves_code() {
        // 非 ASCII(中文注释/字符串)按码元掩空白,不 panic、不漂移
        let text = "# 中文注释 self.velocity\nprint('速度', self.position)\n";
        let masked = to_string(&mask_python_non_code(text));
        assert!(!masked.contains("velocity"));
        // 可见代码自访问保留
        assert!(masked.contains("self.position"));
    }
}
