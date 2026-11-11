//! LANG-NAR-1 语义引擎流敏感窄化(RUST-MIGRATION-AUDIT-006 B1 车道批 1)。
//!
//! TS `src/backend/selfAttributeFlowTypes.ts`(567 行)逐字移植,含其唯一解析
//! 依赖 `src/backend/pythonParser.ts` 的掩码/语句合并/类跨度提取段——**不换
//! ruff**:对拍纪律要求与 TS 引擎字节级等价(嵌套类/语句合并/缩进口径以 TS
//! 正则解析器为准;ruff 换道留给后续精确性车道,见战役计划后续章节)。
//!
//! 移植口径(逐字对齐要点):
//! - 全程 UTF-16 码元(与 JS 字符串索引同基底);行走查器吃调用方原样行
//!   (inlay 路原文/诊断路掩码行,Rust 不二次掩码——与 TS 纯函数同契约);
//! - 解析路径 = 行 join('\n') 后按 `/\r?\n/` 再切(尾随 `\r` 剥离)→
//!   `pythonCodeLines` 掩码 → `pythonStatements` 括号/续行合并 → 类/def 栈式
//!   提取。引擎只用 ClassSpan{name,startLine,endLine,methods:名→行};
//!   TS methods 的 character 列引擎不读,不移植(列口径无消费者);
//! - 正则全部手工展开成扫描器,左优先交替 + 回溯语义逐字保真
//!   (anyBlockOpen 的 `else` 命中后词边界失败不换关键字的 JS 行为等);
//!   `\s` 取 JS 全类(含  /　/﻿ 等),`\w` = `[A-Za-z0-9_]`;
//! - 类型集合 BTreeSet(输出恒排序,与 TS `[...set].sort()` 等值;非 BMP
//!   码点排序差 = 字节序 vs UTF-16 码元序,类型原子皆 ASCII 不触);
//! - `SelfAttributeFlowOptions` 回调面不在 RPC 契约(生产恒 undefined),
//!   Rust 无此参数——调用/裸名解析恒空集(与生产 TS 行为一致);
//! - KODE-PERF-001 版本键 LRU 解析缓存:max=8 触碰移尾/逐最旧,键=TS 传来的
//!   不透明字符串(flowVersionKeyForDocument 产物);无键=现解析不缓存(纯函数
//!   回退逐字节一致)。缓存值只存引擎所需的类跨度(与 TS 缓存整份
//!   ParsedPythonFile 对引擎行为等值)。
//!
//! 诚实边界:类型以原子注解字符串集合表示,推不出即空集(不硬造 Any)。

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::Mutex;

/// 版本键 LRU 容量(TS PARSE_CACHE_MAX_ENTRIES = 8)
pub const PARSE_CACHE_MAX_ENTRIES: usize = 8;

// ---- 基础字符类(JS 语义) --------------------------------------------------

/// JS `\s` 全类(码元):\t \n \v \f \r 空格      -
///
fn is_js_space(code: u16) -> bool {
    matches!(code, 0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20)
        || code == 0xA0
        || code == 0x1680
        || (0x2000..=0x200A).contains(&code)
        || code == 0x2028
        || code == 0x2029
        || code == 0x202F
        || code == 0x205F
        || code == 0x3000
        || code == 0xFEFF
}

