//! CodeAction 决策核(RUST-143 批 1):src/languageProviders/codeAction.ts
//! 与其依赖的四个纯函数模块(defMethodConsistency/completion/
//! receiverNoneDiagnostics/behaviorLints)的编辑器与决策面同构下沉。
//! 纯库零 RPC、零引擎状态——provider 装配(诊断 code 路由/vscode
//! WorkspaceEdit/l10n)留在 TS,本模块只覆盖动作的**可计算核**:
//! - 骨架生成:def_arg_type_to_python_annotation + build_method_stub_code
//!   (创建缺失实现两 provider 的签名与体);
//! - 类块插入点:find_python_class_insertion_point(两 provider 共用);
//! - 类型替换候选:find_registered_type_suggestions(有界编辑距离);
//! - 接收者区间归属:receiver_from_diagnostic_line(守卫 provider 的
//!   receiver 提取,UTF-16 坐标域);
//! - 守卫编辑器:build_receiver_none_guard_edit(早退)/
//!   build_receiver_none_wrap_edit(包裹式,语句组截断+括号平衡);
//! - 整体重赋编辑器:build_fixed_dict_whole_reassign_edit(习语改写)。
//!
//! golden = {corpus, probes, outcomes}:语料(合成文本,自含确定性)与
//! 探测面由 Rust 权威定义,产出 outcomes;TS 镜像
//! tests/kodeCodeActionParity.test.ts 读 corpus+probes 驱动**生产**函数
//! 复算对拍 outcomes(镜像红=移植错,按 TS 源码重推)。
//!
//! 坐标系:行/字符域全部 UTF-16 code unit(TS Range character 与正则
//! match.index 同域);文本换算经 encode_utf16 后扫描(仓无 regex crate,
//! 正则全手写同构)。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// def <Arg> 类型 → Python 注解(defMethodConsistency 同构)
// ---------------------------------------------------------------------------

/// PYTHON_BUILTIN_TYPE_ANNOTATIONS(pythonTypeStubs 单一事实源同表)。
fn builtin_type_annotation(type_name: &str) -> Option<&'static str> {
    match type_name {
        "UINT8" | "UINT16" | "UINT32" | "UINT64" | "INT8" | "INT16" | "INT32" | "INT64" => {
            Some("int")
        }
        "FLOAT" | "DOUBLE" => Some("float"),
        "STRING" | "UNICODE" => Some("str"),
        "BOOL" => Some("bool"),
        "VECTOR2" => Some("Vector2"),
        "VECTOR3" => Some("Vector3"),
        "VECTOR4" => Some("Vector4"),
        "ENTITYCALL" | "PYTHON" => Some("Any"),
        "PY_DICT" => Some("dict"),
        "PY_TUPLE" => Some("tuple"),
        "PY_LIST" => Some("list"),
        "BLOB" => Some("bytes"),
        _ => None,
    }
}

/// def 参数类型文本 → Python 签名注解。只映射**内建名**注解(可直接出现在
/// 方法签名,无需引入 typing;VECTOR2/3/4/Any 等 typing 泛型名需要 import,
/// 骨架是纯插入编辑不碰文件头,故不发射未导入名 → None=调用方退化裸参数名)。
pub fn def_arg_type_to_python_annotation(type_text: &str) -> Option<&'static str> {
    let trimmed = type_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let annotation = builtin_type_annotation(trimmed)?;
    // BUILTIN_ANNOTATIONS 闸:int/float/str/bool/bytes 之外的表值(定长
    // Tuple/Any 族)不进签名
    match annotation {
        "int" | "float" | "str" | "bool" | "bytes" => Some(annotation),
        _ => None,
    }
}

/// 骨架体形态:pass(空体)或 raise(NotImplementedError)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MethodStubBody {
    Pass,
    Raise,
}

/// 空方法骨架(4 空格缩进):签名参数自 <Arg> 类型映射(内建注解,其余裸
/// argN);TS buildMethodStubCode 同构。
pub fn build_method_stub_code(method_name: &str, arg_types: &[&str], body: MethodStubBody) -> String {
    let params: Vec<String> = arg_types
        .iter()
        .enumerate()
        .map(|(index, type_text)| match def_arg_type_to_python_annotation(type_text) {
            Some(annotation) => format!("arg{}: {}", index, annotation),
            None => format!("arg{}", index),
        })
        .collect();
    let signature = if params.is_empty() {
        "self".to_string()
    } else {
        format!("self, {}", params.join(", "))
    };
    let body_line = match body {
        MethodStubBody::Raise => "        raise NotImplementedError",
        MethodStubBody::Pass => "        pass",
    };
    format!("    def {}({}):\n{}\n", method_name, signature, body_line)
}

// ---------------------------------------------------------------------------
// python 类块插入点(codeAction.findPythonClassInsertionPoint 同构)
// ---------------------------------------------------------------------------

