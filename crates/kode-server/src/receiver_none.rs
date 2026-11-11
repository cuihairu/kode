//! receiver-none 诊断收编(AUDIT-005 B2 车道批 3):`$/kode/lint/analyzeReceiverNone`。
//!
//! TS 源 = src/backend/receiverNoneDiagnostics.ts,逐语义忠实移植(对拍纪律):
//!   - 全量在 UTF-16 码元面(`Vec<u16>`,encode_utf16)做扫描——TS 的
//!     `match.index`/`slice` 都是 UTF-16 码元列,非 ASCII 行字节面会漂移;
//!   - 掩码 = crate::python_lexical_mask::mask_python_non_code(与 TS 同源语义,
//!     保长保行,列偏移不变);行切分 = `\r?\n`(剥 `\n` 前至多一个 `\r`);
//!   - 正则全部手工展开:`\b` 左界 = 前码元非 ASCII 词元或文首;词元 =
//!     `[A-Za-z0-9_]`;lookahead/lookbehind 手工展开;顶层 and/or 切分按
//!     `\s+and\s` 形态逐位判定(括号深度 0);
//!   - 方法区间(类/def 行号)由 TS 解析面供给(parsePythonFile 是共享上游,
//!     与 roleMisuse 的 face 同口径)——本模块不重做解析,只做文本分析;
//!   - 消息不出 Rust:只回结构面(code/line/character/length/kind + receiver/
//!     methodName),l10n 渲染与引擎取证留 TS(kind 判别消息,段错配的
//!     declared 由 TS 侧同一 mapping 快照重算,畸形/语义矛盾整面作废)。
//!
//! 入参 `{text, methods:[{startLine,endLine,defLines:[…]}],
//! declarations:{methodName:[section,…]}}`;出 `{items:[...]}`。
//! kind ∈ receiverNone|sectionMismatch(receiverNone 码
//! kbengine.receiverNone / sectionMismatch 码 kbengine.sectionMismatch)。

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::python_lexical_mask::{is_word, mask_python_non_code};
use crate::rpc::RpcRegistry;

pub const CODE_RECEIVER_NONE: &str = "kbengine.receiverNone";
pub const CODE_SECTION_MISMATCH: &str = "kbengine.sectionMismatch";

/// TS ENGINE_VALIDATOR_NAMES:引擎校验器名单( USER-LINT-01 )。后续引擎侧
/// 新增校验器在此追加限定名即可,勿散落硬编码。
const ENGINE_VALIDATOR_NAMES: [&str; 1] = ["kbe.isValid"];

/// TS PYTHON_RECEIVER_SECTIONS:接收者 → .def 段。
const SECTIONS: [(&str, &str); 3] = [
    ("cell", "CellMethods"),
    ("base", "BaseMethods"),
    ("client", "ClientMethods"),
];

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeReceiverNone", analyze_receiver_none);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ReceiverNoneParams {
    text: String,
    /// TS parsePythonFile → 类方法区间(def 行号,Map 按名去重后原样透传;
    /// 区间推导(排序/边界)在本模块做,与 TS buildMethodSpans 同语义)
    #[serde(default)]
    methods: Vec<ClassMethodsInput>,
    /// mapping.methods 投影(段错配面;空表 = 无映射,段错配零产出)
    #[serde(default)]
    declarations: HashMap<String, Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ClassMethodsInput {
    start_line: usize,
    end_line: usize,
    #[serde(default)]
    def_lines: Vec<usize>,
}

/// 一条结构面产物(消息渲染与引擎取证在 TS)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiverNoneItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    kind: &'static str,
    receiver: &'static str,
    method_name: String,
}

fn analyze_receiver_none(params: Value) -> Result<Value, String> {
    let params: ReceiverNoneParams =
        serde_json::from_value(params).map_err(|err| format!("invalid params: {err}"))?;
    let items = compute_receiver_none_items(&params);
    Ok(json!({ "items": items }))
}

// ---- UTF-16 码元面工具 -------------------------------------------------------

/// TS `\s`:常见 Unicode 空白(与 space_nav.rs 同表)。
fn is_js_space(code: u16) -> bool {
    matches!(
        code,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20
            | 0xA0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
    )
}

/// TS `\b` 词元:JS `\w` = [A-Za-z0-9_](ASCII)。
fn is_name_start(code: u16) -> bool {
    matches!(code, 0x41..=0x5A | 0x61..=0x7A | 0x5F)
}

fn starts_with(text: &[u16], at: usize, word: &str) -> bool {
    let bytes: Vec<u16> = word.encode_utf16().collect();
    at + bytes.len() <= text.len() && text[at..].starts_with(&bytes)
}

fn eq_u16(text: &[u16], word: &str) -> bool {
    text == word.encode_utf16().collect::<Vec<u16>>().as_slice()
}

/// TS `String.prototype.trim`(常用空白面;is_js_space 同表)。
fn trim_u16(text: &[u16]) -> &[u16] {
    let mut start = 0usize;
    let mut end = text.len();
    while start < end && is_js_space(text[start]) {
        start += 1;
    }
    while end > start && is_js_space(text[end - 1]) {
        end -= 1;
    }
    &text[start..end]
}

fn is_all_space(text: &[u16]) -> bool {
    text.iter().all(|&code| is_js_space(code))
}

/// TS `text.split(/\r?\n/)`:剥掉每个 `\n` 前至多一个 `\r`(单个 \r 留行内)。
fn split_lines(text: &[u16]) -> Vec<&[u16]> {
    text.split(|&code| code == b'\n' as u16)
        .map(|line| line.strip_suffix(&[b'\r' as u16]).unwrap_or(line))
        .collect()
}