/// JS 行终止符(`.` 排除集;行内孤立 `\r`/U+2028/U+2029 使 `.+/$` 形失配)
fn is_js_line_terminator(code: u16) -> bool {
    matches!(code, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// TS 词首字符类 `[A-Za-z_]`(不含数字)
fn is_name_start(code: u16) -> bool {
    code == 0x5F || (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code)
}

/// TS `\w` = `[A-Za-z0-9_]`
fn is_word(code: u16) -> bool {
    is_name_start(code) || (0x30..=0x39).contains(&code)
}

fn is_digit(code: u16) -> bool {
    (0x30..=0x39).contains(&code)
}

/// 字面量前缀类 `[bBrRuUfF]`
fn is_str_prefix_char(code: u16) -> bool {
    matches!(code, 0x62 | 0x42 | 0x72 | 0x52 | 0x75 | 0x55 | 0x66 | 0x46)
}

// ---- pythonCodeLines 掩码(pythonParser.ts:26-51 逐字移植) -----------------

/// `content.split(/\r?\n/)`(尾随 `\r` 剥离)。attributeNone 诊断面复用:
/// 掩码文本行数组与 TS `maskedText.split(/\r?\n/)` 同法。
pub fn split_crlf(content: &[u16]) -> Vec<Vec<u16>> {
    let mut lines = Vec::new();
    let mut current = Vec::new();
    let mut i = 0usize;
    while i < content.len() {
        let code = content[i];
        if code == 0x0A {
            if let Some(&0x0D) = current.last() {
                current.pop();
            }
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(code);
        }
        i += 1;
    }
    lines.push(current);
    lines
}

/// 掩码注释/字符串字面量为同长占位(quote 态跨行持续;triple 三引号成段)。
/// 逐字对齐 TS:转义内两码元占位、三引号开/闭各三码元占位、`#` 起尾段全空白。
fn python_code_lines(content: &[u16]) -> Vec<Vec<u16>> {
    let mut lines = split_crlf(content);
    let mut quote: u16 = 0; // 0 = 无引号态
    let mut triple = false;
    for raw in lines.iter_mut() {
        let original = std::mem::take(raw);
        let mut masked: Vec<u16> = Vec::with_capacity(original.len());
        let mut col = 0usize;
        while col < original.len() {
            let ch = original[col];
            if quote != 0 {
                if ch == 0x5C {
                    // TS: masked += '  '; col += 1; continue(循环再 +1,共进 2)
                    masked.push(0x20);
                    masked.push(0x20);
                    col += 2;
                    continue;
                }
                let is_triple_close = triple
                    && col + 3 <= original.len()
                    && original[col] == quote
                    && original.get(col + 1) == Some(&quote)
                    && original.get(col + 2) == Some(&quote);
                if is_triple_close {
                    quote = 0;
                    triple = false;
                    masked.push(0x20);
                    masked.push(0x20);
                    masked.push(0x20);
                    col += 3; // TS: col += 2 后循环 +1
                    continue;
                }
                if !triple && ch == quote {
                    quote = 0;
                    masked.push(0x20);
                } else {
                    masked.push(0x20);
                }
                col += 1;
                continue;
            }
            if ch == 0x23 {
                // '#':尾段全空白补齐到行尾,终止
                while masked.len() < original.len() {
                    masked.push(0x20);
                }
                break;
            }
            if ch == 0x27 || ch == 0x22 {
                quote = ch;
                let is_triple_open = col + 3 <= original.len()
                    && original.get(col + 1) == Some(&ch)
                    && original.get(col + 2) == Some(&ch);
                triple = is_triple_open;
                if triple {
                    masked.push(0x5F);
                    masked.push(0x5F);
                    masked.push(0x5F);
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
        *raw = masked;
    }
    lines
}

// ---- pythonStatements(pythonParser.ts:64-88 逐字移植) ---------------------

/// 合并后的语句(括号深度/续行归并;文本=掩码行以单空格连接,首行坐标保留)
#[derive(Debug)]
pub struct PyStatement {
    pub text: Vec<u16>,
    pub line: usize,
    #[allow(dead_code)]
    pub end_line: usize,
    pub indent: usize,
}

/// 行首 `[ \t]*` 缩进(tab 计 4)
fn indent_of(line: &[u16]) -> usize {
    let mut indent = 0usize;
    for &code in line {
        if code == 0x20 {
            indent += 1;
        } else if code == 0x09 {
            indent += 4;
        } else {
            break;
        }
    }
    indent
}

/// `^\s*$`(JS \s 全类)
fn is_blank(line: &[u16]) -> bool {
    line.iter().all(|&code| is_js_space(code))
}

/// `^\s*(#.*)?$`
fn is_comment_only(line: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    i == line.len() || line[i] == 0x23
}

fn python_statements(content: &[u16]) -> Vec<PyStatement> {
    let mut statements: Vec<PyStatement> = Vec::new();
    let mut depth = 0i64;
    let mut pending: Vec<u16> = Vec::new();
    let mut start = 0usize;
    let mut indent = 0usize;
    for (line_no, masked) in python_code_lines(content).into_iter().enumerate() {
        let trimmed_nonempty = masked.iter().any(|&code| !is_js_space(code));
        if pending.is_empty() && !trimmed_nonempty {
            continue;
        }
        if pending.is_empty() {
            start = line_no;
            indent = indent_of(&masked);
        }
        for &ch in &masked {
            if ch == 0x28 || ch == 0x5B || ch == 0x7B {
                depth += 1;
            }
            if ch == 0x29 || ch == 0x5D || ch == 0x7D {
                depth = std::cmp::max(0, depth - 1);
            }
        }
        // /\\\s*$/:行尾反斜杠 + 其后空白(仅此段剥除,其余尾随空白保留——
        // TS `masked.replace(/\\\s*$/, '')` 逐字语义)
        let mut content_end = masked.len();
        while content_end > 0 && is_js_space(masked[content_end - 1]) {
            content_end -= 1;
        }
        let continued = content_end > 0 && masked[content_end - 1] == 0x5C;
        if !pending.is_empty() {
            pending.push(0x20);
        }
        if continued {
            pending.extend_from_slice(&masked[..content_end - 1]);
        } else {
            pending.extend_from_slice(&masked);
        }
        if depth == 0 && !continued {
            statements.push(PyStatement {
                text: std::mem::take(&mut pending),
                line: start,
                end_line: line_no,
                indent,
            });
        }
    }
    statements
}

// ---- 类跨度提取(parsePythonFile 类/def 段逐字移植) ------------------------

/// 类跨度(引擎所需字段;TS methods 的 character 列引擎不读,不移植)
#[derive(Debug, Clone)]
pub struct ClassSpan {
    pub name: String,
    /// 0 起起始行(class 语句行)
    pub start_line: usize,
    /// 0 起结束行(不含);未闭合 = 全文行数
    pub end_line: usize,
    /// 方法名 → 0 起起始行
    pub method_lines: HashMap<String, usize>,
}

/// 语句文本上匹配 `^\s*class\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*:`(贪婪
/// `(.*)` 回溯语义:取**最后一个**其后缀匹配 `\s*:` 的 `)`)。
fn match_class_statement(text: &[u16]) -> Option<usize> {
    let mut i = 0usize;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    for expected in b"class" {
        if text.get(i) != Some(&(*expected as u16)) {
            return None;
        }
        i += 1;
    }
    let ws_start = i;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if i == ws_start {
        return None; // \s+ 至少一空白
    }
    if text.get(i).map(|&c| is_name_start(c)) != Some(true) {
        return None;
    }
    let name_start = i;
    while i < text.len() && is_word(text[i]) {
        i += 1;
    }
    let _name_end = i;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if text.get(i) == Some(&0x28u16) {
        // 带基类括号:贪婪 `(.*)` 取最后一个使 `\)\s*:` 成立的 ')';`.*`
        // 不匹配行终止符 → 首终止符之后的位置不可达(孤立 \r 截断回溯域)
        let open = i;
        let mut limit = text.len();
        for (pos, &c) in text.iter().enumerate().skip(open + 1) {
            if is_js_line_terminator(c) {
                limit = pos;
                break;
            }
        }
        let mut j = limit;
        while j > open + 1 {
            j -= 1;
            if text[j] == 0x29 {
                // 检查 ')' 之后 `\s*:`(\s 含终止符)
                let mut k = j + 1;
                while k < text.len() && is_js_space(text[k]) {
                    k += 1;
                }
                if text.get(k) == Some(&0x3Au16) {
                    return Some(name_start);
                }
            }
        }
        // 括号组不成 → 整体失败(正则可选组失败后 `\s*:` 遇 '(' 不成立)
        None
    } else if text.get(i) == Some(&0x3Au16) {
        Some(name_start)
    } else {
        None
    }
}

/// 语句文本上匹配 `^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`,返回方法名
/// 码元区间。
fn match_def_statement(text: &[u16]) -> Option<(usize, usize)> {
    let mut i = 0usize;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    // (?:async\s+)?
    let mut j = i;
    for expected in b"async" {
        if text.get(j) != Some(&(*expected as u16)) {
            j = i;
            break;
        }
        j += 1;
    }
    if j != i {
        let ws = j;
        while j < text.len() && is_js_space(text[j]) {
            j += 1;
        }
        if j == ws {
            j = i; // async 后无空白 → 可选组整体不成立
        }
    }
    i = j;
    for expected in b"def" {
        if text.get(i) != Some(&(*expected as u16)) {
            return None;
        }
        i += 1;
    }
    let ws_start = i;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if i == ws_start {
        return None;
    }
    if text.get(i).map(|&c| is_name_start(c)) != Some(true) {
        return None;
    }
    let name_start = i;
    while i < text.len() && is_word(text[i]) {
        i += 1;
    }
    let name_end = i;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if text.get(i) == Some(&0x28u16) {
        Some((name_start, name_end))
    } else {
        None
    }
}

/// parsePythonFile 类/def 提取段:栈式作用域(函数体内的类不入表;仅类体直系
/// def 记方法;闭合行=收拢语句起始行;未闭合=全文行数)。
pub fn parse_class_spans(content: &[u16]) -> Vec<ClassSpan> {
    let total_lines = split_crlf(content).len();
    let mut classes: Vec<ClassSpan> = Vec::new();
    // 栈帧:indent + 该层是否类(类在 classes 的下标)/ 是否函数
    struct Scope {
        indent: usize,
        cls: Option<usize>,
        function: bool,
    }
    let mut stack: Vec<Scope> = Vec::new();
    for statement in python_statements(content) {
        let text = &statement.text;
        let line = statement.line;
        let indent = statement.indent;
        let trimmed_nonempty = text.iter().any(|&code| !is_js_space(code));
        if !trimmed_nonempty {
            continue;
        }
        while let Some(top) = stack.last() {
            if top.indent >= indent {
                let closed = stack.pop().unwrap();
                if let Some(idx) = closed.cls {
                    classes[idx].end_line = line;
                }
            } else {
                break;
            }
        }
        if stack.iter().any(|scope| scope.function) {
            continue;
        }
        if let Some(name_start) = match_class_statement(text) {
            let mut name_end = name_start;
            while name_end < text.len() && is_word(text[name_end]) {
                name_end += 1;
            }
            let name = String::from_utf16_lossy(&text[name_start..name_end]);
            classes.push(ClassSpan {
                name,
                start_line: line,
                end_line: total_lines,
                method_lines: HashMap::new(),
            });
            stack.push(Scope {
                indent,
                cls: Some(classes.len() - 1),
                function: false,
            });
            continue;
        }
        if let Some((name_start, name_end)) = match_def_statement(text) {
            if let Some(top) = stack.last() {
                if let Some(idx) = top.cls {
                    let name = String::from_utf16_lossy(&text[name_start..name_end]);
                    classes[idx].method_lines.insert(name, line);
                }
            }
            stack.push(Scope {
                indent,
                cls: None,
                function: true,
            });
            continue;
        }
        // import / 实例赋值段引擎不消费,不移植(注:不影响类跨度/方法集)
    }
    classes
}

// ---- 版本键 LRU 解析缓存(KODE-PERF-001 语义对齐) --------------------------

struct ParseCacheEntry {
    map: HashMap<String, Vec<ClassSpan>>,
    order: VecDeque<String>,
}

static PARSE_CACHE: Mutex<Option<ParseCacheEntry>> = Mutex::new(None);

fn parse_with_version_cache(lines: &[Vec<u16>], version_key: Option<&str>) -> Vec<ClassSpan> {
    let key = match version_key {
        Some(key) => key,
        None => {
            // 无键 = 现解析不缓存(纯函数回退)
            let mut content: Vec<u16> = Vec::new();
            for (idx, line) in lines.iter().enumerate() {
                if idx > 0 {
                    content.push(0x0A);
                }
                content.extend_from_slice(line);
            }
            return parse_class_spans(&content);
        }
    };
    let mut guard = PARSE_CACHE.lock().unwrap();
    let entry = guard.get_or_insert(ParseCacheEntry {
        map: HashMap::new(),
        order: VecDeque::new(),
    });
    if let Some(cached) = entry.map.get(key) {
        let cached = cached.clone();
        // LRU 触碰:移到尾(最近使用)
        if let Some(pos) = entry.order.iter().position(|k| k == key) {
            entry.order.remove(pos);
        }
        entry.order.push_back(key.to_string());
        return cached;
    }
    let mut content: Vec<u16> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx > 0 {
            content.push(0x0A);
        }
        content.extend_from_slice(line);
    }
    let parsed = parse_class_spans(&content);
    entry.map.insert(key.to_string(), parsed.clone());
    entry.order.push_back(key.to_string());
    while entry.order.len() > PARSE_CACHE_MAX_ENTRIES {
        if let Some(oldest) = entry.order.pop_front() {
            entry.map.remove(&oldest);
        }
    }
    parsed
}

/// 清缓存(测试注入口;生产不用)
pub fn reset_self_attribute_flow_parse_cache_for_tests() {
    *PARSE_CACHE.lock().unwrap() = None;
}

// ---- 流类型集合运算 ---------------------------------------------------------

#[derive(Debug)]
pub struct SelfAttributeFlow {
    /// 去重排序的原子类型名;空 = 无法确定
    pub types: Vec<String>,
    /// 格式化注解串('list | None')或 None(types 空)
    pub annotation: Option<String>,
    pub has_none: bool,
    /// 窄化生效:基类含 None 而查询位不含
    pub narrowed: bool,
}

type TypeSet = BTreeSet<String>;

fn union_types(sets: &[&TypeSet]) -> TypeSet {
    let mut out = TypeSet::new();
    for set in sets {
        for item in *set {
            out.insert(item.clone());
        }
    }
    out
}

fn without_none(types: &TypeSet) -> TypeSet {
    types.iter().filter(|t| t.as_str() != "None").cloned().collect()
}

/// 排序 + ` | ` 联接(BTreeSet 迭代即升序;空集 → None)
fn format_types(types: &TypeSet) -> Option<String> {
    if types.is_empty() {
        return None;
    }
    Some(types.iter().cloned().collect::<Vec<_>>().join(" | "))
}

// ---- 行形态扫描器(正则手工展开,左优先 + 回溯语义) -------------------------

/// `x = rhs` 形共通核:`^\s*ESC\s*=\s*(?!=)(.+)`。返回 RHS 码元区间。
/// `\s*` 贪婪回溯:`= =` 形(赋值后空白再 '=')按正则回溯以较少空白使
/// `(?!=)` 成立,匹配带 '=' 的 RHS(与 JS 引擎一致)。
fn match_assignment_tail(text: &[u16], head_end: usize) -> Option<(usize, usize)> {
    let mut i = head_end;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if text.get(i) != Some(&0x3Du16) {
        return None;
    }
    i += 1;
    let ws_start = i;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    // `\s*(?!=)(.+)$` 带全回溯:probe 从最长空白向前逐位试,每位过三关——
    // 前瞻(≠'=')、`.+` 首字符(非行终止符)、余段无终止符(`.` 不匹配
    // \r/U+2028/U+2029,`$` 无 /m 仅串尾;任一不过即回溯一位)
    let mut probe = i;
    loop {
        match text.get(probe) {
            None => return None, // 空白耗尽仍无合法起点((.+) 至少一字符)
            Some(&0x3D) => {
                if probe == ws_start {
                    return None;
                }
                probe -= 1;
            }
            Some(&c) if is_js_line_terminator(c) => {
                if probe == ws_start {
                    return None;
                }
                probe -= 1;
            }
            Some(_) => {
                if text[probe..].iter().any(|&c| is_js_line_terminator(c)) {
                    if probe == ws_start {
                        return None;
                    }
                    probe -= 1;
                    continue;
                }
                return Some((probe, text.len()));
            }
        }
    }
}

/// `^\s*self\.ESC\s*=\s*(?!=)(.+)$` → RHS 区间(attr 精确匹配)
fn assignment_rhs<'a>(line: &'a [u16], attr: &[u16]) -> Option<&'a [u16]> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    for expected in b"self" {
        if line.get(i) != Some(&(*expected as u16)) {
            return None;
        }
        i += 1;
    }
    if line.get(i) != Some(&0x2Eu16) {
        return None;
    }
    i += 1;
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return None;
    }
    i += attr.len();
    let (start, end) = match_assignment_tail(line, i)?;
    Some(&line[start..end])
}

