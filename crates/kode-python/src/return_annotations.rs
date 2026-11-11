//! 返回注解逐文件提取核(RUST-MIGRATION-AUDIT-006 B1 车道批 3):
//! src/backend/pythonReturnTypeInference.ts 提取面逐字移植——maskCodeLine
//! (单行引号/注释掩码,跨行三引号体不处理=TS 既有口径)、parseLocalAssignmentCall
//! (单跳赋值调用形态,三正则 ASSIGNMENT/SIMPLE_CALL/ATTRIBUTE_CALL 手工展开,
//! 含 `\s*=\s*(?!=)(.+)$` 的贪婪回退语义与 JS `.` 行终止符排除)、
//! collectFileAnnotationFacts(首定义优先,def 在而 `->` 缺记 null 事实遮蔽
//! 磁盘旧注解,64 行截断)、extractFileImports(from/bare 导入绑定,通配跳过,
//! 相对前导点剥除按后缀匹配近似)。列/长度一律 UTF-16 码元基底,正则手工展开
//! 的贪婪/回溯语义逐点论证见各 fn 注。回调面不在生产契约(RPC 出参即事实
//! 序列),collect 一次性返回 Vec 由调用方分桶。消息/工作区机械不出本模块。

use crate::self_flow::{is_js_line_terminator, is_js_space, is_name_start, is_word};

/// 一条 `名 = 右值` 赋值里的单层调用(简单调用 f() 或属性直调 a.b())
#[derive(Debug, PartialEq)]
pub struct LocalAssignmentCall {
    /// 被赋值变量名(简单标识符,不含点)
    pub target: String,
    /// 属性直调的接收者(a.b() 的 a);简单调用 f() 为 None
    pub receiver: Option<String>,
    /// 被调函数/方法名
    pub method_name: String,
}

/// 一条注解事实(首定义优先;annotation=None = def 在而 `->` 缺,遮蔽磁盘)
#[derive(Debug, PartialEq)]
pub struct FileAnnotationFact {
    pub name: String,
    pub annotation: Option<String>,
}

/// `from mod import original as local` 绑定(保留被导入原始符号名)
#[derive(Debug, PartialEq)]
pub struct FromImportBindingFace {
    /// 绑定名(alias 有则 alias,否则原始符号)
    pub local: String,
    /// 模块路径(前导点剥除,`.`→`/`)
    pub module: String,
    /// 被导入的原始符号名
    pub symbol: String,
}

/// `import X [as Y]` 绑定(接收者 Y/X 到模块 X)
#[derive(Debug, PartialEq)]
pub struct BareImportBindingFace {
    pub local: String,
    pub module: String,
}

#[derive(Debug, PartialEq)]
pub struct FileImportBindings {
    pub names: Vec<FromImportBindingFace>,
    pub receivers: Vec<BareImportBindingFace>,
}

/// 逐行调用事实(行号 0 起,输入=全文掩码文本的 '\n' 切分行)
#[derive(Debug, PartialEq)]
pub struct LineAssignmentCall {
    pub line: usize,
    pub target: String,
    pub receiver: Option<String>,
    pub method_name: String,
}

fn eq_ascii(text: &[u16], at: usize, word: &str) -> bool {
    let bytes = word.as_bytes();
    if at + bytes.len() > text.len() {
        return false;
    }
    text[at..at + bytes.len()]
        .iter()
        .zip(bytes.iter())
        .all(|(a, b)| *a == u16::from(*b))
}

fn slice3_is(text: &[u16], at: usize, quote: u16) -> bool {
    text.get(at) == Some(&quote)
        && text.get(at + 1) == Some(&quote)
        && text.get(at + 2) == Some(&quote)
}

