//! Python 缩进语法的轻量词法抽取。
//!
//! 这不是完整 Python parser,也不执行 Python。它复刻 TS `pythonClassIndex.parsePythonFile`
//! 的可观察语义(注释/字符串屏蔽、括号/反斜杠续行、缩进作用域),额外补 P0 所需的
//! `self.<name> = ...` 属性表与装饰器记录:
//! - `classes`:类名、限定名、基类、起止行;
//! - `methods`:类直属方法(`async def` 与装饰器保留);
//! - `attributes`:方法体内 `self.<name> = ...` 的写入位置;
//! - `imports`:`import` / `from ... import ...` 的绑定表。
//!
//! 行号 0-based;列号按 LSP/TS 口径为 UTF-16 code unit。

use std::collections::HashMap;

/// 一个 `.py` 文件的四张词法表。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonModule {
    /// TS `content.split(/\r?\n/).length` 同口径(末尾换行会多一空行)。
    pub line_count: usize,
    pub classes: Vec<ClassSymbol>,
    pub methods: Vec<MethodSymbol>,
    pub attributes: Vec<AttributeSymbol>,
    pub imports: Vec<ImportSymbol>,
    /// 模块级实例赋值 `NAME = Class(...)`(TS `instanceAssignments` 兼容面)。
    pub instances: Vec<InstanceAssignment>,
}

/// 类声明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassSymbol {
    pub name: String,
    pub qualified_name: String,
    /// 只保留合法 dotted identifier 且排除 `object`(与 TS 同过滤)。
    pub bases: Vec<String>,
    pub start_line: usize,
    /// 作用域结束行(不含);文件结束时为 `line_count`。
    pub end_line: usize,
}

/// 方法声明(仅类直属 `def`,闭包不算)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodSymbol {
    /// 所属类的限定名。
    pub class: String,
    pub name: String,
    pub line: usize,
    pub character: usize,
    pub is_async: bool,
    /// 紧邻该 `def` 的装饰器行(含 `@`,按源码顺序)。
    pub decorators: Vec<String>,
}

/// 方法体内 `self.<name> = ...` 的属性写入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttributeSymbol {
    /// 所属类的限定名。
    pub class: String,
    pub name: String,
    pub line: usize,
    pub character: usize,
}

/// 导入绑定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSymbol {
    /// 本文件内使用的绑定名。
    pub binding: String,
    /// `from` 的模块名,或 `import` 的目标模块。
    pub module: String,
    /// `from module import symbol` 的 symbol;普通 `import` 为 `None`。
    pub symbol: Option<String>,
    pub line: usize,
    pub is_from: bool,
}

/// 模块级实例赋值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceAssignment {
    pub variable: String,
    pub class_name: String,
    pub line: usize,
}

