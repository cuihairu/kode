//! def 函数形参 inlay 决策核(RUST-144 批 1):src/defParamInlayHints.ts 的
//! 同构下沉——路径判段(inferMethodSectionFromPythonFile)→ 文件解析
//! (parsePythonFile 的类/方法表面)→ 单行 def 解析(parseDefLine)→
//! 形参拆分(splitParams)→ inlay 项配对(buildDefParamInlayItems)。
//! 纯库零 RPC;类型注解解析取内建直查面(workspaceRoot='' 语境,
//! resolveEntityAnnotationType 空注册表分支同构);types.xml/alias.xml
//! 注册表快照链留 TS(诚实边界,批 2)。文本坐标域 UTF-16 code unit
//! (TS [col] 索引与 regex match.index 同域);正则全手写(仓无 regex
//! crate);provider 装配(开关/EntityMappingManager 查询/可视区过滤/
//! vscode.InlayHint 构造)留 TS。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 路径身份归一(pathIdentity.normalizeFileIdentity 同构)
// ---------------------------------------------------------------------------

/// 文件身份键:保留 POSIX 大小写,Windows 盘符与 UNC 路径不区分大小写;
/// 词法折叠 `..`(盘符根/UNC 边界不可弹)。
pub fn normalize_file_identity(file_path: &str) -> String {
    let raw = file_path.replace('\\', "/");
    let unc = raw.starts_with("//");
    let prefix = if unc {
        "//".to_string()
    } else if raw.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            let last = parts.last().copied();
            let last_is_drive_root = last.is_some_and(|p| {
                p.len() == 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic()
            });
            let unc_floor = if unc { 2 } else { 0 };
            if parts.len() > unc_floor && last != Some("..") && !last_is_drive_root {
                parts.pop();
                continue;
            }
            if (!prefix.is_empty() && parts.len() <= unc_floor) || last_is_drive_root {
                continue;
            }
            parts.push("..");
            continue;
        }
        parts.push(part);
    }
    // 裸盘符段收尾仅对无前缀路径生效(POSIX `/C:` 不与盘符根碰撞)
    if prefix.is_empty() && parts.len() == 1 {
        let only = parts[0];
        if only.len() == 2 && only.as_bytes()[1] == b':' && only.as_bytes()[0].is_ascii_alphabetic()
        {
            return format!("{}/", only.to_lowercase());
        }
    }
    let normalized = format!("{}{}", prefix, parts.join("/"));
    let is_drive = normalized.len() >= 3
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
        && normalized.as_bytes()[0].is_ascii_alphabetic();
    if is_drive || unc {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

// ---------------------------------------------------------------------------
// 段判(entityMappingHelpers.inferMethodSectionFromPythonFile 同构)
// ---------------------------------------------------------------------------

/// entity 脚本区块(bots/base/cell/client 四段多形态;目录只按资产层认,
/// 引擎进程名不是目录名)。
pub fn infer_method_section_from_python_file(python_file: &str) -> Option<&'static str> {
    let normalized_path = normalize_file_identity(python_file).to_lowercase();

    if normalized_path.contains("/scripts/bots/")
        || normalized_path.contains("/assets/scripts/bots/")
        || normalized_path.starts_with("bots/")
        || normalized_path.contains("/bots/")
    {
        return Some("ClientMethods");
    }
    if normalized_path.contains("/scripts/base/")
        || normalized_path.contains("/assets/scripts/base/")
        || normalized_path.starts_with("base/")
        || normalized_path.contains("/base/")
    {
        return Some("BaseMethods");
    }
    if normalized_path.contains("/scripts/cell/")
        || normalized_path.contains("/assets/scripts/cell/")
        || normalized_path.starts_with("cell/")
        || normalized_path.contains("/cell/")
    {
        return Some("CellMethods");
    }
    if normalized_path.contains("/scripts/client/")
        || normalized_path.contains("/assets/scripts/client/")
        || normalized_path.starts_with("client/")
        || normalized_path.contains("/client/")
    {
        return Some("ClientMethods");
    }
    None
}

// ---------------------------------------------------------------------------
// python 掩码与语句合并(backend/pythonParser 同构)
// ---------------------------------------------------------------------------