/// JS `String.prototype.trim`:去两端 JS `\s` 全类(含  / /﻿,
/// 与 Rust char::is_whitespace 集合不同,不换用)
fn js_trim_range(text: &[u16]) -> (usize, usize) {
    let mut start = 0usize;
    while start < text.len() && is_js_space(text[start]) {
        start += 1;
    }
    let mut end = text.len();
    while end > start && is_js_space(text[end - 1]) {
        end -= 1;
    }
    (start, end)
}

fn js_trim(text: &[u16]) -> Vec<u16> {
    let (start, end) = js_trim_range(text);
    text[start..end].to_vec()
}

fn from_utf16(units: &[u16]) -> String {
    String::from_utf16(units).unwrap_or_default()
}

/// TS maskCodeLine(pythonReturnTypeInference.ts:48-73 逐字移植):单行引号/
/// 注释掩码——引号体内逐码元换空白(转义 `\\` 两码元占位、闭引号一码元、
/// triple 开/闭各三下划线占位)、`#` 起尾段全空白。**跨行三引号体不处理**
/// (quote 态不跨行,每行重置=TS 既有口径;跨行体由调用方全文掩码,
/// KR-AUD-64)。raw[col] 为 UTF-16 码元访问,slice(col,col+3) 同码元。
pub fn mask_code_line(raw: &[u16]) -> Vec<u16> {
    let mut quote: u16 = 0;
    let mut triple = false;
    let mut masked: Vec<u16> = Vec::with_capacity(raw.len());
    let mut col = 0usize;
    while col < raw.len() {
        let ch = raw[col];
        if quote != 0 {
            if ch == 0x5C {
                // `masked += '  '; col += 1; continue;`(+循环自增共 2)
                masked.push(0x20);
                masked.push(0x20);
                col += 2;
                continue;
            }
            if triple && slice3_is(raw, col, quote) {
                quote = 0;
                triple = false;
                masked.extend_from_slice(&[0x20, 0x20, 0x20]);
                col += 3;
                continue;
            } else if !triple && ch == quote {
                quote = 0;
                masked.push(0x20);
                col += 1;
                continue;
            } else {
                masked.push(0x20);
                col += 1;
                continue;
            }
        }
        if ch == 0x23 {
            // `masked += ' '.repeat(raw.length - col); break;`
            masked.resize(masked.len() + (raw.len() - col), 0x20);
            break;
        }
        if ch == 0x27 || ch == 0x22 {
            quote = ch;
            triple = slice3_is(raw, col, ch);
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
    masked
}

/// `^\s*def\s+([A-Za-z_]\w*)\s*\(` 手工展开。回溯论证:各 `\s*` 贪婪尾随字符
/// ('d'/'名字首元'/'(' 均非空白)、名字贪婪尾随字符(非词元)皆不可回退,单趟
/// 扫描即等价。`\s` 为 JS 全类(is_js_space)。
fn match_def_head(masked: &[u16]) -> Option<Vec<u16>> {
    let mut i = 0usize;
    while i < masked.len() && is_js_space(masked[i]) {
        i += 1;
    }
    if !eq_ascii(masked, i, "def") {
        return None;
    }
    let mut j = i + 3;
    let ws_start = j;
    while j < masked.len() && is_js_space(masked[j]) {
        j += 1;
    }
    if j == ws_start {
        return None; // `\s+` 至少一空白
    }
    if !is_name_start(masked.get(j).copied().unwrap_or(0)) {
        return None;
    }
    let name_start = j;
    j += 1;
    while j < masked.len() && is_word(masked[j]) {
        j += 1;
    }
    let name_end = j;
    while j < masked.len() && is_js_space(masked[j]) {
        j += 1;
    }
    if masked.get(j) != Some(&0x28) {
        return None;
    }
    Some(masked[name_start..name_end].to_vec())
}

/// `^(\s*)([A-Za-z_]\w*)\s*=\s*(?!=)(.+)$` 手工展开(ASSIGNMENT_PATTERN)。
/// 尾段 `\s*=\s*(?!=)(.+)$` 语义:`=` 后 `\s*` 先贪婪吞满空白,前瞻(≠'=')失败
/// 才逐位回退(`x == 5` 无空白可退 → 整体失配;`x =  = 5` 退一位 → 俘获自末个
/// 空白起,含残余 `= 5`);`(.+)$` 的 `.` 排除 JS 行终止符——俘获区内含孤立
/// \r/ /  则该俘获起整体失配(与 TS `(.+)$` 一致)。行内无终止符的
/// 常态下俘获=「= 后首个非(前瞻 '=')位到行尾」。
fn parse_assignment_head(line: &[u16]) -> Option<(Vec<u16>, usize)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !is_name_start(line.get(i).copied().unwrap_or(0)) {
        return None;
    }
    let name_start = i;
    i += 1;
    while i < line.len() && is_word(line[i]) {
        i += 1;
    }
    let name_end = i;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if line.get(i) != Some(&0x3D) {
        return None;
    }
    let eq = i; // '=' 位
    // `\s*` 贪婪:吞满 '=' 后空白
    let mut e = eq + 1;
    while e < line.len() && is_js_space(line[e]) {
        e += 1;
    }
    let mut rhs_start: Option<usize> = None;
    if e < line.len() && line[e] != 0x3D && first_terminator_from(line, e).is_none() {
        rhs_start = Some(e);
    } else if e > eq + 1 && first_terminator_from(line, e - 1).is_none() {
        // 回退一位:line[e-1] 构造上必为空白(≠'=');俘获区需无终止符
        rhs_start = Some(e - 1);
    }
    let start = rhs_start?;
    Some((line[name_start..name_end].to_vec(), start))
}

fn first_terminator_from(text: &[u16], from: usize) -> Option<usize> {
    (from..text.len()).find(|&i| is_js_line_terminator(text[i]))
}

/// rhs 上 `^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(`(ATTRIBUTE_CALL):
/// 名字/空白贪婪尾随字符('.','.'? '(' 非词元非空白)皆不可回退,单趟扫描。
fn match_attribute_call(rhs: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
    if !is_name_start(rhs.first().copied().unwrap_or(0)) {
        return None;
    }
    let mut i = 1usize;
    while i < rhs.len() && is_word(rhs[i]) {
        i += 1;
    }
    let recv = rhs[..i].to_vec();
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if rhs.get(i) != Some(&0x2E) {
        return None;
    }
    i += 1;
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if !is_name_start(rhs.get(i).copied().unwrap_or(0)) {
        return None;
    }
    let m_start = i;
    i += 1;
    while i < rhs.len() && is_word(rhs[i]) {
        i += 1;
    }
    let method = rhs[m_start..i].to_vec();
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if rhs.get(i) != Some(&0x28) {
        return None;
    }
    Some((recv, method))
}

/// rhs 上 `^([A-Za-z_]\w*)\s*\(`(SIMPLE_CALL)
fn match_simple_call(rhs: &[u16]) -> Option<Vec<u16>> {
    if !is_name_start(rhs.first().copied().unwrap_or(0)) {
        return None;
    }
    let mut i = 1usize;
    while i < rhs.len() && is_word(rhs[i]) {
        i += 1;
    }
    let name = rhs[..i].to_vec();
    while i < rhs.len() && is_js_space(rhs[i]) {
        i += 1;
    }
    if rhs.get(i) != Some(&0x28) {
        return None;
    }
    Some(name)
}

fn contains_dot(text: &[u16]) -> bool {
    text.contains(&0x2E)
}

/// parseLocalAssignmentCall(:79-94 逐字移植):单行赋值解析,右值须是「单层
/// 调用整体」(属性直调优先,其次简单调用且 rhs 无点);链式/二元/字面量
/// → None。rhs 先 maskCodeLine 再 trim(引号体内 `)` 显形,注释剔除)。
pub fn parse_local_assignment_call(line: &[u16]) -> Option<LocalAssignmentCall> {
    let (target, rhs_start) = parse_assignment_head(line)?;
    let rhs_raw = &line[rhs_start..];
    let masked = mask_code_line(rhs_raw);
    let rhs = js_trim(&masked);
    let ends_with_paren = rhs.last() == Some(&0x29);
    if let Some((receiver, method)) = match_attribute_call(&rhs) {
        if ends_with_paren {
            return Some(LocalAssignmentCall {
                target: from_utf16(&target),
                receiver: Some(from_utf16(&receiver)),
                method_name: from_utf16(&method),
            });
        }
    }
    if let Some(name) = match_simple_call(&rhs) {
        if ends_with_paren && !contains_dot(&rhs) {
            return Some(LocalAssignmentCall {
                target: from_utf16(&target),
                receiver: None,
                method_name: from_utf16(&name),
            });
        }
    }
    None
}

/// collectFileAnnotationFacts(:202-236 逐字移植;回调面改一次性返回事实序列,
/// 顺序=record 触发序):首定义优先(def 在而 `->` 缺记 annotation=None);
/// 不完整签名不吞后续定义、不借后续冒号/注解;64 行截断弃当前。
pub fn collect_file_annotation_facts(text: &[u16]) -> Vec<FileAnnotationFact> {
    let mut facts = Vec::new();
    let mut seen: std::collections::HashSet<Vec<u16>> = std::collections::HashSet::new();
    struct Current {
        name: Vec<u16>,
        signature: Vec<u16>,
        depth: usize,
        saw_parens: bool,
        lines: usize,
    }
    let mut current: Option<Current> = None;
    for raw_line in crate::self_flow::split_crlf(text) {
        let masked = mask_code_line(&raw_line);
        let next_def = match_def_head(&masked);
        // 不完整的签名不能吞掉后续定义,也不能借用后续定义的冒号或注解
        if current.is_some() && next_def.is_some() {
            current = None;
        }
        if current.is_none() {
            let Some(name) = next_def else { continue };
            if seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());
            current = Some(Current {
                name,
                signature: Vec::new(),
                depth: 0,
                saw_parens: false,
                lines: 0,
            });
        }
        let mut closed = false;
        {
            let cur = current.as_mut().expect("current set above");
            cur.lines += 1;
            for &ch in masked.iter() {
                if ch == 0x28 {
                    cur.depth += 1;
                    cur.saw_parens = true;
                } else if ch == 0x29 {
                    cur.depth = cur.depth.saturating_sub(1);
                } else if ch == 0x3A && cur.saw_parens && cur.depth == 0 {
                    let arrow = find_arrow(&cur.signature);
                    let annotation = if arrow < 0 {
                        Vec::new()
                    } else {
                        js_trim(&cur.signature[(arrow as usize + 2)..])
                    };
                    facts.push(FileAnnotationFact {
                        name: from_utf16(&cur.name),
                        annotation: if annotation.is_empty() {
                            None
                        } else {
                            Some(from_utf16(&annotation))
                        },
                    });
                    closed = true;
                    break;
                }
                cur.signature.push(ch);
            }
        }
        if closed {
            current = None;
        } else if let Some(cur) = &current {
            if cur.lines >= 64 {
                current = None;
            }
        }
    }
    facts
}