/// TS indentOf:前导空白长度(每 \t 记 4,与 `replace(/\t/g, '    ')` 同值)。
fn indent_of(line: &[u16]) -> usize {
    let mut indent = 0usize;
    for &code in line {
        if code == b' ' as u16 {
            indent += 1;
        } else if code == b'\t' as u16 {
            indent += 4;
        } else {
            break;
        }
    }
    indent
}

/// TS COMMENT_ONLY `/^\s*(#.*)?$/`:全空白,或前导空白后单个 `#`(掩码行
/// 注释已空白,`#` 分支常态不触发,保语义对齐)。
fn comment_only(line: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    i == line.len() || line[i] == b'#' as u16
}

/// TS NESTED_SCOPE_HEADER `/^\s*(?:async\s+)?def\s|^\s*class\s`。
fn nested_scope_header(line: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    let rest = &line[i..];
    if starts_with(rest, 0, "class") && rest.len() > 5 && is_js_space(rest[5]) {
        return true;
    }
    let body = if starts_with(rest, 0, "async") {
        let mut j = 5usize;
        let ws_start = j;
        while j < rest.len() && is_js_space(rest[j]) {
            j += 1;
        }
        if j == ws_start {
            return false; // `async\s+` 须至少一个空白
        }
        &rest[j..]
    } else {
        rest
    };
    starts_with(body, 0, "def") && body.len() > 3 && is_js_space(body[3])
}

/// TS RECEIVER_ALIAS_ASSIGN
/// `/^([ \t]*)([A-Za-z_]\w*)\s*=\s*self\.(cell|base|client)(.*)$/`:
/// 返回 Some((名, 接收者, 尾部是否纯空白))。
fn receiver_alias_assign(line: &[u16]) -> Option<(Vec<u16>, &'static str, bool)> {
    let mut i = 0usize;
    while i < line.len() && (line[i] == b' ' as u16 || line[i] == b'\t' as u16) {
        i += 1;
    }
    if i >= line.len() || !is_name_start(line[i]) {
        return None;
    }
    let name_start = i;
    while i < line.len() && is_word(line[i]) {
        i += 1;
    }
    let name = line[name_start..i].to_vec();
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if i >= line.len() || line[i] != b'=' as u16 {
        return None;
    }
    i += 1;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !starts_with(line, i, "self.") {
        return None;
    }
    i += "self.".len();
    let mut role: Option<&'static str> = None;
    for (candidate, _) in SECTIONS {
        if starts_with(line, i, candidate) {
            role = Some(candidate);
            break;
        }
    }
    let role = role?;
    let rest = &line[i + role.len()..];
    Some((name, role, is_all_space(rest)))
}

/// TS rebindPattern(target):
/// `\bTARGET\s*(?:(?:\*\*|//|>>|<<|[-+*/%&|^])?=(?!=)|:=)`。
fn rebind_match(line: &[u16], subject: &[u16]) -> bool {
    for at in find_word_occurrences(line, subject) {
        let mut j = at + subject.len();
        while j < line.len() && is_js_space(line[j]) {
            j += 1;
        }
        // `:=` 分支
        if j + 1 < line.len() && line[j] == b':' as u16 && line[j + 1] == b'=' as u16 {
            return true;
        }
        // 可选双字操作符(** // >> <<)再可选单字([-+*/%&|^]),随后 `=(?!=)`
        let mut k = j;
        for op in ["**", "//", ">>", "<<"] {
            if starts_with(line, k, op) {
                k += 2;
                break;
            }
        }
        if k < line.len() && matches!(line[k], 0x2D | 0x2B | 0x2A | 0x2F | 0x25 | 0x26 | 0x7C | 0x5E) {
            k += 1;
        }
        if k < line.len() && line[k] == b'=' as u16 && (k + 1 >= line.len() || line[k + 1] != b'=' as u16) {
            return true;
        }
    }
    false
}

/// TS nameRebindExtras(name):`\b(?:for|del|as)\s+NAME\b`。
fn name_rebind_extras(line: &[u16], name: &[u16]) -> bool {
    for keyword in ["for", "del", "as"] {
        for at in find_word_occurrences(line, keyword.encode_utf16().collect::<Vec<u16>>().as_slice()) {
            let mut j = at + keyword.len();
            let ws_start = j;
            while j < line.len() && is_js_space(line[j]) {
                j += 1;
            }
            if j == ws_start {
                continue; // `\s+` 须至少一个空白
            }
            if j + name.len() <= line.len()
                && line[j..].starts_with(name)
                && (j + name.len() >= line.len() || !is_word(line[j + name.len()]))
            {
                return true;
            }
        }
    }
    false
}

/// 词元左界(`\b`)约束下的 subject 字面出现位:前码元非词元或文首。
fn find_word_occurrences(line: &[u16], subject: &[u16]) -> Vec<usize> {
    let mut out = Vec::new();
    if subject.is_empty() {
        return out;
    }
    for at in 0..line.len() {
        if at > 0 && is_word(line[at - 1]) {
            continue;
        }
        if line[at..].starts_with(subject) {
            out.push(at);
        }
    }
    out
}

/// TS ALIAS_ATTR_USE `\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)` 的全部命中:
/// 返回 [(名字起点列, 名字, 属性名起点列, 属性名)](行内从左到右)。
fn alias_attr_uses(line: &[u16]) -> Vec<(usize, Vec<u16>, usize, Vec<u16>)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < line.len() {
        if (i == 0 || !is_word(line[i - 1])) && is_name_start(line[i]) {
            let name_start = i;
            let mut end = i;
            while end < line.len() && is_word(line[end]) {
                end += 1;
            }
            if end < line.len()
                && line[end] == b'.' as u16
                && end + 1 < line.len()
                && is_name_start(line[end + 1])
            {
                let attr_start = end + 1;
                let mut attr_end = attr_start;
                while attr_end < line.len() && is_word(line[attr_end]) {
                    attr_end += 1;
                }
                out.push((
                    name_start,
                    line[name_start..end].to_vec(),
                    attr_start,
                    line[attr_start..attr_end].to_vec(),
                ));
                i = attr_end; // lastIndex = 匹配终点
                continue;
            }
        }
        i += 1;
    }
    out
}