/// 解析一个已解码的 Python 源文件。
pub fn parse_python_module(source: &str) -> PythonModule {
    let raw_lines = source_lines(source);
    let masked_lines = mask_lines(&raw_lines);
    let statements = statements(&masked_lines);
    let mut module = PythonModule {
        line_count: raw_lines.len(),
        classes: Vec::new(),
        methods: Vec::new(),
        attributes: Vec::new(),
        imports: Vec::new(),
        instances: Vec::new(),
    };
    let mut method_index: HashMap<(String, String), usize> = HashMap::new();
    let mut attribute_index: HashMap<(String, String), usize> = HashMap::new();
    let mut import_index: HashMap<String, usize> = HashMap::new();
    let mut stack: Vec<Scope> = Vec::new();

    for statement in statements {
        if trim_slice(&statement.text).is_empty() {
            continue;
        }
        while stack
            .last()
            .is_some_and(|scope| scope.indent >= statement.indent)
        {
            let closed = stack.pop().expect("checked by is_some_and");
            if let ScopeKind::Class { class_index, .. } = closed.kind {
                module.classes[class_index].end_line =
                    previous_content_end(&masked_lines, statement.line);
            }
        }

        let inside_function = stack
            .iter()
            .any(|scope| matches!(scope.kind, ScopeKind::Function));
        let nearest_class = stack.iter().rev().find_map(|scope| match &scope.kind {
            ScopeKind::Class {
                class_index,
                qualified_name,
            } => Some((*class_index, qualified_name.clone())),
            ScopeKind::Function => None,
        });

        if let Some(header) = parse_class_header(&statement.text) {
            if inside_function {
                continue;
            }
            let qualified_name = nearest_class
                .as_ref()
                .map(|(_, parent)| format!("{parent}.{}", header.name))
                .unwrap_or_else(|| header.name.clone());
            let class_index = module.classes.len();
            module.classes.push(ClassSymbol {
                name: header.name,
                qualified_name: qualified_name.clone(),
                bases: header.bases,
                start_line: statement.line,
                end_line: module.line_count,
            });
            stack.push(Scope {
                indent: statement.indent,
                kind: ScopeKind::Class {
                    class_index,
                    qualified_name,
                },
            });
            continue;
        }

        if let Some(definition) = parse_def_header(&statement.text) {
            if inside_function {
                continue;
            }
            if let Some((_, class_name)) = &nearest_class {
                let character = declaration_column(&masked_lines, statement.line);
                let method = MethodSymbol {
                    class: class_name.clone(),
                    name: definition.name.clone(),
                    line: statement.line,
                    character,
                    is_async: definition.is_async,
                    decorators: collect_decorators(&raw_lines, statement.line, statement.indent),
                };
                let key = (method.class.clone(), method.name.clone());
                set_last_wins(&mut module.methods, &mut method_index, key, method);
            }
            stack.push(Scope {
                indent: statement.indent,
                kind: ScopeKind::Function,
            });
            continue;
        }

        if inside_function {
            if let Some((_, class_name)) = &nearest_class {
                for attribute in self_attributes(&statement, &masked_lines) {
                    let item = AttributeSymbol {
                        class: class_name.clone(),
                        name: attribute.name,
                        line: attribute.line,
                        character: attribute.character,
                    };
                    let key = (item.class.clone(), item.name.clone());
                    set_last_wins(&mut module.attributes, &mut attribute_index, key, item);
                }
            }
            continue;
        }

        for binding in parse_imports(&statement.text) {
            let item = ImportSymbol {
                binding: binding.binding,
                module: binding.module,
                symbol: binding.symbol,
                line: statement.line,
                is_from: binding.is_from,
            };
            set_last_wins(
                &mut module.imports,
                &mut import_index,
                item.binding.clone(),
                item,
            );
        }

        if statement.indent == 0 {
            if let Some(instance) = parse_instance_assignment(&statement.text, statement.line) {
                module.instances.push(instance);
            }
        }
    }

    while let Some(closed) = stack.pop() {
        if let ScopeKind::Class { class_index, .. } = closed.kind {
            module.classes[class_index].end_line = module.line_count;
        }
    }
    module
}

#[derive(Debug)]
struct Scope {
    indent: usize,
    kind: ScopeKind,
}

#[derive(Debug)]
enum ScopeKind {
    Class {
        class_index: usize,
        qualified_name: String,
    },
    Function,
}

