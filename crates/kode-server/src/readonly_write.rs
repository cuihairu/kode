//! readOnlyWrite 诊断收编(AUDIT-005 B2 车道批 5):`$/kode/lint/analyzeReadOnlyWrite`。
//!
//! TS 源 = src/backend/readOnlyWriteDiagnostics.ts,逐语义忠实移植(对拍纪律):
//!   - 全量在 UTF-16 码元面(`Vec<u16>`)做扫描——TS `match.index` 是 UTF-16
//!     码元列,非 ASCII 行字节面会漂移;
//!   - 掩码 = crate::python_lexical_mask::mask_python_non_code(与 TS
//!     maskPythonNonCode 同源语义,保长保行,字符串/注释内容不误认);
//!   - `\bself\.(\w+)\b` 手工展开:左界 = 前码元非词元或文首;`\w+` 贪心吃满
//!     词元后尾随 `\b` 恒成立(下一码元必非词元或行末,无需回溯);
//!   - 写入形态分类(普通/增强/注解/del)逐形态移植:续写(`.`)/下标写(`[`)/
//!     比较(`==`)/海象(`:=`)/复合语句套件冒号(首个深度 0 冒号 + 复合关键字
//!     头)显式排除;增强赋值两字符先行、三字符(**= //= <<= >>=)补判;
//!   - 只读属性闸 = TS 供给 readonlyNames 集(face 语境已在 TS 解析:面表
//!     readonly 名集)——引擎属性表不过 Rust(单一来源留 TS),渲染面 TS 侧
//!     经 resolveEntityBuiltinPropertyHit 重解析作完整性校验(矛盾整面作废)。
//!
//! 入参 `{text, readonlyNames:[…]}`;出 `{items:[{code,line,character,length,
//! propertyName,kind}]}`,kind ∈ assign|augmented|annotated|del。消息不出 Rust。

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::python_lexical_mask::{is_word, mask_python_non_code};
use crate::rpc::RpcRegistry;

pub const CODE_READ_ONLY_WRITE: &str = "kbengine.readOnlyWrite";

/// TS COMPOUND_KEYWORDS:引入复合语句套件(一行体 `:`)的语句头关键字。
const COMPOUND_KEYWORDS: [&str; 13] = [
    "if", "elif", "else", "for", "while", "with", "try", "except", "finally", "def", "class", "match", "case",
];

/// TS AUGMENTED_OPS 两字符项(`//= **= <<= >>=` 三字符项单独补判)
const AUG_TWO: [&str; 9] = ["+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@="];
const AUG_THREE: [&str; 4] = ["//=", "**=", "<<=", ">>="];

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeReadOnlyWrite", analyze_read_only_write);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ReadOnlyWriteParams {
    text: String,
    /// TS 面表 readonly 名集(face 语境已解析)
    #[serde(default)]
    readonly_names: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlyWriteItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    property_name: String,
    kind: &'static str,
}

fn analyze_read_only_write(params: Value) -> Result<Value, String> {
    let params: ReadOnlyWriteParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let items = compute_read_only_write_items(&params.text, &params.readonly_names);
    Ok(json!({ "items": items }))
}

// ---- 基础词元/空白判定 -------------------------------------------------------

/// 行内空白 = 空格/制表(TS 形态检测面只认 `' '/'\t'`,与 \s 不同)
fn is_line_space(code: u16) -> bool {
    code == 0x20 || code == 0x09
}

/// TS 词首字符类 `[A-Za-z_]`(语句头词/del 判定用,不含数字)
fn is_name_start(code: u16) -> bool {
    code == 0x5F
        || (0x41..=0x5A).contains(&code)
        || (0x61..=0x7A).contains(&code)
}

fn is_name_char(code: u16) -> bool {
    is_name_start(code) || (0x30..=0x39).contains(&code)
}

fn starts_with(text: &[u16], at: usize, word: &str) -> bool {
    let mut expected = word.encode_utf16();
    for &code in text.get(at..).unwrap_or(&[]) {
        match expected.next() {
            Some(want) => {
                if code != want {
                    return false;
                }
            }
            None => return true, // 词元耗尽 = 前缀成立
        }
    }
    expected.next().is_none()
}