fn is_js_space_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x0020 | 0x0009 | 0x000A | 0x000D | 0x000C | 0x000B | 0x00A0
    )
}

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub(crate) fn units_to_string(slice: &[u16]) -> String {
    String::from_utf16_lossy(slice)
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

/// 掩码注释与字符串字面量(位置不位移):引号内字符→空格(三引号→`___`
/// 占三列),转义吞两位,`#` 到行尾整体空白。TS raw[col] UTF-16 索引同域。
pub fn python_code_lines(content: &str) -> Vec<String> {
    let mut quote: u16 = 0;
    let mut triple = false;
    let mut out = Vec::new();
    for raw_line in split_lines_keep(content) {
        let raw = units(&raw_line);
        let mut masked: Vec<u16> = Vec::with_capacity(raw.len());
        let mut col = 0usize;
        while col < raw.len() {
            let ch = raw[col];
            if quote != 0 {
                if ch == b'\\' as u16 {
                    masked.push(b' ' as u16);
                    masked.push(b' ' as u16);
                    col += 2;
                    continue;
                }
                let q3 = [quote, quote, quote];
                if triple && col + 3 <= raw.len() && raw[col..col + 3] == q3 {
                    quote = 0;
                    triple = false;
                    masked.extend_from_slice(&[0x20, 0x20, 0x20]);
                    col += 3;
                    continue;
                } else if !triple && ch == quote {
                    quote = 0;
                    masked.push(b' ' as u16);
                } else {
                    masked.push(b' ' as u16);
                }
                col += 1;
                continue;
            }
            if ch == b'#' as u16 {
                while masked.len() < raw.len() {
                    masked.push(b' ' as u16);
                }
                break;
            }
            if ch == b'\'' as u16 || ch == b'"' as u16 {
                let q3 = [ch, ch, ch];
                triple = col + 3 <= raw.len() && raw[col..col + 3] == q3;
                quote = ch;
                if triple {
                    masked.extend_from_slice(&[0x5F, 0x5F, 0x5F]);
                    col += 3;
                } else {
                    masked.push(b'_' as u16);
                    col += 1;
                }
                continue;
            }
            masked.push(ch);
            col += 1;
        }
        out.push(units_to_string(&masked));
    }
    out
}

/// 语句级信息(pythonStatements 同构):括号/反斜杠续行合并,坐标取首行。
#[derive(Debug)]
pub struct StatementEntry {
    pub text: String,
    pub line: usize,
    pub end_line: usize,
    pub indent: usize,
}

/// 括号/续行合并(`text` 为掩码文本;indent 取首行前导空白,\t 记 4 空格)。
pub fn python_statements(content: &str) -> Vec<StatementEntry> {
    let mut statements = Vec::new();
    let mut depth = 0isize;
    let mut pending = String::new();
    let mut start = 0usize;
    let mut indent = 0usize;
    for (line, masked) in python_code_lines(content).into_iter().enumerate() {
        let has_content = !masked.trim().is_empty();
        if pending.is_empty() && !has_content {
            continue;
        }
        if pending.is_empty() {
            start = line;
            let leading: String = masked
                .chars()
                .take_while(|c| *c == ' ' || *c == '\t')
                .collect();
            indent = leading.replace('\t', "    ").chars().count();
        }
        for ch in masked.chars() {
            if "([{".contains(ch) {
                depth += 1;
            }
            if ")]}".contains(ch) {
                depth = (depth - 1).max(0);
            }
        }
        // TS /\\\s*$/:存在 `\` 其后到行尾全空白即续行;剥掉 `\`+尾空白
        let trimmed_end = masked.trim_end();
        let trailing_ws = masked.len() - trimmed_end.len();
        let continued = trimmed_end.ends_with('\\');
        let stripped = if continued {
            &masked[..masked.len() - trailing_ws - 1]
        } else {
            &masked[..]
        };
        if !pending.is_empty() {
            pending.push(' ');
        }
        pending.push_str(stripped);
        if depth == 0 && !continued {
            statements.push(StatementEntry {
                text: std::mem::take(&mut pending),
                line: start,
                end_line: line,
                indent,
            });
        }
    }
    statements
}

// ---------------------------------------------------------------------------
// 文件解析(parsePythonFile 的类/方法表面)
// ---------------------------------------------------------------------------

/// 类定义(方法名 → 行/列;只取本批消费面,imports/instanceAssignments
/// 不产出——纯输出裁剪,栈行为不变)。
#[derive(Debug)]
pub struct PythonClassDef {
    pub name: String,
    pub qualified_name: String,
    pub start_line: usize,
    pub end_line: usize,
    /// 方法名 → (行 0 基, 列 UTF-16)
    pub methods: Vec<(String, usize, usize)>,
}

struct ScopeFrame {
    indent: usize,
    cls: Option<usize>,
    function: bool,
}

fn class_header_of(text: &str) -> Option<(String, String)> {
    // /^\s*class\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*:/ —— `.*` 贪婪回溯:
    // 从最右 `)` 向左枚举,首个「其后为 `\s*:`」的即闭合(与 TS 正则引擎
    // 回溯序一致,多 `)` 行不歧义)。
    let u = units(text);
    let mut cursor = 0usize;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    let class_word: Vec<u16> = "class".chars().map(|c| c as u16).collect();
    if !u[cursor..].starts_with(&class_word[..]) {
        return None;
    }
    cursor += class_word.len();
    let space_start = cursor;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor == space_start || cursor >= u.len() || !is_ident_start(u[cursor]) {
        return None;
    }
    let name_start = cursor;
    while cursor < u.len() && is_ident_unit(u[cursor]) {
        cursor += 1;
    }
    let name = units_to_string(&u[name_start..cursor]);
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    let mut bases = String::new();
    if cursor < u.len() && u[cursor] == b'(' as u16 {
        // 从右向左枚举 `)` 候选,首个满足「其后全空白+':'」的为闭合
        let mut close = None;
        for candidate in (cursor + 1..u.len()).rev() {
            if u[candidate] != b')' as u16 {
                continue;
            }
            let mut after = candidate + 1;
            while after < u.len() && is_js_space_unit(u[after]) {
                after += 1;
            }
            if after < u.len() && u[after] == b':' as u16 {
                close = Some(candidate);
                break;
            }
        }
        let close = close?;
        bases = units_to_string(&u[cursor + 1..close]);
        cursor = close + 1;
    }
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor >= u.len() || u[cursor] != b':' as u16 {
        return None;
    }
    Some((name, bases))
}

pub(crate) fn is_ident_start(u: u16) -> bool {
    u == b'_' as u16
        || (u >= b'a' as u16 && u <= b'z' as u16)
        || (u >= b'A' as u16 && u <= b'Z' as u16)
}

pub(crate) fn is_ident_unit(u: u16) -> bool {
    is_ident_start(u) || (u >= b'0' as u16 && u <= b'9' as u16)
}

fn def_header_of(text: &str) -> Option<String> {
    // /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
    let u = units(text);
    let mut cursor = 0usize;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    let def_word: Vec<u16> = "def".chars().map(|c| c as u16).collect();
    let async_word: Vec<u16> = "async".chars().map(|c| c as u16).collect();
    if u[cursor..].starts_with(&async_word[..]) {
        cursor += async_word.len();
        let space_start = cursor;
        while cursor < u.len() && is_js_space_unit(u[cursor]) {
            cursor += 1;
        }
        if cursor == space_start {
            return None;
        }
    }
    if !u[cursor..].starts_with(&def_word[..]) {
        return None;
    }
    cursor += def_word.len();
    let space_start = cursor;
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor == space_start || cursor >= u.len() || !is_ident_start(u[cursor]) {
        return None;
    }
    let name_start = cursor;
    while cursor < u.len() && is_ident_unit(u[cursor]) {
        cursor += 1;
    }
    let name = units_to_string(&u[name_start..cursor]);
    while cursor < u.len() && is_js_space_unit(u[cursor]) {
        cursor += 1;
    }
    if cursor >= u.len() || u[cursor] != b'(' as u16 {
        return None;
    }
    Some(name)
}

/// TS text.indexOf(name, text.indexOf('def') + 3) 同构:从 def 词后起找
/// 名字首现列(UTF-16;掩码文本上)。
pub(crate) fn index_from(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let h = units(haystack);
    let n = units(needle);
    if from > h.len() {
        return None;
    }
    let mut cursor = from;
    while cursor + n.len() <= h.len() {
        if h[cursor..cursor + n.len()] == n[..] {
            return Some(cursor);
        }
        cursor += 1;
    }
    None
}

/// parsePythonFile 同构:类/方法表面(imports/instanceAssignments 不产出)。
pub fn parse_python_file(content: &str) -> Vec<PythonClassDef> {
    let mut classes: Vec<PythonClassDef> = Vec::new();
    let total_lines = split_lines_keep(content).len();
    let mut stack: Vec<ScopeFrame> = Vec::new();
    for statement in python_statements(content) {
        let text = statement.text.clone();
        let line = statement.line;
        let indent = statement.indent;
        if text.trim().is_empty() {
            continue;
        }
        while let Some(top) = stack.last() {
            if top.indent >= indent {
                let frame = stack.pop().expect("checked non-empty");
                if let Some(cls_index) = frame.cls {
                    classes[cls_index].end_line = line;
                }
            } else {
                break;
            }
        }
        // 函数体内的 class 是局部运行时类,不进工作区符号表
        if stack.iter().any(|scope| scope.function) {
            continue;
        }
        if let Some((name, _bases)) = class_header_of(&text) {
            let parent = stack.iter().rev().find_map(|scope| scope.cls);
            let qualified_name = match parent {
                Some(parent_index) => format!("{}.{}", classes[parent_index].qualified_name, name),
                None => name.clone(),
            };
            classes.push(PythonClassDef {
                name,
                qualified_name,
                start_line: line,
                end_line: total_lines,
                methods: Vec::new(),
            });
            stack.push(ScopeFrame {
                indent,
                cls: Some(classes.len() - 1),
                function: false,
            });
            continue;
        }
        if let Some(name) = def_header_of(&text) {
            // 只有类套直系函数是方法;闭包不是
            if let Some(top) = stack.last() {
                if let Some(cls_index) = top.cls {
                    let def_at = index_from(&text, "def", 0).unwrap_or(0);
                    let character = index_from(&text, &name, def_at + 3).unwrap_or(0);
                    classes[cls_index].methods.push((name, line, character));
                }
            }
            stack.push(ScopeFrame {
                indent,
                cls: None,
                function: true,
            });
            continue;
        }
    }
    classes
}

// ---------------------------------------------------------------------------
// 单行 def 解析与形参拆分(defParamInlayHints.parseDefLine/splitParams 同构)
// ---------------------------------------------------------------------------

/// 形参位(定义点;start/end 0 起列,行内绝对)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefParamSiteParam {
    pub start: usize,
    pub end: usize,
    /// 形参名所在行(0 起)——KODE-SYN-004 起签名跨行,形参可落在续行
    pub line: usize,
    pub name: String,
    pub has_annotation: bool,
    pub is_star: bool,
}