/// 行首 `class\s+<名>(\s|\(|:|$)` 匹配(正则手写;TS 侧 className 插值进
/// 正则,此处字符串精确等价——类名是标识符,无正则元字符注入面)。
fn class_header_matches(line: &str, class_name: &str) -> bool {
    let units: Vec<u16> = line.encode_utf16().collect();
    if !starts_with_keyword(&units, 0, "class") {
        return false;
    }
    let mut cursor = "class".len();
    let space_start = cursor;
    while cursor < units.len() && is_js_space(units[cursor]) {
        cursor += 1;
    }
    if cursor == space_start {
        return false; // \s+ 至少一个
    }
    let name_units: Vec<u16> = class_name.encode_utf16().collect();
    if units.len() < cursor + name_units.len() {
        return false;
    }
    if units[cursor..cursor + name_units.len()] != name_units[..] {
        return false;
    }
    cursor += name_units.len();
    // (\s|\(|:|$):后邻空白/左括号/冒号/行尾
    match units.get(cursor) {
        None => true,
        Some(&u) => is_js_space(u) || u == b'(' as u16 || u == b':' as u16,
    }
}

/// python 类块插入点(IDE-NAV-014):类头之后到首个缩进 <4 的非空行为类体;
/// 插入点=类体末非空行下一行(0 基行号;空体=类头下一行且不加空行前缀,
/// 非空体加一空行分隔)。类块找不到 → None(不猜)。
pub fn find_python_class_insertion_point(content: &str, class_name: &str) -> Option<(usize, bool)> {
    let lines = split_lines_keep(content);
    let mut class_line = None;
    for (index, line) in lines.iter().enumerate() {
        if class_header_matches(line, class_name) {
            class_line = Some(index);
            break;
        }
    }
    let class_line = class_line?;
    let mut last_body_line = class_line;
    // TS 赋实际行号(index),空行/注释行不推进
    for (index, line) in lines.iter().enumerate().skip(class_line + 1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = leading_space_tabs(line).len();
        // TS /^\s*/ 计前导空白(\t 记 1);缩进 <4 即出体
        if indent < 4 {
            break;
        }
        last_body_line = index;
    }
    Some((last_body_line + 1, last_body_line > class_line))
}

// ---------------------------------------------------------------------------
// 类型替换候选(completion.findRegisteredTypeSuggestions 同构)
// ---------------------------------------------------------------------------

pub const TYPE_SUGGESTION_MAX_DISTANCE: usize = 2;
pub const TYPE_SUGGESTION_LIMIT: usize = 5;

/// 有界编辑距离(列 DP+行极值早退;>max → None)。TS boundedEditDistance
/// 同构(UTF-16 code unit 域;类型名全 ASCII 时与字节域一致)。
pub fn bounded_edit_distance(left: &str, right: &str, max: usize) -> Option<usize> {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    if left.len().abs_diff(right.len()) > max {
        return None;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for row in 1..=left.len() {
        let mut current = vec![row];
        let mut row_min = row;
        for column in 1..=right.len() {
            let substitution = previous[column - 1] + usize::from(left[row - 1] != right[column - 1]);
            let cost = substitution.min(previous[column] + 1).min(current[column - 1] + 1);
            current.push(cost);
            row_min = row_min.min(cost);
        }
        if row_min > max {
            return None;
        }
        previous = current;
    }
    let distance = previous[right.len()];
    if distance > max {
        None
    } else {
        Some(distance)
    }
}

/// 未注册类型诊断的修正候选:已注册类型(内建+types.xml 自定义+实体)按
/// 距离升序、名字节序平距,截 TYPE_SUGGESTION_LIMIT;同名(原文等值)跳过。
pub fn find_registered_type_suggestions(unknown_name: &str, registered: &[&str]) -> Vec<String> {
    let target = unknown_name.to_lowercase();
    let mut hits: Vec<(String, usize)> = Vec::new();
    for candidate in registered {
        if *candidate == unknown_name {
            continue;
        }
        let Some(distance) =
            bounded_edit_distance(&target, &candidate.to_lowercase(), TYPE_SUGGESTION_MAX_DISTANCE)
        else {
            continue;
        };
        hits.push(((*candidate).to_string(), distance));
    }
    hits.sort_by(|left, right| {
        left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0))
    });
    hits.truncate(TYPE_SUGGESTION_LIMIT);
    hits.into_iter().map(|(name, _)| name).collect()
}

// ---------------------------------------------------------------------------
// 接收者区间归属(codeAction.receiverFromDiagnosticLine 同构)
// ---------------------------------------------------------------------------

/// `self.<cell|base|client>.<方法>` 扫描:取方法名 token 与诊断区间
/// `[start_char, end_char)` 相交的 receiver;提不出 → None(不猜)。
/// 坐标域 UTF-16 code unit(诊断区间同域)。
pub fn receiver_from_diagnostic_line(
    line_text: &str,
    start_char: usize,
    end_char: usize,
) -> Option<&'static str> {
    let units: Vec<u16> = line_text.encode_utf16().collect();
    let mut cursor = 0usize;
    while cursor < units.len() {
        // \bself\. :词边界(前邻非词字符或行首)+ 字面 self.
        if !starts_with_keyword(&units, cursor, "self.")
            || (cursor > 0 && is_word_unit(units[cursor - 1]))
        {
            cursor += 1;
            continue;
        }
        let mut after_self = cursor + "self.".len();
        // receiver 词(cell|base|client)
        let receiver = ["cell", "base", "client"]
            .into_iter()
            .find(|word| starts_with_keyword(&units, after_self, word));
        let Some(receiver) = receiver else {
            cursor += 1;
            continue;
        };
        after_self += receiver.len();
        // \s*\.\s*
        while after_self < units.len() && is_js_space(units[after_self]) {
            after_self += 1;
        }
        if units.get(after_self) != Some(&(b'.' as u16)) {
            cursor += 1;
            continue;
        }
        after_self += 1;
        while after_self < units.len() && is_js_space(units[after_self]) {
            after_self += 1;
        }
        // 方法名 [A-Za-z_][A-Za-z0-9_]*
        if !units.get(after_self).copied().is_some_and(is_name_start) {
            cursor += 1;
            continue;
        }
        let method_start = after_self;
        let mut method_end = method_start + 1;
        while method_end < units.len() && is_word_unit(units[method_end]) {
            method_end += 1;
        }
        // 区间相交归属(TS: startChar < methodEnd && endChar > methodStart)
        if start_char < method_end && end_char > method_start {
            return Some(match receiver {
                "cell" => "cell",
                "base" => "base",
                _ => "client",
            });
        }
        cursor = method_end;
    }
    None
}