// ---- if 头条件提取与布尔语义分诊(IDE-LINT-002) -------------------------------

/// TS extractIfHeader:从 `if` 后扫到括号深度 0 的首个 `:`。
/// 返回 (条件切片(已 trim), 块体起始列)。
fn extract_if_header(line: &[u16]) -> Option<(Vec<u16>, usize)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !starts_with(line, i, "if") {
        return None;
    }
    i += 2;
    let ws_start = i;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if i == ws_start {
        return None; // `if\s+` 须至少一个空白
    }
    let mut depth = 0i32;
    while i < line.len() {
        let ch = line[i];
        if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
            depth += 1;
        } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
            depth = depth.saturating_sub(1);
        } else if ch == b':' as u16 && depth == 0 {
            return Some((trim_u16(&line[ws_start..i]).to_vec(), i + 1));
        }
        i += 1;
    }
    None
}

/// TS stripOuterParens:剥最外层配对括号(外括号不包全则原样返回)。
fn strip_outer_parens(expr: &[u16]) -> Vec<u16> {
    let mut current = trim_u16(expr).to_vec();
    loop {
        if current.len() >= 2
            && current[0] == b'(' as u16
            && current[current.len() - 1] == b')' as u16
        {
            let mut depth = 0i32;
            let mut wraps = true;
            for (i, &ch) in current.iter().enumerate() {
                if ch == b'(' as u16 {
                    depth += 1;
                } else if ch == b')' as u16 {
                    depth -= 1;
                    if depth == 0 && i < current.len() - 1 {
                        wraps = false;
                        break;
                    }
                }
            }
            if !wraps || depth != 0 {
                break;
            }
            current = trim_u16(&current[1..current.len() - 1]).to_vec();
            continue;
        }
        break;
    }
    current
}

/// TS isEngineValidatorCall:atom 恰为 `<validator>(subject)`(实参内空白宽容;
/// 多余实参/前缀后缀不匹配)。
fn is_engine_validator_call(atom: &[u16], subject: &[u16]) -> bool {
    for name in ENGINE_VALIDATOR_NAMES {
        let prefix = format!("{name}(");
        let prefix_u16: Vec<u16> = prefix.encode_utf16().collect();
        if atom.len() > prefix_u16.len()
            && atom.starts_with(&prefix_u16)
            && atom[atom.len() - 1] == b')' as u16
        {
            let inner = trim_u16(&atom[prefix_u16.len()..atom.len() - 1]);
            if inner == subject {
                return true;
            }
        }
    }
    false
}

/// TS splitTopLevel:顶层(括号深度 0)按 and/or 切分。切分位形态 =
/// `\s+and\s`(`\s+` 至少 1、`and` 后随空白或文末)。
fn split_top_level(expr: &[u16], op: &str) -> Vec<Vec<u16>> {
    let mut parts: Vec<Vec<u16>> = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < expr.len() {
        let ch = expr[i];
        if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
            depth += 1;
            i += 1;
            continue;
        }
        if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
            depth = depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if depth == 0 && is_js_space(expr[i]) {
            let mut k = i;
            while k < expr.len() && is_js_space(expr[k]) {
                k += 1;
            }
            if starts_with(expr, k, op)
                && (k + op.len() >= expr.len() || is_js_space(expr[k + op.len()]))
            {
                let rest_len = (k - i) + op.len() + usize::from(k + op.len() < expr.len());
                parts.push(expr[start..i].to_vec());
                i += rest_len - 1;
                start = i + 1;
            }
        }
        i += 1;
    }
    parts.push(expr[start..].to_vec());
    parts
}

/// TS conditionVerdict:positive | early-exit | null(不确定)。
#[derive(PartialEq, Clone, Copy)]
enum ConditionVerdict {
    Positive,
    EarlyExit,
}

fn condition_verdict(condition: &[u16], subject: &[u16]) -> Option<ConditionVerdict> {
    let expr = strip_outer_parens(condition);
    if split_top_level(&expr, "or").len() > 1 {
        return None;
    }
    let conjuncts = split_top_level(&expr, "and");
    let positive_atom = |atom_raw: &[u16]| -> bool {
        let atom = strip_outer_parens(atom_raw);
        if atom == subject || eq_u16(&atom, &format!("{} is not None", String::from_utf16_lossy(subject))) {
            return true;
        }
        if is_engine_validator_call(&atom, subject) {
            return true;
        }
        // `not (subject is None)` 是唯一认定的正向 not 形态
        if is_not_prefixed(&atom) {
            return eq_u16(&strip_outer_parens(&atom[3..]), &format!("{} is None", String::from_utf16_lossy(subject)));
        }
        false
    };
    if conjuncts.len() > 1 {
        return if conjuncts.iter().any(|atom| positive_atom(atom)) {
            Some(ConditionVerdict::Positive)
        } else {
            None
        };
    }
    let atom = strip_outer_parens(&conjuncts[0]);
    if positive_atom(&atom) {
        return Some(ConditionVerdict::Positive);
    }
    if is_not_prefixed(&atom) {
        let inner = strip_outer_parens(&atom[3..]);
        if inner == subject || is_engine_validator_call(&inner, subject) {
            return Some(ConditionVerdict::EarlyExit);
        }
    }
    if eq_u16(&atom, &format!("{} is None", String::from_utf16_lossy(subject))) {
        return Some(ConditionVerdict::EarlyExit);
    }
    None
}

