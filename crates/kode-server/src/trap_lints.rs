//! C-23 trap 三规则收编(AUDIT-005 B2 车道首批):`$/kode/lint/analyzeTraps`。
//!
//! TS 源 = src/backend/fixedDictMutationDiagnostics.ts(KBE-PY-015)/
//! destroyedEntityCaptureDiagnostics.ts(KBE-PY-016)/
//! timerCleanupDiagnostics.ts(KBE-PY-017),逐语义忠实移植(对拍纪律):
//!   - 行切分 = `\r?\n`(剥 `\n` 前至多一个 `\r`);词元 = ASCII `[A-Za-z0-9_]`;
//!   - TS 正则的 lookaround 手工展开(standalone self 前后查 `[\w.]`);
//!   - 贪婪段语义:结构段间只出现 `.`/词元(非空白/算符),贪婪扫直等回溯;
//!   - 消息文案不出 Rust:只回结构面(code/line/character/length +
//!     property/container),l10n 渲染留在 TS(调用方逐字段校验,畸形整面
//!     作废回 TS,与 serveDiagnosticsFromRust 同口径)。
//!
//! 入参 `{text, fixedDictProperties?, enabled?}`;出 `{items:[...]}`。

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub const CODE_FIXED_DICT_MUTATION: &str = "kbengine.fixedDictNestedMutation";
pub const CODE_DESTROYED_ENTITY_REFERENCE: &str = "kbengine.destroyedEntityReference";
pub const CODE_TIMER_CLEANUP_ON_DESTROY: &str = "kbengine.timerCleanupOnDestroy";

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeTraps", analyze_traps);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct TrapLintParams {
    text: String,
    #[serde(default)]
    fixed_dict_properties: HashMap<String, Vec<String>>,
    #[serde(default)]
    enabled: TrapLintEnabled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TrapLintEnabled {
    fixed_dict_mutation: bool,
    destroyed_entity_reference: bool,
    timer_cleanup: bool,
}

impl Default for TrapLintEnabled {
    fn default() -> Self {
        Self {
            fixed_dict_mutation: true,
            destroyed_entity_reference: true,
            timer_cleanup: true,
        }
    }
}

/// 一条结构面产物(消息渲染在 TS;l10n 参数字段按 code 携带)
#[derive(serde::Serialize)]
struct TrapItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    property: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    container: Option<String>,
}

fn analyze_traps(params: Value) -> Result<Value, String> {
    let params: TrapLintParams =
        serde_json::from_value(params).map_err(|err| format!("invalid params: {err}"))?;
    let lines = split_lines(&params.text);
    let mut items = Vec::new();
    if params.enabled.fixed_dict_mutation {
        for (line, character, length, property) in
            analyze_fixed_dict_mutations(&lines, &params.fixed_dict_properties)
        {
            items.push(TrapItem {
                code: CODE_FIXED_DICT_MUTATION,
                line,
                character,
                length,
                property: Some(property),
                container: None,
            });
        }
    }
    if params.enabled.destroyed_entity_reference {
        for (line, character, container) in analyze_destroyed_entity_captures(&lines) {
            items.push(TrapItem {
                code: CODE_DESTROYED_ENTITY_REFERENCE,
                line,
                character,
                length: "self".len(),
                property: None,
                container: Some(container),
            });
        }
    }
    if params.enabled.timer_cleanup {
        for (line, character, length) in analyze_timer_cleanup_on_destroy(&lines) {
            items.push(TrapItem {
                code: CODE_TIMER_CLEANUP_ON_DESTROY,
                line,
                character,
                length,
                property: None,
                container: None,
            });
        }
    }
    Ok(json!({ "items": items }))
}

// ---- 基础语义(TS 正则等价物) ----------------------------------------------

/// TS `text.split(/\r?\n/)`:剥掉每个 `\n` 前至多一个 `\r`(单个 \r 留行内)。
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// ASCII 词元(TS `\w` = `[A-Za-z0-9_]`;Rust regex 默认 Unicode 语义不同,故手写)
fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// 词元首字符;`\b` 左界 = 前一字符非词元或行首
fn is_word_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

