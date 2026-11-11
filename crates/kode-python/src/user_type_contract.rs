//! user_type 三契约方法探测与缺方法收集核(RUST-MIGRATION-AUDIT-006 B1 车道
//! 批 4):src/backend/userTypeContract.ts 纯逻辑半边逐字移植——
//! - `impl_file_has_contract_method`(:77-80):`^[ \t]*def[ \t]+METHOD[ \t]*\(`
//!   m 模式测试。JS m 模式 `^` = 串首 + 每个 JS 行终止符(\n/\r/U+2028/U+2029)
//!   之后;贪 `[ \t]*` 后接字面量 `def`/方法名/`(` 无需回溯(d 与 ( 均非
//!   [ \t],贪匹配后单点判定即精确);方法名取自固定三方法,TS 侧 escapeRegExp
//!   对其恒等,按字面量扫描。注意:探测是**原始行正则,无词法掩码**——三引号
//!   体内的形似 def 行与 TS 同判命中(TS 本尊即如此,保真不修饰)。
//! - `contract_symbol_name`(:83-87):implementedBy?.trim().split('.') 末段,
//!   空/缺省回退类型名(trim 集=JS \s 全类,复用 self_flow::is_js_space)。
//! - `collect_user_type_contract_missing`(:95-122):impl 文件缺省/空串静默
//!   (「未找到 python 文件」诊断兜底,不重复报);每缺失方法一条,消息文案
//!   字节级保真(半角括号/半角逗号/`——`,以 TS 编译产物 JSON.stringify 对
//!   基准),related 标签 `实现文件 <basename>`(\ 与 / 双分隔符取尾段)。
//!
//! symbolLength=TS `.length` 语义=**UTF-16 码元数**(代理对计 2),非字节数。
//! 收集核不探测:方法存在性由调用面从源码探测后传入(与 TS 快照流同形)。

use crate::self_flow::{is_js_line_terminator, is_js_space};

/// 三个契约方法,引擎 setImplModule 逐个 GetAttrString 取(顺序即声明序)。
pub const USER_TYPE_CONTRACT_METHODS: [&str; 3] =
    ["createObjFromDict", "getDictFromObj", "isSameType"];

/// 口径③:每个契约方法缺失的后果方向文案(与 TS USER_TYPE_CONTRACT_CONSEQUENCE
/// 字节级一致;未知方法返回空串——调用面固定三方法,不会触达)。
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

/// 在一个 m 模式行起点上做单次尝试(贪 [ \t]* 后字面量,无需回溯,见模块注)。
fn probe_line_start(source: &[u16], start: usize, method: &[u16]) -> bool {
    let mut i = start;
    while i < source.len() && is_probe_space(source[i]) {
        i += 1;
    }
    // `def`
    if i + 3 > source.len()
        || source[i] != 0x64
        || source[i + 1] != 0x65
        || source[i + 2] != 0x66
    {
        return false;
    }
    i += 3;
    // `[ \t]+`(至少一个)
    let ws_start = i;
    while i < source.len() && is_probe_space(source[i]) {
        i += 1;
    }
    if i == ws_start {
        return false;
    }
    // 方法名字面量
    if i + method.len() > source.len() || source[i..i + method.len()] != *method {
        return false;
    }
    i += method.len();
    // `[ \t]*` 后 `(`(贪后单点判定)
    while i < source.len() && is_probe_space(source[i]) {
        i += 1;
    }
    i < source.len() && source[i] == 0x28
}

/// 在 impl 文件原文里查一个契约方法是否定义(file 级扫描;类方法/实例赋值
/// 形态皆覆盖——引擎经模块属性拿对象后取方法,定义在实现模块内即可见)。
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

/// 符号名 = implementedBy 后段(引擎 GetAttrString 取后段);缺省回退类型名。
pub fn contract_symbol_name(name: &str, implemented_by: Option<&str>) -> String {
    let last = implemented_by.map(|raw| {
        js_trim(raw)
            .split('.')
            .next_back()
            .unwrap_or("")
    });
    match last {
        Some(segment) if !segment.is_empty() => segment.to_string(),
        _ => name.to_string(),
    }
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

fn basename_of(path: &str) -> &str {
    // TS: implFile.split(/[\\/]/).pop() ?? implFile(split 恒有 ≥1 段,尾段即)
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// 缺方法记录(定位与文案齐备;line 由 by_impl_file 调用面贴——TS
/// collectUserTypeContractMissingByImplFile 的过滤+`implLine ?? 1` 贴行在
/// kode-server 面,恒等路径比较)。
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

/// 收集单个 user_type 的缺方法记录(纯函数;方法存在性快照由调用面探测后
/// 传入,顺序=USER_TYPE_CONTRACT_METHODS)。impl 文件缺失/空串静默——由
/// 「user_type 未找到 python 文件」诊断兜底,不重复报。
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
        // TS: status.implementedBy ?? symbolName(nullish——空串实现声明保留空串)
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

// ---- 单测 -----------------------------------------------------------------

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
        assert!(!probe("def getDictFromObjOnly(self):\n    pass\n", "getDictFromObj"));
        assert!(!probe("def isSameTypeOnly(self):\n    pass\n", "isSameType"));
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
        // 孤立 \r / \u2028 / \u2029 都是 JS m 模式 ^ 行起点
        assert!(probe("x = 1\rdef isSameType(self):\r    pass", "isSameType"));
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
        // 探测不做词法掩码:三引号体内的形似 def 行与 TS 同判命中(保真)
        let source = "doc = \"\"\"\ndef isSameType(self):\n\"\"\"\n";
        assert!(probe(source, "isSameType"));
        // 引号内同行前缀形(`s = "def …"`)行首不是 def,不命中
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
        let items = status_with("TalentTree", Some("talent.TalentTreeImpl"), Some("/w/impl.py"), [false; 3]);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].method, "createObjFromDict");
        assert_eq!(items[1].method, "getDictFromObj");
        assert_eq!(items[2].method, "isSameType");
        assert!(items[0].message.contains("无法从网络/DB 构造该类型(反序列化入口缺失)"));
        assert!(items[1].message.contains("无法写网络/持久化该类型(序列化出口缺失)"));
        assert!(items[2].message.contains("类型判定失效(createObjFromDict 结果无法通过校验)"));
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
        let items = status_with("T", Some("pkg.Impl"), Some("/w/impl.py"), [true, false, true]);
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
        // implementedBy 空串:?? 语义保留空串(不换 symbolName)
        let items = status_with("T", Some(""), Some("/w/i.py"), [false; 3]);
        assert!(items[0].message.contains("的实现  缺契约方法"));
        // implementedBy 缺省:回退 symbolName=类型名
        let items = status_with("T", None, Some("/w/i.py"), [false; 3]);
        assert!(items[0].message.contains("的实现 T 缺契约方法"));
    }

    #[test]
    fn collect_symbol_length_counts_utf16_units() {
        // 代理对计 2:TS `.length` 语义
        let items = status_with("T\u{1D400}x", Some("m.T\u{1D400}x"), Some("/w/i.py"), [false; 3]);
        assert_eq!(items[0].symbol_name, "T\u{1D400}x");
        assert_eq!(items[0].symbol_length, 4);
    }

    #[test]
    fn collect_basename_handles_windows_separators() {
        let items = status_with("T", Some("pkg.Impl"), Some(r"C:\w\scripts\impl.py"), [false; 3]);
        assert_eq!(items[0].related_label, "实现文件 impl.py");
        let items = status_with("T", Some("pkg.Impl"), Some("no-sep"), [false; 3]);
        assert_eq!(items[0].related_label, "实现文件 no-sep");
    }
}