/// `^\s*if\s+self\.ESC\s+is\s+None\s*:`
fn none_guard(line: &[u16], attr: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    for &byte in b"if" {
        if line.get(i) != Some(&(byte as u16)) {
            return false;
        }
        i += 1;
    }
    // \s+
    let ws = i;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if i == ws {
        return false;
    }
    for &byte in b"self" {
        if line.get(i) != Some(&(byte as u16)) {
            return false;
        }
        i += 1;
    }
    if line.get(i) != Some(&0x2Eu16) {
        return false;
    }
    i += 1;
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return false;
    }
    i += attr.len();
    // \s+ is \s+ None \s* :
    for word in [&b"is"[..], &b"None"[..]] {
        let ws = i;
        while i < line.len() && is_js_space(line[i]) {
            i += 1;
        }
        if i == ws {
            return false;
        }
        for &byte in word.iter() {
            if line.get(i) != Some(&(byte as u16)) {
                return false;
            }
            i += 1;
        }
    }
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    line.get(i) == Some(&0x3Au16)
}

/// `^\s*if\s+self\.ESC\s+is\s+not\s+None\s*:`
fn not_none_guard(line: &[u16], attr: &[u16]) -> bool {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    for word in [&b"if"[..], &b"self"[..]] {
        for &byte in word {
            if line.get(i) != Some(&(byte as u16)) {
                return false;
            }
            i += 1;
        }
        let ws = i;
        while i < line.len() && is_js_space(line[i]) {
            i += 1;
        }
        if i == ws {
            return false;
        }
    }
    // 'self' 后应为 '.'
    if line.get(i) != Some(&0x2Eu16) {
        return false;
    }
    i += 1;
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return false;
    }
    i += attr.len();
    for word in [&b"is"[..], &b"not"[..], &b"None"[..]] {
        let ws = i;
        while i < line.len() && is_js_space(line[i]) {
            i += 1;
        }
        if i == ws {
            return false;
        }
        for &byte in word.iter() {
            if line.get(i) != Some(&(byte as u16)) {
                return false;
            }
            i += 1;
        }
    }
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    line.get(i) == Some(&0x3Au16)
}