/// `[\w.]`(standalone self 的边界排除集)
fn is_word_or_dot(byte: u8) -> bool {
    is_word(byte) || byte == b'.'
}

/// JS 正则 `\s` 的 ASCII 子集(行内无 \n;非 ASCII 空白行首形态不在对拍语料)
fn is_js_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | 0x0B | 0x0C)
}

/// 行首缩进列(TS `length - trimStart().length`)
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// 赋值算符面(TS `(?:=[^=]|[+\-*/%|&^]=)`):`=` 且后随非 `=`,或增强赋值
fn is_assign_at(bytes: &[u8], at: usize) -> bool {
    match bytes.get(at) {
        Some(b'=') => bytes.get(at + 1).is_some_and(|&next| next != b'='),
        Some(b'+' | b'-' | b'*' | b'/' | b'%' | b'|' | b'&' | b'^') => {
            bytes.get(at + 1) == Some(&b'=')
        }
        _ => false,
    }
}

/// `(?<![\w.])self(?![\w.])` 首处出现(0 起列);无则 None
fn standalone_self_offset(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    for (offset, _) in text.match_indices("self") {
        let before_ok = offset == 0 || !is_word_or_dot(bytes[offset - 1]);
        let after = offset + "self".len();
        let after_ok = after >= bytes.len() || !is_word_or_dot(bytes[after]);
        if before_ok && after_ok {
            return Some(offset);
        }
    }
    None
}

// ---- KBE-PY-015 FIXED_DICT 子键赋值 ----------------------------------------

/// 属性子键赋值产物:(line, character, length, property)
fn analyze_fixed_dict_mutations(
    lines: &[&str],
    fixed_dict_properties: &HashMap<String, Vec<String>>,
) -> Vec<(usize, usize, usize, String)> {
    let mut findings = Vec::new();
    for (index, raw) in lines.iter().enumerate() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(property) = match_fixed_dict_target(raw, fixed_dict_properties) else {
            continue;
        };
        findings.push(build_fixed_dict_finding(index, raw, &property));
    }
    findings
}

/// 单行目标匹配:命中属性名;字符串行首/注释/非表内属性不命中
fn match_fixed_dict_target(
    line: &str,
    fixed_dict_properties: &HashMap<String, Vec<String>>,
) -> Option<String> {
    let stripped = line.trim();
    if stripped.starts_with('"') || stripped.starts_with('\'') {
        return None;
    }
    if let Some(property) = match_attr_target(line) {
        if fixed_dict_properties.contains_key(&property) {
            return Some(property);
        }
    }
    if let Some(property) = match_subscript_target(line) {
        if fixed_dict_properties.contains_key(&property) {
            return Some(property);
        }
    }
    None
}

/// TS ATTR_TARGET:`^\s*self\.(\w+)(?:\.\w+)+\s*(?:=[^=]|[+\-*/%|&^]=)`
/// 结构段间只有 `.`/词元(非空白/算符),贪婪扫不回溯直等;属性后至少一段
/// `.word`(整体赋值 `self.<prop> = …` 不在此形)。
fn match_attr_target(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut i = skip_spaces(line, 0);
    if !line[i..].starts_with("self.") {
        return None;
    }
    i += "self.".len();
    let property = take_word(line, i)?;
    i += property.len();
    let mut segments = 0;
    while bytes.get(i) == Some(&b'.') {
        match take_word(line, i + 1) {
            Some(segment) => i += 1 + segment.len(),
            None => break,
        }
        segments += 1;
    }
    if segments == 0 {
        return None;
    }
    let i = skip_spaces(line, i);
    if !is_assign_at(bytes, i) {
        return None;
    }
    Some(property.to_string())
}

