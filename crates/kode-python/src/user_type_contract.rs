//! user_type three-contract-method probing and the missing-method collection core (the
//! RUST-MIGRATION-AUDIT-006 B1 lane, batch 4): a line-for-line port of the pure-logic half of
//! src/backend/userTypeContract.ts --
//! - `impl_file_has_contract_method` (:77-80): an m-mode test of
//!   `^[ \t]*def[ \t]+METHOD[ \t]*\(`. In JS m mode `^` = the string start + the position after
//!   every JS line terminator (\n/\r/U+2028/U+2029); a greedy `[ \t]*` followed by the literals
//!   `def` / method name / `(` needs no backtracking (neither d nor ( is in [ \t], so a
//!   single-point check after the greedy match is exact); the method names come from the fixed
//!   three methods, and TS's escapeRegExp is the identity on them, so they are scanned as
//!   literals. Note: the probe is a **raw line regex with no lexical mask** -- a def-looking line
//!   inside triple quotes hits exactly as it does in TS (the TS original behaves this way, so it is
//!   preserved faithfully, not polished).
//! - `contract_symbol_name` (:83-87): the last segment of implementedBy?.trim().split('.'),
//!   falling back to the type name when empty / absent (the trim set = the whole JS \s class,
//!   reusing self_flow::is_js_space).
//! - `collect_user_type_contract_missing` (:95-122): a missing / empty impl file is silent (the
//!   "python file not found" diagnosis is the fallback, so it is not reported twice); one item per
//!   missing method, with the message wording kept byte-faithful (half-width parentheses /
//!   half-width comma / `——`, benchmarked against the TS build output's JSON.stringify), and the
//!   related label `实现文件 <basename>` (taking the last segment over both \ and / separators).
//!
//! symbolLength = TS `.length` semantics = **UTF-16 code units** (a surrogate pair counts 2), not
//! bytes. The collection core does no probing: method existence is probed by the calling face from
//! the source and passed in (same shape as the TS snapshot flow).

use crate::self_flow::{is_js_line_terminator, is_js_space};

/// The three contract methods, which the engine's setImplModule fetches one by one via GetAttrString
/// (the order is the declaration order).
pub const USER_TYPE_CONTRACT_METHODS: [&str; 3] =
    ["createObjFromDict", "getDictFromObj", "isSameType"];

/// Semantics 3: the wording of the consequence direction for each missing contract method (byte
/// identical to TS USER_TYPE_CONTRACT_CONSEQUENCE; an unknown method returns an empty string -- the
/// calling face uses the fixed three methods, so it is never reached).
pub fn contract_consequence(method: &str) -> &'static str {
    match method {
        "createObjFromDict" => "无法从网络/DB 构造该类型(反序列化入口缺失)",
        "getDictFromObj" => "无法写网络/持久化该类型(序列化出口缺失)",
        "isSameType" => "类型判定失效(createObjFromDict 结果无法通过校验)",
        _ => "",
    }
}

fn is_probe_space(code: u16) -> bool {
    code == 0x20 || code == 0x09
}

/// Make a single attempt at an m-mode line start (greedy [ \t]* then literals, no backtracking
/// needed; see the module note).
fn probe_line_start(source: &[u16], start: usize, method: &[u16]) -> bool {
    let mut i = start;
    while i < source.len() && is_probe_space(source[i]) {
        i += 1;
    }
    // `def`
    if i + 3 > source.len() || source[i] != 0x64 || source[i + 1] != 0x65 || source[i + 2] != 0x66 {
        return false;
    }
    i += 3;
    // `[ \t]+` (at least one)
    let ws_start = i;
    while i < source.len() && is_probe_space(source[i]) {
        i += 1;
    }
    if i == ws_start {
        return false;
    }
    // The method name literal
    if i + method.len() > source.len() || source[i..i + method.len()] != *method {
        return false;
    }
    i += method.len();
    // `(` after `[ \t]*` (single-point check after the greedy match)
    while i < source.len() && is_probe_space(source[i]) {
        i += 1;
    }
    i < source.len() && source[i] == 0x28
}

/// Look up whether a contract method is defined in the impl file's raw source (a file-level scan;
/// both class-method and instance-assignment shapes are covered -- the engine fetches the object
/// through a module attribute and then the method, so defining it anywhere inside the impl
/// module is visible).
pub fn impl_file_has_contract_method(source: &[u16], method: &str) -> bool {
    let method_units: Vec<u16> = method.encode_utf16().collect();
    let mut start = 0usize;
    loop {
        if probe_line_start(source, start, &method_units) {
            return true;
        }
        while start < source.len() && !is_js_line_terminator(source[start]) {
            start += 1;
        }
        if start >= source.len() {
            return false;
        }
        start += 1;
    }
}

fn is_js_trim_char(c: char) -> bool {
    let code = c as u32;
    code <= 0xFFFF && is_js_space(code as u16)
}

fn js_trim(raw: &str) -> &str {
    raw.trim_matches(is_js_trim_char)
}

