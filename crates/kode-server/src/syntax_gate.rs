//! INDEX-DISCIPLINE-001 ③:python 索引输入语法门——轻量预检纯核(Rust 主
//! 路径,TS 侧 `src/backend/syntaxGate.ts` 镜像回退同构)。
//!
//! 用户令(2026-11-18):「py 文件编辑好之后 py_compile 编译之后再索引,
//! 存在错误也没必要索引」+ 纪律修订「不引 py_compile/子进程」——本核是
//! 单遍扫描器级预检(微秒级,零 spawn):
//! - 括号配平:`()`/`[]`/`{}` 跨行配平(字符串与注释内的括号不计);
//! - 引号配平:`'`/`"`/`'''`/`"""` 配平(转义 honoring;单引号字符串内
//!   裸换行 = 未闭合);
//! - 缩进一致性:tab/space 混用、dedent 落到未出现过的层级 → 烂。
//!
//! **宁漏勿冤**:本门是粗检,只拦「确定烂」(编辑中途的显式断裂);假 OK
//! 可接受(真诊断链照常报错),假 NO 不可接受(会让索引饿死)。续行
//! (行尾反斜杠)/括号内换行/三引号串体内的缩进一律不判。
//!
//! 消费纪律(用户令):不过关 → 跳过符号入索引和绑定,索引保留上一次
//! 健康版本符号(编辑中导航不断);诊断面照旧由既有诊断链报语法错,本门
//! 不产诊断只做闸;保存过关 → 自动重新全量索引(onDidSave 链)。

use crate::rpc::RpcRegistry;
use serde_json::{json, Value};

/// 预检结果:`ok=false` 时 reasons 带行号定位(供日志/观测面,不进诊断)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxGateResult {
    pub ok: bool,
    pub reasons: Vec<String>,
}

/// 单遍扫描预检。输入为文件全文;输出见 [`SyntaxGateResult`]。
pub fn syntax_gate(text: &str) -> SyntaxGateResult {
    let mut reasons: Vec<String> = Vec::new();
    // 括号栈:(字符, 行号)
    let mut brackets: Vec<(char, usize)> = Vec::new();
    // 缩进层级(字面前缀集合);首个非空白缩进定 tab/space 基调
    let mut levels: Vec<String> = Vec::new();
    let mut indent_char: Option<char> = None;
    let mut in_triple_string = false;
    let mut physical_line = 0usize;
    let mut lines_iter = text.split('\n');
    let mut pending: Option<String> = None; // 续行缓冲(行尾反斜杠)

    while let Some(raw_line) = lines_iter.next().map(|l| {
        // CRLF 容错:剥离行尾 \r(计数仍按物理行)
        l.strip_suffix('\r').unwrap_or(l)
    }) {
        physical_line += 1;
        let line = pending.take().unwrap_or_default() + raw_line;
        let line_no = physical_line;

        // 三引号串体内:只找收尾引号(缩进/括号一律不判)
        if in_triple_string {
            if let Some(close_col) = find_close_triple(&line) {
                in_triple_string = false;
                // 串后同行还有内容——按普通段扫过;串后又开新三引号则回三引号态
                if scan_segment(&line[close_col + 3..], line_no, &mut brackets, &mut reasons) {
                    in_triple_string = true;
                }
            }
            continue;
        }

        // 续行(行尾反斜杠):先并再扫——本物理行不判定,并入下一物理行;
        // 否则 `'abc \` 这类反斜杠续字符串会被误判 unterminated。
        if line.ends_with('\\') {
            pending = Some(line[..line.len() - 1].to_string());
            continue;
        }

        // 行首缩进判定(空行/纯注释行/括号未闭/上一行续行 → 不判)
        let trimmed_start = line.len() - line.trim_start_matches([' ', '\t']).len();
        let indent = &line[..trimmed_start];
        let rest = &line[trimmed_start..];
        let is_blank = rest.is_empty();
        let is_comment = rest.starts_with('#');
        let in_brackets = !brackets.is_empty();
        if !is_blank && !is_comment && !in_brackets {
            if !indent.is_empty() {
                // 基调检查:tab/space 混用(行内混用或跨行换基调都拦)
                let has_space = indent.contains(' ');
                let has_tab = indent.contains('\t');
                if has_space && has_tab {
                    reasons.push(format!("mixed-indent at line {line_no}"));
                } else {
                    let this_char = if has_tab { '\t' } else { ' ' };
                    match indent_char {
                        None => indent_char = Some(this_char),
                        Some(prev) if prev != this_char => {
                            reasons.push(format!("mixed-indent at line {line_no}"));
                        }
                        _ => {}
                    }
                }
                // dedent 一致性:缩进前缀必须命中既有层级之一(或作为新深缩进入栈)
                if !levels.iter().any(|lvl| lvl == indent) {
                    // 新层级合法当且仅当它比当前最深层级更深(扩展);
                    // 否则 = dedent 到未出现过的层级 = 烂
                    let deepest = levels.last().map(|s| s.len()).unwrap_or(0);
                    if indent.len() < deepest {
                        reasons.push(format!("inconsistent-dedent at line {line_no}"));
                    } else {
                        levels.push(indent.to_string());
                    }
                } else {
                    // 回到既有层级:更深层级出栈
                    while levels.last().map(|s| s.as_str()) != Some(indent) {
                        levels.pop();
                    }
                }
            } else if !levels.is_empty() {
                // 顶格非空行:全部层级出栈
                levels.clear();
            }
        }
        if !is_blank && !is_comment {
            // 行体扫描(括号/引号;引号开三引号串则置态)——括号未闭/续行
            // 只是不判缩进,行体照扫(括号跨行配平)。
            if scan_segment(rest, line_no, &mut brackets, &mut reasons) {
                in_triple_string = true;
            }
        }
    }

    if in_triple_string {
        reasons.push("unterminated-string at EOF".to_string());
    }
    for (open, line_no) in brackets {
        reasons.push(format!("unclosed-bracket '{open}' from line {line_no}"));
    }

    SyntaxGateResult {
        ok: reasons.is_empty(),
        reasons,
    }
}