/// 定义点站点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefParamSite {
    pub line: usize,
    pub method_name: String,
    pub section: String,
    pub params: Vec<DefParamSiteParam>,
    /// 参数列表闭括号行(0 起)——KODE-SYN-004 起闭括号可在续行
    pub close_paren_line: usize,
    pub close_paren_character: usize,
}

/// 跨行 def 签名解析(KODE-SYN-004):统一事实源=python_code_lines 掩码行域
/// (列不位移;引号/字符串/注释已中性化,括号/逗号扫描零字符串干扰)。从方法
/// 名 token 后首个 '(' 起,跨行括号配对到 depth-0 ')';未闭合(编辑中签名/
/// EOF 截断)返回 None 如实让位。形参位(名字 token 行/列 UTF-16 域)与
/// inlay/semantic_tokens 消费面共用同一产物;`/` 与裸 `*` 仅为 Python 形参
/// 标记不占 <Arg> 位,出序列;`*args`/`**kwargs` 保留 is_star 位。
/// TS parseDefSignature 逐位同构。
pub(crate) fn parse_def_signature(
    masked_lines: &[String],
    start_line: usize,
    method_name: &str,
    name_character: usize,
    section: &str,
) -> Option<DefParamSite> {
    let first_units = masked_lines.get(start_line).map(|l| units(l));
    let u = first_units?;
    let mut open = name_character + method_name.chars().map(|c| c.len_utf16()).sum::<usize>();
    // TS indexOf('(', from) 同构:from 起首个 '('
    while open < u.len() && u[open] != b'(' as u16 {
        open += 1;
    }
    if open >= u.len() {
        return None;
    }
    // 跨行分段:depth-1 逗号切段(depth 1=参数列表顶层,开括号已计入),每段
    // 记录 (line, col, ch) 单元流
    let mut segments: Vec<Vec<(usize, usize, u16)>> = vec![Vec::new()];
    let mut depth: isize = 1;
    let mut close_paren_line: Option<usize> = None;
    let mut close_paren_character: Option<usize> = None;
    'scan: for (line_index, line) in masked_lines.iter().enumerate().skip(start_line) {
        let lu = units(line);
        let from = if line_index == start_line {
            open + 1
        } else {
            0
        };
        let mut col = from;
        while col < lu.len() {
            let ch = lu[col];
            if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
                depth += 1;
                segments
                    .last_mut()
                    .expect("非空")
                    .push((line_index, col, ch));
            } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
                depth -= 1;
                if depth == 0 && ch == b')' as u16 {
                    close_paren_line = Some(line_index);
                    close_paren_character = Some(col);
                    break 'scan;
                }
                segments
                    .last_mut()
                    .expect("非空")
                    .push((line_index, col, ch));
            } else if ch == b',' as u16 && depth == 1 {
                // depth 1=参数列表顶层;嵌套默认值里的逗号在 depth ≥2 不切
                segments.push(Vec::new());
            } else {
                segments
                    .last_mut()
                    .expect("非空")
                    .push((line_index, col, ch));
            }
            col += 1;
        }
    }
    // 编辑中未闭合签名:括号未配对到 depth-0 ')' 不出
    let (close_paren_line, close_paren_character) = match (close_paren_line, close_paren_character)
    {
        (Some(l), Some(c)) => (l, c),
        _ => return None,
    };
    let mut params: Vec<DefParamSiteParam> = Vec::new();
    for segment in &segments {
        if let Some(param) = flush_segment(segment, masked_lines) {
            params.push(param);
        }
    }
    // 首参 self/cls 不参与(引擎实体方法恒 self;类方法 cls 同样不是 RPC 形参)
    let meaningful: Vec<DefParamSiteParam> =
        if !params.is_empty() && (params[0].name == "self" || params[0].name == "cls") {
            params[1..].to_vec()
        } else {
            params
        };
    Some(DefParamSite {
        line: start_line,
        method_name: method_name.to_string(),
        section: section.to_string(),
        params: meaningful,
        close_paren_line,
        close_paren_character,
    })
}

/// 单段成形:跳空白(跨行续行的行首缩进)→ `*` 标记 → 名字 token(ASCII
/// 标识符 + 非 ASCII 名字单元);标注判定走段内 depth-0 首个 ':'/'='(嵌套
/// 默认值里的分隔符不算)。`/` 与裸 `*`(后随无标识符)是 Python 形参标
/// 记,不产形参位。TS flushSegment 同构。
fn flush_segment(
    segment: &[(usize, usize, u16)],
    masked_lines: &[String],
) -> Option<DefParamSiteParam> {
    let mut index = 0usize;
    while index < segment.len() && is_js_space_unit(segment[index].2) {
        index += 1;
    }
    if index >= segment.len() {
        return None; // 尾逗号空段不产形参
    }
    let mut is_star = false;
    while index < segment.len() && segment[index].2 == b'*' as u16 {
        is_star = true;
        index += 1;
    }
    let (name_line, name_col, _) = *segment.get(index)?;
    let line_u = units(masked_lines.get(name_line)?);
    if name_col >= line_u.len() {
        return None;
    }
    // ASCII 侧走标识符判定;非 ASCII 单元(中文等 Unicode 名字,PEP 3131)
    // 保留为名字单元。`/` 等标记是 ASCII 非标识符,照旧不产形参位。
    if !is_ident_start(line_u[name_col]) && line_u[name_col] < 0x80 {
        return None; // `/`(positional-only 标记)等 ASCII 非标识符段不产形参位
    }
    let mut name_len = 1usize;
    while name_col + name_len < line_u.len()
        && (is_ident_unit(line_u[name_col + name_len]) || line_u[name_col + name_len] >= 0x80)
    {
        name_len += 1;
    }
    let name = units_to_string(&line_u[name_col..name_col + name_len]);
    // 名字 token 后首个 depth-0 分隔符是 ':' 才算已标注(默认值字典字面量
    // 里的 ':' 处在 depth ≥1,不算)
    let mut seg_depth: isize = 0;
    let mut has_annotation = false;
    let mut after_name = false;
    for &(unit_line, unit_col, ch) in segment {
        if !after_name {
            if unit_line == name_line && unit_col == name_col + name_len {
                after_name = true; // 命中位本身也可能是分隔符(`a: int`),落穿到下面的判定
            } else {
                continue;
            }
        }
        if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
            seg_depth += 1;
        } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
            seg_depth -= 1;
        } else if seg_depth == 0 && ch == b':' as u16 {
            has_annotation = true;
            break;
        } else if seg_depth == 0 && ch == b'=' as u16 {
            break;
        }
    }
    Some(DefParamSiteParam {
        start: name_col,
        end: name_col + name_len,
        line: name_line,
        name,
        has_annotation,
        is_star,
    })
}

