//! postDestroy 诊断收编(AUDIT-005 B2 车道批 4):`$/kode/lint/analyzePostDestroy`。
//!
//! TS 源 = src/backend/postDestroyDiagnostics.ts,逐语义忠实移植(对拍纪律):
//!   - 全量在 UTF-16 码元面(`Vec<u16>`,encode_utf16)做扫描——TS 的
//!     `match.index`/`indexOf` 都是 UTF-16 码元列,非 ASCII 行字节面会漂移;
//!   - 行掩码 = pythonCodeLines 等价移植(注释/字符串/f-string **整段掩码**,
//!     与 receiverNone 用的 mask_python_non_code「f-string 表达式保留」语义
//!     不同;引号态跨行延续,反斜杠转义双格,三引号开/闭 3 格)——注意本
//!     模块自己掩码 text,与 TS 侧 pythonCodeLines 对拍一致;
//!   - 语句面(掩码拼接后的 text/line/endLine/indent)由 TS 供给
//!     (pythonStatements 是共享上游,parsePythonFile 亦建于其上)——本模块
//!     不重做语句切分,只做块/销毁/早退/访问点分析;
//!   - 正则全部手工展开:`\b` 左界 = 前码元非词元或文首;词元 =
//!     `[A-Za-z0-9_]`;`\s` = JS 空白类;锚定前缀形态逐位判定;
//!   - 消息不出 Rust:只回结构面(line/character/length/member + destroyLine/
//!     destroyColumn),l10n 渲染留 TS(畸形整面作废)。
//!
//! 入参 `{text, destroyDeclared,
//! statements:[{text,line,endLine,indent},…]}`(text 为掩码拼接文本);
//! 出 `{items:[{line,character,length,member,destroyLine,destroyColumn}]}`。
//! 面/动态分派闸(pathFace/defFaces/destroyDeclared 短路)在 TS 装配面,
//! 本模块保留 destroyDeclared 防线(契约忠实)。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::python_lexical_mask::is_word;
use crate::rpc::RpcRegistry;

pub const CODE_POST_DESTROY: &str = "kbengine.postDestroy";

/// TS SAFE_MEMBERS:销毁后仍可读/无碍的成员(身份、状态、重复销毁)。
const SAFE_MEMBERS: [&str; 4] = ["id", "isDestroyed", "className", "destroy"];

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzePostDestroy", analyze_post_destroy);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PostDestroyParams {
    text: String,
    /// def 声明 destroy(动态分派边界)→ 零产出(TS 装配面已短路,此为防线)
    #[serde(default)]
    destroy_declared: bool,
    /// TS pythonStatements 产物(掩码拼接文本 + 首行坐标/缩进)
    #[serde(default)]
    statements: Vec<StatementInput>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StatementInput {
    #[serde(default)]
    text: String,
    #[serde(default)]
    line: usize,
    #[serde(default)]
    end_line: usize,
    #[serde(default)]
    indent: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PostDestroyItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    member: String,
    destroy_line: usize,
    destroy_column: usize,
}

fn analyze_post_destroy(params: Value) -> Result<Value, String> {
    let params: PostDestroyParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let items = compute_post_destroy_items(&params.text, params.destroy_declared, &params.statements);
    Ok(json!({ "items": items }))
}

// ---- 基础词元/空白判定 -------------------------------------------------------

fn is_js_space(code: u16) -> bool {
    matches!(code,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20
        | 0xA0 | 0x1680
        | 0x2000..=0x200A
        | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

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

/// 行切分 = `\r?\n`(剥 `\n` 前至多一个 `\r`),与 TS `split(/\r?\n/)` 同语义。
fn split_lines(text: &[u16]) -> Vec<Vec<u16>> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        let code = text[i];
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
        i += 1;
    }
    if let Some(last) = current.last() {
        if *last == 0x0D {
            current.pop();
        }
    }
    lines.push(current);
    lines
}

/// trim 前导与尾随 JS 空白(TS `trimStart()` 后做锚定判定的等价形态:
/// 锚定 `^` 只看前导,尾部空白不影响前缀匹配,这里仍全 trim 以便复用)。
fn trim_u16(text: &[u16]) -> &[u16] {
    let mut start = 0usize;
    while start < text.len() && is_js_space(text[start]) {
        start += 1;
    }
    let mut end = text.len();
    while end > start && is_js_space(text[end - 1]) {
        end -= 1;
    }
    &text[start..end]
}

