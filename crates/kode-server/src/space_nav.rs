//! SP-4 空间/导航语义诊断收编(AUDIT-005 B2 车道批 3):`$/kode/lint/analyzeSpaceNav`。
//!
//! TS 源 = src/backend/spaceNavDiagnostics.ts,逐语义忠实移植(对拍纪律):
//!   - 全量在 UTF-16 码元面(`Vec<u16>`,encode_utf16)做扫描——TS 的
//!     `match.index`/`slice`/`charCodeAt` 都是 UTF-16 码元列,字节面会漂移;
//!   - 词法掩码 = 本模块自实现 code_mask(与 TS spaceNavDiagnostics.codeMask
//!     同语义:行注释 #、单/双引号字符串含三引号整体置非码——**不含**
//!     python_lexical_mask 的 f-string 插值保留,空间导航的调用词元在 f-string
//!     插值体内按 TS 口径整体非码);
//!   - 三类保守检查:1) setSpaceData/delSpaceData 用保留键 "_mapping";
//!     2) self.navigate/navigatePathPoints 出现但全文无 canNavigate;
//!     3) addSpaceGeometryMapping params dict 顶层引号键(引擎需 int 键)。
//!   - 消息不从此模块出:只回结构面(code/line/character/length/kind + 可选
//!     key),l10n 渲染留 TS(kind 判别消息,key 填 {key} 占位)。
//!
//! 入参 `{text}`;出 `{items:[...]}`。kind ∈ mappingKey|navigateNoGuard|
//! paramsStringKey。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub const CODE_SPACE_NAV: &str = "kbengine.spaceNav";

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeSpaceNav", analyze_space_nav);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SpaceNavParams {
    text: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpaceNavItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

fn analyze_space_nav(params: Value) -> Result<Value, String> {
    let params: SpaceNavParams =
        serde_json::from_value(params).map_err(|err| format!("invalid params: {err}"))?;
    let items = compute_space_nav_items(&params.text);
    Ok(json!({ "items": items }))
}

// ---- UTF-16 码元面扫描工具 --------------------------------------------------

/// TS `\s`:空格/制表/换行/CR/换页/垂直制表 + 常见 Unicode 空白(NBSP 等)。
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

/// TS 正则 `\b` 词元:JS `\w` = [A-Za-z0-9_](ASCII)。
fn is_word(code: u16) -> bool {
    code == b'_' as u16 || matches!(code, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A)
}

fn is_ascii_letter(code: u16) -> bool {
    matches!(code, 0x41..=0x5A | 0x61..=0x7A)
}

/// 全文 0 起行起始偏移表(每 '\n' 后一位置;UTF-16 码元)。
fn line_starts(text: &[u16]) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, &code) in text.iter().enumerate() {
        if code == b'\n' as u16 {
            starts.push(i + 1);
        }
    }
    starts
}