/// `signature.indexOf('->')`(UTF-16 码元扫描,`-`=`>` 相邻)
fn find_arrow(signature: &[u16]) -> i64 {
    if signature.len() < 2 {
        return -1;
    }
    for i in 0..signature.len() - 1 {
        if signature[i] == 0x2D && signature[i + 1] == 0x3E {
            return i as i64;
        }
    }
    -1
}

/// `^\s*from\s+([.\w]+)\s+import\s+([^#]*?)(?:#.*)?$` 手工展开(FROM_IMPORT):
/// 模块贪婪 `[.\w]+` 尾随必为空白(类内字符不可回退);`import` 字面量后须
/// 空白;惰性俘获 `([^#]*?)(?:#.*)?$` 网络效应=「'import'+空白 到首个 '#' 或
/// 行尾」(俘获不含 '#',余段要么空要么 '#' 起)。
fn match_from_import(line: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !eq_ascii(line, i, "from") {
        return None;
    }
    let mut j = i + 4;
    let ws = j;
    while j < line.len() && is_js_space(line[j]) {
        j += 1;
    }
    if j == ws {
        return None;
    }
    let mod_start = j;
    while j < line.len() && (is_word(line[j]) || line[j] == 0x2E) {
        j += 1;
    }
    if j == mod_start {
        return None;
    }
    let module = line[mod_start..j].to_vec();
    let ws = j;
    while j < line.len() && is_js_space(line[j]) {
        j += 1;
    }
    if j == ws || !eq_ascii(line, j, "import") {
        return None;
    }
    let mut k = j + 6;
    let ws = k;
    while k < line.len() && is_js_space(line[k]) {
        k += 1;
    }
    if k == ws {
        return None;
    }
    let capture_end = line[k..]
        .iter()
        .position(|&c| c == 0x23)
        .map_or(line.len(), |off| k + off);
    Some((module, line[k..capture_end].to_vec()))
}