fn eq_u16(text: &[u16], word: &str) -> bool {
    text.len() == word.encode_utf16().count() && text.iter().copied().eq(word.encode_utf16())
}

/// 行切分 = `\r?\n`(剥 `\n` 前至多一个 `\r`)
fn split_lines(text: &[u16]) -> Vec<Vec<u16>> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for &code in text {
        if code == 0x0A {
            if let Some(last) = current.last() {
                if *last == 0x0D {
                    current.pop();
                }
            }
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(code);
        }
    }
    if let Some(last) = current.last() {
        if *last == 0x0D {
            current.pop();
        }
    }
    lines.push(current);
    lines
}

/// `line[at..at+n] == word`(窗口越界 = 不匹配,与 TS `?? ''` 短窗形态同语义:
/// 短窗永不命中集合)
fn window_is(line: &[u16], at: usize, word: &str) -> bool {
    let w: Vec<u16> = word.encode_utf16().collect();
    if at + w.len() > line.len() {
        return false;
    }
    line[at..at + w.len()].iter().copied().eq(w.iter().copied())
}

// ---- 写入形态分类(TS classifyWriteKindAfter / isSuiteColon 同构) ------------

/// `:` 是否为复合语句套件冒号:该冒号是所在简单语句内**首个**括号深度 0 冒号,
/// 且语句起始词是复合语句头关键字。
fn is_suite_colon(line: &[u16], colon_index: usize) -> bool {
    let mut depth: i64 = 0;
    let mut i: i64 = colon_index as i64 - 1;
    // 向左扫到简单语句边界(行首或括号深度 0 的 `;`);途中深度 0 冒号 =
    // 非首个深度 0 冒号 → 非套件冒号
    while i >= 0 {
        let ch = line[i as usize];
        if ch == 0x29 || ch == 0x5D || ch == 0x7D {
            depth += 1;
        } else if ch == 0x28 || ch == 0x5B || ch == 0x7B {
            depth -= 1;
        } else if ch == 0x3B && depth == 0 {
            break;
        } else if ch == 0x3A && depth == 0 {
            return false;
        }
        i -= 1;
    }
    // 语句起始(行首或 `;` 后)第一个词是否为复合关键字
    let mut j = (i + 1) as usize;
    while j < line.len() && is_line_space(line[j]) {
        j += 1;
    }
    let start = j;
    while j < line.len() && is_name_start(line[j]) {
        j += 1;
    }
    let word = &line[start..j];
    COMPOUND_KEYWORDS.iter().any(|k| eq_u16(word, k))
}

/// 匹配的 `self.<name>` 之后同行紧跟运算符分类;None = 非写目标
fn classify_write_kind_after(line: &[u16], after_index: usize) -> Option<&'static str> {
    let mut i = after_index;
    while i < line.len() && is_line_space(line[i]) {
        i += 1;
    }
    if i >= line.len() {
        return None;
    }
    let c = line[i];
    if c == 0x2E {
        return None; // self.<p>.x:续写属性,不是重绑定
    }
    if c == 0x5B {
        return None; // self.<p>[i]=x:下标写,不是重绑定
    }
    if c == 0x3D {
        if line.get(i + 1) == Some(&0x3D) {
            return None; // 比较 ==
        }
        return Some("assign"); // 普通赋值 =
    }
    if c == 0x3A {
        if line.get(i + 1) == Some(&0x3D) {
            return None; // 海象 :=(属性目标非法,不写)
        }
        // 复合语句套件冒号(if/for/while 一行体):体里的顶层 `=` 属体语句
        if is_suite_colon(line, i) {
            return None;
        }
        // 注解赋值 `: <类型> =`:同层(括号深度 0)、同语句(`;` 前)找到 `=`
        // 才算;`==`/`=>` 排除;行尾/切片/字典键位找不到顶层 `=` → 不写
        let mut depth: i64 = 0;
        let mut j = i;
        while j < line.len() {
            let ch = line[j];
            if ch == 0x28 || ch == 0x5B || ch == 0x7B {
                depth += 1;
            } else if ch == 0x29 || ch == 0x5D || ch == 0x7D {
                depth -= 1;
            } else if ch == 0x3B && depth == 0 {
                return None; // 语句边界:注解的 `=` 不会在其后
            } else if ch == 0x3D
                && depth == 0
                && line.get(j - 1) != Some(&0x3D)
                && line.get(j + 1) != Some(&0x3D)
                && line.get(j + 1) != Some(&0x3E)
            {
                return Some("annotated");
            }
            j += 1;
        }
        return None;
    }
    if AUG_TWO.iter().any(|op| window_is(line, i, op)) {
        return Some("augmented");
    }
    // 三字符增强赋值(**= //= <<= >>=):两字符前缀不在集合,再拼一位判定
    if AUG_THREE.iter().any(|op| window_is(line, i, op)) {
        return Some("augmented");
    }
    if c == 0x3C || c == 0x3E || c == 0x21 {
        return None; // <= >= !=
    }
    None // 单目算术 + - * / 等:值上下文,非写目标
}