/// TS SUBSCRIPT_TARGET:`^\s*self\.(\w+)\[(['key"])\]\s*(?:=[^=]|[+\-*/%|&^]=)`
fn match_subscript_target(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut i = skip_spaces(line, 0);
    if !line[i..].starts_with("self.") {
        return None;
    }
    i += "self.".len();
    let property = take_word(line, i)?;
    i += property.len();
    if bytes.get(i) != Some(&b'[') {
        return None;
    }
    // key = `'[^']*'` 或 `"[^"]*"`(同引号内不回头)
    let Some(&quote @ (b'\'' | b'"')) = bytes.get(i + 1) else {
        return None;
    };
    i += 2;
    while bytes.get(i).is_some_and(|&byte| byte != quote) {
        i += 1;
    }
    if bytes.get(i) != Some(&quote) {
        return None;
    }
    i += 1;
    if bytes.get(i) != Some(&b']') {
        return None;
    }
    let i = skip_spaces(line, i + 1);
    if !is_assign_at(bytes, i) {
        return None;
    }
    Some(property.to_string())
}

/// TS buildFinding:character = 行首缩进列,length = 目标表达式长
/// (`^\s*(self\.\w+(?:\.\w+)*(?:\[[^\]]+\])*)\s*(?:=…)` 的 group 1;
/// 匹配失败回落脚 trimStart 余行)。
fn build_fixed_dict_finding(index: usize, raw: &str, property: &str) -> (usize, usize, usize, String) {
    let indent = indent_of(raw);
    let target_len = match match_fixed_dict_expression(raw) {
        Some((_, length)) => length,
        None => raw.len() - indent,
    };
    (index, indent, target_len, property.to_string())
}

/// TS `^\s*(self\.\w+(?:\.\w+)*(?:\[[^\]]+\])*)\s*(?:=[^=]|[+\-*/%|&^]=)`
/// group 1:返回 (表达式起点列, 表达式长度;不含算符前空白尾)
fn match_fixed_dict_expression(line: &str) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let start = skip_spaces(line, 0);
    if !line[start..].starts_with("self.") {
        return None;
    }
    let mut i = start + "self.".len();
    let property = take_word(line, i)?;
    i += property.len();
    loop {
        // (?:\.\w+)*(零段或多段)
        if bytes.get(i) == Some(&b'.') {
            if let Some(segment) = take_word(line, i + 1) {
                i += 1 + segment.len();
                continue;
            }
        }
        // (?:\[[^\]]+\])*(零组或多组;组内至少 1 个非 `]`)
        if bytes.get(i) == Some(&b'[') {
            let mut j = i + 1;
            while bytes.get(j).is_some_and(|&byte| byte != b']') {
                j += 1;
            }
            if bytes.get(j) == Some(&b']') && j > i + 1 {
                i = j + 1;
                continue;
            }
        }
        break;
    }
    let expression_end = i;
    let i = skip_spaces(line, i);
    if !is_assign_at(bytes, i) {
        return None;
    }
    Some((start, expression_end - start))
}

/// TS `/\[['"]([^'"]+)['"]\]/` 首 group(两种引号都排除在键内)
#[allow(dead_code)]
fn subscript_key_of(target: &str) -> Option<String> {
    let bytes = target.as_bytes();
    for (open, _) in target.match_indices('[') {
        let Some(&quote @ (b'\'' | b'"')) = bytes.get(open + 1) else {
            continue;
        };
        let mut i = open + 2;
        let key_start = i;
        while bytes.get(i).is_some_and(|&byte| byte != b'\'' && byte != b'"') {
            i += 1;
        }
        if i == key_start {
            continue;
        }
        if bytes.get(i) != Some(&quote) || bytes.get(i + 1) != Some(&b']') {
            continue;
        }
        return Some(target[key_start..i].to_string());
    }
    None
}

// ---- KBE-PY-016 已销毁实体引用滞留 ------------------------------------------

