//! propertyDirection 诊断词法扫描面(AUDIT-005 B2 车道批 7,GEN-DEF-1e ④ 方向
//! 违规 + 2026-11-10 影子/cellData 两流):一次 RPC 回**三扫描束**,TS 用同一束
//! 驱动判定核(影子抑制/两流分类/def 解析/消息渲染全留 TS 单一来源,两条流
//! ——诊断流与提示流——完整保留不收编删除)。三扫描与 TS 逐字对齐(全在原文,
//! 无掩码,UTF-16 码元基底):
//!   1) accesses = `\bself\.(\w+(?:\.\w+)*)`(propertyCodeLens 同正则,列取
//!      后缀算术 match.index+len-path_len,躲 indexOf 同形子串);
//!   2) init 赋值扫描 = `def __init__` 出块缩进行扫 + `self.(\w+)\s*=(?!=)`
//!      + RHS 内 `self.cellData[\"k\"]`/`.get(\"k\")` 键提取(注意 TS 按 '\n'
//!      切分,行尾 \r 全保留;且 `(.*)$` 尾锚下 JS `.` 不匹配行终结符——携
//!      \r 行整匹配失败即不出赋值,crlf 对拍抓出);
//!   3) cellData 键访问 = `self.cellData[\"k\"]`(须闭])/`.get(\"k\")`(无须
//!      闭)),列取 match[0].indexOf(key) 首次出现语义(既有口径,含键名命中
//!      'self.cellData' 前缀的既行行为)。
//! 回结构面 {accesses,initNames,initSites,initCellDataKeys,cellDataAccesses}。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzePropertyDirection", analyze_property_direction);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PropertyDirectionParams {
    /// 原文(三扫描全在原文,无掩码——与 TS 同口径)
    text: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessItem {
    line: usize,
    character: usize,
    full_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InitSiteItem {
    name: String,
    line: usize,
    character: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CellDataKeyPair {
    name: String,
    key: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CellDataAccessItem {
    line: usize,
    character: usize,
    length: usize,
    access_end: usize,
    key: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertyDirectionScan {
    accesses: Vec<AccessItem>,
    init_names: Vec<String>,
    init_sites: Vec<InitSiteItem>,
    init_cell_data_keys: Vec<CellDataKeyPair>,
    cell_data_accesses: Vec<CellDataAccessItem>,
}

fn analyze_property_direction(params: Value) -> Result<Value, String> {
    let params: PropertyDirectionParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let scan = scan_property_direction(&params.text);
    Ok(json!({ "scan": scan }))
}

/// TS 词元类 `\w` = `[A-Za-z0-9_]`(数字可起头——访问路径段与赋值名均为 `\w+`)
fn is_word(code: u16) -> bool {
    code == 0x5F
        || (0x30..=0x39).contains(&code)
        || (0x41..=0x5A).contains(&code)
        || (0x61..=0x7A).contains(&code)
}

/// 行内 regex `\s` 全类(JS spec:tab/LF/VT/FF/CR/空格 + NBSP/U+1680/
/// U+2000..U+200A/U+2028/U+2029/U+202F/U+205F/U+3000/ZWNBSP;窄 ASCII 类在
/// NBSP/全角缩进上会与 TS 分歧,js-space 对拍口径)
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

/// 行终结符(正则 `.` 不匹配:\r/ / ;\n 已切分不入行)——
/// `(.*)$` 尾锚语义的关键
fn is_line_terminator(code: u16) -> bool {
    matches!(code, 0x0D | 0x2028 | 0x2029)
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

/// 匹配段内子串首次出现偏移(TS `match[0].indexOf(key)` 既有口径)
fn first_occurrence(span: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || needle.len() > span.len() {
        return None;
    }
    for start in 0..=(span.len() - needle.len()) {
        if &span[start..start + needle.len()] == needle {
            return Some(start);
        }
    }
    None
}

/// 行切分双视图(行号一致;初版单视图剥尾 \r 过宽,对拍抓出):
/// stripped = TS `split(/\r?\n/)`(只剥紧邻 \n 的一个 \r;末行无 \n,尾 \r
/// 保留——`get("hp"` 孤尾 \r 时 TS 键类 `[^"')]+` 含 \r);raw = TS
/// `split('\n')`(全保留)。行内孤 \r 两视图都保留。
fn split_lines(text: &str) -> (Vec<Vec<u16>>, Vec<Vec<u16>>) {
    let all: Vec<u16> = text.encode_utf16().collect();
    let mut raw_lines: Vec<Vec<u16>> = Vec::new();
    let mut stripped_lines: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for &code in &all {
        if code == 10 {
            let line = std::mem::take(&mut current);
            raw_lines.push(line.clone());
            let mut stripped = line;
            if stripped.last() == Some(&0x0D) {
                stripped.pop();
            }
            stripped_lines.push(stripped);
        } else {
            current.push(code);
        }
    }
    // 末行(无 \n 收尾;空文本的尾行)两视图都全保留
    raw_lines.push(current.clone());
    stripped_lines.push(current);
    (stripped_lines, raw_lines)
}

// ---- 扫描 1:self.<path> 访问(\bself\.(\w+(?:\.\w+)*)) ----------------------

/// greedy path 无回溯:`(?:\.\w+)*` 每组只在 `.` 后跟词元时扩张,收缩不产生
/// 新候选(段内词元 greedy 同理)——逐组判定即等价。
fn scan_self_accesses(text: &str) -> Vec<AccessItem> {
    let mut items = Vec::new();
    for (line_idx, line) in split_lines(text).0.iter().enumerate() {
        let mut i = 0usize;
        while i < line.len() {
            let boundary = i == 0 || !is_word(line[i - 1]);
            if boundary && starts_with(line, i, "self") && line.get(i + 4) == Some(&0x2E) {
                // 首段 \w+(数字可起头)
                let path_start = i + 5;
                if let Some(&first) = line.get(path_start) {
                    if is_word(first) {
                        let mut j = path_start;
                        while j < line.len() && is_word(line[j]) {
                            j += 1;
                        }
                        // (?:\.\w+)*:每段 '.' 后必须紧跟词元
                        let mut end = j;
                        while end + 1 < line.len()
                            && line[end] == 0x2E
                            && is_word(line[end + 1])
                        {
                            end += 1;
                            while end < line.len() && is_word(line[end]) {
                                end += 1;
                            }
                        }
                        let full_path =
                            String::from_utf16(&line[path_start..end]).unwrap_or_default();
                        // 列 = match.index + match.len - path.len(后缀算术):
                        // match[0] = 'self.' + path → 列恒 = path_start(i+5)
                        items.push(AccessItem {
                            line: line_idx,
                            character: path_start,
                            full_path,
                        });
                        i = end; // g 正则 lastIndex:越过整段
                        continue;
                    }
                }
            }
            i += 1;
        }
    }
    items
}

// ---- 扫描 2:def __init__ 内 self.<名> = 赋值 + RHS cellData 键 -------------

/// `self\.cellData\s*(?:\[\s*(["'])([^"'\]]+)\1|\.get\s*\(\s*(["'])([^"')]+)\3)`
/// 首次命中键名(形式一无须闭 ],形式二无须闭 );未命中 None。
fn cell_data_key_after(text: &[u16]) -> Option<String> {
    let mut i = 0usize;
    while i < text.len() {
        if starts_with(text, i, "self.cellData") {
            let mut j = i + "self.cellData".len();
            while j < text.len() && is_regex_space(text[j]) {
                j += 1;
            }
            match text.get(j) {
                // 形式一:['k'](键止于引号/],须同引号收口)
                Some(&0x5B) => {
                    let mut k = j + 1;
                    while k < text.len() && is_regex_space(text[k]) {
                        k += 1;
                    }
                    match text.get(k) {
                        Some(&q @ (0x22 | 0x27)) => {
                            let key_start = k + 1;
                            let mut m = key_start;
                            while m < text.len() && text[m] != q && text[m] != 0x5D {
                                m += 1;
                            }
                            if m > key_start && text.get(m) == Some(&q) {
                                return Some(String::from_utf16(&text[key_start..m]).unwrap_or_default());
                            }
                        }
                        _ => {}
                    }
                }
                // 形式二:.get('k')(键止于引号/),须同引号收口)
                Some(&0x2E) if starts_with(text, j, ".get") => {
                    let mut k = j + 4;
                    while k < text.len() && is_regex_space(text[k]) {
                        k += 1;
                    }
                    if text.get(k) == Some(&0x28) {
                        let mut m = k + 1;
                        while m < text.len() && is_regex_space(text[m]) {
                            m += 1;
                        }
                        if let Some(&q @ (0x22 | 0x27)) = text.get(m) {
                            let key_start = m + 1;
                            let mut n = key_start;
                            while n < text.len() && text[n] != q && text[n] != 0x29 {
                                n += 1;
                            }
                            if n > key_start && text.get(n) == Some(&q) {
                                return Some(String::from_utf16(&text[key_start..n]).unwrap_or_default());
                            }
                        }
                    }
                }
                _ => {}
            }
            // 本位未命中:'self.cellData' 子串无左界约束,g 正则按整匹配推进
            // (未成匹配时 exec 从 lastIndex+1 续搜);此处保守 +1 对齐
            i += 1;
            continue;
        }
        i += 1;
    }
    None
}

/// TS `^(\s*)def\s+__init__\s*\(`(行首空白后 def __init__();返缩进)
fn init_def_indent(line: &[u16]) -> Option<usize> {
    let mut i = 0usize;
    while i < line.len() && is_regex_space(line[i]) {
        i += 1;
    }
    if !starts_with(line, i, "def") {
        return None;
    }
    let mut j = i + 3;
    let ws_start = j;
    while j < line.len() && is_regex_space(line[j]) {
        j += 1;
    }
    if j == ws_start {
        return None; // \s+ 至少一空白
    }
    if !starts_with(line, j, "__init__") {
        return None;
    }
    let mut k = j + "__init__".len();
    while k < line.len() && is_regex_space(line[k]) {
        k += 1;
    }
    if line.get(k) == Some(&0x28) {
        Some(i)
    } else {
        None
    }
}

/// TS `^(\s*)self\.(\w+)\s*=(?!=)(.*)$`(返 (缩进, 名, token 尾列, RHS 切片起点))。
/// 尾锚语义:crlf 对拍抓出的真分歧——JS `.` 不匹配行终结符,行尾携 \r 时
/// `(.*)$` 不可达,**整匹配失败**(而非「RHS 含 \r 继续匹配」);回溯面里
/// 前缀空白/\w+/\s* 收缩均无新 '=' 候选,故「首个可配 '=' 之后含终结符 ⇒
/// None」逐字等价。行中孤 \r 落在 `\s*` 段内仍可配(全类 \s)。
fn init_assign_of(line: &[u16]) -> Option<(usize, String, usize, usize)> {
    let mut i = 0usize;
    while i < line.len() && is_regex_space(line[i]) {
        i += 1;
    }
    if !starts_with(line, i, "self.") {
        return None;
    }
    let name_start = i + 5;
    let mut j = name_start;
    while j < line.len() && is_word(line[j]) {
        j += 1;
    }
    if j == name_start {
        return None; // \w+ 至少一词元
    }
    let mut k = j;
    while k < line.len() && is_regex_space(line[k]) {
        k += 1;
    }
    if line.get(k) != Some(&0x3D) || line.get(k + 1) == Some(&0x3D) {
        return None; // '=' 且后随非 '='(== / += / <= 均不命中)
    }
    if line[k + 1..].iter().any(|&code| is_line_terminator(code)) {
        return None; // `(.*)$`:RHS 段含行终结符 → TS 整匹配失败
    }
    let name = String::from_utf16(&line[name_start..j]).unwrap_or_default();
    // TS character = ws + 5 + name.len → 恒 = name 终点 j(UTF-16 码元)
    Some((i, name, j, k + 1))
}

/// def __init__ 出块扫描(TS `split('\n')` 口径:raw 视图,孤/尾 \r 全保留;
/// 空行(trim 全空白,JS 全类)跳过不退出;缩进回落出块;`==`/增强/注解
/// 不计)。返 (names, sites, cellKeys)。
fn scan_init_assignments(text: &str) -> (Vec<String>, Vec<InitSiteItem>, Vec<CellDataKeyPair>) {
    let mut names = Vec::new();
    let mut sites = Vec::new();
    let mut cell_keys = Vec::new();
    let mut init_indent: Option<usize> = None;
    for (line_idx, line) in split_lines(text).1.iter().enumerate() {
        if let Some(indent) = init_def_indent(line) {
            init_indent = Some(indent);
            continue;
        }
        let Some(block_indent) = init_indent else {
            continue;
        };
        // 纯空白行(含携 \r)跳过;缩进回落出块(该行本身不扫)
        let is_blank = line.iter().all(|&code| is_regex_space(code));
        let indent = line
            .iter()
            .take_while(|&&code| is_regex_space(code))
            .count();
        if is_blank {
            continue;
        }
        if indent <= block_indent {
            init_indent = None;
            continue;
        }
        if let Some((_, name, token_end, rhs_start)) = init_assign_of(line) {
            if !names.contains(&name) {
                names.push(name.clone());
            }
            sites.push(InitSiteItem {
                name: name.clone(),
                line: line_idx,
                character: token_end,
            });
            if let Some(key) = cell_data_key_after(&line[rhs_start..]) {
                cell_keys.push(CellDataKeyPair { name, key });
            }
        }
    }
    (names, sites, cell_keys)
}

// ---- 扫描 3:self.cellData["k"] / self.cellData.get("k") 访问 ---------------

const CELL_DATA_HEAD: &str = "self.cellData";

/// 形式一:`\[\s*(["'])([^"'\]]+)\1\s*\]`(须闭 ]);返 (key 起点, key 终点, 表达式终点)
fn bracket_key_at(text: &[u16], mut j: usize) -> Option<(usize, usize, usize)> {
    while j < text.len() && is_regex_space(text[j]) {
        j += 1;
    }
    let q = *text.get(j)?;
    if q != 0x22 && q != 0x27 {
        return None;
    }
    let key_start = j + 1;
    let mut m = key_start;
    while m < text.len() && text[m] != q && text[m] != 0x5D {
        m += 1;
    }
    if m == key_start || text.get(m) != Some(&q) {
        return None;
    }
    let mut e = m + 1;
    while e < text.len() && is_regex_space(text[e]) {
        e += 1;
    }
    if text.get(e) != Some(&0x5D) {
        return None; // 形式一须闭 ]
    }
    Some((key_start, m, e + 1))
}

/// 形式二:`\.get\s*\(\s*(["'])([^"')]+)\3`(无须闭 ));返 (key 起点, key 终点, 表达式终点)
fn get_call_key_at(text: &[u16], mut j: usize) -> Option<(usize, usize, usize)> {
    if !starts_with(text, j, ".get") {
        return None;
    }
    j += 4;
    while j < text.len() && is_regex_space(text[j]) {
        j += 1;
    }
    if text.get(j) != Some(&0x28) {
        return None;
    }
    let mut m = j + 1;
    while m < text.len() && is_regex_space(text[m]) {
        m += 1;
    }
    let q = *text.get(m)?;
    if q != 0x22 && q != 0x27 {
        return None;
    }
    let key_start = m + 1;
    let mut n = key_start;
    while n < text.len() && text[n] != q && text[n] != 0x29 {
        n += 1;
    }
    if n == key_start || text.get(n) != Some(&q) {
        return None;
    }
    Some((key_start, n, n + 1))
}

/// 全文 cellData 键访问扫描(TS `split(/\r?\n/)` 口径;列取 indexOf 首现语义)。
fn scan_cell_data_accesses(text: &str) -> Vec<CellDataAccessItem> {
    let mut items = Vec::new();
    let head: Vec<u16> = CELL_DATA_HEAD.encode_utf16().collect();
    for (line_idx, line) in split_lines(text).0.iter().enumerate() {
        let mut i = 0usize;
        while i < line.len() {
            if line[i..].len() >= head.len() && line[i..i + head.len()] == head[..] {
                let mut j = i + head.len();
                while j < line.len() && is_regex_space(line[j]) {
                    j += 1;
                }
                let matched = match line.get(j) {
                    // j 指 '[';形式一从其后再跳空白找开引号
                    Some(&0x5B) => bracket_key_at(line, j + 1),
                    Some(&0x2E) => get_call_key_at(line, j),
                    _ => None,
                };
                if let Some((key_start, key_end, expr_end)) = matched {
                    let key = String::from_utf16(&line[key_start..key_end]).unwrap_or_default();
                    let key_u16: Vec<u16> = key.encode_utf16().collect();
                    let span = &line[i..expr_end];
                    let offset = first_occurrence(span, &key_u16).unwrap_or(0);
                    items.push(CellDataAccessItem {
                        line: line_idx,
                        character: i + offset,
                        length: key_end - key_start,
                        access_end: expr_end,
                        key,
                    });
                    i = expr_end; // g 正则 lastIndex:越过整匹配
                    continue;
                }
            }
            i += 1;
        }
    }
    items
}

fn scan_property_direction(text: &str) -> PropertyDirectionScan {
    let accesses = scan_self_accesses(text);
    let (init_names, init_sites, init_cell_data_keys) = scan_init_assignments(text);
    let cell_data_accesses = scan_cell_data_accesses(text);
    PropertyDirectionScan {
        accesses,
        init_names,
        init_sites,
        init_cell_data_keys,
        cell_data_accesses,
    }
}

// ---- 单测 -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accesses_basic_path_and_column() {
        let items = scan_self_accesses("  self.hp.max\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].full_path, "hp.max");
        assert_eq!(items[0].character, 7);
        assert_eq!(items[0].line, 0);
    }

    #[test]
    fn accesses_single_segment_suffix_arithmetic() {
        let items = scan_self_accesses("self.hp\n");
        assert_eq!(items[0].full_path, "hp");
        assert_eq!(items[0].character, 5);
    }

    #[test]
    fn accesses_digits_start_segment_matches() {
        // \w+ 数字可起头(与 TS 同口径,与 [A-Za-z_] 起头类不同)
        let items = scan_self_accesses("self.9x.y\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].full_path, "9x.y");
    }

    #[test]
    fn accesses_word_boundary_and_double_dot() {
        assert!(scan_self_accesses("myself.a.b\n").is_empty());
        assert!(scan_self_accesses("_self.a.b\n").is_empty());
        // self..a:首段空,整位失败
        assert!(scan_self_accesses("self..a.b\n").is_empty());
    }

    #[test]
    fn init_assignment_basic_with_cell_key() {
        let text = "class A:\n    def __init__(self):\n        self.spaceUType = self.cellData[\"spaceUType\"]\n        self.plain = 1\n";
        let (names, sites, keys) = scan_init_assignments(text);
        assert_eq!(names, vec!["spaceUType", "plain"]);
        assert_eq!(sites[0].line, 2);
        // character = 缩进8 + 'self.'(5) + spaceUType(10) = 23(name 终点)
        assert_eq!(sites[0].character, 23);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].name, "spaceUType");
        assert_eq!(keys[0].key, "spaceUType");
    }

    #[test]
    fn init_assignment_excludes_compare_and_augmented() {
        let text = "class A:\n    def __init__(self):\n        self.a == 1\n        self.b += 1\n        self.c: int = 0\n        self.d = 1\n";
        let (names, _, _) = scan_init_assignments(text);
        assert_eq!(names, vec!["d"]);
    }

    #[test]
    fn init_assignment_crlf_line_whole_match_fails() {
        // TS `(.*)$` 尾锚:JS `.` 不匹配行终结符 → 携尾 \r 行整匹配失败
        // (init 扫描空、影子抑制不生效;crlf-corpus 对拍抓出的真分歧)
        let text = "class A:\r\n    def __init__(self):\r\n        self.hp = 1\r\n";
        let (names, sites, _) = scan_init_assignments(text);
        assert!(names.is_empty());
        assert!(sites.is_empty());
    }

    #[test]
    fn init_assignment_matches_full_js_space_indent() {
        // `\s` 全类:NBSP/全角空格算缩进空白(行级窄 ASCII 类漏)
        let text = "class A:\n\u{00a0}def __init__(self):\n\u{3000}\u{3000}self.hp = 1\n";
        let (names, sites, _) = scan_init_assignments(text);
        assert_eq!(names, vec!["hp"]);
        // character = 缩进 2 码元 + 'self.'(5) + hp(2)= 9
        assert_eq!(sites[0].character, 9);
    }

    #[test]
    fn final_line_without_newline_keeps_trailing_cr() {
        // split(/\r?\n/) 只剥紧邻 \n 的一个 \r;末行无 \n 不剥(TS 切分逐字
        // 等值;孤尾 \r 下三正则匹配面均止于引号/]/),保留为忠实实现面)
        let (stripped, raw) = split_lines("x\r\ny\r");
        assert_eq!(raw[0].last(), Some(&0x0D));
        assert_ne!(stripped[0].last(), Some(&0x0D)); // \r\n 对剥
        assert_eq!(raw[1].last(), Some(&0x0D));
        assert_eq!(stripped[1].last(), Some(&0x0D)); // 末行不剥
        // 无收口引号 + 尾 \r:键类 [^"')]+ 吞 \r 但回引收口失败,与 TS 回溯
        // 同判(空面)
        assert!(scan_cell_data_accesses("self.cellData.get(\"hp\r").is_empty());
        // 有收口引号:匹配止于引号,尾 \r 在匹配外(两侧同有键 hp)
        let items = scan_cell_data_accesses("self.cellData.get(\"hp\"\r");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "hp");
    }

    #[test]
    fn init_block_exits_on_dedent_and_reenters_next_class() {
        let text = "class A:\n    def __init__(self):\n        self.a = 1\n\n    def other(self):\n        self.b = 2\nclass B:\n    def __init__(self):\n        self.c = 3\n";
        let (names, sites, _) = scan_init_assignments(text);
        // a(__init__ 内)与 c(B 类 __init__)在;b(other 方法,出块后)不在
        assert_eq!(names, vec!["a", "c"]);
        assert_eq!(sites.len(), 2);
    }

    #[test]
    fn init_rhs_get_form_key() {
        let text = "class A:\n    def __init__(self):\n        self.x = self.cellData.get('k')\n";
        let (_, _, keys) = scan_init_assignments(text);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, "k");
    }

    #[test]
    fn init_rhs_non_cell_data_no_key() {
        let text = "class A:\n    def __init__(self):\n        self.x = foo()\n";
        let (_, _, keys) = scan_init_assignments(text);
        assert!(keys.is_empty());
    }

    #[test]
    fn cell_data_access_bracket_form() {
        let items = scan_cell_data_accesses("v = self.cellData[\"hp\"]\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "hp");
        // indexOf 首现语义:'self.cellData["hp"]' 内 indexOf('hp') = 15 → 4+15
        assert_eq!(items[0].character, 19);
        assert_eq!(items[0].length, 2);
        assert_eq!(items[0].access_end, 23);
    }

    #[test]
    fn cell_data_access_get_form_no_close_paren_required() {
        let items = scan_cell_data_accesses("v = self.cellData.get('hp')\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "hp");
        // 无闭 ) 的形态也命中(TS 形式二无闭括号要求)
        assert_eq!(scan_cell_data_accesses("v = self.cellData.get('hp'\n").len(), 1);
        // 形式一无闭 ] 不命中(形式一须闭 ])
        assert!(scan_cell_data_accesses("v = self.cellData[\"hp\"\n").is_empty());
    }

    #[test]
    fn cell_data_access_keyname_indexof_quirk() {
        // 键名命中 'self.cellData' 前缀:indexOf('cellData') = 5(既有口径)
        // → character = 匹配起点 4 + 5 = 9
        let items = scan_cell_data_accesses("x = self.cellData[\"cellData\"]\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].character, 9);
    }

    #[test]
    fn cell_data_access_unterminated_bracket_form_fails() {
        // [ 后键段遇 EOF 无收口引号 → 不命中;形式一缺 ] 不命中(见上测)
        assert!(scan_cell_data_accesses("x = self.cellData[hp]\n").is_empty());
    }

    #[test]
    fn scan_bundle_integration() {
        let scan = scan_property_direction(
            "class A:\n    def __init__(self):\n        self.k = self.cellData[\"hp\"]\n    def m(self):\n        self.k.pos.x\n        v = self.cellData.get(\"k\")\n"
        );
        // 4 处:k(赋值 LHS)+ cellData(L2)+ k.pos.x(L4)+ cellData.get(L5,
        // greedy path 吃到 cellData.get)
        assert_eq!(scan.accesses.len(), 4);
        assert_eq!(scan.init_names, vec!["k"]);
        assert_eq!(scan.init_cell_data_keys.len(), 1);
        assert_eq!(scan.cell_data_accesses.len(), 2);
    }

    #[test]
    fn encoded_shape_is_camel_case() {
        let scan = scan_property_direction("self.hp\n");
        let encoded = serde_json::to_value(&scan).unwrap();
        assert_eq!(encoded["accesses"][0]["fullPath"], json!("hp"));
        let scan2 = scan_property_direction("x = self.cellData[\"k\"]\n");
        let encoded2 = serde_json::to_value(&scan2).unwrap();
        // 'self.cellData["k"]' 长 18,匹配起点 4 → accessEnd = 22
        assert_eq!(encoded2["cellDataAccesses"][0]["accessEnd"], json!(22));
    }
}