/// 偏移 → 0 起行号(双指针/二分,TS offsetToLine 同值)。
fn offset_to_line(starts: &[usize], offset: usize) -> usize {
    let mut lo = 0usize;
    let mut hi = starts.len() - 1;
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if starts[mid] <= offset {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

fn offset_to_col(starts: &[usize], offset: usize) -> usize {
    offset - starts[offset_to_line(starts, offset)]
}

/// TS spaceNavDiagnostics.codeMask:true=代码区(非注释/字符串)。
/// 逐字符状态机:行注释 #、单/双引号字符串(含三引号)。与 TS 同语义,
/// 返回 bool 数组(UTF-16 码元长)。
fn code_mask(text: &[u16]) -> Vec<bool> {
    let mut mask = vec![true; text.len()];
    let mut i = 0usize;
    let n = text.len();
    while i < n {
        let ch = text[i];
        if ch == b'#' as u16 {
            while i < n && text[i] != b'\n' as u16 {
                mask[i] = false;
                i += 1;
            }
            continue;
        }
        if ch == b'"' as u16 || ch == b'\'' as u16 {
            let q = ch;
            let triple = i + 2 < n && text[i + 1] == q && text[i + 2] == q;
            mask[i] = false;
            i += 1;
            if triple {
                mask[i] = false;
                i += 1;
                mask[i] = false;
                i += 1;
            }
            while i < n {
                mask[i] = false;
                if text[i] == b'\\' as u16 {
                    i += 1;
                    if i < n {
                        mask[i] = false;
                        i += 1;
                    }
                    continue;
                }
                if triple {
                    if i + 2 < n && text[i] == q && text[i + 1] == q && text[i + 2] == q {
                        mask[i] = false;
                        mask[i + 1] = false;
                        mask[i + 2] = false;
                        i += 3;
                        break;
                    }
                } else if text[i] == q {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    mask
}

// ---- 1) 保留键 "_mapping" ---------------------------------------------------
/// 匹配 `\b(?:setSpaceData|delSpaceData)\s*\(\s*[^,)]+,\s*("|')_mapping\1`
/// 返回:命中起点(UTF-16 码元)与键 token 起点、键 token 长度(含引号)。
fn match_mapping_key(text: &[u16], at: usize) -> Option<(usize, usize, usize)> {
    // \b 左界:前码元非词元或文首;后随 setSpaceData|delSpaceData
    let kw = at + 4 < text.len()
        && is_ascii_letter(text[at])
        && text[at..].starts_with(&[
            b's' as u16, b'e' as u16, b't' as u16, b'S' as u16, b'p' as u16, b'a' as u16,
            b'c' as u16, b'e' as u16, b'D' as u16, b'a' as u16, b't' as u16, b'a' as u16,
        ]);
    let kw_del = at + 4 < text.len()
        && is_ascii_letter(text[at])
        && text[at..].starts_with(&[
            b'd' as u16, b'e' as u16, b'l' as u16, b'S' as u16, b'p' as u16, b'a' as u16,
            b'c' as u16, b'e' as u16, b'D' as u16, b'a' as u16, b't' as u16, b'a' as u16,
        ]);
    if at > 0 && is_word(text[at - 1]) {
        return None;
    }
    if !(kw || kw_del) {
        return None;
    }
    let mut i = at + 12; // setSpaceData/delSpaceData 均 12 字符
    // \s*(
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if i >= text.len() || text[i] != b'(' as u16 {
        return None;
    }
    i += 1;
    // \s*
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    // [^,)]+
    let arg_start = i;
    while i < text.len() && text[i] != b',' as u16 && text[i] != b')' as u16 {
        i += 1;
    }
    if i == arg_start {
        return None;
    }
    // ,\s*
    if i >= text.len() || text[i] != b',' as u16 {
        return None;
    }
    i += 1;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    // ("|')_mapping\1
    if i >= text.len() || (text[i] != b'"' as u16 && text[i] != b'\'' as u16) {
        return None;
    }
    let q = text[i];
    let key_start = i;
    let body_start = i + 1;
    if body_start + "_mapping".len() > text.len() {
        return None;
    }
    if !text[body_start..].starts_with(b"_mapping".iter().map(|&b| b as u16).collect::<Vec<u16>>().as_slice())
    {
        return None;
    }
    let after = body_start + "_mapping".len();
    if after >= text.len() || text[after] != q {
        return None;
    }
    // 键 token 长度 = "_mapping" + 两引号
    Some((at, key_start, "_mapping".len() + 2))
}

// ---- 2) navigate 无 canNavigate ---------------------------------------------
/// `\bself\s*\.\s*(navigate|navigatePathPoints)\s*\(`
/// 返回:(调用命中起点, 方法名起点, 方法名长度)
fn match_nav_call(text: &[u16], at: usize) -> Option<(usize, usize, usize)> {
    // \bself
    if at > 0 && is_word(text[at - 1]) {
        return None;
    }
    if at + 4 > text.len() || !text[at..].starts_with(b"self".iter().map(|&b| b as u16).collect::<Vec<u16>>().as_slice()) {
        return None;
    }
    let mut i = at + 4;
    // \s*\.
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if i >= text.len() || text[i] != b'.' as u16 {
        return None;
    }
    i += 1;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    // (navigate|navigatePathPoints)
    let method_start = i;
    let nav = text[i..].starts_with(b"navigate".iter().map(|&b| b as u16).collect::<Vec<u16>>().as_slice())
        && (i + 8 >= text.len() || !is_word(text[i + 8]));
    let nav_pp = text[i..].starts_with(b"navigatePathPoints".iter().map(|&b| b as u16).collect::<Vec<u16>>().as_slice())
        && (i + 18 >= text.len() || !is_word(text[i + 18]));
    let method_len = if nav {
        8
    } else if nav_pp {
        18
    } else {
        return None;
    };
    i += method_len;
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if i >= text.len() || text[i] != b'(' as u16 {
        return None;
    }
    Some((at, method_start, method_len))
}

/// `\bcanNavigate\b` 命中(起点码元)。
fn match_can_navigate(text: &[u16], at: usize) -> bool {
    if at > 0 && is_word(text[at - 1]) {
        return false;
    }
    if at + 11 > text.len()
        || !text[at..].starts_with(b"canNavigate".iter().map(|&b| b as u16).collect::<Vec<u16>>().as_slice())
    {
        return false;
    }
    if at + 11 < text.len() && is_word(text[at + 11]) {
        return false;
    }
    true
}

// ---- 3) params dict 引号键 ---------------------------------------------------
/// `\baddSpaceGeometryMapping\s*\(` 命中:返回调用开括号起点。
fn match_mapping_call(text: &[u16], at: usize) -> Option<usize> {
    if at > 0 && is_word(text[at - 1]) {
        return None;
    }
    let kw = b"addSpaceGeometryMapping".iter().map(|&b| b as u16).collect::<Vec<u16>>();
    if at + kw.len() > text.len() || !text[at..].starts_with(&kw) {
        return None;
    }
    let mut i = at + kw.len();
    while i < text.len() && is_js_space(text[i]) {
        i += 1;
    }
    if i >= text.len() || text[i] != b'(' as u16 {
        return None;
    }
    Some(i)
}

/// addSpaceGeometryMapping 调用 params dict 区间([dictOpen, dictClose],含括号)。
/// 从调用开括号起括号深度扫描,跳过字符串;depth==1 的 `{` 即 params dict。
fn find_params_dict_span(text: &[u16], call_open: usize) -> Option<(usize, usize)> {
    let mut depth = 0i32;
    let mut in_string: Option<u16> = None;
    let mut dict_open: i64 = -1;
    let mut i = call_open;
    while i < text.len() {
        let ch = text[i];
        if let Some(q) = in_string {
            if ch == b'\\' as u16 {
                i += 1;
            } else if ch == q {
                in_string = None;
            }
            i += 1;
            continue;
        }
        if ch == b'"' as u16 || ch == b'\'' as u16 {
            in_string = Some(ch);
            i += 1;
            continue;
        }
        if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
            if ch == b'{' as u16 && depth == 1 && dict_open < 0 {
                dict_open = i as i64;
            }
            depth += 1;
            i += 1;
            continue;
        }
        if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
            depth -= 1;
            if depth == 0 {
                return None;
            }
            if ch == b'}' as u16 && dict_open >= 0 && depth == 1 {
                return Some((dict_open as usize, i));
            }
        }
        i += 1;
    }
    None
}

/// dict 体内**顶层**引号键(嵌套 dict/list 不收):返回 [(体偏移, 键 token UTF-16)]。
/// 逐字符扫描:字符串整体跳过(含转义),闭引号后跳空白紧跟 `:` 且深度 0 才算键位。
fn top_level_quoted_keys(body: &[u16]) -> Vec<(usize, Vec<u16>)> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut i = 0usize;
    let n = body.len();
    while i < n {
        let ch = body[i];
        if ch == b'"' as u16 || ch == b'\'' as u16 {
            let q = ch;
            let mut j = i + 1;
            while j < n {
                if body[j] == b'\\' as u16 {
                    j += 2;
                    continue;
                }
                if body[j] == q {
                    break;
                }
                j += 1;
            }
            if j >= n {
                return out; // 未闭合:保守收手
            }
            let token = body[i..=j].to_vec();
            let mut k = j + 1;
            while k < n && is_js_space(body[k]) {
                k += 1;
            }
            if depth == 0 && k < n && body[k] == b':' as u16 {
                out.push((i, token));
            }
            i = j + 1;
            continue;
        }
        if ch == b'{' as u16 || ch == b'[' as u16 {
            depth += 1;
        } else if ch == b'}' as u16 || ch == b']' as u16 {
            depth -= 1;
        }
        i += 1;
    }
    out
}

// ---- 全量判定 -----------------------------------------------------------------
fn compute_space_nav_items(text: &str) -> Vec<SpaceNavItem> {
    if text.is_empty() {
        return Vec::new();
    }
    let text: Vec<u16> = text.encode_utf16().collect();
    let starts = line_starts(&text);
    let mask = code_mask(&text);
    let in_code = |offset: usize| offset < mask.len() && mask[offset];
    let mut items = Vec::new();

    // 1) _mapping 保留键
    let mut i = 0usize;
    while i < text.len() {
        if let Some((_, key_start, key_len)) = match_mapping_key(&text, i) {
            if in_code(i) {
                let line = offset_to_line(&starts, key_start);
                let col = offset_to_col(&starts, key_start);
                items.push(SpaceNavItem {
                    code: CODE_SPACE_NAV,
                    line,
                    character: col,
                    length: key_len,
                    kind: "mappingKey",
                    key: None,
                });
                i = key_start + key_len;
                continue;
            }
        }
        i += 1;
    }

    // 2) navigate 无 canNavigate
    let mut has_can_navigate = false;
    let mut i = 0usize;
    while i < text.len() {
        if match_can_navigate(&text, i) && in_code(i) {
            has_can_navigate = true;
            break;
        }
        i += 1;
    }
    if !has_can_navigate {
        let mut i = 0usize;
        while i < text.len() {
            if let Some((_, method_start, method_len)) = match_nav_call(&text, i) {
                if in_code(i) {
                    let line = offset_to_line(&starts, method_start);
                    let col = offset_to_col(&starts, method_start);
                    items.push(SpaceNavItem {
                        code: CODE_SPACE_NAV,
                        line,
                        character: col,
                        length: method_len,
                        kind: "navigateNoGuard",
                        key: None,
                    });
                    i = method_start + method_len;
                    continue;
                }
            }
            i += 1;
        }
    }

    // 3) params dict 引号键
    let mut i = 0usize;
    while i < text.len() {
        if let Some(call_open) = match_mapping_call(&text, i) {
            if in_code(i) {
                if let Some((dict_open, dict_close)) = find_params_dict_span(&text, call_open) {
                    let dict_body = &text[dict_open + 1..dict_close];
                    for (body_offset, token) in top_level_quoted_keys(dict_body) {
                        let key_offset = dict_open + 1 + body_offset;
                        let line = offset_to_line(&starts, key_offset);
                        let col = offset_to_col(&starts, key_offset);
                        items.push(SpaceNavItem {
                            code: CODE_SPACE_NAV,
                            line,
                            character: col,
                            length: token.len(),
                            kind: "paramsStringKey",
                            key: Some(String::from_utf16(&token).unwrap_or_default()),
                        });
                    }
                    i = dict_close + 1;
                    continue;
                }
            }
        }
        i += 1;
    }

    // TS 排序:line asc,start asc
    items.sort_by(|a, b| a.line.cmp(&b.line).then(a.character.cmp(&b.character)));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> Vec<SpaceNavItem> {
        compute_space_nav_items(text)
    }

    #[test]
    fn reports_mapping_reserved_key() {
        let found = run("self.setSpaceData(\"foo\", \"_mapping\")\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "mappingKey");
        assert_eq!(found[0].line, 0);
        assert_eq!(found[0].length, 10); // "_mapping"(8) + 2 quotes
    }

    #[test]
    fn navigate_without_guard_reports_and_with_guard_does_not() {
        let found = run("def f(self):\n    self.navigate(1)\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "navigateNoGuard");
        let guarded = run("def f(self):\n    if self.canNavigate():\n        self.navigate(1)\n");
        assert!(guarded.is_empty());
    }

    #[test]
    fn params_string_key_reports() {
        let found = run("self.addSpaceGeometryMapping(0, 1, 2, 3, {\"0\": \"x.navmesh\"})\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "paramsStringKey");
        assert_eq!(found[0].key.as_deref(), Some("\"0\""));
    }

    #[test]
    fn comments_and_strings_do_not_trigger() {
        let found = run("# self.setSpaceData(\"a\", \"_mapping\")\n' self.navigate(1) '\n");
        assert!(found.is_empty());
    }

    #[test]
    fn nested_dict_string_key_is_ignored() {
        // 顶层键 0 是 int;嵌套 {\"a\": 1} 的字符串键不收
        let found = run("self.addSpaceGeometryMapping(0, 1, 2, 3, {0: {\"a\": 1}})\n");
        assert!(found.is_empty());
    }
}