// ---------------------------------------------------------------------------
// 定义点站点面(纯函数入口)
// ---------------------------------------------------------------------------

/// 提取定义点:只认区块文件内、类体内、单行闭合括号的 def。
pub fn find_def_param_sites(text: &str, file_path: &str) -> Vec<DefParamSite> {
    let section = match infer_method_section_from_python_file(file_path) {
        Some(section) => section,
        // 区块外普通方法不出(不做推导)
        None => return Vec::new(),
    };
    // KODE-SYN-004:统一事实源=python_code_lines 掩码行域(列不位移,引号/
    // 注释天然中性化)——跨行签名解析与 semantic_tokens 形参着色走同一份
    // 掩码行,与 TS parseDefSignature 逐位同构
    let masked_lines = python_code_lines(text);
    let mut sites = Vec::new();
    for cls in parse_python_file(text) {
        for (method_name, method_line, character) in &cls.methods {
            if masked_lines.get(*method_line).is_none() {
                continue;
            }
            if let Some(site) = parse_def_signature(
                &masked_lines,
                *method_line,
                method_name,
                *character,
                section,
            ) {
                sites.push(site);
            }
        }
    }
    sites
}

// ---------------------------------------------------------------------------
// 内建注解直查(pythonTypeStubs 空注册表分支同构)
// ---------------------------------------------------------------------------

/// KBENGINE_TYPE_ALIASES = {Address, WatcherValue}:注册表缺失语境按名引用。
fn kbengine_type_alias(name: &str) -> bool {
    matches!(name, "Address" | "WatcherValue")
}

/// PYTHON_BUILTIN_TYPE_ANNOTATIONS 22 键**直查无闸**(pythonTypeStubs 表同构;
/// 与 code_action 的骨架闸不同——签名骨架只发射可裸用的内建名,而 inlay
/// 类型提示 VECTOR2→Vector2 照出)。
fn builtin_table_lookup(name: &str) -> Option<&'static str> {
    match name {
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

/// resolveEntityAnnotationType(workspaceRoot='', raw) 同构:内建直查+引擎
/// 别名按名引用;其余落 Any。返回 None=生产面产 Any(该位不出)。
pub fn resolve_annotation_direct(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "ALIAS" {
        return None;
    }
    if let Some(builtin) = builtin_table_lookup(trimmed) {
        return Some(builtin.to_string());
    }
    if kbengine_type_alias(trimmed) {
        return Some(trimmed.to_string());
    }
    None
}

// ---------------------------------------------------------------------------
// inlay 项配对(buildDefParamInlayItems 同构)
// ---------------------------------------------------------------------------

/// inlay 项(纯数据;position 与 TS {line, character} 同形)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefParamInlayItem {
    pub position: InlayPosition,
    pub text: String,
    pub kind: String,
}

/// 行内绝对位置(0 起行/0 起列,UTF-16 单元域)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlayPosition {
    pub line: usize,
    pub character: usize,
}

/// def 声明面(EntityMethodDefinitionLocation 消费子形)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationFace {
    pub declared_args: Option<Vec<String>>,
    pub declared_return_type: Option<String>,
}

/// 一个定义点的 inlay 项:未标注形参逐位配对 def <Arg>(min(声明数, 形参数)),
/// <ReturnType> 存在且可解析时闭括号后 `-> <Type>`。
pub fn build_def_param_inlay_items(
    site: &DefParamSite,
    declaration: &DeclarationFace,
) -> Vec<DefParamInlayItem> {
    let mut items = Vec::new();
    let declared_args = declaration.declared_args.clone().unwrap_or_default();
    let paired = declared_args.len().min(site.params.len());
    for (index, declared_raw) in declared_args.iter().enumerate().take(paired) {
        let param = &site.params[index];
        let declared = declared_raw.trim().to_string();
        if declared.is_empty() || param.has_annotation || param.is_star {
            continue;
        }
        // TS annotation === PYTHON_TYPE_STUB_FALLBACK('Any') → 该位不出
        let annotation = match resolve_annotation_direct(&declared) {
            Some(annotation) if annotation != "Any" => annotation,
            _ => continue,
        };
        items.push(DefParamInlayItem {
            // KODE-SYN-004:形参提示锚其所在行(跨行签名各提示落各自行)
            position: InlayPosition {
                line: param.line,
                character: param.end,
            },
            text: format!(": {}", annotation),
            kind: "Parameter".to_string(),
        });
    }
    let declared_return = declaration
        .declared_return_type
        .as_ref()
        .map(|t| t.trim().to_string());
    if let Some(declared_return) = declared_return {
        if !declared_return.is_empty() {
            if let Some(return_annotation) = resolve_annotation_direct(&declared_return) {
                if return_annotation != "Any" {
                    items.push(DefParamInlayItem {
                        // 闭括号可能跨行(KODE-SYN-004),锚闭括号所在行
                        position: InlayPosition {
                            line: site.close_paren_line,
                            character: site.close_paren_character + 1,
                        },
                        text: format!(" -> {}", return_annotation),
                        kind: "Type".to_string(),
                    });
                }
            }
        }
    }
    items
}

// ---------------------------------------------------------------------------
// golden(语料+权威探测面+产出;TS 镜像 tests/kodeDefParamHintsParity.test.ts)
// ---------------------------------------------------------------------------

/// 语料条目:路径参与段判(text 为 python 源)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusEntry {
    pub name: String,
    pub path: String,
    pub text: String,
}

/// 探测面:决策核两入口(sites 站点提取 / items inlay 配对)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum Probe {
    Sites {
        corpus: String,
    },
    Items {
        corpus: String,
        site_index: usize,
        declared_args: Option<Vec<String>>,
        declared_return_type: Option<String>,
    },
}