#[derive(Debug)]
struct Statement {
    text: Vec<char>,
    line: usize,
    indent: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct ClassHeader {
    name: String,
    bases: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct DefHeader {
    name: String,
    is_async: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct ImportBinding {
    binding: String,
    module: String,
    symbol: Option<String>,
    is_from: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct SelfAttribute {
    name: String,
    line: usize,
    character: usize,
}

fn source_lines(source: &str) -> Vec<&str> {
    source
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

fn mask_lines(lines: &[&str]) -> Vec<Vec<char>> {
    let mut masked = Vec::with_capacity(lines.len());
    let mut quote: Option<char> = None;
    let mut triple = false;
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let mut out = Vec::with_capacity(chars.len());
        let mut index = 0;
        while index < chars.len() {
            let ch = chars[index];
            if let Some(active) = quote {
                if ch == '\\' {
                    out.push(' ');
                    if index + 1 < chars.len() {
                        out.push(' ');
                        index += 2;
                    } else {
                        index += 1;
                    }
                } else if triple
                    && index + 2 < chars.len()
                    && chars[index] == active
                    && chars[index + 1] == active
                    && chars[index + 2] == active
                {
                    out.extend([' ', ' ', ' ']);
                    quote = None;
                    triple = false;
                    index += 3;
                } else if !triple && ch == active {
                    out.push(' ');
                    quote = None;
                    index += 1;
                } else {
                    out.push(' ');
                    index += 1;
                }
                continue;
            }
            if ch == '#' {
                out.extend(std::iter::repeat_n(' ', chars.len() - out.len()));
                break;
            }
            if ch == '\'' || ch == '"' {
                let is_triple =
                    index + 2 < chars.len() && chars[index + 1] == ch && chars[index + 2] == ch;
                quote = Some(ch);
                triple = is_triple;
                if is_triple {
                    out.extend(['_', '_', '_']);
                    index += 3;
                } else {
                    out.push('_');
                    index += 1;
                }
                continue;
            }
            out.push(ch);
            index += 1;
        }
        masked.push(out);
    }
    masked
}

fn statements(lines: &[Vec<char>]) -> Vec<Statement> {
    let mut out = Vec::new();
    let mut pending: Vec<char> = Vec::new();
    let mut start = 0;
    let mut indent = 0;
    let mut depth = 0usize;
    for (line_index, line) in lines.iter().enumerate() {
        if pending.is_empty() && trim_slice(line).is_empty() {
            continue;
        }
        if pending.is_empty() {
            start = line_index;
            indent = leading_indent(line);
        }
        for ch in line {
            if matches!(ch, '(' | '[' | '{') {
                depth += 1;
            } else if matches!(ch, ')' | ']' | '}') {
                depth = depth.saturating_sub(1);
            }
        }
        let mut end = line.len();
        while end > 0 && line[end - 1].is_whitespace() {
            end -= 1;
        }
        let continued = end > 0 && line[end - 1] == '\\';
        let piece_end = if continued { end - 1 } else { line.len() };
        if !pending.is_empty() {
            pending.push(' ');
        }
        pending.extend_from_slice(&line[..piece_end]);
        if depth == 0 && !continued {
            out.push(Statement {
                text: std::mem::take(&mut pending),
                line: start,
                indent,
            });
        }
    }
    out
}

fn leading_indent(line: &[char]) -> usize {
    let mut indent = 0;
    for ch in line {
        match ch {
            ' ' => indent += 1,
            '\t' => indent += 4,
            _ => break,
        }
    }
    indent
}

fn declaration_column(lines: &[Vec<char>], line: usize) -> usize {
    let Some(chars) = lines.get(line) else {
        return 0;
    };
    let leading = chars
        .iter()
        .position(|ch| !ch.is_whitespace())
        .unwrap_or(chars.len());
    utf16_column(chars, leading)
}

fn trim_slice(chars: &[char]) -> &[char] {
    let start = chars
        .iter()
        .position(|ch| !ch.is_whitespace())
        .unwrap_or(chars.len());
    let end = chars
        .iter()
        .rposition(|ch| !ch.is_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    &chars[start..end]
}

fn previous_content_end(lines: &[Vec<char>], before_line: usize) -> usize {
    lines[..before_line.min(lines.len())]
        .iter()
        .rposition(|line| !trim_slice(line).is_empty())
        .map_or(0, |line| line + 1)
}

fn parse_class_header(text: &[char]) -> Option<ClassHeader> {
    let mut index = skip_whitespace(text, 0);
    consume_keyword(text, &mut index, "class")?;
    if !text.get(index).is_some_and(|ch| ch.is_whitespace()) {
        return None;
    }
    index = skip_whitespace(text, index);
    let (name, next) = identifier(text, index)?;
    index = skip_whitespace(text, next);
    let trimmed = trim_slice(text);
    if trimmed.last() != Some(&':') {
        return None;
    }
    let colon = text
        .iter()
        .rposition(|ch| !ch.is_whitespace())
        .expect("trimmed has colon");
    if text.get(index) != Some(&'(') {
        return if index == colon {
            Some(ClassHeader {
                name,
                bases: Vec::new(),
            })
        } else {
            None
        };
    }
    let close = text[..colon].iter().rposition(|ch| *ch == ')')?;
    if close < index {
        return None;
    }
    let bases = split_commas(&text[index + 1..close])
        .into_iter()
        .map(|base| trim_slice(base).iter().collect::<String>())
        .filter(|base| valid_dotted_identifier(base) && base != "object")
        .collect();
    Some(ClassHeader { name, bases })
}

fn parse_def_header(text: &[char]) -> Option<DefHeader> {
    let mut index = skip_whitespace(text, 0);
    let is_async = if keyword_at(text, index, "async") {
        index += "async".len();
        if !text.get(index).is_some_and(|ch| ch.is_whitespace()) {
            return None;
        }
        index = skip_whitespace(text, index);
        true
    } else {
        false
    };
    consume_keyword(text, &mut index, "def")?;
    if !text.get(index).is_some_and(|ch| ch.is_whitespace()) {
        return None;
    }
    index = skip_whitespace(text, index);
    let (name, next) = identifier(text, index)?;
    index = skip_whitespace(text, next);
    if text.get(index) != Some(&'(') {
        return None;
    }
    Some(DefHeader { name, is_async })
}

fn parse_imports(text: &[char]) -> Vec<ImportBinding> {
    let trimmed = trim_slice(text);
    let mut out = Vec::new();
    if keyword_at(trimmed, 0, "from") {
        let mut index = skip_whitespace(trimmed, "from".len());
        let module_start = index;
        while index < trimmed.len()
            && (trimmed[index].is_ascii_alphanumeric() || matches!(trimmed[index], '_' | '.'))
        {
            index += 1;
        }
        if index == module_start {
            return out;
        }
        let module: String = trimmed[module_start..index].iter().collect();
        index = skip_whitespace(trimmed, index);
        if !keyword_at(trimmed, index, "import") {
            return out;
        }
        index += "import".len();
        let rest: Vec<char> = trimmed[index..]
            .iter()
            .copied()
            .filter(|ch| !matches!(ch, '(' | ')'))
            .collect();
        for binding in split_commas(&rest) {
            if let Some((name, alias)) = parse_binding(binding) {
                out.push(ImportBinding {
                    binding: alias.unwrap_or_else(|| name.clone()),
                    module: module.clone(),
                    symbol: Some(name),
                    is_from: true,
                });
            }
        }
        return out;
    }
    if keyword_at(trimmed, 0, "import") {
        let rest: Vec<char> = trimmed["import".len()..]
            .iter()
            .copied()
            .filter(|ch| !matches!(ch, '(' | ')'))
            .collect();
        for binding in split_commas(&rest) {
            if let Some((name, alias)) = parse_binding(binding) {
                let first = name.split('.').next().unwrap_or_default().to_string();
                let module = if alias.is_some() {
                    name.clone()
                } else {
                    first.clone()
                };
                out.push(ImportBinding {
                    binding: alias.unwrap_or(first),
                    module,
                    symbol: None,
                    is_from: false,
                });
            }
        }
    }
    out
}

fn parse_binding(chars: &[char]) -> Option<(String, Option<String>)> {
    let trimmed = trim_slice(chars);
    let mut index = 0;
    let (name, next) = dotted_identifier(trimmed, index)?;
    index = skip_whitespace(trimmed, next);
    if !keyword_at(trimmed, index, "as") {
        if index == trimmed.len() {
            return Some((name, None));
        }
        return None;
    }
    index = skip_whitespace(trimmed, index + "as".len());
    let (alias, end) = identifier(trimmed, index)?;
    if skip_whitespace(trimmed, end) != trimmed.len() {
        return None;
    }
    Some((name, Some(alias)))
}

fn parse_instance_assignment(text: &[char], line: usize) -> Option<InstanceAssignment> {
    let trimmed = trim_slice(text);
    let mut index = 0;
    let (variable, next) = identifier(trimmed, index)?;
    index = skip_whitespace(trimmed, next);
    if trimmed.get(index) != Some(&'=') || trimmed.get(index + 1) == Some(&'=') {
        return None;
    }
    index = skip_whitespace(trimmed, index + 1);
    let (class_name, next) = identifier(trimmed, index)?;
    if !class_name.chars().next().is_some_and(char::is_uppercase) {
        return None;
    }
    index = skip_whitespace(trimmed, next);
    if trimmed.get(index) != Some(&'(') {
        return None;
    }
    Some(InstanceAssignment {
        variable,
        class_name,
        line,
    })
}

fn self_attributes(statement: &Statement, masked_lines: &[Vec<char>]) -> Vec<SelfAttribute> {
    let Some(equal) = simple_assignment_position(&statement.text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let lhs = &statement.text[..equal];
    let mut index = 0;
    while index < lhs.len() {
        if keyword_at(lhs, index, "self") && lhs.get(index + 4) == Some(&'.') {
            let before = index.checked_sub(1).and_then(|at| lhs.get(at));
            if before.is_some_and(|ch| is_ident_char(*ch) || *ch == '.') {
                index += 4;
                continue;
            }
            let name_start = index + 5;
            if let Some((name, next)) = identifier(lhs, name_start) {
                let character = if statement.line < masked_lines.len() {
                    utf16_column(&masked_lines[statement.line], index)
                } else {
                    0
                };
                out.push(SelfAttribute {
                    name,
                    line: statement.line,
                    character,
                });
                index = next;
                continue;
            }
        }
        index += 1;
    }
    out
}

fn simple_assignment_position(text: &[char]) -> Option<usize> {
    let mut depth = 0usize;
    for (index, ch) in text.iter().copied().enumerate() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            '=' if depth == 0 => {
                let previous = index.checked_sub(1).and_then(|at| text.get(at)).copied();
                let next = text.get(index + 1).copied();
                if next == Some('=') || previous.is_some_and(is_compound_assignment) {
                    return None;
                }
                return Some(index);
            }
            _ => {}
        }
    }
    None
}

fn is_compound_assignment(ch: char) -> bool {
    matches!(
        ch,
        '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '@' | '<' | '>' | '!'
    )
}

fn collect_decorators(lines: &[&str], def_line: usize, indent: usize) -> Vec<String> {
    let mut decorators = Vec::new();
    let mut line = def_line;
    while line > 0 {
        line -= 1;
        let raw = lines[line];
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            break;
        }
        if leading_indent(&raw.chars().collect::<Vec<_>>()) != indent {
            break;
        }
        if trimmed.starts_with('@') {
            decorators.push(trimmed.to_string());
        } else if trimmed.starts_with('#') {
            continue;
        } else {
            break;
        }
    }
    decorators.reverse();
    decorators
}

fn split_commas(chars: &[char]) -> Vec<&[char]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (index, ch) in chars.iter().enumerate() {
        if *ch == ',' {
            out.push(&chars[start..index]);
            start = index + 1;
        }
    }
    out.push(&chars[start..]);
    out
}

fn consume_keyword(text: &[char], index: &mut usize, keyword: &str) -> Option<()> {
    if !keyword_at(text, *index, keyword) {
        return None;
    }
    *index += keyword.len();
    Some(())
}

fn keyword_at(text: &[char], index: usize, keyword: &str) -> bool {
    let end = index + keyword.len();
    if end > text.len() {
        return false;
    }
    let matches = text[index..end]
        .iter()
        .copied()
        .zip(keyword.chars())
        .all(|(actual, expected)| actual == expected);
    let boundary_before = index == 0 || !is_ident_char(text[index - 1]);
    let boundary_after = end == text.len() || !is_ident_char(text[end]);
    matches && boundary_before && boundary_after
}

fn identifier(text: &[char], start: usize) -> Option<(String, usize)> {
    let first = *text.get(start)?;
    if !(first.is_alphabetic() || first == '_') {
        return None;
    }
    let mut end = start + 1;
    while end < text.len() && is_ident_char(text[end]) {
        end += 1;
    }
    Some((text[start..end].iter().collect(), end))
}

fn dotted_identifier(text: &[char], start: usize) -> Option<(String, usize)> {
    let (first, mut end) = identifier(text, start)?;
    let mut name = first;
    while text.get(end) == Some(&'.') {
        let (next, after) = identifier(text, end + 1)?;
        name.push('.');
        name.push_str(&next);
        end = after;
    }
    Some((name, end))
}

fn valid_dotted_identifier(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    dotted_identifier(&chars, 0).is_some_and(|(_, end)| end == chars.len())
}

fn is_ident_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn skip_whitespace(text: &[char], mut index: usize) -> usize {
    while text.get(index).is_some_and(|ch| ch.is_whitespace()) {
        index += 1;
    }
    index
}

fn utf16_column(line: &[char], char_index: usize) -> usize {
    line.iter()
        .take(char_index.min(line.len()))
        .map(|ch| ch.len_utf16())
        .sum()
}

fn set_last_wins<T, K: std::hash::Hash + Eq + Clone>(
    items: &mut Vec<T>,
    index: &mut HashMap<K, usize>,
    key: K,
    value: T,
) {
    if let Some(existing) = index.get(&key) {
        items[*existing] = value;
    } else {
        index.insert(key, items.len());
        items.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_classes_bases_methods_and_attributes() {
        let source = "class Base:\n    def base(self):\n        self.hp = 1\n\nclass Avatar(Base, object):\n    def __init__(self):\n        self.hp = 100\n        self.name, self.ready = 'x', True\n\n    async def run(self):\n        self.level = 2\n";
        let module = parse_python_module(source);
        assert_eq!(
            module
                .classes
                .iter()
                .map(|class| (class.name.clone(), class.bases.clone()))
                .collect::<Vec<_>>(),
            [
                ("Base".to_string(), Vec::new()),
                ("Avatar".to_string(), vec!["Base".to_string()])
            ]
        );
        assert_eq!(module.classes[1].qualified_name, "Avatar");
        assert_eq!(module.classes[0].start_line, 0);
        assert_eq!(module.classes[0].end_line, 3);
        assert_eq!(module.classes[1].end_line, module.line_count);
        assert_eq!(
            module
                .methods
                .iter()
                .map(|method| (
                    method.class.as_str(),
                    method.name.as_str(),
                    method.line,
                    method.character,
                    method.is_async
                ))
                .collect::<Vec<_>>(),
            [
                ("Base", "base", 1, 4, false),
                ("Avatar", "__init__", 5, 4, false),
                ("Avatar", "run", 9, 4, true)
            ]
        );
        assert_eq!(
            module
                .attributes
                .iter()
                .map(|attribute| (attribute.class.as_str(), attribute.name.as_str()))
                .collect::<Vec<_>>(),
            [
                ("Base", "hp"),
                ("Avatar", "hp"),
                ("Avatar", "name"),
                ("Avatar", "ready"),
                ("Avatar", "level")
            ]
        );
    }

    #[test]
    fn ignores_comments_strings_and_fake_scope_traps() {
        let source = "class Real:\n    def real(self):\n        # self.fake = 1\n        text = 'self.fake = 1'\n        '''\n        class Fake:\n            def nope(self):\n                self.fake = 1\n        '''\n        self.ok = 2\n";
        let module = parse_python_module(source);
        assert_eq!(module.classes.len(), 1);
        assert_eq!(module.methods.len(), 1);
        let attributes: Vec<&str> = module
            .attributes
            .iter()
            .map(|attribute| attribute.name.as_str())
            .collect();
        assert_eq!(attributes, ["ok"]);
    }

    #[test]
    fn nested_class_in_function_is_not_indexed() {
        let source = "def factory():\n    class Local:\n        def hidden(self):\n            pass\n    return Local\n\nclass Visible:\n    class Nested:\n        def nested(self):\n            pass\n";
        let module = parse_python_module(source);
        assert_eq!(
            module
                .classes
                .iter()
                .map(|class| class.qualified_name.as_str())
                .collect::<Vec<_>>(),
            ["Visible", "Visible.Nested"]
        );
        assert_eq!(module.methods.len(), 1);
        assert_eq!(module.methods[0].class, "Visible.Nested");
    }

    #[test]
    fn parses_multiline_class_headers_and_decorators() {
        let source = "@decorate\nclass Avatar(\n    Mixin, # comment\n    Generic[T],\n    object,\n):\n    @staticmethod\n    async def make(\n        value,\n    ):\n        pass\n";
        let module = parse_python_module(source);
        assert_eq!(module.classes.len(), 1);
        assert_eq!(module.classes[0].bases, ["Mixin"]);
        assert_eq!(module.methods.len(), 1);
        assert_eq!(module.methods[0].name, "make");
        assert!(module.methods[0].is_async);
        assert_eq!(module.methods[0].decorators, ["@staticmethod"]);
    }

    #[test]
    fn parses_import_aliases_and_parenthesized_bindings() {
        let source = "from .mix import (\n    RunMixin as RM,\n    Health,\n)\nimport pkg.mod as pm\nimport os.path\nfrom pkg import thing as alias\n";
        let module = parse_python_module(source);
        let imports: Vec<(String, String, Option<String>, bool)> = module
            .imports
            .iter()
            .map(|item| {
                (
                    item.binding.clone(),
                    item.module.clone(),
                    item.symbol.clone(),
                    item.is_from,
                )
            })
            .collect();
        assert_eq!(
            imports,
            [
                (
                    "RM".to_string(),
                    ".mix".to_string(),
                    Some("RunMixin".to_string()),
                    true
                ),
                (
                    "Health".to_string(),
                    ".mix".to_string(),
                    Some("Health".to_string()),
                    true
                ),
                ("pm".to_string(), "pkg.mod".to_string(), None, false),
                ("os".to_string(), "os".to_string(), None, false),
                (
                    "alias".to_string(),
                    "pkg".to_string(),
                    Some("thing".to_string()),
                    true
                )
            ]
        );
    }

    #[test]
    fn last_method_attribute_and_import_definition_wins() {
        let source = "import a\nimport a as a\nclass A:\n    def run(self):\n        self.x = 1\n    def run(self):\n        self.x = 2\n";
        let module = parse_python_module(source);
        assert_eq!(module.imports.len(), 1);
        assert_eq!(module.imports[0].module, "a");
        assert_eq!(module.methods.len(), 1);
        assert_eq!(module.methods[0].line, 5);
        assert_eq!(module.attributes.len(), 1);
        assert_eq!(module.attributes[0].line, 6);
    }

    #[test]
    fn records_module_level_instance_assignments() {
        let source = "avatar = Avatar()\nother = make_avatar()\nif True:\n    nested = Avatar()\n";
        let module = parse_python_module(source);
        assert_eq!(
            module
                .instances
                .iter()
                .map(|item| (item.variable.as_str(), item.class_name.as_str(), item.line))
                .collect::<Vec<_>>(),
            [("avatar", "Avatar", 0)]
        );
    }

    #[test]
    fn line_count_and_crlf_match_ts_split_semantics() {
        let module = parse_python_module("class A:\r\n    def run(self):\r\n        pass\r\n");
        assert_eq!(module.line_count, 4);
        assert_eq!(module.classes[0].start_line, 0);
        assert_eq!(module.methods[0].line, 1);
    }

    #[test]
    fn utf16_columns_cover_non_ascii_prefixes() {
        let source = "class A:\n    emoji = '😀'; def run(self):\n        pass\n";
        let module = parse_python_module(source);
        assert_eq!(module.methods.len(), 0);
        let source = "class A:\n    def 运行(self):\n        self.生命值 = 1\n";
        let module = parse_python_module(source);
        assert_eq!(module.methods.len(), 1);
        assert_eq!(module.methods[0].name, "运行");
        assert_eq!(module.methods[0].character, 4);
        assert_eq!(module.attributes[0].name, "生命值");
        let line: Vec<char> = "😀self.hp = 1".chars().collect();
        assert_eq!(utf16_column(&line, 1), 2);
    }
}
