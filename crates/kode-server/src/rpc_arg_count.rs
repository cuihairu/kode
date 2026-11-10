//! rpcArgCount 诊断词法计数面(AUDIT-005 B2 车道批 8,IDE-LINT-008/KBE-PY-009
//! 用户令 2026-11-06):TS 供给调用点发现面(findPythonReceiverCalls 走掩码文本,
//! 列偏移不变)+语义闸(mapping.methods 声明对账/段匹配/星号形参,消息渲染留
//! TS 单一来源);Rust 只做 `countCallArguments` 逐字移植——**原文**自持字符串/
//! 注释词法态(字符串里的逗号/括号/星号不计,注释到行尾,顶层逗号即实参分隔),
//! 括号栈跨行计数,星号实参/括号不闭合/名后非 '(' → null(未知,TS 不报)。
//! UTF-16 码元基底;`\s` = JS 全类(批 7 crlf/js-space 对拍口径:NBSP/全角空格
//! 都算空白);行切分 = `split(/\r?\n/)` 语义(只剥紧邻 \n 的 \r,末行孤尾 \r
//! 保留——本计数面尾 \r 属空白不可区分,保留为忠实实现面)。响应
//! {counts:[u64|null]} 与 calls 序对齐(未知=null 合法面,非错误)。

use serde::Deserialize;
use serde_json::Value;

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeRpcArgCount", analyze_rpc_arg_count);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RpcArgCountParams {
    /// 原文(计数面自持词法态,发现面掩码坐标在原文同位)
    text: String,
    /// TS 发现面调用点(结构子集,序即 counts 对齐序)
    calls: Vec<CallItem>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CallItem {
    line: usize,
    character: usize,
    method_name: String,
}

#[derive(serde::Serialize)]
struct RpcArgCountReport {
    counts: Vec<Option<u64>>,
}

fn analyze_rpc_arg_count(params: Value) -> Result<Value, String> {
    let params: RpcArgCountParams = serde_json::from_value(params).map_err(|err| err.to_string())?;
    let lines = split_lines(&params.text);
    let counts = params
        .calls
        .iter()
        .map(|call| {
            let method: Vec<u16> = call.method_name.encode_utf16().collect();
            count_call_arguments(&lines, call.line, call.character, &method)
        })
        .collect();
    let report = RpcArgCountReport { counts };
    serde_json::to_value(report).map_err(|err| err.to_string())
}

/// 行内 regex `\s` 全类(JS spec,批 7 js-space 对拍口径;窄 ASCII 类在
/// NBSP/全角缩进上会与 TS 分歧)
fn is_regex_space(code: u16) -> bool {
    matches!(
        code,
        0x09 | 0x0A
            | 0x0B
            | 0x0C
            | 0x0D
            | 0x20
            | 0xA0
            | 0x1680
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    ) || (0x2000..=0x200A).contains(&code)
}

/// 行切分 = TS `split(/\r?\n/)`(只剥紧邻 \n 的一个 \r;末行无 \n,尾 \r 保留;
/// 行内孤 \r 保留)
fn split_lines(text: &str) -> Vec<Vec<u16>> {
    let all: Vec<u16> = text.encode_utf16().collect();
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for &code in &all {
        if code == 10 {
            let mut line = std::mem::take(&mut current);
            if line.last() == Some(&0x0D) {
                line.pop();
            }
            lines.push(line);
        } else {
            current.push(code);
        }
    }
    lines.push(current);
    lines
}

/// 三连引号检查(TS `text.startsWith(q.repeat(3), col)`)
fn starts_with_triple(text: &[u16], at: usize, q: u16) -> bool {
    at + 3 <= text.len() && text[at] == q && text[at + 1] == q && text[at + 2] == q
}