// ---- pythonCodeLines 等价移植(引号态跨行延续;保长保位) ----------------------
//
// TS 逐码元状态机:引号内 → 空格(反斜杠转义双格;单引号闭合 1 格;三引号
// 闭合 3 格);开引号 → `_`(三引号 `___`);`#` → 行尾全空格;引号态跨行
// 延续(未闭合单引号续到下一行)。f-string 无特判 = 表达式整段掩码。

fn python_code_lines(text: &[u16]) -> Vec<Vec<u16>> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut quote: Option<u16> = None;
    let mut triple = false;
    for raw in split_lines(text) {
        let mut masked: Vec<u16> = Vec::with_capacity(raw.len());
        let mut col = 0usize;
        while col < raw.len() {
            let ch = raw[col];
            if let Some(q) = quote {
                if ch == 0x5C {
                    // TS:`masked += '  '; col += 1; continue;`(循环再 +1 = 双格双码元)
                    masked.push(0x20);
                    masked.push(0x20);
                    col += 2;
                    continue;
                }
                let triple_close = triple
                    && col + 3 <= raw.len()
                    && raw[col] == q
                    && raw[col + 1] == q
                    && raw[col + 2] == q;
                if triple_close {
                    quote = None;
                    triple = false;
                    masked.extend_from_slice(&[0x20, 0x20, 0x20]);
                    col += 3;
                } else if !triple && ch == q {
                    quote = None;
                    masked.push(0x20);
                    col += 1;
                } else {
                    masked.push(0x20);
                    col += 1;
                }
                continue;
            }
            if ch == 0x23 {
                while masked.len() < raw.len() {
                    masked.push(0x20);
                }
                break;
            }
            if ch == 0x27 || ch == 0x22 {
                let triple_open = col + 3 <= raw.len() && raw[col + 1] == ch && raw[col + 2] == ch;
                quote = Some(ch);
                triple = triple_open;
                if triple {
                    masked.extend_from_slice(&[0x5F, 0x5F, 0x5F]);
                    col += 3;
                } else {
                    masked.push(0x5F);
                    col += 1;
                }
                continue;
            }
            masked.push(ch);
            col += 1;
        }
        lines.push(masked);
    }
    lines
}

// ---- 语句形态判定(TS 正则手工展开) ------------------------------------------

/// `^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(`
fn function_header(text: &[u16]) -> bool {
    let mut i = 0usize;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if starts_with(text, i, "async") {
        let mut j = i + 5;
        let ws_start = j;
        while j < text.len() && is_js_space(text[j]) {
            j += 1;
        }
        if j > ws_start {
            i = j;
        }
        // async 后无空白 → 可选组不成立(回退到从 i 判 def,必失败,与
        // 正则回溯同语义)
    }
    if !starts_with(text, i, "def") {
        return false;
    }
    let mut j = i + 3;
    let ws_start = j;
    while j < text.len() && is_js_space(text[j]) {
        j += 1;
    }
    if j == ws_start {
        return false; // def 后要求 ≥1 空白
    }
    if j >= text.len() || !is_name_start(text[j]) {
        return false;
    }
    j += 1;
    while j < text.len() && is_name_char(text[j]) {
        j += 1;
    }
    while j < text.len() && is_js_space(text[j]) {
        j += 1;
    }
    j < text.len() && text[j] == 0x28
}

/// `self\.destroy\s*\(` 在 `at` 处(前缀形态由调用方保证)
fn destroy_call_at(text: &[u16], at: usize) -> bool {
    if !starts_with(text, at, "self.destroy") {
        return false;
    }
    let mut j = at + "self.destroy".len();
    while j < text.len() && is_js_space(text[j]) {
        j += 1;
    }
    j < text.len() && text[j] == 0x28
}

/// `^(?:[A-Za-z_]\w*\s*=\s*)?self\.destroy\s*\(`(trimStart 后判定)
fn destroy_statement(trimmed: &[u16]) -> bool {
    if destroy_call_at(trimmed, 0) {
        return true;
    }
    // 赋值前缀形态:名称 + \s* + '=' + \s*(可回退到无前缀,已先行尝试)
    if trimmed.is_empty() || !is_name_start(trimmed[0]) {
        return false;
    }
    let mut k = 1usize;
    while k < trimmed.len() && is_name_char(trimmed[k]) {
        k += 1;
    }
    while k < trimmed.len() && is_js_space(trimmed[k]) {
        k += 1;
    }
    if k >= trimmed.len() || trimmed[k] != 0x3D {
        return false;
    }
    k += 1;
    while k < trimmed.len() && is_js_space(trimmed[k]) {
        k += 1;
    }
    destroy_call_at(trimmed, k)
}