// ---------------------------------------------------------------------------
// 守卫编辑器(receiverNoneDiagnostics 同构)
// ---------------------------------------------------------------------------

/// 早退守卫插入编辑(行首之前插入两行):`if not self.<receiver>:` +
/// 缩进 return。使用行空/越界 → None。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverNoneGuardEdit {
    pub line: usize,
    pub text: String,
}

/// 包裹式守卫替换编辑:`if self.<receiver>:` 包住「用到本 receiver 的连续
/// 语句」(含多行续行,括号未闭合不因空行/注释中断;首个不引用本 receiver
/// 的同级语句截断),块内整体加一级缩进(相对深度保持)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverNoneWrapEdit {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

fn is_js_space(code: u16) -> bool {
    // JS \s 全集(Space \t \n \v \f \r NBSP);分行后行内不含 \n \r,
    // 列在这里只是与正则语义同域,不改变任何行内判定。
    matches!(code, 0x0020 | 0x0009 | 0x000A | 0x000D | 0x000C | 0x000B | 0x00A0)
}

fn is_word_unit(code: u16) -> bool {
    code == b'_' as u16
        || (b'a' as u16..=b'z' as u16).contains(&code)
        || (b'A' as u16..=b'Z' as u16).contains(&code)
        || (b'0' as u16..=b'9' as u16).contains(&code)
}

fn is_name_start(code: u16) -> bool {
    code == b'_' as u16
        || (b'a' as u16..=b'z' as u16).contains(&code)
        || (b'A' as u16..=b'Z' as u16).contains(&code)
}

fn starts_with_keyword(units: &[u16], at: usize, word: &str) -> bool {
    let word: Vec<u16> = word.encode_utf16().collect();
    units.len() >= at + word.len() && units[at..at + word.len()] == word[..]
}