/// TS `/^not\b/`:前缀 `not` 且后一码元非词元(或文末)。
fn is_not_prefixed(atom: &[u16]) -> bool {
    starts_with(atom, 0, "not") && (atom.len() == 3 || !is_word(atom[3]))
}

// ---- guard 前缀扫描(IDE-DIA-004 单趟) ---------------------------------------

struct MethodSpan {
    start_line: usize,
    end_line: usize,
}

struct ClassSpans {
    start_line: usize,
    end_line: usize,
    spans: Vec<MethodSpan>,
}

/// TS buildMethodSpans:类内 def 行排序后按边界推导方法区间
/// (下一 def 起点前一行收尾,末个到类 endLine-1;endLine 为不含界)。
fn build_method_spans(classes: &[ClassMethodsInput]) -> Vec<ClassSpans> {
    classes
        .iter()
        .map(|cls| {
            let mut starts = cls.def_lines.clone();
            starts.sort_unstable();
            starts.dedup();
            let spans = starts
                .iter()
                .enumerate()
                .map(|(i, &start_line)| MethodSpan {
                    start_line,
                    end_line: if i + 1 < starts.len() {
                        starts[i + 1] - 1
                    } else {
                        cls.end_line.saturating_sub(1)
                    },
                })
                .collect();
            ClassSpans {
                start_line: cls.start_line,
                end_line: cls.end_line,
                spans,
            }
        })
        .collect()
}

/// TS enclosingMethodSpan:方法体界(0 起行,含尾;类顺序保留,区间倒序取)。
fn enclosing_method_span(classes: &[ClassSpans], line: usize) -> Option<MethodSpan> {
    for cls in classes {
        if line < cls.start_line || line >= cls.end_line {
            continue;
        }
        for span in cls.spans.iter().rev() {
            if span.start_line <= line {
                return Some(MethodSpan {
                    start_line: span.start_line,
                    end_line: span.end_line,
                });
            }
        }
        return None;
    }
    None
}

struct GuardCandidate {
    line: usize,
    indent: usize,
    kind: ConditionVerdict,
    /// 命中的分句 subject(明文;TS 的转义形只作 rebind 表键,此处直用明文)
    subject: Vec<u16>,
    /// 正向 guard:if 块闭合行(首个缩进 ≤ ifIndent 的非空行;无则方法体界+1)
    block_end: Option<usize>,
    /// 早退 guard:块体内首个无条件 return/raise 行
    exit_line: Option<usize>,
}

struct MethodGuardScan {
    receiver: &'static str,
    candidates: Vec<GuardCandidate>,
    /// 别名赋值行与名(`x = self.<role>`)
    aliases: Vec<(usize, Vec<u16>)>,
    /// 明文 subject → 重绑行表(guard 与 use 之间的重绑使旧证明失效)
    rebinds: HashMap<Vec<u16>, Vec<usize>>,
    /// 方法体内嵌套 def/class 头行(guard 证明不跨作用域边界)
    nested_headers: Vec<usize>,
}

/// 单趟扫方法体(掩码行):维持存活 subject 集(self.<role> 起步,遇别名
/// 赋值追加),记录重绑行与嵌套 def/class 头,guard 形态按条件布尔语义分诊。
fn scan_guard_candidates(
    lines: &[&[u16]],
    span: &MethodSpan,
    receiver: &'static str,
) -> MethodGuardScan {
    let mut candidates: Vec<GuardCandidate> = Vec::new();
    let mut aliases: Vec<(usize, Vec<u16>)> = Vec::new();
    let mut rebinds: HashMap<Vec<u16>, Vec<usize>> = HashMap::new();
    let mut nested_headers: Vec<usize> = Vec::new();
    let self_subject: Vec<u16> = format!("self.{receiver}").encode_utf16().collect();
    let mut subjects: Vec<Vec<u16>> = vec![self_subject.clone()];
    let mut alias_names: HashSet<Vec<u16>> = HashSet::new();
    let mut nested_indents: Vec<usize> = Vec::new();
    for j in span.start_line..=span.end_line {
        let Some(text) = lines.get(j) else {
            continue; // 行越界防御(TS 侧靠 coercion 存活,Rust 显式跳过)
        };
        let text = *text;
        if comment_only(text) {
            continue;
        }
        let indent = indent_of(text);
        while let Some(&top) = nested_indents.last() {
            if indent <= top {
                nested_indents.pop();
            } else {
                break;
            }
        }
        if j > span.start_line && nested_scope_header(text) {
            nested_indents.push(indent);
            nested_headers.push(j);
            continue; // 嵌套作用域头行本身不是 guard/别名行
        }
        let nested = !nested_indents.is_empty();
        if !nested {
            if let Some((name, role, rest_ws)) = receiver_alias_assign(text) {
                if role == receiver && rest_ws {
                    aliases.push((j, name.clone()));
                    if alias_names.insert(name.clone()) {
                        subjects.push(name);
                    }
                    continue; // 别名赋值行本身不是 guard 行
                }
            }
        }
        // 重绑记账:别名名与 self.<role> 属性的重赋值/for/del/as
        for subject in &subjects {
            let hit = rebind_match(text, subject)
                || (!starts_with(subject, 0, "self.") && name_rebind_extras(text, subject));
            if hit {
                rebinds.entry(subject.clone()).or_default().push(j);
            }
        }
        // guard 形态判定:if 头条件按布尔语义分诊(行内单行体不算块 guard)
        let Some((condition, body_start)) = extract_if_header(text) else {
            continue;
        };
        let inline_body = !is_all_space(&text[body_start..]);
        let mut positive: Option<Vec<u16>> = None;
        let mut early: Option<Vec<u16>> = None;
        for subject in &subjects {
            match condition_verdict(&condition, subject) {
                Some(ConditionVerdict::Positive) if positive.is_none() => {
                    positive = Some(subject.clone());
                }
                Some(ConditionVerdict::EarlyExit) if early.is_none() => {
                    early = Some(subject.clone());
                }
                _ => {}
            }
        }
        if inline_body {
            continue;
        }
        if let Some(subject) = positive {
            candidates.push(GuardCandidate {
                line: j,
                indent,
                kind: ConditionVerdict::Positive,
                subject,
                block_end: None,
                exit_line: None,
            });
        } else if let Some(subject) = early {
            candidates.push(GuardCandidate {
                line: j,
                indent,
                kind: ConditionVerdict::EarlyExit,
                subject,
                block_end: None,
                exit_line: None,
            });
        }
    }
    // 块界/早退位置每候选预计算一次(扫描期),逐调用只做位置闸判定
    for candidate in &mut candidates {
        if candidate.kind == ConditionVerdict::Positive {
            candidate.block_end = Some(first_dedent_after(lines, span, candidate));
        } else {
            candidate.exit_line = first_exit_after(lines, span, candidate);
        }
    }
    MethodGuardScan {
        receiver,
        candidates,
        aliases,
        rebinds,
        nested_headers,
    }
}