/// 块开关键字交替(左优先序,与 TS 正则同序):if|elif|else|for|while|try|
/// except|finally|with + `\b` 词界。JS 行为保真:某关键字命中但词界失败时,
/// 继续试**后续**交替(如 `elsewhere`:'else' 词界失败,余者不匹配 → 整体否)。
fn any_block_open(line: &[u16]) -> bool {
    const KEYWORDS: [&[u8]; 9] = [
        b"if", b"elif", b"else", b"for", b"while", b"try", b"except", b"finally", b"with",
    ];
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    'outer: for keyword in KEYWORDS {
        if line.len() - i < keyword.len() {
            continue;
        }
        for (offset, &byte) in keyword.iter().enumerate() {
            if line[i + offset] != byte as u16 {
                continue 'outer;
            }
        }
        let after = i + keyword.len();
        // \b:词元后界(行尾 = 界;非 \w = 界)
        if after == line.len() || !is_word(line[after]) {
            return true;
        }
    }
    false
}

/// `^\s*(return|raise)\b`
fn terminal_line(line: &[u16]) -> bool {
    const KEYWORDS: [&[u8]; 2] = [b"return", b"raise"];
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    'outer: for keyword in KEYWORDS {
        if line.len() - i < keyword.len() {
            continue;
        }
        for (offset, &byte) in keyword.iter().enumerate() {
            if line[i + offset] != byte as u16 {
                continue 'outer;
            }
        }
        let after = i + keyword.len();
        if after == line.len() || !is_word(line[after]) {
            return true;
        }
    }
    false
}

/// RHS 尾注释剥离(简单形态:字符串外 `#` 截断;引号内 `\'` 转义不闭串)。
/// 空串/全空白剥离后返回空切片(TS 返回 '',typeOfExpr 空集)。
fn strip_trailing_comment(rhs: &[u16]) -> &[u16] {
    let mut in_string: Option<u16> = None;
    for i in 0..rhs.len() {
        let ch = rhs[i];
        if let Some(q) = in_string {
            if ch == q && i > 0 && rhs[i - 1] != 0x5C {
                in_string = None;
            }
            continue;
        }
        if ch == 0x27 || ch == 0x22 {
            in_string = Some(ch);
            continue;
        }
        if ch == 0x23 {
            return trim_js(&rhs[..i]);
        }
    }
    trim_js(rhs)
}