/// 捕获产物:(line, character, container)
fn analyze_destroyed_entity_captures(lines: &[&str]) -> Vec<(usize, usize, String)> {
    let mut findings = Vec::new();
    // 第一遍:容器声明(`^NAME\s*=\s*(\[\]|\{\}|set\(\))\s*$`;锚行首故缩进行不参与)
    let mut containers: HashSet<&str> = HashSet::new();
    for raw in lines {
        if let Some(name) = match_container_init(raw) {
            containers.insert(name);
        }
    }
    // 第二遍:类体内(缩进)语句把 self 存入容器
    for (index, raw) in lines.iter().enumerate() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || !raw.starts_with(' ') {
            continue;
        }
        let line_indent = indent_of(raw);
        // call 分支先行:命中(即便实参无 self)即 continue,下标形不再判
        if let Some((container, args, arg_start)) = match_container_call(trimmed, &containers) {
            if let Some(self_offset) = standalone_self_offset(args) {
                findings.push((index, line_indent + arg_start + self_offset, container.to_string()));
            }
            continue;
        }
        if let Some((container, rhs, target_len)) = match_container_subscript(trimmed, &containers) {
            if let Some(self_offset) = standalone_self_offset(rhs) {
                findings.push((index, line_indent + target_len + self_offset, container.to_string()));
            }
        }
    }
    findings
}

/// TS CONTAINER_INIT:`^([A-Za-z_]\w*)\s*=\s*(\[\]|\{\}|set\(\))\s*$`
fn match_container_init(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    if !bytes.first().copied().is_some_and(is_word_start) {
        return None;
    }
    let mut i = 0;
    while bytes.get(i).is_some_and(|&byte| is_word(byte)) {
        i += 1;
    }
    let name = &line[..i];
    let mut i = skip_spaces(line, i);
    if bytes.get(i) != Some(&b'=') {
        return None;
    }
    i = skip_spaces(line, i + 1);
    for literal in ["[]", "{}", "set()"] {
        if line[i..].starts_with(literal) {
            let end = skip_spaces(line, i + literal.len());
            if end == line.len() {
                return Some(name);
            }
            return None;
        }
    }
    None
}

/// TS CALL_CAPTURE:`\b(\w+)\.(append|add|extend|update)\((.+)\)`(leftmost
/// 候选,实参贪婪吃到行内最后一个 `)`)。返回 (容器名, 实参文本, 实参在行内列)
fn match_container_call<'a>(
    trimmed: &'a str,
    containers: &HashSet<&str>,
) -> Option<(&'a str, &'a str, usize)> {
    let bytes = trimmed.as_bytes();
    for (start, _) in trimmed.char_indices() {
        if !is_word_start(bytes[start]) || (start > 0 && is_word(bytes[start - 1])) {
            continue; // \b 左界
        }
        let mut i = start;
        while bytes.get(i).is_some_and(|&byte| is_word(byte)) {
            i += 1;
        }
        let name = &trimmed[start..i];
        if !containers.contains(name) || bytes.get(i) != Some(&b'.') {
            continue;
        }
        i += 1;
        let method = ["append", "add", "extend", "update"]
            .into_iter()
            .find(|candidate| trimmed[i..].starts_with(candidate));
        let Some(method) = method else { continue };
        i += method.len();
        if bytes.get(i) != Some(&b'(') {
            continue;
        }
        // (.+)\) 贪婪:实参 = `(` 后到行内最后一个 `)`(须至少 1 字符)
        let close = trimmed[i + 1..].rfind(')')? + i + 1;
        if close <= i + 1 {
            continue;
        }
        return Some((name, &trimmed[i + 1..close], i + 1));
    }
    None
}