/// TS split(/\r?\n/) 同构(保留空行;行内不含换行)。
fn split_lines_keep(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '\n' {
            if current.ends_with('\r') {
                current.pop();
            }
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    lines.push(current);
    lines
}

/// 行前导空白(TS /^[ \t]*/ 同构;字节=单元=字符,前导全 ASCII)。
fn leading_space_tabs(line: &str) -> &str {
    let byte_end = line
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    &line[..byte_end]
}

/// TS indentOf:lineText.length - trimStart().length = 前导空白数(UTF-16 单元域)。
fn indent_of(line: &str) -> usize {
    let units: Vec<u16> = line.encode_utf16().collect();
    units.iter().take_while(|u| is_js_space(**u)).count()
}

/// 注释行或空行(TS /^\s*(#.*)?$/ 同构:全空白,或前导空白后 # 到行尾)。
fn comment_only(line: &str) -> bool {
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut seen_content = false;
    for unit in &units {
        if is_js_space(*unit) {
            continue;
        }
        if !seen_content {
            if *unit == b'#' as u16 {
                return true;
            }
            seen_content = true;
        }
    }
    !seen_content
}

/// 行内未闭合括号差(续行判定)。
fn delimiter_delta(line: &str) -> isize {
    let mut delta = 0isize;
    for ch in line.chars() {
        match ch {
            '(' | '[' | '{' => delta += 1,
            ')' | ']' | '}' => delta -= 1,
            _ => {}
        }
    }
    delta
}

/// 行内 `\bself\.<receiver>\b`(包裹式语句组截断判据;手写扫描)。
fn line_references_receiver(line: &str, receiver: &str) -> bool {
    let units: Vec<u16> = line.encode_utf16().collect();
    let needle: Vec<u16> = format!("self.{}", receiver).encode_utf16().collect();
    let mut cursor = 0usize;
    while cursor + needle.len() <= units.len() {
        if units[cursor..cursor + needle.len()] == needle[..]
            && (cursor == 0 || !is_word_unit(units[cursor - 1]))
            && (cursor + needle.len() == units.len() || !is_word_unit(units[cursor + needle.len()]))
        {
            return true;
        }
        cursor += 1;
    }
    false
}

pub fn build_receiver_none_guard_edit(
    text: &str,
    line: usize,
    receiver: &str,
) -> Option<ReceiverNoneGuardEdit> {
    if text.is_empty() {
        return None;
    }
    let lines = split_lines_keep(text);
    let use_line = lines.get(line)?;
    if use_line.trim().is_empty() {
        return None;
    }
    let leading = leading_space_tabs(use_line);
    let inner = if leading.contains('\t') {
        format!("{}\t", leading)
    } else {
        format!("{}    ", leading)
    };
    Some(ReceiverNoneGuardEdit {
        line,
        text: format!(
            "{}if not self.{}:\n{}return\n",
            leading, receiver, inner
        ),
    })
}

pub fn build_receiver_none_wrap_edit(
    text: &str,
    line: usize,
    receiver: &str,
) -> Option<ReceiverNoneWrapEdit> {
    if text.is_empty() {
        return None;
    }
    let lines = split_lines_keep(text);
    let use_line = lines.get(line)?;
    if use_line.trim().is_empty() {
        return None;
    }
    let leading = leading_space_tabs(use_line);
    let inner = if leading.contains('\t') {
        format!("{}\t", leading)
    } else {
        format!("{}    ", leading)
    };
    let use_indent = indent_of(use_line);
    // 语句组截断:只包「用到本 receiver 的连续语句」(括号未闭合的续行
    // 不因空行/注释中断;首个不引用本 receiver 的同级语句即停)
    let mut end = line + 1;
    let mut balance = delimiter_delta(use_line);
    while end < lines.len() {
        let current = &lines[end];
        if comment_only(current) {
            // 多行语句续行内不因空行/注释中断;否则语句组结束
            if balance > 0 {
                end += 1;
                continue;
            }
            break;
        }
        if indent_of(current) < use_indent {
            break;
        }
        if !line_references_receiver(current, receiver) && balance <= 0 {
            break;
        }
        balance += delimiter_delta(current);
        end += 1;
    }
    let leading_units: Vec<u16> = leading.encode_utf16().collect();
    let body: Vec<String> = lines[line..end]
        .iter()
        .map(|entry| {
            if comment_only(entry) {
                entry.clone()
            } else {
                let units: Vec<u16> = entry.encode_utf16().collect();
                format!(
                    "{}{}",
                    inner,
                    String::from_utf16_lossy(&units[leading_units.len()..])
                )
            }
        })
        .collect();
    Some(ReceiverNoneWrapEdit {
        start_line: line,
        end_line: end,
        text: format!("{}if self.{}:\n{}", leading, receiver, body.join("\n")),
    })
}

// ---------------------------------------------------------------------------
// 整体重赋编辑器(behaviorLints.buildFixedDictWholeReassignEdit 同构)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedDictWholeReassignEdit {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

/// `^([ \t]*)(self\.[A-Za-z_]\w*)((?:\s*\[[^\]\n]*\]\s*)+)(?:(\*\*|//|>>|<<|
/// [+\-*/%&|^]))?=(?!=)(.*)$` 手写同构:前导空白 → self. 标识符 → 一段或多段
/// 下标(`[` 到 `]` 内无 `]` 无换行,段间空白可) → 可选运算符(**|//|>>|<<|
/// 单字符)→ `=`(后邻非 `=`)→ 其余全收(到行尾)。
fn match_subscript_store_line(line: &str) -> Option<(String, String, String, Option<String>, String)> {
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut cursor = 0usize;
    // 前导空白
    let indent_start = cursor;
    while cursor < units.len() && (units[cursor] == b' ' as u16 || units[cursor] == b'\t' as u16) {
        cursor += 1;
    }
    let indent = String::from_utf16_lossy(&units[indent_start..cursor]);
    // self.(TS 捕获组 2 含 self. 前缀)
    if !starts_with_keyword(&units, cursor, "self.") {
        return None;
    }
    let base_start = cursor;
    cursor += "self.".len();
    // 标识符
    if !units.get(cursor).copied().is_some_and(is_name_start) {
        return None;
    }
    cursor += 1;
    while cursor < units.len() && is_word_unit(units[cursor]) {
        cursor += 1;
    }
    let base = String::from_utf16_lossy(&units[base_start..cursor]);
    // 一段或多段 (\s* \[ [^\]\n]* \] \s*)
    let subscripts_start = cursor;
    let mut groups = 0usize;
    loop {
        let group_start = cursor;
        while cursor < units.len() && is_js_space(units[cursor]) {
            cursor += 1;
        }
        if units.get(cursor) != Some(&(b'[' as u16)) {
            cursor = group_start;
            break;
        }
        cursor += 1;
        while cursor < units.len() && units[cursor] != b']' as u16 && units[cursor] != b'\n' as u16 {
            cursor += 1;
        }
        if units.get(cursor) != Some(&(b']' as u16)) {
            cursor = group_start;
            break;
        }
        cursor += 1;
        while cursor < units.len() && is_js_space(units[cursor]) {
            cursor += 1;
        }
        groups += 1;
    }
    if groups == 0 {
        return None;
    }
    // 尾空白裁剪(TS subscripts.replace(/\s+$/, '') 在捕获串上做)
    let mut subscripts_end = cursor;
    while subscripts_end > subscripts_start && is_js_space(units[subscripts_end - 1]) {
        subscripts_end -= 1;
    }
    let subscripts = String::from_utf16_lossy(&units[subscripts_start..subscripts_end]);
    // 可选运算符(双字符优先)
    let mut operator = None;
    for two in ["**", "//", ">>", "<<"] {
        if starts_with_keyword(&units, cursor, two) {
            operator = Some((*two).to_string());
            cursor += 2;
            break;
        }
    }
    if operator.is_none() {
        if let Some(&u) = units.get(cursor) {
            let ch = char::from_u32(u as u32);
            if ch.is_some_and(|c| "+-*/%&|^".contains(c)) {
                operator = Some(ch.unwrap().to_string());
                cursor += 1;
            }
        }
    }
    // =(后邻非 =)
    if units.get(cursor) != Some(&(b'=' as u16)) {
        return None;
    }
    if units.get(cursor + 1) == Some(&(b'=' as u16)) {
        return None;
    }
    cursor += 1;
    // 其余全收($:必须已能到行尾——.*)$ 贪婪到尾,任何剩余都进 rhs)
    let rhs = String::from_utf16_lossy(&units[cursor..]);
    Some((indent, base, subscripts, operator, rhs))
}

pub fn build_fixed_dict_whole_reassign_edit(
    text: &str,
    line: usize,
) -> Option<FixedDictWholeReassignEdit> {
    if text.is_empty() {
        return None;
    }
    let lines = split_lines_keep(text);
    let source = lines.get(line)?;
    if source.trim().is_empty() {
        return None;
    }
    let (indent, base, subscripts, operator, rhs) = match_subscript_store_line(source)?;
    let tail = rhs.trim();
    Some(FixedDictWholeReassignEdit {
        start_line: line,
        end_line: line + 1,
        text: format!(
            "{}_fd = {}\n{}_fd{} {}= {}\n{}{} = _fd",
            indent,
            base,
            indent,
            subscripts,
            operator.as_deref().unwrap_or(""),
            tail,
            indent,
            base
        ),
    })
}

// ---------------------------------------------------------------------------
// golden 语料与回放
// ---------------------------------------------------------------------------

/// 合成语料条目(自含确定性;覆盖编辑器与插入点的边界形态)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusEntry {
    pub name: String,
    pub text: String,
}