/// JS `String.prototype.trim`(两端 JS \s)
fn trim_js(text: &[u16]) -> &[u16] {
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

/// `&[u16]` 与 ASCII 字面量逐码元相等(UTF-16 码元比较,替代 `[u16]==[u8]`)
fn eq_word(text: &[u16], word: &str) -> bool {
    text.iter().copied().eq(word.encode_utf16())
}

fn atom(name: &str) -> TypeSet {
    let mut set = TypeSet::new();
    set.insert(name.to_string());
    set
}

/// 表达式类型(原子集合)。生产契约无回调(调用/裸名解析恒空集)。
/// 字面量:None/True/False/int/float/bytes|str(前缀 b/B=bytes)/list/dict/
/// tuple;调用形态与裸名推不出 → 空集(不硬造)。
fn type_of_expr(expr: &[u16]) -> TypeSet {
    let text = strip_trailing_comment(expr);
    if text.is_empty() {
        return TypeSet::new();
    }
    if eq_word(text, "None") {
        return atom("None");
    }
    if eq_word(text, "True") || eq_word(text, "False") {
        return atom("bool");
    }
    // ^[+-]?\d+$
    {
        let mut i = 0usize;
        if text.first() == Some(&0x2B) || text.first() == Some(&0x2D) {
            i = 1;
        }
        let digits_start = i;
        while i < text.len() && is_digit(text[i]) {
            i += 1;
        }
        if i == text.len() && i > digits_start {
            return atom("int");
        }
    }
    // ^[+-]?\d+\.\d+$
    {
        let mut i = 0usize;
        if text.first() == Some(&0x2B) || text.first() == Some(&0x2D) {
            i = 1;
        }
        let digits_start = i;
        while i < text.len() && is_digit(text[i]) {
            i += 1;
        }
        if i > digits_start
            && text.get(i) == Some(&0x2Eu16)
            && i + 1 < text.len()
        {
            let frac_start = i + 1;
            let mut j = frac_start;
            while j < text.len() && is_digit(text[j]) {
                j += 1;
            }
            if j == text.len() && j > frac_start {
                return atom("float");
            }
        }
    }
    // 字符串字面量:^([bBrRuUfF]{0,2})['"] 且 ['"]$;b/B 前缀 = bytes
    if matches!(text.last(), Some(&0x27) | Some(&0x22)) {
        let mut prefix_len = 0usize;
        while prefix_len < 2 && prefix_len < text.len() && is_str_prefix_char(text[prefix_len]) {
            prefix_len += 1;
        }
        // {0,2} 贪婪回溯:前缀类先吃满再回退至引号可成立的最短——直接枚举
        // 前缀长 2/1/0(首位必须是引号)
        for candidate in [2usize, 1, 0] {
            if candidate <= prefix_len
                && matches!(text.get(candidate), Some(&0x27) | Some(&0x22))
            {
                let has_b = text[..candidate]
                    .iter()
                    .any(|&c| c == 0x62 || c == 0x42);
                return atom(if has_b { "bytes" } else { "str" });
            }
        }
    }
    if text.first() == Some(&0x5Bu16) && text.last() == Some(&0x5Du16) {
        return atom("list");
    }
    if text.first() == Some(&0x7Bu16) && text.last() == Some(&0x7Du16) {
        return atom("dict");
    }
    if text.first() == Some(&0x28u16) && text.last() == Some(&0x29u16) {
        return atom("tuple");
    }
    // 调用形态:name(… / a.b.c( → 末段 callee 取注解;无回调恒空集
    if match_call_form(text) {
        return TypeSet::new();
    }
    // self.Y(有界:不递归)恒空集
    if match_self_chain(text) {
        return TypeSet::new();
    }
    // 裸名:无回调恒空集
    if match_bare_name(text) {
        return TypeSet::new();
    }
    TypeSet::new()
}

/// `^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(` 完整形态判定
fn match_call_form(text: &[u16]) -> bool {
    let mut i = 0usize;
    if text.first().map(|&c| is_name_start(c)) != Some(true) {
        return false;
    }
    while i < text.len() && is_word(text[i]) {
        i += 1;
    }
    loop {
        let save = i;
        while i < text.len() && is_js_space(text[i]) {
            i += 1;
        }
        if text.get(i) == Some(&0x2Eu16) {
            i += 1;
            while i < text.len() && is_js_space(text[i]) {
                i += 1;
            }
            if text.get(i).map(|&c| is_name_start(c)) == Some(true) {
                while i < text.len() && is_word(text[i]) {
                    i += 1;
                }
                continue;
            }
            // '.' 后非名 → 整体失败(正则该分支必填)
            return false;
        }
        i = save;
        break;
    }
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    text.get(i) == Some(&0x28u16)
}

/// `^self\.([A-Za-z_]\w*)$`
fn match_self_chain(text: &[u16]) -> bool {
    text.len() > 5
        && text[0] == b's' as u16
        && text[1] == b'e' as u16
        && text[2] == b'l' as u16
        && text[3] == b'f' as u16
        && text[4] == 0x2E
        && is_name_start(text[5])
        && text[6..].iter().all(|&c| is_word(c))
}

/// `^[A-Za-z_]\w*$`
fn match_bare_name(text: &[u16]) -> bool {
    !text.is_empty() && is_name_start(text[0]) && text[1..].iter().all(|&c| is_word(c))
}

// ---- 方法域定位与流走查器 ---------------------------------------------------

struct MethodSpan {
    start_line: usize,
    end_line: usize,
}

/// 方法体界(0 起,含尾):类方法排序区间;查询行在类内但先于首方法/类外 → None
fn enclosing_method(classes: &[ClassSpan], line: usize) -> Option<(MethodSpan, usize)> {
    for (idx, cls) in classes.iter().enumerate() {
        if line < cls.start_line || line >= cls.end_line {
            continue;
        }
        let mut starts: Vec<usize> = cls.method_lines.values().copied().collect();
        starts.sort_unstable();
        for i in (0..starts.len()).rev() {
            if starts[i] <= line {
                let end_line = if i + 1 < starts.len() {
                    starts[i + 1] - 1
                } else {
                    cls.end_line - 1
                };
                return Some((MethodSpan { start_line: starts[i], end_line }, idx));
            }
        }
        return None;
    }
    None
}

/// 方法体基础缩进:方法行后首个非空行缩进;无体行 = 方法行缩进 + 1
fn method_base_indent(lines: &[Vec<u16>], method: &MethodSpan) -> usize {
    let method_indent = lines
        .get(method.start_line)
        .map(|l| indent_of(l))
        .unwrap_or(0);
    for j in method.start_line + 1..=method.end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            return indent_of(text);
        }
    }
    method_indent + 1
}

struct ScanResult {
    state: TypeSet,
    /// then 分支以 return/raise 终止(不落到块后)
    terminal: bool,
    /// 扫描在 stopAtLine 前停住(查询位在本块内)
    reached_stop: bool,
}

/// 顺序扫描(同缩进层):赋值覆盖/两种 None 守卫/通用块并集/return raise 终止。
/// stop 非空时到达查询行前停(写点恰是赋值行先落 RHS 语义再停)。
#[allow(clippy::too_many_arguments)]
fn scan_sequence(
    lines: &[Vec<u16>],
    start_line: usize,
    end_line: usize,
    indent: usize,
    attr: &[u16],
    initial_state: &TypeSet,
    stop_at_line: Option<usize>,
) -> ScanResult {
    let mut state = initial_state.clone();
    let mut line = start_line;
    while line <= end_line {
        if let Some(stop) = stop_at_line {
            if line >= stop {
                // 查询位:先落赋值语义(写点 inlay 显 RHS 类型)再停
                let empty: Vec<u16> = Vec::new();
                let text = lines.get(line).unwrap_or(&empty);
                if let Some(rhs) = assignment_rhs(text, attr) {
                    return ScanResult {
                        state: type_of_expr(rhs),
                        terminal: false,
                        reached_stop: true,
                    };
                }
                return ScanResult {
                    state,
                    terminal: false,
                    reached_stop: true,
                };
            }
        }
        let empty: Vec<u16> = Vec::new();
        let text = lines.get(line).unwrap_or(&empty);
        if is_blank(text) || is_comment_only(text) {
            line += 1;
            continue;
        }
        let this_indent = indent_of(text);
        if this_indent < indent {
            break; // 去缩进:本序列结束
        }
        if this_indent > indent {
            line += 1; // 更深缩进(块体)不属本层,跳过
            continue;
        }
        if let Some(rhs) = assignment_rhs(text, attr) {
            state = type_of_expr(rhs);
            line += 1;
            continue;
        }
        if none_guard(text, attr) {
            let block_end = find_block_end(lines, line, end_line, this_indent);
            let body_indent = block_body_indent(lines, line, block_end);
            let none_set = atom("None");
            let inner = scan_sequence(
                lines,
                line + 1,
                block_end,
                body_indent,
                attr,
                &none_set,
                stop_at_line,
            );
            if inner.terminal {
                // 早退:then 不落到块后;else 路径继续 → 去 None
                state = union_types(&[&without_none(&state)]);
            } else {
                state = union_types(&[&without_none(&state), &inner.state]);
            }
            if inner.reached_stop {
                return ScanResult {
                    state: inner.state,
                    terminal: inner.terminal,
                    reached_stop: true,
                };
            }
            line = block_end + 1;
            continue;
        }
        if not_none_guard(text, attr) {
            let block_end = find_block_end(lines, line, end_line, this_indent);
            let body_indent = block_body_indent(lines, line, block_end);
            let entry = without_none(&state);
            let inner = scan_sequence(
                lines,
                line + 1,
                block_end,
                body_indent,
                attr,
                &entry,
                stop_at_line,
            );
            if inner.terminal {
                // 早退非 None 块:then 退出,else(X 可 None)继续 → 入口态
                state = union_types(&[&state]);
            } else {
                state = union_types(&[&state, &inner.state]);
            }
            if inner.reached_stop {
                return ScanResult {
                    state: inner.state,
                    terminal: inner.terminal,
                    reached_stop: true,
                };
            }
            line = block_end + 1;
            continue;
        }
        if any_block_open(text) {
            let block_end = find_block_end(lines, line, end_line, this_indent);
            let body_indent = block_body_indent(lines, line, block_end);
            let inner = scan_sequence(
                lines,
                line + 1,
                block_end,
                body_indent,
                attr,
                &state,
                stop_at_line,
            );
            if inner.terminal {
                state = union_types(&[&state]);
            } else {
                state = union_types(&[&state, &inner.state]);
            }
            if inner.reached_stop {
                return ScanResult {
                    state: inner.state,
                    terminal: inner.terminal,
                    reached_stop: true,
                };
            }
            line = block_end + 1;
            continue;
        }
        if terminal_line(text) {
            return ScanResult {
                state,
                terminal: true,
                reached_stop: false,
            };
        }
        line += 1;
    }
    ScanResult {
        state,
        terminal: false,
        reached_stop: false,
    }
}