/// `^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$` 手工展开(IMPORT_ALIAS,
/// 两端锚定):名字贪婪后余段为空→无别名;否则须 `\s+as\s+名字` 恰到行尾
/// (`x as y z` 类残段失配=TS 同判)。
fn match_import_alias(part: &[u16]) -> Option<(Vec<u16>, Option<Vec<u16>>)> {
    if !is_name_start(part.first().copied().unwrap_or(0)) {
        return None;
    }
    let mut i = 1usize;
    while i < part.len() && is_word(part[i]) {
        i += 1;
    }
    let name = part[..i].to_vec();
    if i == part.len() {
        return Some((name, None));
    }
    let ws = i;
    while i < part.len() && is_js_space(part[i]) {
        i += 1;
    }
    if i == ws || !eq_ascii(part, i, "as") {
        return None;
    }
    let mut j = i + 2;
    let ws = j;
    while j < part.len() && is_js_space(part[j]) {
        j += 1;
    }
    if j == ws || !is_name_start(part.get(j).copied().unwrap_or(0)) {
        return None;
    }
    let a_start = j;
    j += 1;
    while j < part.len() && is_word(part[j]) {
        j += 1;
    }
    if j != part.len() {
        return None;
    }
    Some((name, Some(part[a_start..j].to_vec())))
}