/// TS firstDedentAfter:候选行之后首个非空且缩进 ≤ ifIndent 的行;
/// 块贯通到方法体界则界+1。
fn first_dedent_after(lines: &[&[u16]], span: &MethodSpan, candidate: &GuardCandidate) -> usize {
    for j in candidate.line + 1..=span.end_line {
        let Some(text) = lines.get(j) else {
            continue;
        };
        if comment_only(text) {
            continue;
        }
        if indent_of(text) <= candidate.indent {
            return j;
        }
    }
    span.end_line + 1
}

/// TS firstExitAfter:块体内首个无条件 return/raise 行(块级语句顺序扫;
/// 首个块级复合语句即不确定;更深缩进跳过)。
fn first_exit_after(lines: &[&[u16]], span: &MethodSpan, candidate: &GuardCandidate) -> Option<usize> {
    let mut body_indent: Option<usize> = None;
    for j in candidate.line + 1..=span.end_line {
        let Some(text) = lines.get(j) else {
            continue;
        };
        if comment_only(text) {
            continue;
        }
        let indent = indent_of(text);
        if indent <= candidate.indent {
            return None; // 块已闭
        }
        if body_indent.is_none() {
            body_indent = Some(indent);
        }
        if Some(indent) == body_indent {
            if keyword_bounded_at(text, &["return", "raise"]) {
                return Some(j);
            }
            if keyword_bounded_at(
                text,
                &[
                    "if", "elif", "else", "for", "while", "try", "except", "finally", "with",
                    "def", "class", "match", "case",
                ],
            ) {
                return None;
            }
        }
    }
    None
}

/// TS `/^\s*(?:kw|…)\b/`:前导空白后任一关键字且后一码元非词元。
fn keyword_bounded_at(text: &[u16], keywords: &[&str]) -> bool {
    let mut i = 0usize;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    for keyword in keywords {
        if starts_with(text, i, keyword)
            && (i + keyword.len() >= text.len() || !is_word(text[i + keyword.len()]))
        {
            return true;
        }
    }
    false
}

/// TS bindingStableBetween:guard 与 use 之间 subject 无重绑。
fn binding_stable_between(
    scan: &MethodGuardScan,
    subject: &[u16],
    from_line: usize,
    to_line: usize,
) -> bool {
    let Some(list) = scan.rebinds.get(subject) else {
        return true;
    };
    !list.iter().any(|&line| line > from_line && line < to_line)
}

/// TS proofWindowStart:别名 guard 的证明窗口起点 = guard 前最近一次该名的
/// receiver 赋值;self.<role> 本体的窗口就是 guard 行。
fn proof_window_start(scan: &MethodGuardScan, candidate: &GuardCandidate) -> Option<usize> {
    let self_subject: Vec<u16> = format!("self.{}", scan.receiver).encode_utf16().collect();
    if candidate.subject == self_subject {
        return Some(candidate.line);
    }
    let mut start: Option<usize> = None;
    for (line, name) in &scan.aliases {
        if *name == candidate.subject && *line < candidate.line {
            start = Some(*line);
        }
    }
    start
}

/// TS crossesNestedScope:guard 与 use 之间不跨嵌套 def/class 边界。
fn crosses_nested_scope(scan: &MethodGuardScan, from_line: usize, to_line: usize) -> bool {
    scan.nested_headers
        .iter()
        .any(|&header| header > from_line && header < to_line)
}

/// TS hasReceiverGuardFromScan:候选过闸(位置闸 + 重绑/跨作用域失效闸,
/// 零文本重扫)+ 同行 guard(单行 if / 三元前置判空)。
fn has_receiver_guard_from_scan(
    lines: &[&[u16]],
    scan: &MethodGuardScan,
    use_line: usize,
) -> bool {
    let Some(use_text) = lines.get(use_line) else {
        return false;
    };
    let use_indent = indent_of(use_text);
    for candidate in &scan.candidates {
        if candidate.line >= use_line {
            continue;
        }
        if crosses_nested_scope(scan, candidate.line, use_line) {
            continue;
        }
        let Some(proof_start) = proof_window_start(scan, candidate) else {
            continue;
        };
        let self_subject: Vec<u16> =
            format!("self.{}", scan.receiver).encode_utf16().collect();
        if !binding_stable_between(scan, &candidate.subject, proof_start, use_line)
            // 别名值与接收者属性同源:期间 self.<role> 被重赋值则旧证明同失效
            || !binding_stable_between(scan, &self_subject, proof_start, use_line)
        {
            continue;
        }
        if candidate.kind == ConditionVerdict::Positive {
            if candidate.indent < use_indent
                && candidate.block_end.unwrap_or(0) > use_line
            {
                return true;
            }
        } else if candidate.indent <= use_indent
            && candidate.exit_line.is_some_and(|exit| exit < use_line)
        {
            return true;
        }
    }
    // 同行 guard:单行 if(条件按布尔语义判定)/ 三元前置判空
    let use_text = *use_text;
    for subject in scan_subjects_up_to(scan, use_line) {
        if let Some((condition, body_start)) = extract_if_header(use_text) {
            if !is_all_space(&use_text[body_start..])
                && condition_verdict(&condition, &subject) == Some(ConditionVerdict::Positive)
            {
                return true;
            }
        }
        if same_line_ternary(use_text, &subject) {
            return true;
        }
    }
    false
}