/// 块闭合行:首个缩进 <= 块行缩进的非空行前一行;无 = endLine
fn find_block_end(lines: &[Vec<u16>], start_line: usize, end_line: usize, indent: usize) -> usize {
    for j in start_line + 1..=end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            if indent_of(text) <= indent {
                return j - 1;
            }
        }
    }
    end_line
}

/// 块体实际缩进:块行后首个非空行缩进;无体行 = 块行缩进 + 1
fn block_body_indent(lines: &[Vec<u16>], start_line: usize, end_line: usize) -> usize {
    for j in start_line + 1..=end_line {
        if let Some(text) = lines.get(j) {
            if is_blank(text) || is_comment_only(text) {
                continue;
            }
            return indent_of(text);
        }
    }
    lines
        .get(start_line)
        .map(|l| indent_of(l))
        .unwrap_or(0)
        + 1
}

/// 收敛基类:类级声明(注解 `X: T` T 优先 + 赋值 `X = ...` 推导)∪ __init__
/// 体流扫描末态(尾部赋值覆盖)
fn converged_baseline(lines: &[Vec<u16>], cls: &ClassSpan, attr: &[u16]) -> TypeSet {
    let mut baseline = TypeSet::new();
    let class_body_indent = block_body_indent(lines, cls.start_line, cls.end_line.saturating_sub(1));
    let first_method_line = cls
        .method_lines
        .values()
        .copied()
        .min()
        .unwrap_or(cls.end_line.saturating_sub(1));
    let mut j = cls.start_line + 1;
    while j < first_method_line && j < cls.end_line {
        let empty: Vec<u16> = Vec::new();
        let text = lines.get(j).unwrap_or(&empty);
        if !(is_blank(text) || is_comment_only(text)) && indent_of(text) == class_body_indent {
            // 注解声明 `X: T = ...`(T 优先;`X: T` 无初始值亦算)
            if let Some(annotation) = match_class_annotated(text, attr) {
                baseline.insert(String::from_utf16_lossy(trim_js(annotation)));
            }
            // 赋值声明 `X = ...`
            if let Some(assigned) = match_class_assignment(text, attr) {
                baseline.extend(type_of_expr(assigned));
            }
        }
        j += 1;
    }
    if let Some(&init_line) = cls.method_lines.get("__init__") {
        let init_method = MethodSpan {
            start_line: init_line,
            end_line: cls.end_line.saturating_sub(1),
        };
        let base_indent = method_base_indent(lines, &init_method);
        let result = scan_sequence(
            lines,
            init_line + 1,
            init_method.end_line,
            base_indent,
            attr,
            &baseline,
            None,
        );
        baseline = result.state;
    }
    baseline
}

/// `^\s*ESC\s*=\s*(?!=)(.+)$`(类级赋值声明)→ RHS 区间
fn match_class_assignment<'a>(line: &'a [u16], attr: &[u16]) -> Option<&'a [u16]> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return None;
    }
    i += attr.len();
    let (start, end) = match_assignment_tail(line, i)?;
    Some(&line[start..end])
}

/// `^\s*ESC\s*:\s*([^=#]+?)\s*(?:=|$)`(类级注解声明)。惰性捕获带回溯:
/// 捕获 = 非 `#` 非 `=` 字符;`:` 后的 `\s*`(W1)贪吃满再逐位回吐给捕获
/// (畸形如 `x: = 5`/`x:␣` 以空白字符作捕获命中,trimmed 后为空串——JS
/// 引擎同此行为,逐字保真);捕获逐位延伸,每长度试一次 `\s*(=|$)` 边界;
/// '#' 使当前 W1 全长失败,回吐耗尽则整体失败。
fn match_class_annotated<'a>(line: &'a [u16], attr: &[u16]) -> Option<&'a [u16]> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if line.len() - i < attr.len() || &line[i..i + attr.len()] != attr {
        return None;
    }
    i += attr.len();
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if line.get(i) != Some(&0x3Au16) {
        return None;
    }
    i += 1;
    // W1 = ':' 后空白贪吃上界
    let ws_max = i;
    let mut run = i;
    while run < line.len() && is_js_space(line[run]) {
        run += 1;
    }
    let mut w1_end = run;
    loop {
        let capture_start = w1_end;
        // 捕获至少一字符:延伸位越界/不在 [^=#] 类则本 W1 失败
        let mut end = capture_start;
        loop {
            if end >= line.len() || line[end] == 0x3D || line[end] == 0x23 {
                break;
            }
            end += 1;
            // 边界:`\s*(=|$)`(W2 回溯永不成立,'=' 非空白,略)
            let mut q = end;
            while q < line.len() && is_js_space(line[q]) {
                q += 1;
            }
            if q == line.len() || line[q] == 0x3D {
                return Some(&line[capture_start..end]);
            }
        }
        if w1_end > ws_max {
            w1_end -= 1;
        } else {
            return None;
        }
    }
}