/// TS countCallArguments 逐字移植:名后同行找 '('(先出其他非空白 token →
/// 形态不明);括号闭符号栈(调用自身 '(' 是根不入栈),栈空见 ')' 收口返回、
/// 见逗号分段计数;字符串态(引号定界,转义吞下一字符,三引号 3 格出);
/// '#' 注释到行尾;段首 '*' → 解包/收集不可判定;未闭合到文件尾 → None。
fn count_call_arguments(
    lines: &[Vec<u16>],
    line: usize,
    character: usize,
    method: &[u16],
) -> Option<u64> {
    let name_end = character + method.len();
    let first_line: &[u16] = lines.get(line).map(|v| v.as_slice()).unwrap_or(&[]);

    // 方法名后同行找 '(';先出现其他非空白 token → 形态不明,未知
    let mut open_paren = None;
    for i in name_end..first_line.len() {
        let ch = first_line[i];
        if ch == 0x28 {
            open_paren = Some(i);
            break;
        }
        if !is_regex_space(ch) {
            return None;
        }
    }
    let open_paren = open_paren?;

    let mut count: u64 = 0;
    // 括号闭符号栈:调用自身 '(' 是根(不入栈),其内嵌套 ( [ { 才入栈;
    // 栈空时看到的 ')' 即调用闭合,栈空时看到的逗号即顶层实参分隔。
    let mut closer_stack: Vec<u16> = Vec::new();
    let mut at_segment_start = true; // 段首(括号后/逗号后)
    let mut segment_has_star = false; // 段首出现 '*' → 解包/收集,数量不可判定
    let mut segment_has_code = false; // 段内出现实参内容(逗号前)
    let mut in_string: Option<u16> = None; // 字符串定界引号;None=不在字符串
    let mut triple_string = false;

    for line_idx in line..lines.len() {
        let text: &[u16] = &lines[line_idx];
        let mut col = if line_idx == line { open_paren + 1 } else { 0 };
        while col < text.len() {
            let ch = text[col];
            // 字符串态:引号内一切字符不计(含逗号/括号/星号/注释符)
            if let Some(q) = in_string {
                if ch == 0x5C {
                    col += 2; // 转义吞下一字符
                    continue;
                }
                if triple_string {
                    if starts_with_triple(text, col, q) {
                        in_string = None;
                        triple_string = false;
                        col += 2; // 连同循环尾 +1 净跳 3 格(三连引号整体出)
                    }
                } else if ch == q {
                    in_string = None;
                }
                col += 1;
                continue;
            }
            // 引号进入字符串态(整个字符串是一个实参内容,不展开内部逗号)
            if ch == 0x22 || ch == 0x27 {
                triple_string = starts_with_triple(text, col, ch);
                in_string = Some(ch);
                if closer_stack.is_empty() {
                    segment_has_code = true;
                    at_segment_start = false;
                }
                if triple_string {
                    col += 3;
                } else {
                    col += 1;
                }
                continue;
            }
            // 注释:到行尾(行首续扫)
            if ch == 0x23 {
                break;
            }
            if closer_stack.is_empty() {
                if ch == 0x29 {
                    if segment_has_star {
                        return None;
                    }
                    if segment_has_code {
                        count += 1;
                    }
                    return Some(count);
                }
                if ch == 0x2C {
                    if segment_has_star {
                        return None;
                    }
                    if segment_has_code {
                        count += 1;
                    }
                    at_segment_start = true;
                    segment_has_star = false;
                    segment_has_code = false;
                    col += 1;
                    continue;
                }
                // 嵌套结构整段算一个实参内容;段内星号不影响外层计数
                if ch == 0x28 {
                    closer_stack.push(0x29);
                    segment_has_code = true;
                    at_segment_start = false;
                    col += 1;
                    continue;
                }
                if ch == 0x5B {
                    closer_stack.push(0x5D);
                    segment_has_code = true;
                    at_segment_start = false;
                    col += 1;
                    continue;
                }
                if ch == 0x7B {
                    closer_stack.push(0x7D);
                    segment_has_code = true;
                    at_segment_start = false;
                    col += 1;
                    continue;
                }
                if ch == 0x2A && at_segment_start {
                    segment_has_star = true;
                    col += 1;
                    continue;
                }
                if !is_regex_space(ch) {
                    segment_has_code = true;
                    at_segment_start = false;
                }
                col += 1;
                continue;
            }
            // 嵌套深度 >0:只记括号配对,不参与顶层实参统计
            let top = *closer_stack.last().expect("stack checked non-empty");
            if ch == top {
                closer_stack.pop();
            } else if ch == 0x28 {
                closer_stack.push(0x29);
            } else if ch == 0x5B {
                closer_stack.push(0x5D);
            } else if ch == 0x7B {
                closer_stack.push(0x7D);
            }
            col += 1;
        }
    }
    None // '(' 到文件尾未闭合:形态不明,未知
}