/// `^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$`
/// 手工展开(BARE_IMPORT):点分段贪婪后,先试有别名(`\s+as\s+名`)再试无别名
/// (`\s*(?:#.*)?$`);段数回退=正则 `(\.\w+)*` 循环回溯(段内 `\w*` 截断必留
/// 词元字符,不可回退,只需枚举 '.' 边界)。
fn match_bare_import(line: &[u16]) -> Option<(Vec<u16>, Option<Vec<u16>>)> {
    let mut i = 0usize;
    while i < line.len() && is_js_space(line[i]) {
        i += 1;
    }
    if !eq_ascii(line, i, "import") {
        return None;
    }
    let mut j = i + 6;
    let ws = j;
    while j < line.len() && is_js_space(line[j]) {
        j += 1;
    }
    if j == ws {
        return None;
    }
    // 首段 [A-Za-z_]\w*
    if !is_name_start(line.get(j).copied().unwrap_or(0)) {
        return None;
    }
    let first_start = j;
    j += 1;
    while j < line.len() && is_word(line[j]) {
        j += 1;
    }
    // 贪婪收集 '.'+名 段边界(每段终点)
    let mut seg_ends: Vec<usize> = vec![j];
    while j < line.len() && line[j] == 0x2E {
        let mut k = j + 1;
        if !is_name_start(line.get(k).copied().unwrap_or(0)) {
            break;
        }
        k += 1;
        while k < line.len() && is_word(line[k]) {
            k += 1;
        }
        seg_ends.push(k);
        j = k;
    }
    let first_seg_end = seg_ends[0];
    // 段数自多变少(贪婪回溯);固定段数下先试有别名再试无别名
    for &mod_end in seg_ends.iter().rev() {
        // 有别名:\s+ 'as' \s+ 名 → \s* (?:#.*)? $
        let mut t = mod_end;
        let ws = t;
        while t < line.len() && is_js_space(line[t]) {
            t += 1;
        }
        if t > ws && eq_ascii(line, t, "as") {
            let mut u = t + 2;
            let ws = u;
            while u < line.len() && is_js_space(line[u]) {
                u += 1;
            }
            if u > ws && is_name_start(line.get(u).copied().unwrap_or(0)) {
                let a_start = u;
                u += 1;
                while u < line.len() && is_word(line[u]) {
                    u += 1;
                }
                if tail_matches(line, u) {
                    return Some((
                        line[first_start..mod_end].to_vec(),
                        Some(line[a_start..u].to_vec()),
                    ));
                }
            }
        }
        // 无别名:\s* (?:#.*)? $
        let mut t = mod_end;
        while t < line.len() && is_js_space(line[t]) {
            t += 1;
        }
        if tail_matches(line, t) {
            return Some((line[first_start..mod_end].to_vec(), None));
        }
    }
    let _ = first_seg_end;
    None
}