/// 产出面(与 Probe 一一对应)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum ProbeOutcome {
    Sites { sites: Vec<DefParamSite> },
    Items { items: Vec<DefParamInlayItem> },
}

/// golden 文件形态。
#[derive(Debug, Serialize, Deserialize)]
pub struct DefParamHintsGolden {
    pub generator: String,
    pub corpus: Vec<CorpusEntry>,
    pub probes: Vec<Probe>,
    pub outcomes: Vec<ProbeOutcome>,
}

pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/def-param-hints-parity.json";

fn corpus() -> Vec<CorpusEntry> {
    vec![
        CorpusEntry {
            name: "cell_multimethod".into(),
            path: "/p/scripts/cell/avatar.py".into(),
            text: concat!(
                "import base\n",
                "\n",
                "class Avatar:\n",
                "    def foo(self, a, b):\n",
                "        pass\n",
                "\n",
                "    def annotated(self, a: int, b: str = \"x\"):\n",
                "        pass\n",
                "\n",
                "    def starred(self, a, *args, **kwargs):\n",
                "        pass\n",
                "\n",
                "    def tricky(self, a, b=\"s,d\", c={'k': 1}):\n",
                "        pass\n",
                "\n",
                "    async def late(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "base_methods".into(),
            path: "/p/scripts/base/mailbox.py".into(),
            text: concat!(
                "class Mailbox:\n",
                "    def deliver(self, a, b):\n",
                "        pass\n",
                "\n",
                "    def withReturn(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "bots_section".into(),
            path: "/p/scripts/bots/robot.py".into(),
            text: "class Robot:\n    def think(self, a):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "client_section".into(),
            path: "/p/scripts/client/ui.py".into(),
            text: "class Ui:\n    def show(self, a, b, c):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "outside_section".into(),
            path: "/p/scripts/common/util.py".into(),
            text: "class Util:\n    def helper(self, a):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "nested_class".into(),
            path: "/p/scripts/cell/nest.py".into(),
            text: concat!(
                "class Outer:\n",
                "    class Inner:\n",
                "        def inside(self, a):\n",
                "            pass\n",
                "\n",
                "    def plain(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "inner_class_skip".into(),
            path: "/p/scripts/base/factory.py".into(),
            text: concat!(
                "class Factory:\n",
                "    def builder(self):\n",
                "        def inner():\n",
                "            pass\n",
                "        class Local:\n",
                "            def hidden(self, a):\n",
                "                pass\n",
                "        return Local\n",
                "\n",
                "    def visible(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "crossline_def".into(),
            path: "/p/scripts/cell/bridge.py".into(),
            text: concat!(
                "class Bridge:\n",
                "    def cross(self, a,\n",
                "              b):\n",
                "        pass\n",
                "\n",
                "    def ok(self, a):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "cjk_params".into(),
            path: "/p/scripts/cell/cjk.py".into(),
            text: "class Cjk:\n    def attack(self, \u{76ee}\u{6807}, \u{6b21}\u{6570}):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "cls_first".into(),
            path: "/p/scripts/base/cache.py".into(),
            text: "class Cache:\n    @classmethod\n    def load(cls, a):\n        pass\n".into(),
        },
        CorpusEntry {
            name: "deep_default".into(),
            path: "/p/scripts/cell/deep.py".into(),
            text: concat!(
                "class Deep:\n",
                "    def defaults(self, a=(1, 2), b=\"x:y\", c=[3, 4], d={'k': 'v'}):\n",
                "        pass\n",
            )
            .into(),
        },
        CorpusEntry {
            name: "assets_scripts_cell".into(),
            path: "/p/assets/scripts/cell/x.py".into(),
            text: "class X:\n    def go(self, a):\n        pass\n".into(),
        },
        // KODE-SYN-004 验收语料:多行 async + `/`/`*` 标记 + CJK + 非 BMP
        // (astral 代理对)+ 跨行嵌套默认值(dict 内 ':' 在 depth ≥2 不误判
        // 已标注;段内跨行逗号在 depth ≥2 不切段)
        CorpusEntry {
            name: "multiline_rich".into(),
            path: "/p/scripts/cell/summon.py".into(),
            text: concat!(
                "class Rich:\n",
                "    async def summon(\n",
                "        self,\n",
                "        \u{76ee}\u{6807},\n",
                "        /,\n",
                "        power,\n",
                "        *,\n",
                "        options={\"delay\": 1, \"rows\": [\n",
                "            1, 2\n",
                "        ]},\n",
                "        note,\n",
                "    ):\n",
                "        pass\n",
            )
            .into(),
        },
        // 编辑中未闭合签名:括号未配对到 depth-0 ')',诚实让位零站点
        CorpusEntry {
            name: "unclosed_sig".into(),
            path: "/p/scripts/cell/torn.py".into(),
            text: concat!(
                "class Torn:\n",
                "    def part(self, a):\n",
                "        pass\n",
                "\n",
                "    def torn(self,\n",
                "        b,\n",
            )
            .into(),
        },
    ]
}

fn probes() -> Vec<Probe> {
    let args_a = vec![
        "UINT8".to_string(),
        "VECTOR3".to_string(),
        "UNKNOWN_X".to_string(),
        "STRING".to_string(),
        "BOOL".to_string(),
    ];
    let args_b = vec!["STRING".to_string()];
    let args_c = vec!["ENTITYCALL".to_string(), "PY_DICT".to_string()];
    let mut probes = Vec::new();
    for entry in corpus() {
        probes.push(Probe::Sites {
            corpus: entry.name.clone(),
        });
    }
    // cell_multimethod:5 站点 × 4 声明面
    for site_index in 0..5usize {
        for (args, ret) in [
            (Some(args_a.clone()), None),
            (Some(args_b.clone()), Some("BOOL".to_string())),
            (Some(args_c.clone()), Some("ENTITYCALL".to_string())),
            (None, None),
        ] {
            probes.push(Probe::Items {
                corpus: "cell_multimethod".into(),
                site_index,
                declared_args: args,
                declared_return_type: ret,
            });
        }
    }
    for (corpus, site_index, args, ret) in [
        ("base_methods", 0usize, Some(args_b.clone()), None),
        (
            "base_methods",
            1,
            Some(args_c.clone()),
            Some("BOOL".to_string()),
        ),
        ("bots_section", 0, Some(args_a.clone()), None),
        ("client_section", 0, Some(args_a.clone()), None),
        ("client_section", 0, Some(args_c.clone()), None),
        ("outside_section", 0, Some(args_a.clone()), None),
        ("nested_class", 0, Some(args_a.clone()), None),
        ("nested_class", 1, Some(args_a.clone()), None),
        ("inner_class_skip", 0, Some(args_b.clone()), None),
        ("crossline_def", 0, Some(args_a.clone()), None),
        (
            "cjk_params",
            0,
            Some(vec!["UINT8".to_string(), "UINT16".to_string()]),
            None,
        ),
        ("cls_first", 0, Some(vec!["UINT8".to_string()]), None),
        (
            "deep_default",
            0,
            Some(vec![
                "UINT8".to_string(),
                "STRING".to_string(),
                "PY_LIST".to_string(),
                "PY_DICT".to_string(),
            ]),
            Some("BOOL".to_string()),
        ),
        ("assets_scripts_cell", 0, Some(args_a.clone()), None),
        // KODE-SYN-004:多行签名站点 × 声明面(逐位配对/未声明零提示)
        (
            "multiline_rich",
            0,
            Some(vec![
                "UINT16".to_string(),
                "UINT8".to_string(),
                "PY_DICT".to_string(),
                "STRING".to_string(),
            ]),
            None,
        ),
        (
            "multiline_rich",
            0,
            Some(vec![
                "UINT16".to_string(),
                "UINT8".to_string(),
                "PY_DICT".to_string(),
                "STRING".to_string(),
            ]),
            Some("BOOL".to_string()),
        ),
        ("multiline_rich", 0, None, None),
    ] {
        probes.push(Probe::Items {
            corpus: corpus.into(),
            site_index,
            declared_args: args,
            declared_return_type: ret,
        });
    }
    probes
}

fn run_probe(
    table: &std::collections::HashMap<String, CorpusEntry>,
    probe: &Probe,
) -> ProbeOutcome {
    match probe {
        Probe::Sites { corpus } => {
            let entry = table.get(corpus).expect("corpus 名必在表");
            ProbeOutcome::Sites {
                sites: find_def_param_sites(&entry.text, &entry.path),
            }
        }
        Probe::Items {
            corpus,
            site_index,
            declared_args,
            declared_return_type,
        } => {
            let entry = table.get(corpus).expect("corpus 名必在表");
            let sites = find_def_param_sites(&entry.text, &entry.path);
            let items = sites
                .get(*site_index)
                .map(|site| {
                    build_def_param_inlay_items(
                        site,
                        &DeclarationFace {
                            declared_args: declared_args.clone(),
                            declared_return_type: declared_return_type.clone(),
                        },
                    )
                })
                .unwrap_or_default();
            ProbeOutcome::Items { items }
        }
    }
}

pub fn dump_def_param_hints_golden() -> String {
    let list = probes();
    let table: std::collections::HashMap<String, CorpusEntry> = corpus()
        .into_iter()
        .map(|entry| (entry.name.clone(), entry))
        .collect();
    let outcomes: Vec<ProbeOutcome> = list.iter().map(|probe| run_probe(&table, probe)).collect();
    let golden = DefParamHintsGolden {
        generator: "dump-def-param-hints-golden".into(),
        corpus: corpus(),
        probes: list,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_strings_and_comments_position_invariant() {
        let text = "def f(self, a=\"x,y\", b): # note\n    pass\n";
        let masked = python_code_lines(text);
        let lines = split_lines_keep(text);
        assert_eq!(masked.len(), lines.len());
        for (m, r) in masked.iter().zip(lines.iter()) {
            assert_eq!(
                m.encode_utf16().count(),
                r.encode_utf16().count(),
                "掩码不位移: {m:?} vs {r:?}"
            );
        }
        // 字面量:开引号 _ 其余空格(位置不变),注释到行尾全空白
        assert_eq!(masked[0], "def f(self, a=_    , b):       ");
        // 转义引号不关闭(转义吞两位)
        let esc = python_code_lines("s = 'a\\'b,c'\nd(self, x)\n");
        assert_eq!(esc[0], "s = _       ");
        // 三引号开占三列 _,关闭占三列空格
        let tri = python_code_lines("t = \"\"\"ab\nc\"\"\"\n");
        assert_eq!(tri[0], "t = ___  ");
        assert_eq!(tri[1], "    ");
    }

    #[test]
    fn statement_merges_continuations() {
        let text = "class A(\n    Base,\n):\n    def m(self):\n        pass\n";
        let st = python_statements(text);
        assert_eq!(st.len(), 3, "class 合并 1 条 + def + pass");
        assert_eq!(st[0].text, "class A(     Base, ):");
        assert_eq!(st[0].line, 0);
        assert_eq!(st[0].end_line, 2);
        assert_eq!(st[0].indent, 0);
        assert_eq!(st[1].line, 3);
        assert_eq!(st[2].line, 4);
        // 反斜杠续行剥 \
        let bs = python_statements("x = 1 + \\\n    2\n");
        assert_eq!(bs.len(), 1);
        assert_eq!(bs[0].text, "x = 1 +      2");
        // \t 缩进记 4
        let tab = python_statements("\tdef m(self):\n");
        assert_eq!(tab[0].indent, 4);
    }

    #[test]
    fn parse_python_file_class_method_table() {
        let text = "import base\n\nclass Avatar(Base):\n    def foo(self):\n        pass\n\n    async def bar(self):\n        pass\n\n    def notAMethod(self):\n        pass\n\n    def inner():\n        class Local:\n            def hidden(self):\n                pass\n\nclass Other:\n    def baz(self, a):\n        pass\n";
        let classes = parse_python_file(text);
        assert_eq!(classes.len(), 2, "函数体内的 Local 类不进表");
        assert_eq!(classes[0].name, "Avatar");
        assert_eq!(classes[0].qualified_name, "Avatar");
        let names: Vec<&str> = classes[0]
            .methods
            .iter()
            .map(|(n, _, _)| n.as_str())
            .collect();
        assert_eq!(
            names,
            vec!["foo", "bar", "notAMethod", "inner"],
            "async def 同表;Local.hidden 闭包不是方法"
        );
        assert_eq!(classes[1].qualified_name, "Other");
        // 嵌套类(类体内 class):qualifiedName 链
        let nested = parse_python_file(
            "class Outer:\n    class Inner:\n        def m(self):\n            pass\n",
        );
        assert_eq!(nested.len(), 2);
        assert_eq!(nested[1].qualified_name, "Outer.Inner");
    }

    #[test]
    fn section_inference_multiform() {
        assert_eq!(
            infer_method_section_from_python_file("/p/assets/scripts/cell/a.py"),
            Some("CellMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/base/a.py"),
            Some("BaseMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/bots/a.py"),
            Some("ClientMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/client/a.py"),
            Some("ClientMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("base/a.py"),
            Some("BaseMethods")
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/../scripts/cell/a.py"),
            Some("CellMethods"),
            ".. 词法折叠"
        );
        assert_eq!(
            infer_method_section_from_python_file("/p/scripts/common/util.py"),
            None,
            "区块外"
        );
        // 大小写:Windows 盘符身份小写化
        assert_eq!(
            infer_method_section_from_python_file("C:/Proj/Scripts/Cell/a.py"),
            Some("CellMethods")
        );
    }

    #[test]
    fn parse_def_signature_boundaries() {
        // self 剥离/闭括号列(KODE-SYN-004:掩码行域跨行核)
        let masked = python_code_lines("    def foo(self, a, b):\n");
        let site = parse_def_signature(&masked, 0, "foo", 8, "CellMethods").unwrap();
        assert_eq!(site.line, 0);
        assert_eq!(site.method_name, "foo");
        assert_eq!(site.params.len(), 2);
        assert_eq!(site.params[0].name, "a");
        assert_eq!(site.params[0].start, 18);
        assert_eq!(site.params[0].line, 0);
        assert_eq!(site.params[1].name, "b");
        assert_eq!(site.close_paren_line, 0);
        assert_eq!(site.close_paren_character, 22);
        // 首参非 self 全保留
        let masked = python_code_lines("def m(x, y):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "BaseMethods").unwrap();
        assert_eq!(site.params.len(), 2);
        // 编辑中未闭合签名(跨行不闭合)不出
        let masked = python_code_lines("def m(self, a,\n");
        assert_eq!(parse_def_signature(&masked, 0, "m", 4, "CellMethods"), None);
        // 名后无 '(' 不出
        let masked = python_code_lines("def m:\n");
        assert_eq!(parse_def_signature(&masked, 0, "m", 4, "CellMethods"), None);
    }

    #[test]
    fn signature_masking_defaults_and_markers() {
        // 字符串内逗号/冒号被掩码中性化;默认值 dict 内冒号不算标注
        let masked = python_code_lines("def m(self, a, b=\"x,y\", c={'k': 1}, d: int = 2):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "BaseMethods").unwrap();
        assert_eq!(site.params.len(), 4);
        assert_eq!(site.params[1].name, "b");
        assert!(!site.params[1].has_annotation);
        assert_eq!(site.params[2].name, "c");
        assert!(
            !site.params[2].has_annotation,
            "默认值字面量内冒号不算已标注"
        );
        assert_eq!(site.params[3].name, "d");
        assert!(site.params[3].has_annotation);
        // 名字列含 CJK 前缀(UTF-16 域)
        let masked = python_code_lines("def m(self, 中文, x):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert_eq!(site.params[0].name, "中文");
        assert_eq!(site.params[0].start, 12);
        assert_eq!(site.params[0].end, 14, "UTF-16 单元域");
        assert_eq!(
            site.params[1].start, 16,
            "x 在 UTF-16 全域 index 16(两 CJK 各 1 单元)"
        );
        // star 形参保留 is_star
        let masked = python_code_lines("def m(self, *args, **kwargs):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert!(site.params[0].is_star);
        assert_eq!(site.params[0].name, "args");
        assert!(site.params[1].is_star);
        assert_eq!(site.params[1].name, "kwargs");
        // `/` 与裸 `*` 标记出序列(keyword-only 前后形参仍逐位对齐)
        let masked = python_code_lines("def m(self, a, /, b, *, c):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        let names: Vec<&str> = site.params.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"], "标记 `/` 与裸 `*` 不产形参位");
        assert!(!site.params.iter().any(|p| p.is_star));
    }

    /// KODE-SYN-004 验收面:多行 async/嵌套默认值/CJK+非 BMP 坐标/未闭合。
    #[test]
    fn multiline_signature_acceptance_arms() {
        // 多行 async:形参落各自所在行,闭括号行如实
        let masked = python_code_lines(
            "    async def multi(\n        self,\n        a,\n        b: str = \"x,y\",\n    ):\n        pass\n",
        );
        let site = parse_def_signature(&masked, 0, "multi", 14, "ClientMethods").unwrap();
        assert_eq!(site.params.len(), 2);
        assert_eq!(site.params[0].name, "a");
        assert_eq!(site.params[0].line, 2);
        assert_eq!(site.params[0].start, 8);
        assert_eq!(site.params[1].name, "b");
        assert_eq!(site.params[1].line, 3);
        assert!(
            site.params[1].has_annotation,
            "真实标注 :str 认出;默认值字符串内逗号不切段"
        );
        assert_eq!(site.close_paren_line, 4);
        assert_eq!(site.close_paren_character, 4);
        // 嵌套默认值跨行 + 段内注释(掩码后空白)不误切
        let masked = python_code_lines(
            "    def nested(self, a={\n        \"k\": [1, 2]},\n        b):\n        pass\n",
        );
        let site = parse_def_signature(&masked, 0, "nested", 8, "ClientMethods").unwrap();
        assert_eq!(site.params.len(), 2);
        assert_eq!(site.params[0].name, "a");
        assert_eq!(site.params[0].line, 0);
        assert!(
            !site.params[0].has_annotation,
            "嵌套默认值里的 ':' 在 depth ≥1"
        );
        assert_eq!(site.params[1].name, "b");
        assert_eq!(site.params[1].line, 2);
        assert_eq!(site.close_paren_line, 2);
        // 中文形参 + 非 BMP(astral 代理对 2 单元)后的坐标
        let masked = python_code_lines("def m(self, 中文, \u{1D11E}note):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert_eq!(site.params[0].name, "中文");
        assert_eq!(site.params[0].start, 12);
        assert_eq!(site.params[1].name, "\u{1D11E}note");
        assert_eq!(site.params[1].start, 16, "astral 名起在 UTF-16 index 16");
        assert_eq!(site.params[1].end, 22, "𝄞 占 2 单元 + note 4 单元");
        // 多行编辑中未闭合签名:EOF 截断不出
        let masked = python_code_lines("    def broken(self,\n        a,\n");
        assert_eq!(
            parse_def_signature(&masked, 0, "broken", 8, "CellMethods"),
            None
        );
    }

    /// 空形参段(尾逗号)如实跳过不出伪参数。
    #[test]
    fn trailing_comma_skips_empty_segment() {
        let masked = python_code_lines("def m(self, a, ):\n");
        let site = parse_def_signature(&masked, 0, "m", 4, "CellMethods").unwrap();
        assert_eq!(site.params.len(), 1);
        assert_eq!(site.params[0].name, "a");
    }

    #[test]
    fn inlay_items_pairing_rules() {
        // 配对 min(声明, 形参);已标注/star/Any 跳过
        let text = "class Avatar:\n    def foo(self, a, b, c):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        assert_eq!(sites.len(), 1);
        let site = &sites[0];
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT8".into(), "VECTOR3".into(), "UNKNOWN_X".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(site, &decl);
        assert_eq!(items.len(), 2, "UNKNOWN_X 落 Any 不出");
        assert_eq!(
            items[0].position,
            InlayPosition {
                line: 1,
                character: site.params[0].end
            }
        );
        assert_eq!(items[0].text, ": int");
        assert_eq!(items[0].kind, "Parameter");
        assert_eq!(items[1].text, ": Vector3", "VECTOR2/3 直查无闸照出");
        // 已标注形参不覆盖
        let text = "class Avatar:\n    def foo(self, a: str, b):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "a 已标注跳过;b 配 VECTOR3 照出");
        assert_eq!(items[0].text, ": Vector3");
        assert_eq!(
            items[0].position,
            InlayPosition {
                line: 1,
                character: sites[0].params[1].end
            }
        );
        // ReturnType
        let text = "class Avatar:\n    def foo(self, a):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT16".into()]),
            declared_return_type: Some("BOOL".into()),
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].text, " -> bool");
        assert_eq!(items[1].kind, "Type");
        assert_eq!(
            items[1].position,
            InlayPosition {
                line: 1,
                character: sites[0].close_paren_character + 1
            }
        );
        // ReturnType 落 Any 不出
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT16".into()]),
            declared_return_type: Some("ENTITYCALL".into()),
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "ENTITYCALL 表值 Any 与 fallback 同串不出");
        // 声明多于形参:配对 min
        let text = "class Avatar:\n    def foo(self, a):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT8".into(), "UINT16".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1);
        // Parameter 位 Any 表值(ENTITYCALL/PYTHON)该位不出
        let text = "class Avatar:\n    def foo(self, a, b):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["ENTITYCALL".into(), "PY_DICT".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "ENTITYCALL 位落 Any 不出;PY_DICT→dict 照出");
        assert_eq!(items[0].text, ": dict");
        // star 位不出
        let text = "class Avatar:\n    def foo(self, a, *args):\n        pass\n";
        let sites = find_def_param_sites(text, "/p/scripts/cell/avatar.py");
        let decl = DeclarationFace {
            declared_args: Some(vec!["UINT8".into(), "UINT16".into()]),
            declared_return_type: None,
        };
        let items = build_def_param_inlay_items(&sites[0], &decl);
        assert_eq!(items.len(), 1, "*args 位不出");
    }

    #[test]
    fn builtin_direct_gate() {
        assert_eq!(resolve_annotation_direct("UINT8").as_deref(), Some("int"));
        assert_eq!(
            resolve_annotation_direct(" VECTOR3 ").as_deref(),
            Some("Vector3")
        );
        assert_eq!(
            resolve_annotation_direct("Address").as_deref(),
            Some("Address")
        );
        assert_eq!(
            resolve_annotation_direct("ENTITYCALL").as_deref(),
            Some("Any")
        );
        assert_eq!(resolve_annotation_direct("UNKNOWN_X").as_deref(), None);
        assert_eq!(resolve_annotation_direct("ALIAS").as_deref(), None);
        assert_eq!(resolve_annotation_direct("  ").as_deref(), None);
    }

    #[test]
    fn find_def_param_sites_section_gate() {
        // 区块外文件零站点
        let text = "class Avatar:\n    def foo(self, a):\n        pass\n";
        assert!(find_def_param_sites(text, "/p/scripts/common/util.py").is_empty());
        assert!(find_def_param_sites(text, "/p/scripts/cell/avatar.py").len() == 1);
        // 区块内无类零站点
        assert!(
            find_def_param_sites("def foo(self):\n    pass\n", "/p/scripts/cell/a.py").is_empty()
        );
    }

    // ---- 身份折叠/头部拒绝/查找边界面(COV 批补) --------------------------------

    /// 路径身份折叠:UNC 前缀/UNC 根界不弹/盘符根不弹/前导 .. 保留/裸盘符
    /// 小写收尾/POSIX 大小写保留。
    #[test]
    fn normalize_file_identity_unc_drive_and_dotdot_folds() {
        // UNC 前缀 + UNC 根界(srv/share 两段是地板,.. 不弹穿)
        assert_eq!(normalize_file_identity("//Srv/Share/.."), "//srv/share");
        // POSIX 绝对根:.. 不穿根
        assert_eq!(normalize_file_identity("/.."), "/");
        // 盘符根:.. 不弹掉 C:
        assert_eq!(normalize_file_identity("C:/.."), "c:/");
        // 无前缀前导 ..:如实保留(相对路径身份)
        assert_eq!(normalize_file_identity("a/../../x"), "../x");
        // 裸盘符:小写 + 收尾 /
        assert_eq!(normalize_file_identity("C:"), "c:/");
        // POSIX 保留大小写(仅 drive/unc 折叠小写)
        assert_eq!(normalize_file_identity("/Scripts/Base"), "/Scripts/Base");
    }

    /// class 头拒绝面与带基类/带空白的完整形。
    #[test]
    fn class_header_reject_and_bases_faces() {
        assert_eq!(class_header_of("class"), None);
        assert_eq!(class_header_of("class 1X:"), None);
        assert_eq!(class_header_of("class A(Base)"), None, "缺收尾冒号");
        assert_eq!(
            class_header_of("class A (Base) :"),
            Some(("A".to_string(), "Base".to_string()))
        );
        assert_eq!(
            class_header_of("class A:"),
            Some(("A".to_string(), String::new()))
        );
    }

    /// def 头拒绝面:async 无空白不成立/名字与括号间空白成立/无括号拒绝。
    #[test]
    fn def_header_reject_and_space_faces() {
        assert_eq!(def_header_of("asyncdef foo(x)"), None);
        assert_eq!(def_header_of("def foo:"), None);
        assert_eq!(def_header_of("def foo (x):"), Some("foo".to_string()));
    }

    /// index_from 边界:起点越界/无命中/起点后首现。
    #[test]
    fn index_from_bounds_and_miss() {
        assert_eq!(index_from("abc", "a", 99), None);
        assert_eq!(index_from("abc", "z", 0), None);
        assert_eq!(index_from("abcabc", "b", 3), Some(4));
    }

    /// crlf 文本全链:切分剥 \r、站点照出。
    #[test]
    fn crlf_text_still_yields_sites() {
        let text = "class A:\r\n    def f(self, a):\r\n        pass\r\n";
        let sites = find_def_param_sites(text, "/p/scripts/base/mod.py");
        assert_eq!(sites.len(), 1);
        // 首参 self 剔除后只剩 a
        assert_eq!(sites[0].params.len(), 1);
        assert_eq!(sites[0].params[0].name, "a");
    }

    /// 返回注解三拒绝面:空串/ALIAS/Any 表值都不出;引擎别名照出。
    #[test]
    fn return_annotation_reject_faces_and_alias_emits() {
        let text = "class A:\n    def f(self):\n        pass\n";
        let site = &find_def_param_sites(text, "/p/scripts/cell/a.py")[0];
        for bad in ["", "  ", "ALIAS", "ENTITYCALL"] {
            let decl = DeclarationFace {
                declared_args: None,
                declared_return_type: Some(bad.to_string()),
            };
            assert!(
                build_def_param_inlay_items(site, &decl).is_empty(),
                "{bad:?} 不出返回注解"
            );
        }
        let decl = DeclarationFace {
            declared_args: None,
            declared_return_type: Some("Address".to_string()),
        };
        let items = build_def_param_inlay_items(site, &decl);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, " -> Address");
        assert_eq!(items[0].kind, "Type");
    }
}