/// TS SUBSCRIPT_CAPTURE:`\b(\w+)\[[^\]]+\]\s*=\s*(.+)`
/// 返回 (容器名, 右值文本, 目标表达式长 = 右值起点 - 名起点)
fn match_container_subscript<'a>(
    trimmed: &'a str,
    containers: &HashSet<&str>,
) -> Option<(&'a str, &'a str, usize)> {
    let bytes = trimmed.as_bytes();
    for (start, _) in trimmed.char_indices() {
        if !is_word_start(bytes[start]) || (start > 0 && is_word(bytes[start - 1])) {
            continue; // \b 左界
        }
        let mut i = start;
        while bytes.get(i).is_some_and(|&byte| is_word(byte)) {
            i += 1;
        }
        let name = &trimmed[start..i];
        if !containers.contains(name) || bytes.get(i) != Some(&b'[') {
            continue;
        }
        let mut j = i + 1;
        while bytes.get(j).is_some_and(|&byte| byte != b']') {
            j += 1;
        }
        if bytes.get(j) != Some(&b']') || j == i + 1 {
            continue;
        }
        let mut k = skip_spaces(trimmed, j + 1);
        // `\s*=\s*`(此处 `=` 无 `[^=]` 守卫,TS 同)
        if bytes.get(k) != Some(&b'=') {
            continue;
        }
        k = skip_spaces(trimmed, k + 1);
        if k >= trimmed.len() {
            continue; // (.+) 至少 1 字符
        }
        return Some((name, &trimmed[k..], k - start));
    }
    None
}

// ---- KBE-PY-017 onDestroy 内冗余 delTimer -----------------------------------