/// `\s*(?:#.*)?$` 残段判据:跳过空白后要么 '#' 起注释要么直达行尾
fn tail_matches(line: &[u16], mut t: usize) -> bool {
    while t < line.len() && is_js_space(line[t]) {
        t += 1;
    }
    t == line.len() || line[t] == 0x23
}

/// extractFileImports(:799-826 逐字移植):行序遍历,from 绑定(通配跳过,
/// 模块前导点剥除+点→斜杠)与 bare 绑定(别名绑完整点分路径,无别名维持单段)
/// 分列表;同名重复 set 覆盖语义由调用方 Map 承接,此处保插入序。
pub fn extract_file_imports(lines: &[Vec<u16>]) -> FileImportBindings {
    let mut names: Vec<FromImportBindingFace> = Vec::new();
    let mut receivers: Vec<BareImportBindingFace> = Vec::new();
    for raw in lines {
        let line = raw;
        if let Some((module_raw, capture)) = match_from_import(line) {
            // replace(/^[.]+/, '').replace(/\./g, '/')
            let mut m_start = 0usize;
            while m_start < module_raw.len() && module_raw[m_start] == 0x2E {
                m_start += 1;
            }
            let mut module: Vec<u16> = Vec::new();
            for &c in &module_raw[m_start..] {
                module.push(if c == 0x2E { 0x2F } else { c });
            }
            if module.is_empty() || capture.contains(&0x2A) {
                continue;
            }
            // capture.split(','):逐段 trim 后 IMPORT_ALIAS
            let mut part_start = 0usize;
            loop {
                let split = capture[part_start..]
                    .iter()
                    .position(|&c| c == 0x2C)
                    .map_or(capture.len(), |off| part_start + off);
                let part = &capture[part_start..split];
                let trimmed = js_trim(part);
                if let Some((name, alias)) = match_import_alias(&trimmed) {
                    let local = alias.clone().unwrap_or_else(|| name.clone());
                    names.push(FromImportBindingFace {
                        local: from_utf16(&local),
                        module: from_utf16(&module),
                        symbol: from_utf16(&name),
                    });
                }
                if split == capture.len() {
                    break;
                }
                part_start = split + 1;
            }
            continue;
        }
        if let Some((dotted, alias)) = match_bare_import(line) {
            // firstSegment = dotted.split('.')[0]
            let first_end = dotted
                .iter()
                .position(|&c| c == 0x2E)
                .unwrap_or(dotted.len());
            let first_segment = &dotted[..first_end];
            let module: Vec<u16> = if alias.is_some() {
                dotted.iter().map(|&c| if c == 0x2E { 0x2F } else { c }).collect()
            } else {
                first_segment.to_vec()
            };
            let local = alias.unwrap_or_else(|| first_segment.to_vec());
            receivers.push(BareImportBindingFace {
                local: from_utf16(&local),
                module: from_utf16(&module),
            });
        }
    }
    FileImportBindings { names, receivers }
}