/// `^(?:return|break|continue|raise)\b`(trimStart 后判定;\b = 后随非词元或文末)
fn early_exit_statement(trimmed: &[u16]) -> bool {
    for word in ["return", "break", "continue", "raise"] {
        if starts_with(trimmed, 0, word) {
            let end = word.len();
            if end >= trimmed.len() || !is_word(trimmed[end]) {
                return true;
            }
        }
    }
    false
}

/// `\bself\.` 在语句文本中存在(无尾界;词元最大性由左界保证)
fn contains_self_access(text: &[u16]) -> bool {
    let mut i = 0usize;
    while i + 5 <= text.len() {
        if starts_with(text, i, "self.")
            && (i == 0 || !is_word(text[i - 1]))
        {
            return true;
        }
        i += 1;
    }
    false
}

/// `\bself\.(\w+)/g` 逐命中(掩码行;(起点, 名字起点, 名字长度);\w+ 匹配
/// 失败时引擎前进一步,这里同语义 `pos = i + 1`)
fn access_matches(masked: &[u16]) -> Vec<(usize, usize, usize)> {
    let mut hits: Vec<(usize, usize, usize)> = Vec::new();
    let mut pos = 0usize;
    while pos + 5 <= masked.len() {
        let mut found: Option<usize> = None;
        let mut i = pos;
        while i + 5 <= masked.len() {
            if starts_with(masked, i, "self.") && (i == 0 || !is_word(masked[i - 1])) {
                found = Some(i);
                break;
            }
            i += 1;
        }
        let Some(start) = found else { break };
        let name_start = start + 5;
        let mut name_end = name_start;
        while name_end < masked.len() && is_name_char(masked[name_end]) {
            name_end += 1;
        }
        if name_end == name_start {
            pos = start + 1;
            continue;
        }
        hits.push((start, name_start, name_end - name_start));
        pos = name_end;
    }
    hits
}

/// `indexOf('self.destroy')`(无命中 → TS `Math.max(0, -1)` = 0)
fn destroy_column_of(masked: &[u16]) -> Option<usize> {
    let word: Vec<u16> = "self.destroy".encode_utf16().collect();
    if masked.len() < word.len() {
        return None;
    }
    for i in 0..=masked.len() - word.len() {
        if masked[i..i + word.len()].iter().copied().eq(word.iter().copied()) {
            return Some(i);
        }
    }
    None
}

// ---- 块/销毁/早退分析(TS findPostDestroyFindings 同构) ----------------------

/// 同一函数体同一块:同缩进,且两者间无缩进 < 本层的语句(无 dedent)
fn same_block(
    from: &StatementInput,
    to: &StatementInput,
    body: &[&StatementInput],
) -> bool {
    if from.indent != to.indent {
        return false;
    }
    for stmt in body {
        if stmt.line <= from.line {
            continue;
        }
        if stmt.line >= to.line {
            break;
        }
        if stmt.indent < from.indent {
            return false;
        }
    }
    true
}