/// TS scanSubjectsUpTo:接收者本体 + use 之前赋值且未被重绑的别名。
fn scan_subjects_up_to(scan: &MethodGuardScan, use_line: usize) -> Vec<Vec<u16>> {
    let self_subject: Vec<u16> = format!("self.{}", scan.receiver).encode_utf16().collect();
    let mut subjects = vec![self_subject];
    for (line, name) in &scan.aliases {
        if *line < use_line && binding_stable_between(scan, name, *line, use_line) {
            subjects.push(name.clone());
        }
    }
    subjects
}

/// TS sameLineTernary:`\bif\s+SUBJECT\s*(?:is\s+not\s+None)?\s+else\b`。
/// `\s*`+`\s+` 相邻同 char 类,回溯只在其间重新分配总量 → 等价形态:
/// 可选组不在场时 subject 与 else 之间须 ≥1 空白且 else 紧随空白游程;
/// 可选组在场时 "None" 与 else 之间须 ≥1 空白。
fn same_line_ternary(line: &[u16], subject: &[u16]) -> bool {
    for at in 0..line.len() {
        if at > 0 && is_word(line[at - 1]) {
            continue;
        }
        if !starts_with(line, at, "if") {
            continue;
        }
        let mut j = at + 2;
        let ws_start = j;
        while j < line.len() && is_js_space(line[j]) {
            j += 1;
        }
        if j == ws_start {
            continue; // `\s+` 须至少一个空白
        }
        if j + subject.len() > line.len() || !line[j..].starts_with(subject) {
            continue;
        }
        let k = j + subject.len();
        let mut run = k;
        while run < line.len() && is_js_space(line[run]) {
            run += 1;
        }
        // 可选组不在场:`\s+else`(≥1 空白后紧跟 else + 词元右界)
        if run > k
            && starts_with(line, run, "else")
            && (run + 4 >= line.len() || !is_word(line[run + 4]))
        {
            return true;
        }
        // 可选组 `is\s+not\s+None`(仅可能起于空白游程终点)
        if starts_with(line, k, "is") {
            let mut m = k + 2;
            let ws = m;
            while m < line.len() && is_js_space(line[m]) {
                m += 1;
            }
            if m > ws && starts_with(line, m, "not") {
                let mut n = m + 3;
                let ws = n;
                while n < line.len() && is_js_space(line[n]) {
                    n += 1;
                }
                if n > ws && starts_with(line, n, "None") {
                    let mut q = n + 4;
                    let ws = q;
                    while q < line.len() && is_js_space(line[q]) {
                        q += 1;
                    }
                    if q > ws
                        && starts_with(line, q, "else")
                        && (q + 4 >= line.len() || !is_word(line[q + 4]))
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

// ---- 本地别名使用点(IDE-LINT-006) --------------------------------------------

struct AliasScope {
    indent: i64,
    /// 名 → receiver 绑定(行号);None = 已重绑为其他值
    bindings: HashMap<Vec<u16>, Option<(&'static str, usize)>>,
}

/// TS collectAliasUseCalls:收集方法体内本地别名的使用点(单趟,掩码行,
/// 按方法区间一次)。作用域链解析:嵌套 def/class 各自持绑定表;use 从最内层
/// 向外找首个绑定该名的作用域。
fn collect_alias_use_calls(
    lines: &[&[u16]],
    span: &MethodSpan,
) -> Vec<(usize, usize, &'static str, String)> {
    let mut calls: Vec<(usize, usize, &'static str, String)> = Vec::new();
    let mut scopes: Vec<AliasScope> = vec![AliasScope {
        indent: -1,
        bindings: HashMap::new(),
    }];
    for j in span.start_line + 1..=span.end_line {
        let Some(text) = lines.get(j) else {
            continue;
        };
        let text = *text;
        if comment_only(text) {
            continue;
        }
        let indent = indent_of(text) as i64;
        while scopes.len() > 1 && indent <= scopes[scopes.len() - 1].indent {
            scopes.pop();
        }
        if nested_scope_header(text) {
            scopes.push(AliasScope {
                indent,
                bindings: HashMap::new(),
            });
            continue;
        }
        let scope_index = scopes.len() - 1;
        let scope = &mut scopes[scope_index];
        if let Some((name, role, rest_ws)) = receiver_alias_assign(text) {
            if rest_ws {
                scope.bindings.insert(name, Some((role, j)));
                continue;
            }
        }
        // 本作用域内重绑使该名绑定失效
        let names: Vec<Vec<u16>> = scope.bindings.keys().cloned().collect();
        for name in names {
            if scope.bindings.get(&name) == Some(&None) {
                continue;
            }
            if rebind_match(text, &name) || name_rebind_extras(text, &name) {
                scope.bindings.insert(name, None);
            }
        }
        for (_, name, attr_start, attr) in alias_attr_uses(text) {
            // 作用域链向外解析:最内层持有该名绑定的作用域
            let binding = scopes.iter().rev().find_map(|s| s.bindings.get(&name));
            match binding {
                Some(Some((receiver, line))) if *line != j => {
                    calls.push((
                        j,
                        attr_start,
                        receiver,
                        String::from_utf16(&attr).unwrap_or_default(),
                    ));
                }
                _ => {}
            }
        }
    }
    calls
}

// ---- 全量判定 -----------------------------------------------------------------

/// TS findPythonReceiverCalls:`\bself\.(cell|base|client)\.([A-Za-z_]\w*)`
/// 逐行扫描(掩码文本),返回 (行, 方法名起点列, 接收者, 方法名)。
fn find_receiver_calls(lines: &[&[u16]]) -> Vec<(usize, usize, &'static str, String)> {
    let mut calls = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        let mut i = 0usize;
        while i < line.len() {
            if line[i] == b's' as u16
                && (i == 0 || !is_word(line[i - 1]))
                && starts_with(line, i, "self.")
            {
                let mut j = i + "self.".len();
                let mut role: Option<&'static str> = None;
                for (candidate, _) in SECTIONS {
                    if starts_with(line, j, candidate) {
                        role = Some(candidate);
                        break;
                    }
                }
                if let Some(role) = role {
                    j += role.len();
                    if j < line.len() && line[j] == b'.' as u16 {
                        j += 1;
                        if j < line.len() && is_name_start(line[j]) {
                            let name_start = j;
                            while j < line.len() && is_word(line[j]) {
                                j += 1;
                            }
                            calls.push((
                                line_index,
                                name_start,
                                role,
                                String::from_utf16(&line[name_start..j]).unwrap_or_default(),
                            ));
                            i = j; // lastIndex = 匹配终点
                            continue;
                        }
                    }
                }
            }
            i += 1;
        }
    }
    calls
}

/// TS RECEIVER_ALIAS_HINT:
/// `\b[A-Za-z_]\w*\s*=\s*self\.(?:cell|base|client)\b`(全文,`\s` 可跨行)。
fn has_alias_hint(text: &[u16]) -> bool {
    let mut i = 0usize;
    while i < text.len() {
        if (i == 0 || !is_word(text[i - 1])) && is_name_start(text[i]) {
            let mut j = i;
            while j < text.len() && is_word(text[j]) {
                j += 1;
            }
            while j < text.len() && is_js_space(text[j]) {
                j += 1;
            }
            if j < text.len() && text[j] == b'=' as u16 {
                j += 1;
                while j < text.len() && is_js_space(text[j]) {
                    j += 1;
                }
                if starts_with(text, j, "self.") {
                    j += "self.".len();
                    for (candidate, _) in SECTIONS {
                        if starts_with(text, j, candidate) {
                            let after = j + candidate.len();
                            if after >= text.len() || !is_word(text[after]) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    false
}

/// TS sectionMismatch 判定:方法在 def 声明了,但没有一处在接收者对应的段。
/// 返回 Some(()) = 错配成立。
fn section_mismatches(
    declarations: &HashMap<String, Vec<String>>,
    receiver: &'static str,
    method_name: &str,
) -> bool {
    let Some(list) = declarations.get(method_name) else {
        return false;
    };
    if list.is_empty() {
        return false;
    }
    let expected = SECTIONS
        .iter()
        .find(|(candidate, _)| *candidate == receiver)
        .map(|(_, section)| *section)
        .unwrap_or("");
    !list.iter().any(|section| section == expected)
}

/// 全量判定(与 TS computeReceiverNoneFindings 同语义):无判空 guard 的
/// 接收者引用(receiver-none)+ .def 段错配(section-mismatch)。
fn compute_receiver_none_items(params: &ReceiverNoneParams) -> Vec<ReceiverNoneItem> {
    let masked = mask_python_non_code(&params.text);
    let lines = split_lines(&masked);
    let base_calls = find_receiver_calls(&lines);
    let alias_hint = has_alias_hint(&masked);
    if base_calls.is_empty() && !alias_hint {
        return Vec::new();
    }
    let classes = build_method_spans(&params.methods);
    // guard 前缀扫描按(方法区间, 接收者)一次,同方法同接收者共享同一份候选
    let mut scan_cache: HashMap<(usize, usize, &'static str), MethodGuardScan> = HashMap::new();
    let mut alias_calls: Vec<(usize, usize, &'static str, String)> = Vec::new();
    if alias_hint {
        for cls in &classes {
            for span in &cls.spans {
                alias_calls.extend(collect_alias_use_calls(&lines, span));
            }
        }
    }
    let mut items = Vec::new();
    for (line, character, receiver, method_name) in base_calls.into_iter().chain(alias_calls) {
        if let Some(span) = enclosing_method_span(&classes, line) {
            let key = (span.start_line, span.end_line, receiver);
            let scan = scan_cache.entry(key).or_insert_with(|| {
                scan_guard_candidates(&lines, &span, receiver)
            });
            if !has_receiver_guard_from_scan(&lines, scan, line) {
                items.push(ReceiverNoneItem {
                    code: CODE_RECEIVER_NONE,
                    line,
                    character,
                    length: method_name.encode_utf16().count(),
                    kind: "receiverNone",
                    receiver,
                    method_name: method_name.clone(),
                });
            }
        }
        if section_mismatches(&params.declarations, receiver, &method_name) {
            items.push(ReceiverNoneItem {
                code: CODE_SECTION_MISMATCH,
                line,
                character,
                length: method_name.encode_utf16().count(),
                kind: "sectionMismatch",
                receiver,
                method_name,
            });
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> Vec<ReceiverNoneItem> {
        compute_receiver_none_items(&ReceiverNoneParams {
            text: text.to_string(),
            methods: Vec::new(),
            declarations: HashMap::new(),
        })
    }

    fn run_with(
        text: &str,
        methods: Vec<ClassMethodsInput>,
        declarations: HashMap<String, Vec<String>>,
    ) -> Vec<ReceiverNoneItem> {
        compute_receiver_none_items(&ReceiverNoneParams {
            text: text.to_string(),
            methods,
            declarations,
        })
    }

    fn class(start: usize, end: usize, defs: &[usize]) -> ClassMethodsInput {
        ClassMethodsInput {
            start_line: start,
            end_line: end,
            def_lines: defs.to_vec(),
        }
    }

    #[test]
    fn unguarded_receiver_call_reports() {
        let found = run("class A:\n    def f(self):\n        self.cell.foo()\n");
        assert_eq!(found.len(), 0); // 无方法区间输入(空 methods)→ 无 guard 闸面,TS 同语义
        let found = run_with(
            "class A:\n    def f(self):\n        self.cell.foo()\n",
            vec![class(0, 4, &[1])],
            HashMap::new(),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "receiverNone");
        assert_eq!(found[0].line, 2);
        assert_eq!(found[0].character, 18); // self.cell. 前缀后方法名起点
        assert_eq!(found[0].code, CODE_RECEIVER_NONE);
    }

    #[test]
    fn guarded_forms_do_not_report() {
        let body = "    def f(self):\n";
        for guard in [
            "        if self.cell:\n",
            "        if self.cell is not None:\n",
            "        if not (self.cell is None):\n",
            "        if kbe.isValid(self.cell):\n",
        ] {
            let text = format!("class A:\n{body}{guard}            self.cell.foo()\n");
            let found = run_with(&text, vec![class(0, 7, &[1])], HashMap::new());
            assert!(found.is_empty(), "guard form should suppress: {guard}");
        }
    }

    #[test]
    fn early_exit_guard_with_return_suppresses() {
        let text = "class A:\n    def f(self):\n        if not self.cell:\n            return\n        self.cell.foo()\n";
        let found = run_with(text, vec![class(0, 6, &[1])], HashMap::new());
        assert!(found.is_empty());
        let text = "class A:\n    def f(self):\n        if self.cell is None:\n            return\n        self.cell.foo()\n";
        let found = run_with(text, vec![class(0, 6, &[1])], HashMap::new());
        assert!(found.is_empty());
    }

    #[test]
    fn alias_positive_guard_suppresses_but_rebind_invalidates() {
        let ok = "class A:\n    def f(self):\n        cell = self.cell\n        if cell:\n            cell.foo()\n";
        assert!(run_with(ok, vec![class(0, 6, &[1])], HashMap::new()).is_empty());
        // 别名 guard 与 self.<role> 使用之间重赋值别名 → 旧证明失效 → 报
        // (别名使用点本身因重绑为 None 而不再是接收者调用,与 TS 同语义)
        let bad = "class A:\n    def f(self):\n        cell = self.cell\n        if cell:\n            cell = None\n            self.cell.foo()\n";
        let found = run_with(bad, vec![class(0, 7, &[1])], HashMap::new());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "receiverNone");
        assert_eq!(found[0].line, 5);
    }

    #[test]
    fn same_line_ternary_suppresses() {
        let text = "class A:\n    def f(self):\n        v = self.cell.foo() if self.cell else 0\n";
        assert!(run_with(text, vec![class(0, 5, &[1])], HashMap::new()).is_empty());
    }

    #[test]
    fn masks_strings_and_comments() {
        let text = "class A:\n    def f(self):\n        # self.cell.foo()\n        s = \"self.cell.foo()\"\n";
        assert!(run_with(text, vec![class(0, 6, &[1])], HashMap::new()).is_empty());
    }

    #[test]
    fn section_mismatch_reports_and_match_does_not() {
        let text = "class A:\n    def f(self):\n        self.base.jump()\n";
        let mut decls = HashMap::new();
        decls.insert("jump".to_string(), vec!["CellMethods".to_string()]);
        let found = run_with(text, vec![class(0, 4, &[1])], decls);
        // 无 guard 的接收者引用与段错配各自成条(receiverNone 在前,与 TS 同序)
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].kind, "receiverNone");
        assert_eq!(found[1].kind, "sectionMismatch");
        assert_eq!(found[1].code, CODE_SECTION_MISMATCH);
        let mut decls = HashMap::new();
        decls.insert("jump".to_string(), vec!["BaseMethods".to_string()]);
        let found = run_with(text, vec![class(0, 4, &[1])], decls);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "receiverNone");
    }

    #[test]
    fn alias_use_via_local_name_collects_calls() {
        let text = "class A:\n    def f(self):\n        cell = self.cell\n        cell.foo()\n";
        let found = run_with(text, vec![class(0, 5, &[1])], HashMap::new());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 3);
        assert_eq!(found[0].method_name, "foo");
    }

    #[test]
    fn non_ascii_offsets_stay_in_utf16_code_units() {
        // 字符串内非 ASCII 被掩成同长度空白(码元保长),调用列不漂移
        let text = "class A:\n    def f(self):\n        print(\"庆祝🎉\") ; self.cell.foo()\n";
        let found = run_with(text, vec![class(0, 5, &[1])], HashMap::new());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].character, 34); // self.cell. 之后 foo 起点(码元列)
    }

    #[test]
    fn params_shape_round_trip() {
        let result = analyze_receiver_none(json!({
            "text": "class A:\n    def f(self):\n        self.cell.foo()\n",
            "methods": [{ "startLine": 0, "endLine": 4, "defLines": [1] }],
            "declarations": {}
        }))
        .unwrap();
        let items = result["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["code"], CODE_RECEIVER_NONE);
        assert_eq!(items[0]["kind"], "receiverNone");
        assert_eq!(items[0]["receiver"], "cell");
        assert_eq!(items[0]["methodName"], "foo");
    }
}