/// 探测面(权威定义;TS 镜像按面驱动对应生产函数)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum Probe {
    /// 类块插入点
    Insertion { corpus: String, class_name: String },
    /// 方法骨架
    Stub { method_name: String, arg_types: Vec<String>, body: MethodStubBody },
    /// 类型替换候选
    Suggestions { unknown: String, registered: Vec<String> },
    /// 接收者区间归属
    ReceiverFace { corpus: String, line: usize, start_char: usize, end_char: usize },
    /// 早退守卫编辑
    GuardEdit { corpus: String, line: usize, receiver: String },
    /// 包裹式守卫编辑
    WrapEdit { corpus: String, line: usize, receiver: String },
    /// 整体重赋编辑
    FdEdit { corpus: String, line: usize },
}

/// 探测产出(与 Probe 一一对应;tag=face 同形)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum ProbeOutcome {
    Insertion { result: Option<InsertionPoint> },
    Stub { code: String },
    Suggestions { hits: Vec<String> },
    ReceiverFace { receiver: Option<&'static str> },
    GuardEdit { edit: Option<ReceiverNoneGuardEdit> },
    WrapEdit { edit: Option<ReceiverNoneWrapEdit> },
    FdEdit { edit: Option<FixedDictWholeReassignEdit> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertionPoint {
    /// 插入行(0 基)
    pub line: usize,
    /// 非空体=真(编辑文本需前置一空行)
    pub blank_prefix: bool,
}

pub fn run_probe(corpus: &BTreeMap<String, CorpusEntry>, probe: &Probe) -> ProbeOutcome {
    match probe {
        Probe::Insertion { corpus: name, class_name } => {
            let entry = corpus.get(name).expect("语料条目存在");
            ProbeOutcome::Insertion {
                result: find_python_class_insertion_point(&entry.text, class_name)
                    .map(|(line, blank_prefix)| InsertionPoint { line, blank_prefix }),
            }
        }
        Probe::Stub { method_name, arg_types, body } => {
            let refs: Vec<&str> = arg_types.iter().map(String::as_str).collect();
            ProbeOutcome::Stub {
                code: build_method_stub_code(method_name, &refs, *body),
            }
        }
        Probe::Suggestions { unknown, registered } => {
            let refs: Vec<&str> = registered.iter().map(String::as_str).collect();
            ProbeOutcome::Suggestions {
                hits: find_registered_type_suggestions(unknown, &refs),
            }
        }
        Probe::ReceiverFace { corpus: name, line, start_char, end_char } => {
            let entry = corpus.get(name).expect("语料条目存在");
            let lines = split_lines_keep(&entry.text);
            let line_text = lines.get(*line).map(String::as_str).unwrap_or("");
            ProbeOutcome::ReceiverFace {
                receiver: receiver_from_diagnostic_line(line_text, *start_char, *end_char),
            }
        }
        Probe::GuardEdit { corpus: name, line, receiver } => {
            let entry = corpus.get(name).expect("语料条目存在");
            ProbeOutcome::GuardEdit {
                edit: build_receiver_none_guard_edit(&entry.text, *line, receiver),
            }
        }
        Probe::WrapEdit { corpus: name, line, receiver } => {
            let entry = corpus.get(name).expect("语料条目存在");
            ProbeOutcome::WrapEdit {
                edit: build_receiver_none_wrap_edit(&entry.text, *line, receiver),
            }
        }
        Probe::FdEdit { corpus: name, line } => {
            let entry = corpus.get(name).expect("语料条目存在");
            ProbeOutcome::FdEdit {
                edit: build_fixed_dict_whole_reassign_edit(&entry.text, *line),
            }
        }
    }
}

/// 合成语料(权威定义;边界形态逐族覆盖)。
pub fn corpus() -> Vec<CorpusEntry> {
    vec![
        CorpusEntry {
            name: "class-basic".into(),
            text: "class Avatar:\n    def onEnterSpace(self, baseEntity):\n        pass\n\n    def onLeaveSpace(self, baseEntity):\n        pass\n\nclass Monster:\n    pass\n".into(),
        },
        CorpusEntry {
            name: "class-nested-comment-blank".into(),
            text: "class Tower:\n\n    # comment inside body\n\n    def shoot(self):\n        pass\n\n        # deeper comment\n        return 0\n\nclass Empty:\nclass Tail:\n    x = 1\n".into(),
        },
        CorpusEntry {
            name: "class-crlf-tabs".into(),
            text: "class Gate:\r\n\tdef open(self):\r\n\t\tpass\r\n\tdef close(self):\r\n\t\tpass\r\n\r\nclass After:\r\n\tpass\r\n".into(),
        },
        CorpusEntry {
            name: "guard-shapes".into(),
            text: "    def onUse(self):\n        self.cell.useItem(1)\n        self.cell.recharge(2, True)\n        # idle comment\n\n        self.base.report(\"done\")\n        if self.client.ready(\n            1,\n            2,\n        ):\n            self.client.play()\n        self.cell.sync()\n        deeper = self.cell.lookup(\n            # comment inside call\n            42,\n        )\n        self.base.notify()\n".into(),
        },
        CorpusEntry {
            name: "receiver-two-oneline".into(),
            text: "        self.cell.pickup(); self.base.drop()\n        return\n".into(),
        },
        CorpusEntry {
            name: "fd-shapes".into(),
            text: "_fd = self.attr\nself.profile[\"name\"] = \"张三\"\nself.grid[0][1] = 5\nself.count += 1\nself.count+=1\nself.m[ \"k\" ] = v\nself.m[\"k\"] == v\nself.total **= 2\nself.ratio //= 3\nself.bits |= mask\nself.n[\"a\"] =\nself.m[\"k\"] = 值 + 1\n        self.deep[\"x\"] = 1\nself.plain = 3\n".into(),
        },
        CorpusEntry {
            name: "cjk-receiver".into(),
            text: "        # 中文注释:self.cell 假前缀\n        self.cell.攻击(\"怪\")\n        self.base.撤退()\n".into(),
        },
        CorpusEntry {
            name: "class-eof-header".into(),
            text: "class Lonely:".into(),
        },
        CorpusEntry {
            name: "wrap-eof-blank-comment".into(),
            text: "def f():\n    self.base.save(x,\n\n    # trailing comment in call\n    y)\n    self.base.flush()\n".into(),
        },
        CorpusEntry {
            name: "indent-dedent".into(),
            text: "    if True:\n        self.cell.a()\n    self.base.b()\n        self.cell.c()\n".into(),
        },
        CorpusEntry {
            name: "tabs-guard".into(),
            text: "\tdef m(self):\n\t\tself.cell.hit(1)\n\t\tself.base.miss(2)\n".into(),
        },
    ]
}

/// 类名探测表(逐语料:体内真名×若干+缺失名)。
pub fn insertion_probes(entries: &[CorpusEntry]) -> Vec<Probe> {
    let mut probes = Vec::new();
    let known: BTreeMap<&str, Vec<&str>> = BTreeMap::from([
        ("class-basic", vec!["Avatar", "Monster", "NotFound", "Avata"]),
        ("class-nested-comment-blank", vec!["Tower", "Empty", "Tail", "NotFound"]),
        ("class-crlf-tabs", vec!["Gate", "After", "NotFound"]),
        ("class-eof-header", vec!["Lonely", "NotFound"]),
    ]);
    for entry in entries {
        let Some(names) = known.get(entry.name.as_str()) else {
            continue;
        };
        for name in names {
            probes.push(Probe::Insertion {
                corpus: entry.name.clone(),
                class_name: (*name).to_string(),
            });
        }
    }
    probes
}

/// 骨架探测(参数类型全表扫+未知+空白 trim+空表;两 body 形态)。
pub fn stub_probes() -> Vec<Probe> {
    let full_table = [
        "UINT8", "UINT16", "UINT32", "UINT64", "INT8", "INT16", "INT32", "INT64",
        "FLOAT", "DOUBLE", "STRING", "UNICODE", "BOOL", "VECTOR2", "VECTOR3",
        "VECTOR4", "ENTITYCALL", "PYTHON", "PY_DICT", "PY_TUPLE", "PY_LIST", "BLOB",
    ];
    let mut probes = Vec::new();
    for body in [MethodStubBody::Pass, MethodStubBody::Raise] {
        probes.push(Probe::Stub {
            method_name: "noArgs".into(),
            arg_types: vec![],
            body,
        });
        probes.push(Probe::Stub {
            method_name: "fullSweep".into(),
            arg_types: full_table.iter().map(|s| s.to_string()).collect(),
            body,
        });
        probes.push(Probe::Stub {
            method_name: "mixed".into(),
            arg_types: vec![
                "UINT32".into(),
                "UNKNOWN_TYPE".into(),
                "  UINT16  ".into(),
                "".into(),
                "py_dict".into(),
                "VECTOR3".into(),
            ],
            body,
        });
        probes.push(Probe::Stub {
            method_name: "lowercaseUnknown".into(),
            arg_types: vec!["string".into(), "bool".into()],
            body,
        });
    }
    probes
}

/// 类型候选探测(大小写/距离边界/平距排序/截断)。
pub fn suggestion_probes() -> Vec<Probe> {
    let registered = ["Avatar", "Avatar2", "AvatarProxy", "Monster", "NPC", "MailBox", "ACCOUNT"];
    let unknowns = [
        "Avtar", "avatar", "AVATAR", "Avatar22", "Monstr", "NCP", "Mailbox",
        "accout", "XYZQW", "", "Avatar",
    ];
    let mut probes = Vec::new();
    for unknown in unknowns {
        probes.push(Probe::Suggestions {
            unknown: unknown.to_string(),
            registered: registered.iter().map(|s| s.to_string()).collect(),
        });
    }
    probes.push(Probe::Suggestions {
        unknown: "LongName".into(),
        registered: vec![
            "LongNam".into(),
            "longnameX".into(),
            "LonName".into(),
            "xxxxxxxxxx".into(),
        ],
    });
    probes
}

/// 行级探测:guard/wrap/receiverFace/fdEdit 逐行×receiver 三值/区间网格。
pub fn line_probes(entries: &[CorpusEntry]) -> Vec<Probe> {
    let mut probes = Vec::new();
    let receivers = ["cell", "base", "client"];
    for entry in entries {
        let lines = split_lines_keep(&entry.text);
        for (line, _entry_line) in lines.iter().enumerate() {
            for receiver in receivers {
                probes.push(Probe::GuardEdit {
                    corpus: entry.name.clone(),
                    line,
                    receiver: receiver.to_string(),
                });
                probes.push(Probe::WrapEdit {
                    corpus: entry.name.clone(),
                    line,
                    receiver: receiver.to_string(),
                });
            }
            probes.push(Probe::FdEdit {
                corpus: entry.name.clone(),
                line,
            });
            // 接收者区间归属:全行 + 滑窗(步 3,宽 2;首行 60 单元内)
            let units: usize = lines[line].encode_utf16().count();
            probes.push(Probe::ReceiverFace {
                corpus: entry.name.clone(),
                line,
                start_char: 0,
                end_char: units,
            });
            let mut start = 0usize;
            while start + 2 <= units && start < 90 {
                probes.push(Probe::ReceiverFace {
                    corpus: entry.name.clone(),
                    line,
                    start_char: start,
                    end_char: start + 2,
                });
                start += 3;
            }
        }
    }
    probes
}

/// 权威探测全集。
pub fn probes() -> (BTreeMap<String, CorpusEntry>, Vec<Probe>) {
    let entries = corpus();
    let table: BTreeMap<String, CorpusEntry> = entries
        .iter()
        .map(|entry| (entry.name.clone(), entry.clone()))
        .collect();
    let mut all = Vec::new();
    all.extend(insertion_probes(&entries));
    all.extend(stub_probes());
    all.extend(suggestion_probes());
    all.extend(line_probes(&entries));
    (table, all)
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeActionGolden {
    pub generator: &'static str,
    pub corpus: Vec<CorpusEntry>,
    pub probes: Vec<Probe>,
    pub outcomes: Vec<ProbeOutcome>,
}

pub const CODE_ACTION_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/code-action-parity.json";

/// golden 生成(纯 JSON 无尾换行;bin 侧补 println)。
pub fn dump_code_action_golden() -> String {
    let (table, probes) = probes();
    let outcomes: Vec<ProbeOutcome> = probes.iter().map(|probe| run_probe(&table, probe)).collect();
    let golden = CodeActionGolden {
        generator: "dump-code-action-golden",
        corpus: corpus(),
        probes,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

// ---------------------------------------------------------------------------
// 单元钉(防 golden 自洽同义反复)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_builtin_gate() {
        // 表值但非内建注解族 → None(typing 泛型不进签名)
        assert_eq!(def_arg_type_to_python_annotation("UINT32"), Some("int"));
        assert_eq!(def_arg_type_to_python_annotation(" VECTOR3 "), None);
        assert_eq!(def_arg_type_to_python_annotation("PY_DICT"), None);
        assert_eq!(def_arg_type_to_python_annotation("BLOB"), Some("bytes"));
        assert_eq!(def_arg_type_to_python_annotation("py_dict"), None);
        assert_eq!(def_arg_type_to_python_annotation(""), None);
    }

    #[test]
    fn stub_signature_shape() {
        assert_eq!(
            build_method_stub_code("shoot", &["UINT32", "UNKNOWN"], MethodStubBody::Raise),
            "    def shoot(self, arg0: int, arg1):\n        raise NotImplementedError\n"
        );
        assert_eq!(
            build_method_stub_code("plain", &[], MethodStubBody::Pass),
            "    def plain(self):\n        pass\n"
        );
    }

    #[test]
    fn insertion_point_body_boundary() {
        // 行 0=class A,行 1=体末非空行 → 插入点行 2(空行 2 仍在,骨架带
        // 空行前缀落其前)
        let text = "class A:\n    x = 1\n\nclass B:\n    y = 2\n";
        assert_eq!(find_python_class_insertion_point(text, "A"), Some((2, true)));
        assert_eq!(find_python_class_insertion_point(text, "B"), Some((5, true)));
        assert_eq!(find_python_class_insertion_point(text, "Missing"), None);
        // 空体=类头下一行且无空行前缀
        assert_eq!(find_python_class_insertion_point("class C:", "C"), Some((1, false)));
        // 后邻非词:Avat 不认 Avatar 行
        assert_eq!(find_python_class_insertion_point("class Avatar:\n    pass\n", "Avat"), None);
        // 体行中空行间隔:末体行=实际 index 3(计数递增会错为 2,prove-red 靶)
        assert_eq!(
            find_python_class_insertion_point("class A:\n    x = 1\n\n    y = 2\n\nclass B:\n", "A"),
            Some((4, true))
        );
    }

    #[test]
    fn suggestions_distance_and_order() {
        let registered = vec!["Avatar", "Avatar2", "Monster", "NPC"];
        // 距离升序,平距名字节序;界内全收(Avtar→Avatar 距 1、Avatar2 距 2)
        assert_eq!(
            find_registered_type_suggestions("Avtar", &registered),
            vec!["Avatar", "Avatar2"]
        );
        assert_eq!(
            find_registered_type_suggestions("avatar", &registered),
            vec!["Avatar", "Avatar2"]
        );
        // 原文等值跳过
        assert_eq!(find_registered_type_suggestions("NPC", &registered), Vec::<String>::new());
        // 距离界外(长度差>2)不收
        assert_eq!(
            find_registered_type_suggestions("TotallyDifferent", &registered),
            Vec::<String>::new()
        );
    }

    #[test]
    fn receiver_interval_attribution() {
        let line = "        self.cell.pickup(); self.base.drop()";
        // 方法名 token 区间归属;同行双 receiver 不互串
        let units: Vec<u16> = line.encode_utf16().collect();
        let find = |needle: &str| {
            let n: Vec<u16> = needle.encode_utf16().collect();
            units
                .windows(n.len())
                .position(|w| *w == n[..])
                .map(|p| (p, p + n.len()))
        };
        let (s, e) = find("pickup").unwrap();
        assert_eq!(receiver_from_diagnostic_line(line, s, e), Some("cell"));
        let (s, e) = find("drop").unwrap();
        assert_eq!(receiver_from_diagnostic_line(line, s, e), Some("base"));
        // 宽区间=首个相交归属
        assert_eq!(receiver_from_diagnostic_line(line, 0, units.len()), Some("cell"));
        // 词边界:xself. 不认
        assert_eq!(receiver_from_diagnostic_line("xself.cell.a()", 0, 12), None);
        // CJK 行:方法名中文名(标识符起点非 ASCII → 不认,不猜)
        assert_eq!(receiver_from_diagnostic_line("self.cell.攻击()", 0, 16), None);
    }

    #[test]
    fn guard_edit_shape_and_blank_refusal() {
        let text = "    self.cell.a()\n\n    self.base.b()\n";
        let edit = build_receiver_none_guard_edit(text, 0, "cell").unwrap();
        assert_eq!(edit.line, 0);
        assert_eq!(edit.text, "    if not self.cell:\n        return\n");
        // 空行不出
        assert_eq!(build_receiver_none_guard_edit(text, 1, "cell"), None);
        assert_eq!(build_receiver_none_guard_edit(text, 99, "cell"), None);
        assert_eq!(build_receiver_none_guard_edit("", 0, "cell"), None);
        // tab 前导:inner 前导+\t
        let tabs = "\tself.cell.a()";
        let edit = build_receiver_none_guard_edit(tabs, 0, "cell").unwrap();
        assert_eq!(edit.text, "\tif not self.cell:\n\t\treturn\n");
    }

    #[test]
    fn wrap_edit_truncates_statement_group() {
        // 首个不引用 receiver 的同级语句截断;空行/注释在括号续行内不中断
        let text = "    self.cell.a()\n    self.base.b()\n";
        let edit = build_receiver_none_wrap_edit(text, 0, "cell").unwrap();
        assert_eq!(edit.start_line, 0);
        assert_eq!(edit.end_line, 1);
        // TS join 无尾换行(provider 按 trailingNewline 面)
        assert_eq!(edit.text, "    if self.cell:\n        self.cell.a()");
        // 括号续行:注释/空行不断,闭合后同级不引用即停
        let multi = "    self.cell.x(\n\n    # c\n    1)\n    self.base.b()\n";
        let edit = build_receiver_none_wrap_edit(multi, 0, "cell").unwrap();
        assert_eq!(edit.end_line, 4);
        assert!(edit.text.contains("        1)"));
    }

    #[test]
    fn fd_edit_requires_subscripts_and_bare_eq() {
        let text = "self.m[\"k\"] = v\nself.count += 1\nself.m[\"k\"] == v\nself.plain = 3\n";
        let edit = build_fixed_dict_whole_reassign_edit(text, 0).unwrap();
        assert_eq!(
            edit.text,
            "_fd = self.m\n_fd[\"k\"] = v\nself.m = _fd"
        );
        // 无下标不认
        assert_eq!(build_fixed_dict_whole_reassign_edit(text, 1), None);
        assert_eq!(build_fixed_dict_whole_reassign_edit(text, 2), None);
        assert_eq!(build_fixed_dict_whole_reassign_edit(text, 3), None);
        // 运算符变体(带下标段;无下标段如 self.total **= 2 两端都 None)
        let pow = "self.m[\"k\"] **= 2";
        let edit = build_fixed_dict_whole_reassign_edit(pow, 0).unwrap();
        assert!(edit.text.contains("_fd[\"k\"] **= 2"), "{}", edit.text);
        assert_eq!(build_fixed_dict_whole_reassign_edit("self.total **= 2", 0), None);
        // 紧贴运算符无下标:必需组拒绝(守卫删除会变 Some,prove-red 靶)
        assert_eq!(build_fixed_dict_whole_reassign_edit("self.count+=1", 0), None);
    }
}