// ---- 单测 -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const P: &str = "self.cell.";

    fn count(text: &str, line: usize, character: usize, method: &str) -> Option<u64> {
        let lines = split_lines(text);
        count_call_arguments(&lines, line, character, method.encode_utf16().collect::<Vec<u16>>().as_slice())
    }

    fn count_first(text: &str, method: &str) -> Option<u64> {
        count(text, 0, P.len(), method)
    }

    #[test]
    fn basic_top_level_comma_counting() {
        assert_eq!(count_first("self.cell.foo()", "foo"), Some(0));
        assert_eq!(count_first("self.cell.foo(1)", "foo"), Some(1));
        assert_eq!(count_first("self.cell.foo(1, 2)", "foo"), Some(2));
        assert_eq!(count_first("self.cell.foo( 1 , 2 , 3 )", "foo"), Some(3));
        assert_eq!(count_first("self.cell.foo(1,)", "foo"), Some(1)); // 尾随逗号不多计
    }

    #[test]
    fn shape_failures_are_null() {
        // 名后无 '(' / 名后先出其他 token / 行尾无括号
        assert_eq!(count_first("self.cell.foo", "foo"), None);
        assert_eq!(count_first("self.cell.foo x(1)", "foo"), None);
        assert_eq!(count("x\nself.cell.foo", 1, P.len(), "foo"), None);
        // 行号越界(空行替身同 TS ?? '' 口径)
        assert_eq!(count("", 3, 0, "foo"), None);
    }

    #[test]
    fn whitespace_before_paren_ok() {
        assert_eq!(count_first("self.cell.foo (1, 2)", "foo"), Some(2));
    }

    #[test]
    fn star_argument_is_undecidable() {
        assert_eq!(count_first("self.cell.foo(*args)", "foo"), None);
        assert_eq!(count_first("self.cell.foo(1, *kw)", "foo"), None);
        assert_eq!(count_first("self.cell.foo(**kw)", "foo"), None);
        // 二元乘法星号不触发(非段首)
        assert_eq!(count_first("self.cell.foo(a * b)", "foo"), Some(1));
    }

    #[test]
    fn strings_do_not_count_separators() {
        assert_eq!(count_first("self.cell.foo(\"a,b\", 2)", "foo"), Some(2));
        assert_eq!(count_first("self.cell.foo(\"(x)\")", "foo"), Some(1));
        assert_eq!(count_first("self.cell.foo('a\\'b', 1)", "foo"), Some(2));
        assert_eq!(count_first("self.cell.foo(\"\"\"a,b(c)\"\"\", 1)", "foo"), Some(2));
    }

    #[test]
    fn comments_break_line_but_scan_continues() {
        // 注释后换行续扫:foo(1, # c\n 2) 计 2
        assert_eq!(count_first("self.cell.foo(1, # c\n 2)", "foo"), Some(2));
        assert_eq!(count_first("self.cell.foo(1, 2) # , 3", "foo"), Some(2));
    }

    #[test]
    fn nested_brackets_count_as_one_argument() {
        assert_eq!(count_first("self.cell.foo([1, 2], (a, b))", "foo"), Some(2));
        assert_eq!(count_first("self.cell.foo(f(1, 2), 3)", "foo"), Some(2));
        assert_eq!(count_first("self.cell.foo({\"k\": 1})", "foo"), Some(1));
    }

    #[test]
    fn cross_line_and_unclosed() {
        assert_eq!(count("x = self.cell.foo(\n  1,\n  2\n)", 0, P.len() + 4, "foo"), Some(2));
        assert_eq!(count("x = self.cell.foo(1,", 0, P.len() + 4, "foo"), None);
    }

    #[test]
    fn crlf_lines_count_same() {
        assert_eq!(count("self.cell.foo(1,\r\n 2)", 0, P.len(), "foo"), Some(2));
    }

    #[test]
    fn second_line_call_counts() {
        // 第二行调用点:行号偏移正确解析(第一行内容不干扰)
        let text = "self.cell.a(1)\nself.cell.b(1, 2)\n";
        assert_eq!(count(text, 1, P.len(), "b"), Some(2));
    }

    #[test]
    fn report_shape_serializes_nulls() {
        let report = RpcArgCountReport { counts: vec![Some(2), None] };
        let encoded = serde_json::to_value(&report).unwrap();
        assert_eq!(encoded["counts"], json!([2, null]));
    }
}