/// 查询位自管属性流敏感类型(纯函数;与 TS inferSelfAttributeFlow 等值)。
/// None 当:attr 空 / 查询行越界。
pub fn infer_self_attribute_flow(
    lines: &[Vec<u16>],
    query_line: usize,
    attr: &[u16],
    version_key: Option<&str>,
) -> Option<SelfAttributeFlow> {
    if attr.is_empty() || query_line >= lines.len() {
        return None;
    }
    let classes = parse_with_version_cache(lines, version_key);
    let enclosing = enclosing_method(&classes, query_line);
    let (flow, baseline) = if let Some((method, cls_idx)) = enclosing {
        let baseline = converged_baseline(lines, &classes[cls_idx], attr);
        let base_indent = method_base_indent(lines, &method);
        let result = scan_sequence(
            lines,
            method.start_line + 1,
            method.end_line,
            base_indent,
            attr,
            &baseline,
            Some(query_line),
        );
        (result.state, baseline)
    } else {
        // 类体/模块层:无方法流,直接用收敛基类
        let cls = classes
            .iter()
            .find(|c| query_line >= c.start_line && query_line < c.end_line);
        match cls {
            Some(cls) => {
                let baseline = converged_baseline(lines, cls, attr);
                (baseline.clone(), baseline)
            }
            None => (TypeSet::new(), TypeSet::new()),
        }
    };
    let has_none = flow.contains("None");
    let narrowed = baseline.contains("None") && !has_none;
    Some(SelfAttributeFlow {
        types: flow.iter().cloned().collect(),
        annotation: format_types(&flow),
        has_none,
        narrowed,
    })
}