/// 段扫描:只做括号配平与未闭合字符串定位(缩进判定不在此面)。
/// 字节下标推进(ASCII 引号/括号/反斜杠语义按字节处理即可)。
/// 返回 `true` = 段内开了未闭的三引号串(调用方须置三引号态)。
fn scan_segment(
    segment: &str,
    line_no: usize,
    brackets: &mut Vec<(char, usize)>,
    reasons: &mut Vec<String>,
) -> bool {
    let bytes = segment.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'#' => return false,
            b'\\' => {
                i += 2;
            }
            b'\'' | b'"' => {
                let triple = bytes.get(i + 1) == Some(&b) && bytes.get(i + 2) == Some(&b);
                if triple {
                    // 三引号串在段中途开:收尾判定交由外层三引号态,此处停止
                    return true;
                }
                let mut probe = i + 1;
                let mut closed = false;
                while probe < bytes.len() {
                    if bytes[probe] == b'\\' {
                        probe += 2;
                        continue;
                    }
                    if bytes[probe] == b {
                        closed = true;
                        break;
                    }
                    probe += 1;
                }
                if !closed {
                    reasons.push(format!("unterminated-string at line {line_no}"));
                    return false;
                }
                i = probe + 1;
            }
            b'(' | b'[' | b'{' => {
                brackets.push((b as char, line_no));
                i += 1;
            }
            b')' | b']' | b'}' => {
                let expect = match b {
                    b')' => '(',
                    b']' => '[',
                    _ => '{',
                };
                match brackets.last() {
                    Some((open, _)) if *open == expect => {
                        brackets.pop();
                    }
                    Some((open, open_line)) => {
                        let want = match open {
                            '(' => ')',
                            '[' => ']',
                            _ => '{',
                        };
                        reasons.push(format!(
                            "unbalanced-bracket at line {line_no} (expected '{want}' for line {open_line})"
                        ));
                        brackets.pop();
                    }
                    None => {
                        reasons.push(format!("unbalanced-bracket at line {line_no}"));
                    }
                }
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }
    false
}

/// 在行内找三引号收尾(`'''` 或 `"""` 尊重转义);返回起始字节位。
fn find_close_triple(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        let is_single = bytes[i] == b'\''
            && bytes.get(i + 1) == Some(&b'\'')
            && bytes.get(i + 2) == Some(&b'\'');
        let is_double =
            bytes[i] == b'"' && bytes.get(i + 1) == Some(&b'"') && bytes.get(i + 2) == Some(&b'"');
        if is_single || is_double {
            return Some(i);
        }
        i += 1;
    }
    None
}

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/syntax/gate", syntax_gate_handler);
}

