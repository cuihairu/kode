//! def 树取源(TS DefTreeSource 对应物)。

use std::collections::HashMap;

use kode_parser::diag::DiagCode;
use kode_parser::xml::{parse as parse_xml, Document};

use crate::message_table::views::{parse_def_view_with, DefView};

// ---------------------------------------------------------------------------
// def 树取源(TS DefTreeSource 对应物)
// ---------------------------------------------------------------------------

/// 取源:实体自身 defText + 其余 def 按名;路径按名(装配序 sources 用)。
pub(super) struct Source<'a> {
    pub(super) entity_name: &'a str,
    pub(super) def_text: &'a str,
    pub(super) defs: &'a HashMap<String, String>,
    pub(super) paths: &'a HashMap<String, String>,
}

impl Source<'_> {
    /// TS loadDef:按名取文本解析;结构错误(未闭合/闭合不匹配/游离闭合/非法
    /// 标签)按 TS parseLocalDefinition 抛错 → null 处理。其余容错解析继续。
    pub(super) fn load(&self, name: &str) -> Option<DefView> {
        let text = if name == self.entity_name {
            self.def_text
        } else {
            self.defs.get(name)?
        };
        let doc = parse_xml(text, true);
        if is_structural_error(&doc) {
            return None;
        }
        Some(parse_def_view_with(&doc, text))
    }

    /// 组件 def 装载:仅查 defs 原文表(不特判 entity_name;组件类型与实体同名
    /// 属名称冲突边角,按 defs 表缺失处理→回落)。
    pub(super) fn load_component(&self, name: &str) -> Option<DefView> {
        let text = self.defs.get(name)?;
        let doc = parse_xml(text, true);
        if is_structural_error(&doc) {
            return None;
        }
        Some(parse_def_view_with(&doc, text))
    }

    pub(super) fn path_of(&self, name: &str) -> &str {
        self.paths.get(name).map(String::as_str).unwrap_or("")
    }
}

/// 结构错误判定(与 client_sdk::is_structural_error 同口径):TS fxp 对
/// 未闭合/闭合不匹配/游离闭合/非法标签抛错 → loadDef 返回 null。
pub(super) fn is_structural_error(doc: &Document) -> bool {
    doc.diagnostics.iter().any(|diag| {
        matches!(
            diag.code,
            DiagCode::UnclosedElement
                | DiagCode::MismatchedCloseTag
                | DiagCode::StrayCloseTag
                | DiagCode::InvalidTagName
        )
    })
}