// ---- 单测(TS tests/selfAttributeFlowTypes.test.ts 关键例移植;回调面用例
// ---- 留 TS 侧——生产契约无回调) -------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(body: &[&str]) -> Vec<Vec<u16>> {
        body.iter()
            .map(|l| l.encode_utf16().collect())
            .collect()
    }

    fn attr_u16(name: &str) -> Vec<u16> {
        name.encode_utf16().collect()
    }

    fn flow(body: &[&str], query_line: usize, attr: &str) -> SelfAttributeFlow {
        infer_self_attribute_flow(
            &lines_of(body),
            query_line,
            &attr.encode_utf16().collect::<Vec<u16>>(),
            None,
        )
        .unwrap()
    }

    #[test]
    fn guard_narrowing_without_call_annotation() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        if self.TalentTree is None:",
            "            self.TalentTree = make_tree()",
            "        x = self.TalentTree",
        ];
        let f = flow(&body, 6, "TalentTree");
        assert!(!f.has_none);
        assert!(f.narrowed);
        assert_eq!(f.annotation, None); // 调用注解解不出 → 空集,不硬造 Any
    }

    #[test]
    fn init_override_converges_to_list() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "        self.TalentTree = []",
            "    def method(self):",
            "        x = self.TalentTree",
        ];
        let f = flow(&body, 5, "TalentTree");
        assert!(!f.has_none);
        assert_eq!(f.annotation.as_deref(), Some("list"));
    }

    #[test]
    fn bare_none_keeps_none_evidence() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        self.TalentTree.get(0)",
        ];
        let f = flow(&body, 4, "TalentTree");
        assert!(f.has_none);
        assert!(!f.narrowed);
        assert_eq!(f.annotation.as_deref(), Some("None"));
    }

    #[test]
    fn class_level_none_reports() {
        let body = [
            "class Foo:",
            "    TalentTree = None",
            "    def method(self):",
            "        self.TalentTree.get(0)",
        ];
        assert!(flow(&body, 3, "TalentTree").has_none);
    }

    #[test]
    fn not_none_guard_narrows_inside_block() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "        self.TalentTree = []",
            "    def method(self):",
            "        if self.TalentTree is not None:",
            "            self.TalentTree.get(0)",
        ];
        assert!(!flow(&body, 6, "TalentTree").has_none);
    }

    #[test]
    fn early_exit_guard_removes_none() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.TalentTree = None",
            "    def method(self):",
            "        if self.TalentTree is None:",
            "            return",
            "        self.TalentTree.get(0)",
        ];
        let f = flow(&body, 6, "TalentTree");
        assert!(!f.has_none);
        assert!(f.narrowed);
    }

    #[test]
    fn sibling_attribute_unaffected() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.Alpha = None",
            "        self.Beta = None",
            "    def method(self):",
            "        if self.Alpha is None:",
            "            self.Alpha = []",
            "        x = self.Beta",
        ];
        assert!(flow(&body, 7, "Beta").has_none);
    }

    #[test]
    fn literal_annotations() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.A = [1, 2, 3]",
            "        self.B = {\"k\": 1}",
            "        self.C = \"hi\"",
            "        self.D = 7",
        ];
        assert_eq!(flow(&body, 2, "A").annotation.as_deref(), Some("list"));
        assert_eq!(flow(&body, 3, "B").annotation.as_deref(), Some("dict"));
        assert_eq!(flow(&body, 4, "C").annotation.as_deref(), Some("str"));
        assert_eq!(flow(&body, 5, "D").annotation.as_deref(), Some("int"));
    }

    #[test]
    fn guard_union_drops_none() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.X = None",
            "        self.X = []",
            "    def method(self):",
            "        if self.X is None:",
            "            self.X = [1]",
            "        y = self.X",
        ];
        assert!(!flow(&body, 7, "X").has_none);
    }

    #[test]
    fn kode_aud_004_else_body_joins_union() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.X = None",
            "    def method(self):",
            "        if cond:",
            "            self.X = None",
            "        else:",
            "            self.X = [2]",
            "        y = self.X",
        ];
        let f = flow(&body, 8, "X");
        assert!(f.types.iter().any(|t| t == "None"));
        assert!(f.types.iter().any(|t| t == "list"));
    }

    #[test]
    fn kode_aud_004_if_elif_else_three_sides() {
        let body = [
            "class Foo:",
            "    def method(self):",
            "        if a:",
            "            self.X = None",
            "        elif b:",
            "            self.X = [1]",
            "        else:",
            "            self.X = \"s\"",
            "        y = self.X",
        ];
        let f = flow(&body, 8, "X");
        assert!(f.types.iter().any(|t| t == "None"));
        assert!(f.types.iter().any(|t| t == "list"));
        assert!(f.types.iter().any(|t| t == "str"));
    }

    #[test]
    fn kode_aud_004_try_except_else_finally() {
        let body = [
            "class Foo:",
            "    def method(self):",
            "        try:",
            "            self.X = [1]",
            "        except ValueError:",
            "            self.X = None",
            "        else:",
            "            self.X = [2]",
            "        finally:",
            "            cleanup()",
            "        y = self.X",
        ];
        let f = flow(&body, 10, "X");
        assert!(f.types.iter().any(|t| t == "list"));
        assert!(f.types.iter().any(|t| t == "None"));
    }

    #[test]
    fn kode_aud_004_early_return_branch_not_after_block() {
        let body = [
            "class Foo:",
            "    def method(self):",
            "        if self.X is None:",
            "            return",
            "        else:",
            "            self.X = [2]",
            "        y = self.X",
        ];
        let f = flow(&body, 6, "X");
        assert!(!f.has_none);
        assert!(f.types.iter().any(|t| t == "list"));
    }

    #[test]
    fn kode_aud_004_bytes_prefixes() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.B = b'abc'",
            "        self.BR = br'abc'",
            "        self.RB = rb'abc'",
            "        self.S = 'abc'",
            "        self.R = r'abc'",
            "        self.F = f'{x}'",
        ];
        assert_eq!(flow(&body, 2, "B").annotation.as_deref(), Some("bytes"));
        assert_eq!(flow(&body, 3, "BR").annotation.as_deref(), Some("bytes"));
        assert_eq!(flow(&body, 4, "RB").annotation.as_deref(), Some("bytes"));
        assert_eq!(flow(&body, 5, "S").annotation.as_deref(), Some("str"));
        assert_eq!(flow(&body, 6, "R").annotation.as_deref(), Some("str"));
        assert_eq!(flow(&body, 7, "F").annotation.as_deref(), Some("str"));
    }

    #[test]
    fn kr_aud_59_augmented_assignment_not_captured() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = []",
            "    def add(self):",
            "        self.items += [1]",
            "    def use(self):",
            "        x = self.items",
        ];
        let f = flow(&body, 6, "items");
        assert_eq!(f.annotation.as_deref(), Some("list"));
        assert!(!f.has_none);
    }

    #[test]
    fn kr_aud_59_augmented_keeps_none() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = None",
            "    def use(self):",
            "        self.items += [1]",
            "        x = self.items",
        ];
        assert!(flow(&body, 5, "items").has_none);
    }

    #[test]
    fn kr_aud_59_comparison_not_captured() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = None",
            "    def use(self):",
            "        self.items != []",
            "        x = self.items",
        ];
        assert!(flow(&body, 5, "items").has_none);
    }

    #[test]
    fn kr_aud_59_plain_assignment_overrides() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        self.items = None",
            "    def use(self):",
            "        self.items = []",
            "        x = self.items",
        ];
        let f = flow(&body, 5, "items");
        assert!(!f.has_none);
        assert_eq!(f.annotation.as_deref(), Some("list"));
    }

    #[test]
    fn write_point_atomic_faces() {
        let body = [
            "class Foo:",
            "    def __init__(self):",
            "        pass",
            "    def method(self):",
            "        self.a = 1 # 整数注释",
            "        self.b = # 只剩注释",
            "        self.c = True",
            "        self.d = 3.14",
            "        self.e = (1, 2)",
            "        self.f = self.g",
            "        self.j = a[0]",
        ];
        assert_eq!(flow(&body, 4, "a").annotation.as_deref(), Some("int"));
        assert_eq!(flow(&body, 5, "b").annotation, None);
        assert_eq!(flow(&body, 6, "c").types, vec!["bool"]);
        assert_eq!(flow(&body, 7, "d").types, vec!["float"]);
        assert_eq!(flow(&body, 8, "e").types, vec!["tuple"]);
        assert_eq!(flow(&body, 9, "f").annotation, None); // self 链不递归
        assert_eq!(flow(&body, 10, "j").annotation, None); // 下标形态回落空集
    }

    #[test]
    fn invalid_inputs_return_none() {
        let lines = lines_of(&["class Foo:", "    def m(self):", "        self.x = 1"]);
        assert!(infer_self_attribute_flow(&lines, 1, &[], None).is_none());
        assert!(infer_self_attribute_flow(&lines, usize::MAX, &attr_u16("x"), None).is_none());
    }

    #[test]
    fn outside_class_and_docstring_positions() {
        let outside = lines_of(&[
            "class A:",
            "    def m(self):",
            "        pass",
            "def free():",
            "    pass",
            "class B:",
            "    def n(self):",
            "        pass",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&outside, 4, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            None
        );
        let docstring = lines_of(&[
            "class Foo:",
            "    \"\"\"类文档串\"\"\"",
            "    def m(self):",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&docstring, 1, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            None
        );
    }

    #[test]
    fn method_body_indent_fallbacks() {
        let commented = lines_of(&[
            "class Foo:",
            "    def m(self):",
            "        # 先注释",
            "        self.x = 1",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&commented, 4, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let empty_body = lines_of(&[
            "class Foo:",
            "    def m1(self):",
            "    def m2(self):",
            "        self.x = 1",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&empty_body, 4, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let blank_body = lines_of(&[
            "class Foo:",
            "    def m1(self):",
            "",
            "    def m2(self):",
            "        self.x = 1",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&blank_body, 2, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            None
        );
    }

    #[test]
    fn is_not_none_guard_terminal_and_block_stop() {
        let terminal = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if self.x is not None:",
            "            return",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&terminal, 6, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let block_stop = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if self.x is not None:",
            "            self.x = \"s\"",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 6, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 5, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("str".to_string())
        );
    }

    #[test]
    fn plain_block_blank_lines_do_not_close_block() {
        let terminal = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if other:",
            "            return",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&terminal, 6, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
        let block_stop = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "    def m(self):",
            "        if other:",
            "",
            "            self.x = \"s\"",
            "",
            "        self.x = 1",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 6, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("str".to_string())
        );
        assert_eq!(
            infer_self_attribute_flow(&block_stop, 8, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
    }

    #[test]
    fn bodyless_block_does_not_panic() {
        let lines = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.x = None",
            "        if other:",
            "",
        ]);
        assert!(infer_self_attribute_flow(&lines, 4, &attr_u16("x"), None).is_some());
    }

    #[test]
    fn deeper_indented_stray_lines_skipped() {
        let lines = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        pass",
            "    def m(self):",
            "        self.x = 1",
            "            stray = 2",
            "        return",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&lines, 6, &attr_u16("x"), None)
                .unwrap()
                .annotation,
            Some("int".to_string())
        );
    }

    #[test]
    fn class_level_annotated_declarations() {
        let annotated = lines_of(&[
            "class Foo:",
            "",
            "    x: str = \"d\"",
            "        weird = 2",
            "    def __init__(self):",
            "        pass",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&annotated, 5, &attr_u16("x"), None)
                .unwrap()
                .types,
            vec!["str"]
        );
        let bare_annotated = lines_of(&[
            "class Foo:",
            "    x: list",
            "    def __init__(self):",
            "        pass",
        ]);
        assert_eq!(
            infer_self_attribute_flow(&bare_annotated, 3, &attr_u16("x"), None)
                .unwrap()
                .types,
            vec!["list"]
        );
    }

    #[test]
    fn version_key_cache_reuses_parse() {
        reset_self_attribute_flow_parse_cache_for_tests();
        let lines = lines_of(&[
            "class Foo:",
            "    def __init__(self):",
            "        self.X = None",
            "        self.X = []",
            "    def m(self):",
            "        y = self.X",
        ]);
        let key = "file:///a.py|9";
        let a = infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some(key)).unwrap();
        let b = infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some(key)).unwrap();
        assert_eq!(a.annotation, b.annotation);
        // 异键/无键照常
        assert!(infer_self_attribute_flow(&lines, 5, &attr_u16("X"), Some("file:///a.py|10"))
            .is_some());
        assert!(infer_self_attribute_flow(&lines, 5, &attr_u16("X"), None).is_some());
    }
}