/// 同一行 `self` 之前紧邻(隔空白)是否为 `del` 关键字(整词)
fn preceded_by_del(line: &[u16], self_index: usize) -> bool {
    let mut i: i64 = self_index as i64 - 1;
    while i >= 0 && is_line_space(line[i as usize]) {
        i -= 1;
    }
    if i < 0 {
        return false;
    }
    let end = (i + 1) as usize;
    while i >= 0 && is_name_start(line[i as usize]) {
        i -= 1;
    }
    eq_u16(&line[(i + 1) as usize..end], "del")
}

// ---- 逐行扫描(TS findReadOnlyWriteFindings 同构) ----------------------------

fn compute_read_only_write_items(text: &str, readonly_names: &[String]) -> Vec<ReadOnlyWriteItem> {
    let masked = mask_python_non_code(text);
    let lines = split_lines(&masked);
    let names: HashSet<Vec<u16>> = readonly_names
        .iter()
        .map(|n| n.encode_utf16().collect())
        .collect();
    let mut items: Vec<ReadOnlyWriteItem> = Vec::new();

    for (line_no, line) in lines.iter().enumerate() {
        let mut pos = 0usize;
        while pos + 5 <= line.len() {
            // 找下一处 `\bself\.`(左界 = 前码元非词元或文首)
            let mut found: Option<usize> = None;
            let mut i = pos;
            while i + 5 <= line.len() {
                if starts_with(line, i, "self.") && (i == 0 || !is_word(line[i - 1])) {
                    found = Some(i);
                    break;
                }
                i += 1;
            }
            let Some(self_index) = found else { break };
            let name_start = self_index + 5;
            let mut name_end = name_start;
            while name_end < line.len() && is_name_char(line[name_end]) {
                name_end += 1;
            }
            if name_end == name_start {
                // `\w+` 不匹配(如 `self.(`):引擎前进一步重试
                pos = self_index + 1;
                continue;
            }
            // 尾随 `\b`:贪心吃满词元后边界恒成立(下一码元必非词元或行末)
            let after_index = name_end;
            // 续写/下标写都不是重绑定(del 路径也不放行)
            let mut after_first = after_index;
            while after_first < line.len() && is_line_space(line[after_first]) {
                after_first += 1;
            }
            if after_first < line.len() && (line[after_first] == 0x2E || line[after_first] == 0x5B) {
                pos = name_end;
                continue;
            }
            let mut kind = classify_write_kind_after(line, after_index);
            if kind.is_none() && preceded_by_del(line, self_index) {
                kind = Some("del");
            }
            let Some(kind) = kind else {
                pos = name_end;
                continue;
            };
            let name: Vec<u16> = line[name_start..name_end].to_vec();
            if !names.contains(&name) {
                pos = name_end;
                continue;
            }
            items.push(ReadOnlyWriteItem {
                code: CODE_READ_ONLY_WRITE,
                line: line_no,
                character: self_index,
                length: name_end - self_index,
                property_name: String::from_utf16_lossy(&name),
                kind,
            });
            pos = name_end;
        }
    }
    items
}

// ---- 单测(形态面,行为面由 tests/readOnlyWriteRustParity.test.ts 对拍) ------

#[cfg(test)]
mod tests {
    use super::*;

    fn items(text: &str) -> Vec<ReadOnlyWriteItem> {
        let names = ["id", "isDestroyed", "className", "cell", "base", "client", "databaseID"];
        compute_read_only_write_items(
            text,
            &names.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
        )
    }