/// 产物:(line, character, length)
fn analyze_timer_cleanup_on_destroy(lines: &[&str]) -> Vec<(usize, usize, usize)> {
    let mut findings = Vec::new();
    let mut on_destroy_indent: Option<usize> = None;
    for (index, raw) in lines.iter().enumerate() {
        let trimmed = raw.trim();
        let indent = indent_of(raw);
        if let Some(header_indent) = on_destroy_indent {
            // 块闭合:非空行缩进回到/低于方法头缩进
            if !trimmed.is_empty() && indent <= header_indent {
                on_destroy_indent = None;
            }
        }
        if on_destroy_indent.is_none() {
            if let Some(header_indent) = match_on_destroy_header(raw) {
                on_destroy_indent = Some(header_indent);
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((at, length)) = match_del_timer_call(trimmed) {
            findings.push((index, indent + at, length));
        }
    }
    findings
}

/// TS ON_DESTROY_HEADER:`^\s*(?:async\s+)?def\s+onDestroy\s*\(\s*self\b`
fn match_on_destroy_header(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = skip_spaces(line, 0);
    let indent = i;
    if trimmed_prefix(line, i, "async") {
        let after = i + "async".len();
        let spaces = count_spaces(line, after);
        if spaces == 0 {
            return None; // `async\s+`:async 后须至少一个空白
        }
        i = after + spaces;
    }
    if !trimmed_prefix(line, i, "def") {
        return None;
    }
    i += "def".len();
    let spaces = count_spaces(line, i);
    if spaces == 0 {
        return None;
    }
    i += spaces;
    if !trimmed_prefix(line, i, "onDestroy") {
        return None;
    }
    i += "onDestroy".len();
    let i = skip_spaces(line, i);
    if bytes.get(i) != Some(&b'(') {
        return None;
    }
    let i = skip_spaces(line, i + 1);
    if !trimmed_prefix(line, i, "self") {
        return None;
    }
    // \b:后随字符非词元(或行尾)
    if bytes.get(i + "self".len()).copied().is_some_and(is_word) {
        return None;
    }
    Some(indent)
}

/// TS DEL_TIMER_CALL:`\bself\.delTimer\s*\(` 首 match;返回 (行内列, 匹配长)
fn match_del_timer_call(trimmed: &str) -> Option<(usize, usize)> {
    let bytes = trimmed.as_bytes();
    for (at, _) in trimmed.match_indices("self.delTimer") {
        if at > 0 && is_word(bytes[at - 1]) {
            continue; // \b 左界
        }
        let mut i = at + "self.delTimer".len();
        while bytes.get(i).is_some_and(|&byte| is_js_space(byte)) {
            i += 1;
        }
        if bytes.get(i) == Some(&b'(') {
            return Some((at, i + 1 - at));
        }
    }
    None
}

// ---- 小工具 ------------------------------------------------------------------

fn skip_spaces(line: &str, mut at: usize) -> usize {
    let bytes = line.as_bytes();
    while bytes.get(at).is_some_and(|&byte| is_js_space(byte)) {
        at += 1;
    }
    at
}

fn count_spaces(line: &str, at: usize) -> usize {
    skip_spaces(line, at) - at
}

/// `line[at..]` 以 `prefix` 开头(防越界;前缀后是否词元由调用方判)
fn trimmed_prefix(line: &str, at: usize, prefix: &str) -> bool {
    line[at..].starts_with(prefix)
}

/// `line[at..]` 起始的最长 ASCII 词元(空返回 None)
fn take_word(line: &str, at: usize) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut end = at;
    while bytes.get(end).is_some_and(|&byte| is_word(byte)) {
        end += 1;
    }
    if end == at {
        return None;
    }
    Some(&line[at..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(entries: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        entries
            .iter()
            .map(|(name, keys)| {
                (
                    name.to_string(),
                    keys.iter().map(|key| key.to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn fixed_dict_hits_subkey_and_misses_whole_assign() {
        let lines = split_lines("self.profile.name = 'x'\nself.profile = {}\nself.other.name = 'y'\n");
        let table = table(&[("profile", &["name"])]);
        let findings = analyze_fixed_dict_mutations(&lines, &table);
        assert_eq!(findings.len(), 1);
        let (line, character, length, property) = &findings[0];
        assert_eq!(*line, 0);
        assert_eq!(*character, 0);
        assert_eq!(*length, "self.profile.name".len());
        assert_eq!(property, "profile");
    }

    #[test]
    fn fixed_dict_handles_augmented_strings_and_deep_chain() {
        let lines = split_lines(
            "self.profile.name += 'x'\n'self.profile.name = inside string'\n# self.profile.name = comment\nself.profile.name == y\nself.profile.a.b = 1\nself.profile['slot'] = 1\n",
        );
        let table = table(&[("profile", &["name"])]);
        let findings = analyze_fixed_dict_mutations(&lines, &table);
        // 深链与下标两处命中;增强/字符串/注释/比较四处不报
        assert_eq!(findings.len(), 3);
        assert_eq!(findings[0].0, 0);
        assert_eq!(findings[1].0, 4);
        assert_eq!(findings[2].0, 5);
    }

    #[test]
    fn destroyed_capture_reports_append_and_skips_member_read() {
        let lines = split_lines(
            "REGISTRY = []\nCACHE = {}\nclass Avatar:\n    def register(self):\n        REGISTRY.append(self)\n        CACHE['a'] = self\n        CACHE['b'] = self.id\n",
        );
        let findings = analyze_destroyed_entity_captures(&lines);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].0, 4);
        assert_eq!(findings[0].2, "REGISTRY");
        assert_eq!(findings[1].0, 5);
        assert_eq!(findings[1].2, "CACHE");
    }

    #[test]
    fn timer_cleanup_reports_inside_block_only() {
        let lines = split_lines(
            "class Avatar:\n    def onDestroy(self):\n        pass\n        self.delTimer(self.tid)\n    def tick(self):\n        self.delTimer(self.tid)\n",
        );
        let findings = analyze_timer_cleanup_on_destroy(&lines);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].0, 3);
    }

    #[test]
    fn analyze_traps_params_and_items_shape() {
        let result = analyze_traps(json!({
            "text": "CACHE = []\nclass A:\n    def f(self):\n        CACHE.append(self)\n    def onDestroy(self):\n        self.delTimer(1)\n",
            "fixedDictProperties": {},
            "enabled": {"fixedDictMutation": false, "destroyedEntityReference": true, "timerCleanup": true}
        }))
        .unwrap();
        let items = result["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["code"], CODE_DESTROYED_ENTITY_REFERENCE);
        assert_eq!(items[0]["line"], 3);
        assert_eq!(items[0]["container"], "CACHE");
        assert_eq!(items[1]["code"], CODE_TIMER_CLEANUP_ON_DESTROY);
    }
}