fn compute_post_destroy_items(
    text: &str,
    destroy_declared: bool,
    statements: &[StatementInput],
) -> Vec<PostDestroyItem> {
    if destroy_declared {
        return Vec::new();
    }
    let text_u16: Vec<u16> = text.encode_utf16().collect();
    let masked_lines = python_code_lines(&text_u16);
    let mut findings: Vec<PostDestroyItem> = Vec::new();

    // 只分析函数体内(模块/类体无 self;顶层匹配不成立)
    for s in 0..statements.len() {
        let header = &statements[s];
        let header_text: Vec<u16> = header.text.encode_utf16().collect();
        if !function_header(&header_text) {
            continue;
        }
        // 函数体 = 其后缩进 > def 缩进的语句
        let body_start = s + 1;
        let mut body_end = statements.len();
        for t in body_start..statements.len() {
            if statements[t].indent <= header.indent {
                body_end = t;
                break;
            }
        }
        let body: Vec<&StatementInput> = statements[body_start..body_end].iter().collect();

        // 同块内查找每个访问语句前面的销毁语句
        for (a_idx, access) in body.iter().enumerate() {
            let access_text: Vec<u16> = access.text.encode_utf16().collect();
            if !contains_self_access(&access_text) {
                continue;
            }
            let mut destroy: Option<&StatementInput> = None;
            for d in 0..a_idx {
                let candidate = body[d];
                let candidate_text: Vec<u16> = candidate.text.encode_utf16().collect();
                if !destroy_statement(trim_u16(&candidate_text)) {
                    continue;
                }
                if !same_block(candidate, access, &body) {
                    continue;
                }
                // 同层早退(return/break/continue/raise)在销毁与访问之间 → 访问死码
                let mut dead = false;
                for k in d + 1..a_idx {
                    let mid = body[k];
                    let mid_text: Vec<u16> = mid.text.encode_utf16().collect();
                    if mid.indent == access.indent && early_exit_statement(trim_u16(&mid_text)) {
                        dead = true;
                        break;
                    }
                }
                if !dead {
                    destroy = Some(candidate);
                    break;
                }
            }
            let Some(destroy) = destroy else { continue };
            // 逐个命中 `self.<member>`(member 非安全集):扫掩码行(掩码保留
            // 源位置,字符串/注释内的伪访问不命中)
            let destroy_column = masked_lines
                .get(destroy.line)
                .and_then(|line| destroy_column_of(line))
                .unwrap_or(0);
            let mut ln = access.line;
            while ln <= access.end_line {
                if let Some(masked) = masked_lines.get(ln) {
                    for (start, name_start, name_len) in access_matches(masked) {
                        let member_slice = &masked[name_start..name_start + name_len];
                        if SAFE_MEMBERS.iter().any(|m| eq_u16(member_slice, m)) {
                            continue;
                        }
                        findings.push(PostDestroyItem {
                            code: CODE_POST_DESTROY,
                            line: ln,
                            character: start,
                            length: name_start + name_len - start,
                            member: String::from_utf16_lossy(member_slice),
                            destroy_line: destroy.line,
                            destroy_column,
                        });
                    }
                }
                ln += 1;
            }
        }
    }
    // 去重:嵌套函数体既随外层函数分析、又作自身函数分析,同一命中会重复
    let mut seen: Vec<(usize, usize, String)> = Vec::new();
    let mut deduped: Vec<PostDestroyItem> = Vec::new();
    for finding in findings {
        let key = (finding.line, finding.character, finding.member.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        deduped.push(finding);
    }
    deduped
}

// ---- 单测(形态面,行为面由 tests/postDestroyRustParity.test.ts 对拍) --------

#[cfg(test)]
mod tests {
    use super::*;

    fn stmt(text: &str, line: usize, end_line: usize, indent: usize) -> StatementInput {
        StatementInput {
            text: text.to_string(),
            line,
            end_line,
            indent,
        }
    }

    #[test]
    fn bare_destroy_then_access_reports() {
        let text = "class A:\n    def f(self):\n        self.destroy()\n        self.hp\n";
        let statements = vec![
            stmt("class A:", 0, 0, 0),
            stmt("def f(self):", 1, 1, 4),
            stmt("self.destroy()", 2, 2, 8),
            stmt("self.hp", 3, 3, 8),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 3);
        assert_eq!(items[0].character, 8);
        assert_eq!(items[0].length, "self.hp".len());
        assert_eq!(items[0].member, "hp");
        assert_eq!(items[0].destroy_line, 2);
        assert_eq!(items[0].destroy_column, 8);
    }

    #[test]
    fn assignment_form_destroy_reports() {
        let text = "def f(self):\n    result = self.destroy()\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("result = self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].destroy_line, 1);
    }

    #[test]
    fn safe_members_are_skipped() {
        let text = "def f(self):\n    self.destroy()\n    a = [self.id, self.isDestroyed, self.className, self.destroy]\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("a = [self.id, self.isDestroyed, self.className, self.destroy]", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn same_level_early_exit_makes_access_dead() {
        let text = "def f(self):\n    self.destroy()\n    return\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("return", 2, 2, 4),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn deeper_early_exit_does_not_kill_proof() {
        let text = "def f(self):\n    self.destroy()\n    if x: return\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("if x: return", 2, 2, 4),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        // 「if x: return」是单条语句(text 前缀非 return)→ 不构成早退
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn dedent_between_breaks_same_block() {
        let text = "def f(self):\n    self.destroy()\n  x = 1\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("x = 1", 2, 2, 2),
            stmt("self.hp", 3, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn destroy_after_access_not_reported() {
        let text = "def f(self):\n    self.hp\n    self.destroy()\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.hp", 1, 1, 4),
            stmt("self.destroy()", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn masked_string_statement_no_false_hit() {
        // 字符串整段掩码(语句文本由 TS 供给已是掩码形态):含 self.hp 的
        // 字符串不构成访问;掩码行扫描同样不命中
        let text = "def f(self):\n    self.destroy()\n    s = \"self.hp\"\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("s = _________", 2, 2, 4), // "self.hp" 掩码形态(9 码元)
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert!(items.is_empty());
    }

    #[test]
    fn multiline_access_scans_each_line() {
        let text = "def f(self):\n    self.destroy()\n    total = (self.hp +\n        self.mp)\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("total = (self.hp +         self.mp)", 2, 3, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].line, 2);
        assert_eq!(items[0].member, "hp");
        assert_eq!(items[1].line, 3);
        assert_eq!(items[1].member, "mp");
        assert_eq!(items[1].character, 8);
    }

    #[test]
    fn nested_def_deeper_access_not_cross_reported() {
        let text = "def f(self):\n    self.destroy()\n    def g():\n        self.hp\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("def g():", 2, 2, 4),
            stmt("self.hp", 3, 3, 8),
            stmt("self.hp", 4, 4, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        // line3 在 g 体(缩进 8):销毁在 f 体(缩进 4)→ 同块缩进不等不跨块;
        // g 体自身无销毁 → 不报。仅 line4 同层直进报 1。
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 4);
    }

    #[test]
    fn destroy_declared_zero_items() {
        let text = "def f(self):\n    self.destroy()\n    self.hp\n";
        let statements = vec![
            stmt("def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        assert!(compute_post_destroy_items(text, true, &statements).is_empty());
    }

    #[test]
    fn async_header_recognized() {
        let text = "async def f(self):\n    self.destroy()\n    self.hp\n";
        let statements = vec![
            stmt("async def f(self):", 0, 0, 0),
            stmt("self.destroy()", 1, 1, 4),
            stmt("self.hp", 2, 2, 4),
        ];
        let items = compute_post_destroy_items(text, false, &statements);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn mask_preserves_positions_across_quote_lines() {
        // 引号态跨行:未闭合单引号续到下一行;开引号 1 格 `_`、引号内空格、
        // 闭引号 1 格空格;反斜杠转义双格
        let text = "s = 'abc\ndef\n' + self.hp\n";
        let lines = python_code_lines(&text.encode_utf16().collect::<Vec<u16>>());
        assert_eq!(lines.len(), 4); // 尾 \n → 末尾空行(split 同语义)
        assert_eq!(String::from_utf16_lossy(&lines[0]), "s = _   ");
        assert_eq!(String::from_utf16_lossy(&lines[1]), "   ");
        assert_eq!(String::from_utf16_lossy(&lines[2]), "  + self.hp");
        let escaped = "\"a\\\"b\" self.hp";
        let lines = python_code_lines(&escaped.encode_utf16().collect::<Vec<u16>>());
        // 开引号 `_` + 引号内('a' 空格、转义双格、'b' 空格)+ 闭引号空格 + 空格
        assert_eq!(String::from_utf16_lossy(&lines[0]), "_      self.hp");
    }

    #[test]
    fn params_round_trip() {
        let params: PostDestroyParams = serde_json::from_value(json!({
            "text": "def f(self):\n    self.destroy()\n    self.hp\n",
            "destroyDeclared": false,
            "statements": [
                { "text": "def f(self):", "line": 0, "endLine": 0, "indent": 0 },
                { "text": "self.destroy()", "line": 1, "endLine": 1, "indent": 4 },
                { "text": "self.hp", "line": 2, "endLine": 2, "indent": 4 }
            ]
        }))
        .expect("params decode");
        let items = compute_post_destroy_items(&params.text, params.destroy_declared, &params.statements);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].member, "hp");
        let encoded = serde_json::to_value(&items[0]).expect("item encode");
        assert_eq!(encoded["line"], json!(2));
        assert_eq!(encoded["character"], json!(4));
        assert_eq!(encoded["member"], json!("hp"));
        assert_eq!(encoded["destroyLine"], json!(1));
        assert_eq!(encoded["destroyColumn"], json!(4));
        assert_eq!(encoded["length"], json!(7));
    }
}