/// Symbol name = the trailing segment of implementedBy (the engine's GetAttrString takes the
/// trailing segment); falls back to the type name when absent.
pub fn contract_symbol_name(name: &str, implemented_by: Option<&str>) -> String {
    let last = implemented_by.map(|raw| js_trim(raw).split('.').next_back().unwrap_or(""));
    match last {
        Some(segment) if !segment.is_empty() => segment.to_string(),
        _ => name.to_string(),
    }
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

fn basename_of(path: &str) -> &str {
    // TS: implFile.split(/[\\/]/).pop() ?? implFile (split always yields >= 1 segment, so the last one is it)
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// A missing-method record (with the location and wording both present; the line is attached by
/// the by_impl_file calling face -- TS collectUserTypeContractMissingByImplFile's filtering plus
/// the `implLine ?? 1` line attachment live on the kode-server face, so the path comparison is the
/// same).
#[derive(Debug)]
pub struct UserTypeContractMissingItem {
    pub message: String,
    pub method: &'static str,
    pub type_name: String,
    pub symbol_name: String,
    pub symbol_length: usize,
    pub related_target_file: String,
    pub related_label: String,
}

/// Collect the missing-method records of one user_type (pure function; the method-existence
/// snapshot is probed by the calling face and passed in, ordered as USER_TYPE_CONTRACT_METHODS).
/// A missing / empty impl file is silent -- covered by the "user_type python file not found"
/// diagnosis fallback, so it is not reported twice.
pub fn collect_user_type_contract_missing(
    name: &str,
    implemented_by: Option<&str>,
    impl_file: Option<&str>,
    methods: &[bool; 3],
) -> Vec<UserTypeContractMissingItem> {
    let Some(file) = impl_file.filter(|f| !f.is_empty()) else {
        return Vec::new();
    };
    let symbol_name = contract_symbol_name(name, implemented_by);
    let mut items = Vec::new();
    for (idx, method) in USER_TYPE_CONTRACT_METHODS.iter().enumerate() {
        if methods[idx] {
            continue;
        }
        // TS: status.implementedBy ?? symbolName (nullish -- an empty-string implementation declaration keeps the empty string)
        let impl_label = implemented_by
            .map(str::to_string)
            .unwrap_or_else(|| symbol_name.clone());
        items.push(UserTypeContractMissingItem {
            message: format!(
                "user_type {} 的实现 {} 缺契约方法 {}():{}——引擎 setImplModule 取不到该方法,装载实现模块必失败",
                name,
                impl_label,
                method,
                contract_consequence(method)
            ),
            method,
            type_name: name.to_string(),
            symbol_name: symbol_name.clone(),
            symbol_length: utf16_len(&symbol_name),
            related_target_file: file.to_string(),
            related_label: format!("实现文件 {}", basename_of(file)),
        });
    }
    items
}

// ---- unit tests -----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(source: &str, method: &str) -> bool {
        impl_file_has_contract_method(&source.encode_utf16().collect::<Vec<_>>(), method)
    }

    #[test]
    fn probe_matches_indented_and_plain_defs() {
        let source = [
            "class TalentTreeImpl:",
            "    def createObjFromDict(self, dictData):",
            "        return dictData",
            "\tdef getDictFromObj(self, obj):",
            "        return {}",
            "def isSameType(self, obj):",
            "    return True",
        ]
        .join("\n");
        for method in USER_TYPE_CONTRACT_METHODS {
            assert!(probe(&source, method), "expect {method} present");
        }
    }

    #[test]
    fn probe_rejects_non_def_and_malformed_heads() {
        assert!(!probe("deffoo(self):\n    pass\n", "isSameType"));
        assert!(!probe("def isSameType x(self):\n    pass\n", "isSameType"));
        assert!(!probe("x def isSameType(self):\n    pass\n", "isSameType"));
        assert!(!probe(
            "def getDictFromObjOnly(self):\n    pass\n",
            "getDictFromObj"
        ));
        assert!(!probe(
            "def isSameTypeOnly(self):\n    pass\n",
            "isSameType"
        ));
    }

    #[test]
    fn probe_requires_open_paren_after_ws() {
        assert!(probe("def isSameType(self):\n    pass\n", "isSameType"));
        assert!(probe("def isSameType (self):\n    pass\n", "isSameType"));
        assert!(probe("def isSameType(\n", "isSameType"));
        assert!(!probe("def isSameType self):\n    pass\n", "isSameType"));
    }

    #[test]
    fn probe_line_starts_cover_cr_lf_and_unicode_separators() {
        // A lone \r / \u2028 / \u2029 is also a JS m-mode ^ line start
        assert!(probe(
            "x = 1\rdef isSameType(self):\r    pass",
            "isSameType"
        ));
        assert!(probe(
            "x = 1\u{2028}def isSameType(self):\u{2028}    pass",
            "isSameType"
        ));
        assert!(probe(
            "x = 1\u{2029}def isSameType(self):\u{2029}    pass",
            "isSameType"
        ));
        assert!(probe("def isSameType(self):", "isSameType"));
        assert!(!probe("x = 1def isSameType(self):", "isSameType"));
    }

    #[test]
    fn probe_is_raw_line_regex_no_lexical_mask() {
        // The probe applies no lexical mask: a def-looking line inside triple quotes hits just as it does
        // in TS (kept faithful)
        let source = "doc = \"\"\"\ndef isSameType(self):\n\"\"\"\n";
        assert!(probe(source, "isSameType"));
        // A same-line prefix form inside quotes (`s = "def …"`): the line start is not def, so no hit
        assert!(!probe("s = \"def isSameType(self):\"\n", "isSameType"));
    }

    #[test]
    fn symbol_name_last_segment_with_trim_and_fallback() {
        assert_eq!(contract_symbol_name("T", Some("pkg.Impl")), "Impl");
        assert_eq!(contract_symbol_name("T", Some("  a.B  ")), "B");
        assert_eq!(contract_symbol_name("T", Some("a.")), "T");
        assert_eq!(contract_symbol_name("T", Some("")), "T");
        assert_eq!(contract_symbol_name("T", None), "T");
        assert_eq!(contract_symbol_name("T", Some(".")), "T");
    }

    fn status_with(
        name: &str,
        implemented_by: Option<&str>,
        impl_file: Option<&str>,
        methods: [bool; 3],
    ) -> Vec<UserTypeContractMissingItem> {
        collect_user_type_contract_missing(name, implemented_by, impl_file, &methods)
    }

    #[test]
    fn collect_all_missing_three_items_in_declaration_order() {
        let items = status_with(
            "TalentTree",
            Some("talent.TalentTreeImpl"),
            Some("/w/impl.py"),
            [false; 3],
        );
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].method, "createObjFromDict");
        assert_eq!(items[1].method, "getDictFromObj");
        assert_eq!(items[2].method, "isSameType");
        assert!(items[0]
            .message
            .contains("无法从网络/DB 构造该类型(反序列化入口缺失)"));
        assert!(items[1]
            .message
            .contains("无法写网络/持久化该类型(序列化出口缺失)"));
        assert!(items[2]
            .message
            .contains("类型判定失效(createObjFromDict 结果无法通过校验)"));
        assert!(items[0]
            .message
            .contains("——引擎 setImplModule 取不到该方法,装载实现模块必失败"));
        assert_eq!(items[0].symbol_name, "TalentTreeImpl");
        assert_eq!(items[0].symbol_length, "TalentTreeImpl".len());
        assert_eq!(items[0].type_name, "TalentTree");
        assert_eq!(items[0].related_target_file, "/w/impl.py");
        assert_eq!(items[0].related_label, "实现文件 impl.py");
    }

    #[test]
    fn collect_partial_missing_only() {
        let items = status_with(
            "T",
            Some("pkg.Impl"),
            Some("/w/impl.py"),
            [true, false, true],
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].method, "getDictFromObj");
    }

    #[test]
    fn collect_silent_on_missing_or_empty_impl_file() {
        assert!(status_with("T", Some("pkg.Impl"), None, [false; 3]).is_empty());
        assert!(status_with("T", Some("pkg.Impl"), Some(""), [false; 3]).is_empty());
    }

    #[test]
    fn collect_message_uses_implemented_by_nullish_semantics() {
        // implementedBy as an empty string: the ?? semantics keep the empty string (no swap to symbolName)
        let items = status_with("T", Some(""), Some("/w/i.py"), [false; 3]);
        assert!(items[0].message.contains("的实现  缺契约方法"));
        // implementedBy absent: fall back to symbolName = the type name
        let items = status_with("T", None, Some("/w/i.py"), [false; 3]);
        assert!(items[0].message.contains("的实现 T 缺契约方法"));
    }

    #[test]
    fn collect_symbol_length_counts_utf16_units() {
        // A surrogate pair counts 2: TS `.length` semantics
        let items = status_with(
            "T\u{1D400}x",
            Some("m.T\u{1D400}x"),
            Some("/w/i.py"),
            [false; 3],
        );
        assert_eq!(items[0].symbol_name, "T\u{1D400}x");
        assert_eq!(items[0].symbol_length, 4);
    }

    #[test]
    fn collect_basename_handles_windows_separators() {
        let items = status_with(
            "T",
            Some("pkg.Impl"),
            Some(r"C:\w\scripts\impl.py"),
            [false; 3],
        );
        assert_eq!(items[0].related_label, "实现文件 impl.py");
        let items = status_with("T", Some("pkg.Impl"), Some("no-sep"), [false; 3]);
        assert_eq!(items[0].related_label, "实现文件 no-sep");
    }

    #[test]
    fn unknown_method_consequence_is_empty() {
        // An unknown method yields the empty string (the calling face uses the fixed three methods; this
        // public direct call pins down the `_` arm's semantics)
        assert_eq!(contract_consequence("notInContract"), "");
    }
}