// ---- 单测 -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn u(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn parse(line: &str) -> Option<LocalAssignmentCall> {
        parse_local_assignment_call(&u(line))
    }

    // ---- maskCodeLine ----

    #[test]
    fn mask_string_literal_same_length() {
        assert_eq!(mask_code_line(&u("\"abc\"")), u("_    "));
        assert_eq!(mask_code_line(&u("'x'")), u("_  "));
    }

    #[test]
    fn mask_triple_opener_three_underscores() {
        assert_eq!(mask_code_line(&u("x = \"\"\"abc")), u("x = ___   "));
    }

    #[test]
    fn mask_escape_two_spaces() {
        assert_eq!(mask_code_line(&u("\"a\\\"b\"")), u("_     "));
    }

    #[test]
    fn mask_comment_tail_all_spaces() {
        assert_eq!(mask_code_line(&u("x = 1 # hi")), u("x = 1     "));
    }

    // ---- parseLocalAssignmentCall ----

    #[test]
    fn attribute_call_hit() {
        assert_eq!(
            parse("data = activity_data.get_data()"),
            Some(LocalAssignmentCall {
                target: "data".into(),
                receiver: Some("activity_data".into()),
                method_name: "get_data".into(),
            })
        );
    }

    #[test]
    fn simple_call_hit() {
        assert_eq!(
            parse("x = make()"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: None,
                method_name: "make".into(),
            })
        );
    }

    #[test]
    fn chained_call_rejected() {
        assert_eq!(parse("x = f().g()"), None);
    }

    #[test]
    fn equality_not_assignment() {
        assert_eq!(parse("x == 5"), None);
    }

    #[test]
    fn plain_rhs_rejected() {
        assert_eq!(parse("x = 5"), None);
        assert_eq!(parse("x = (a)"), None);
        assert_eq!(parse("x ="), None);
    }

    #[test]
    fn spaced_attribute_form_hit() {
        assert_eq!(
            parse("x = obj . m ()"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: Some("obj".into()),
                method_name: "m".into(),
            })
        );
    }

    #[test]
    fn quoted_rhs_masked_then_call_visible() {
        // 引号体掩码后 `)` 显形,简单调用成立
        assert_eq!(
            parse("x = f(\"s\")"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: None,
                method_name: "f".into(),
            })
        );
    }

    #[test]
    fn comment_stripped_from_rhs() {
        assert_eq!(
            parse("x = f() # note"),
            Some(LocalAssignmentCall {
                target: "x".into(),
                receiver: None,
                method_name: "f".into(),
            })
        );
    }

    #[test]
    fn assignment_with_stray_eq_still_matches_head() {
        // `x =  = 5`:回退一位俘获 "= 5" → 非调用 None(但赋值头成立)
        assert_eq!(parse("x =  = 5"), None);
    }

    #[test]
    fn lone_cr_in_rhs_fails_whole_match() {
        // 行内孤立 \r 使 `(.+)$` 整体失配(JS `.` 排除行终止符)
        let text = "x = f(\rx)";
        assert_eq!(parse(text), None);
    }

    #[test]
    fn dotted_target_rejected() {
        assert_eq!(parse("x.y = f()"), None);
    }

    // ---- collectFileAnnotationFacts ----

    #[test]
    fn facts_annotation_and_missing() {
        let text = u("def a() -> int:\n    return 1\ndef b():\n    return 2\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].name, "a");
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
        assert_eq!(facts[1].name, "b");
        assert_eq!(facts[1].annotation, None);
    }

    #[test]
    fn facts_first_definition_wins() {
        let text = u("def a() -> int:\n    pass\ndef a() -> str:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    #[test]
    fn facts_multiline_signature() {
        let text = u("def a(x: int,\n    y: str) -> JSONDATA:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].annotation.as_deref(), Some("JSONDATA"));
    }

    #[test]
    fn facts_truncated_signature_does_not_borrow_next() {
        // 首签名未收口被第二 def 打断:首名无事实(不在 64 行截断内而打断),
        // 第二名带注解
        let mut text = String::from("def a(\n");
        for _ in 0..3 {
            text.push_str("    param,\n");
        }
        text.push_str("def b() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&u(&text));
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "b");
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    #[test]
    fn facts_sixty_four_line_cap_drops() {
        let mut text = String::from("def a(\n");
        for _ in 0..70 {
            text.push_str("    param,\n");
        }
        text.push_str("def b() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&u(&text));
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "b");
    }

    #[test]
    fn facts_def_in_string_masked_out() {
        let text = u("s = \"def fake() -> Ghost:\"\ndef real() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "real");
    }

    #[test]
    fn facts_comment_mention_masked_out() {
        let text = u("# def fake() -> Ghost:\ndef real() -> int:\n    pass\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name, "real");
    }

    #[test]
    fn facts_crlf_split() {
        let text = u("def a() -> int:\r\n    pass\r\n");
        let facts = collect_file_annotation_facts(&text);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].annotation.as_deref(), Some("int"));
    }

    // ---- extractFileImports ----

    #[test]
    fn from_import_with_alias_and_plain() {
        let lines = vec![u("from mods import Good as G, Bad")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names.len(), 2);
        assert_eq!(out.names[0].local, "G");
        assert_eq!(out.names[0].module, "mods");
        assert_eq!(out.names[0].symbol, "Good");
        assert_eq!(out.names[1].local, "Bad");
        assert_eq!(out.names[1].symbol, "Bad");
        assert!(out.receivers.is_empty());
    }

    #[test]
    fn relative_dots_stripped_and_slashed() {
        let lines = vec![u("from .rel.path import x")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names[0].module, "rel/path");
    }

    #[test]
    fn wildcard_skipped() {
        let lines = vec![u("from m import *")];
        let out = extract_file_imports(&lines);
        assert!(out.names.is_empty());
    }

    #[test]
    fn comment_after_capture_stripped() {
        let lines = vec![u("from m import x # note")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.names[0].local, "x");
    }

    #[test]
    fn bare_import_alias_binds_full_dotted_path() {
        let lines = vec![u("import pkg.good as g")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers[0].local, "g");
        assert_eq!(out.receivers[0].module, "pkg/good");
    }

    #[test]
    fn bare_import_no_alias_single_segment() {
        let lines = vec![u("import pkg.good")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers[0].local, "pkg");
        assert_eq!(out.receivers[0].module, "pkg");
    }

    #[test]
    fn bare_import_with_comment() {
        let lines = vec![u("import time # as note")];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers[0].local, "time");
        assert_eq!(out.receivers[0].module, "time");
    }

    #[test]
    fn malformed_imports_rejected() {
        let lines = vec![
            u("import a..b"),
            u("import a as"),
            u("import a as b c"),
            u("from a import"),
            u("from import x"),
        ];
        let out = extract_file_imports(&lines);
        assert!(out.names.is_empty());
        assert!(out.receivers.is_empty());
    }

    #[test]
    fn mixed_names_and_receivers_order() {
        let lines = vec![
            u("import base"),
            u("from mods import Good"),
            u("x = 1"),
        ];
        let out = extract_file_imports(&lines);
        assert_eq!(out.receivers.len(), 1);
        assert_eq!(out.names.len(), 1);
        assert_eq!(out.names[0].local, "Good");
    }
}