    #[test]
    fn plain_assign_reports() {
        let items = items("class A:\n    def f(self):\n        self.id = 1\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 2);
        assert_eq!(items[0].character, 8);
        assert_eq!(items[0].length, 7);
        assert_eq!(items[0].property_name, "id");
        assert_eq!(items[0].kind, "assign");
    }

    #[test]
    fn augmented_two_and_three_char_ops_report() {
        assert_eq!(items("self.id += 1\n")[0].kind, "augmented");
        assert_eq!(items("self.id //= 2\n")[0].kind, "augmented");
        assert_eq!(items("self.id **= 2\n")[0].kind, "augmented");
        assert_eq!(items("self.id <<= 1\n")[0].kind, "augmented");
    }

    #[test]
    fn annotated_assign_reports() {
        assert_eq!(items("self.id: int = 0\n")[0].kind, "annotated");
        // def 头冒号后的同行注解赋值:非套件冒号,正确报
        assert_eq!(items("def m(self): self.id: int = 0\n").len(), 1);
        // 一行体套件冒号:体里的 `=` 属体语句,不报
        assert_eq!(items("if self.isDestroyed: self.counter = 0\n").len(), 0);
    }

    #[test]
    fn del_reports_and_edge_forms_do_not() {
        assert_eq!(items("del self.id\n")[0].kind, "del");
        assert_eq!(items("del  self.id\n")[0].kind, "del");
        // 括号/逗号前缀形态罕见面:不报(已知边界)
        assert_eq!(items("del (self.id)\n").len(), 0);
    }

    #[test]
    fn comparisons_and_value_context_do_not_report() {
        assert_eq!(items("x = self.id == 1\n").len(), 0);
        assert_eq!(items("x = self.id != 1\n").len(), 0);
        assert_eq!(items("x = self.id >= 1\n").len(), 0);
        assert_eq!(items("x = self.id + 1\n").len(), 0);
        assert_eq!(items("self.id := 1\n").len(), 0);
    }

    #[test]
    fn attr_chain_and_subscript_do_not_report() {
        assert_eq!(items("self.id.x = 1\n").len(), 0);
        assert_eq!(items("self.id[0] = 1\n").len(), 0);
        assert_eq!(items("del self.id.x\n").len(), 0);
    }

    #[test]
    fn writable_names_do_not_report() {
        // 只读名集是 face 表 readonly 集:可写属性(position)不在集 → 不报
        let writable = compute_read_only_write_items(
            "self.position = (0,0,0)\nself.id = 1\n",
            &["id".to_string()],
        );
        assert_eq!(writable.len(), 1);
        assert_eq!(writable[0].property_name, "id");
        assert_eq!(writable[0].line, 1);
    }

    #[test]
    fn masked_string_comment_do_not_report() {
        assert_eq!(items("# self.id = 1\n").len(), 0);
        assert_eq!(items("s = \"self.id = 1\"\n").len(), 0);
    }

    #[test]
    fn non_ascii_columns_are_utf16() {
        // 掩码保位:中文字符串之前的列数按 UTF-16 码元计(Rust str::len() 是
        // 字节面 15,TS .len 是码元面 11 —— 对拍基准是码元)
        let text = "s = \"庆祝\" ; self.id = 1\n";
        let items = items(text);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].character, 11);
    }

    #[test]
    fn multi_findings_in_order() {
        let items = items("def f(self):\n    self.id = 1\n    del self.className\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].line, 1);
        assert_eq!(items[0].kind, "assign");
        assert_eq!(items[1].line, 2);
        assert_eq!(items[1].kind, "del");
    }

    #[test]
    fn params_round_trip() {
        let params: ReadOnlyWriteParams = serde_json::from_value(json!({
            "text": "self.id = 1\n",
            "readonlyNames": ["id"]
        }))
        .expect("params decode");
        let encoded = serde_json::to_value(&compute_read_only_write_items(&params.text, &params.readonly_names)[0])
            .expect("item encode");
        assert_eq!(encoded["code"], json!("kbengine.readOnlyWrite"));
        assert_eq!(encoded["line"], json!(0));
        assert_eq!(encoded["character"], json!(0));
        assert_eq!(encoded["length"], json!(7));
        assert_eq!(encoded["propertyName"], json!("id"));
        assert_eq!(encoded["kind"], json!("assign"));
    }
}