/// `$/kode/syntax/gate` 桥:{text} → {ok, reasons}。缺 text 如实 Err。
fn syntax_gate_handler(params: Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "syntaxGate: text (string) required".to_string())?;
    let result = syntax_gate(text);
    Ok(json!({ "ok": result.ok, "reasons": result.reasons }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_healthy_python() {
        let src = "class Avatar(object):\n    def __init__(self):\n        self.x = [1, 2, {'k': (1, 2)}]\n        s = \"tricky '\\\" quote\"\n";
        let result = syntax_gate(src);
        assert!(result.ok, "reasons={:?}", result.reasons);
    }

    #[test]
    fn accepts_triple_string_with_brackets_inside() {
        let src = "def f():\n    doc = '''\n    ))))((({{{  [[[\n    not code at all\n    '''\n    return doc\n";
        assert!(syntax_gate(src).ok);
    }

    #[test]
    fn accepts_multiline_bracket_continuation() {
        let src = "values = [\n    1,\n        2,  # 括号内缩进随意\n]\n";
        assert!(syntax_gate(src).ok);
    }

    #[test]
    fn rejects_unclosed_bracket() {
        let result = syntax_gate("def f(:\n    pass\n");
        assert!(!result.ok);
        assert!(result.reasons.iter().any(|r| r.contains("bracket")));
    }

    #[test]
    fn rejects_mismatched_bracket() {
        let result = syntax_gate("x = (1, 2]\n");
        assert!(!result.ok);
        assert!(result
            .reasons
            .iter()
            .any(|r| r.contains("unbalanced-bracket")));
    }

    #[test]
    fn rejects_unterminated_string() {
        let result = syntax_gate("x = 'abc\n");
        assert!(!result.ok);
        assert!(result
            .reasons
            .iter()
            .any(|r| r.contains("unterminated-string")));
    }

    #[test]
    fn rejects_unterminated_triple_string() {
        let result = syntax_gate("doc = '''\nstuff\n");
        assert!(!result.ok);
        assert!(result
            .reasons
            .iter()
            .any(|r| r.contains("unterminated-string")));
    }

    #[test]
    fn rejects_mixed_indent() {
        let result = syntax_gate("if True:\n    x = 1\n\ty = 2\n");
        assert!(!result.ok);
        assert!(result.reasons.iter().any(|r| r.contains("mixed-indent")));
    }

    #[test]
    fn rejects_inconsistent_dedent() {
        // dedent 到 2 空格(从未出现的层级)= 烂
        let result = syntax_gate("def f():\n        x = 1\n  y = 2\n");
        assert!(!result.ok);
        assert!(result
            .reasons
            .iter()
            .any(|r| r.contains("inconsistent-dedent")));
    }

    #[test]
    fn accepts_escaped_quotes_and_comments() {
        let src = "s = 'it\\'s fine'  # comment with ( unbalanced\n";
        assert!(syntax_gate(src).ok);
    }

    #[test]
    fn accepts_backslash_continuation_odd_indent() {
        // 续行(行尾反斜杠)下一行缩进不判
        let src = "total = 1 + \\\n        2\n";
        assert!(syntax_gate(src).ok);
    }

    #[test]
    fn handler_requires_text() {
        let err = syntax_gate_handler(json!({})).unwrap_err();
        assert!(err.contains("text"));
    }

    #[test]
    fn handler_roundtrip() {
        let out = syntax_gate_handler(json!({ "text": "x = (" })).unwrap();
        assert_eq!(out["ok"], false);
        assert!(!out["reasons"].as_array().unwrap().is_empty());
    }

    #[test]
    fn indent_mixed_dedent_pop_and_flush_clear_faces() {
        // 同一行内 space+tab 混用 → mixed-indent。
        let mixed = syntax_gate("x = 1\n \ty = 2\n");
        assert!(!mixed.ok, "reasons={:?}", mixed.reasons);
        assert!(mixed
            .reasons
            .iter()
            .any(|r| r.contains("mixed-indent at line 2")));
        // 回既有层级:更深层级出栈,合法 dedent。
        let dedent = syntax_gate("if a:\n    b = 1\n    if c:\n        d = 2\n    e = 5\n");
        assert!(dedent.ok, "reasons={:?}", dedent.reasons);
        // 顶格非空行:全部层级清栈。
        let flush = syntax_gate("x = 1\n    y = 2\nz = 3\n");
        assert!(flush.ok, "reasons={:?}", flush.reasons);
    }

    #[test]
    fn bracket_mismatch_maps_expected_and_empty_stack_closer() {
        // 错配闭符按开符映射期望字符(此处 [ 开在 ( 上,期望 ']')。
        let mismatched = syntax_gate("([)]\n");
        assert!(!mismatched.ok);
        assert!(mismatched
            .reasons
            .iter()
            .any(|r| r.contains("(expected ']' for line 1)")));
        // 空栈闭符:无 (expected 尾巴的裸报。
        let orphan = syntax_gate("x = )\n");
        assert!(!orphan.ok);
        assert!(orphan
            .reasons
            .iter()
            .any(|r| r == "unbalanced-bracket at line 1"));
    }

    #[test]
    fn string_reopen_after_close_code_backslash_and_body_escape() {
        // 三引号收尾后同线又开新三引号 → 重回三引号态,整体仍配平。
        let reopen = syntax_gate("a = \"\"\"text\nend\"\"\" b = \"\"\"\ntail\n\"\"\"\n");
        assert!(reopen.ok, "reasons={:?}", reopen.reasons);
        // 码位反斜杠(串外):字节对跳过,不影响配平。
        let code_bs = syntax_gate("a = 1 \\ 2\n");
        assert!(code_bs.ok, "reasons={:?}", code_bs.reasons);
        // 三引号体内转义对被跳过后才认收尾引号。
        let body_esc = syntax_gate("a = \"\"\"\nsay(\\\"hi\\\")\n\"\"\"\n");
        assert!(body_esc.ok, "reasons={:?}", body_esc.reasons);
    }
}
