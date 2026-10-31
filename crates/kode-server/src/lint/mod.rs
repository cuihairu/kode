//! def 分析 lint 规则注册表(uv/ruff 口径):把 .def 分析规则收口到 Rust。
//!
//! 命令面 `$/kode/lint/analyzeDef`(经 `$/kode/rpc` 单臂派发):入参
//! `{text, inheritedNames?, knownTypes?}`,出 `{findings:[...]}`。每条 finding
//! 与 TS `analyzeDefDocument` 输出同形(`check`/`severity`/`line`/`offset`/
//! `length`/`name?`/`message`),TS 侧 `ok:true` 直接消费,`ok:false` 回退
//! TS 兜底。`offset`/`length` 为 UTF-16 码元偏移(与 vscode positionAt 同
//! 坐标系),`line` 为 1 基。
//!
//! 规则分两类:
//! - 分析建议(analyzeDefDocument 面):幻影类型/缺 Type/重复 Type/大字段全体
//!   广播/DetailLevel 冗余/Python 关键字/方法-属性同名/引擎受限名/继承链同名;
//! - 结构校验(diagnostics.rs 语料子集面):未知 Type 引用/未知 Flags 值/
//!   未知 DetailLevel/重复定义(旗标作用域 Warning+Info 成对)/属性缺 Flags。
//!
//! 规则注册顺序稳定(registry 为 Vec),输出按规则序分组,不依赖 HashMap 序。

pub mod rules;

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::Value;

use kode_parser::diag::{LineMap, Span};
use kode_parser::xml::Document;

use crate::rpc::RpcRegistry;

// ---------------------------------------------------------------------------
// Finding(与 TS DefAnalysisFinding 同形)
// ---------------------------------------------------------------------------

/// 一个 lint finding 的定位区间(UTF-16 码元,与 offset/length 同坐标系)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct RangeFace {
    pub offset: usize,
    pub length: usize,
}

/// 一条 lint finding(与 TS `analyzeDefDocument` 输出同形;`code` 为
/// `check` 的别名,`range` 为定位区间的自描述面,二者皆与 `check`/`offset`/
/// `length` 冗余,仅供消费方按需取用,不影响 TS 直用)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Finding {
    pub check: &'static str,
    pub code: &'static str,
    pub severity: &'static str,
    /// 1 基行号(报告展示用)。
    pub line: usize,
    /// 0 基 UTF-16 码元偏移(诊断定位用)。
    pub offset: usize,
    pub length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub message: String,
    pub range: RangeFace,
}

// ---------------------------------------------------------------------------
// 继承链同名输入面(TS collectInheritedNames 的 JSON 形)
// ---------------------------------------------------------------------------

/// 祖先闭包面上一个名字的声明聚合(跨祖先并集)。
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct InheritedNameInfo {
    pub property_domains: Vec<String>,
    pub component_domains: Vec<String>,
    pub method_sections: Vec<String>,
    pub property_sources: Vec<String>,
    pub component_sources: Vec<String>,
    pub method_sources: Vec<String>,
}

/// 名字 → 祖先声明聚合(analyzeDefDocument 的可选入参)。
pub type InheritedNames = BTreeMap<String, InheritedNameInfo>;

// ---------------------------------------------------------------------------
// 规则上下文与 trait
// ---------------------------------------------------------------------------

/// 规则执行的只读上下文:文档解析视图 + 原文 + 行映射 + 继承面 + 已知类型。
#[derive(Debug)]
pub struct RuleContext<'a> {
    pub text: &'a str,
    pub doc: &'a Document,
    pub line_map: &'a LineMap,
    pub inherited: &'a InheritedNames,
    /// 已知类型并集(内建 ∪ 调用方提供的语料)。
    pub known_types: &'a BTreeSet<String>,
}

/// 一条 lint 规则:稳定 id + 对上下文产出 findings(规则内部自保序)。
pub trait Rule {
    fn id(&self) -> &'static str;
    fn check(&self, ctx: &RuleContext) -> Vec<Finding>;
}

/// 规则注册表:顺序稳定(Vec),按注册序执行。
pub struct RuleRegistry {
    rules: Vec<Box<dyn Rule>>,
}

impl std::fmt::Debug for RuleRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.rules.iter().map(|r| r.id())).finish()
    }
}

impl RuleRegistry {
    pub fn new() -> Self {
        RuleRegistry { rules: Vec::new() }
    }

    /// 追加一条规则;重复注册同一 id 是编程错误,panic 防静默覆盖。
    pub fn push(&mut self, rule: Box<dyn Rule>) {
        assert!(
            !self.rules.iter().any(|r| r.id() == rule.id()),
            "lint rule {} registered twice",
            rule.id()
        );
        self.rules.push(rule);
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// 按注册序执行全部规则,聚合 findings。
    pub fn run(&self, ctx: &RuleContext) -> Vec<Finding> {
        let mut out = Vec::new();
        for rule in &self.rules {
            out.extend(rule.check(ctx));
        }
        out
    }
}

impl Default for RuleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 全量规则注册表(def 分析建议 + 结构校验,注册序 = 稳定输出序)。
pub fn all_rules() -> RuleRegistry {
    let mut reg = RuleRegistry::new();
    rules::register_all(&mut reg);
    reg
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

/// 注册 `$/kode/lint/analyzeDef` 到通用 RPC 面(ServerState::new() 调用)。
pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeDef", handle_analyze_def);
}

/// `$/kode/lint/analyzeDef` handler:入参 `{text, inheritedNames?, knownTypes?}`
/// 出 `{findings:[...]}`。Err = 输入缺失/内部错误(TS 兜底回退路径)。
fn handle_analyze_def(params: Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing text param".to_string())?
        .to_string();
    let inherited: InheritedNames = params
        .get("inheritedNames")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let known_types: Vec<String> = params
        .get("knownTypes")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let known_refs: Vec<&str> = known_types.iter().map(|s| s.as_str()).collect();
    let findings = analyze_def(&text, &inherited, &known_refs)?;
    Ok(serde_json::json!({ "findings": findings }))
}

/// 对一份 .def 文本运行全量 lint 规则(与 RPC handler 同口径,供单测直用)。
pub fn analyze_def(
    text: &str,
    inherited: &InheritedNames,
    known_types: &[&str],
) -> Result<Vec<Finding>, String> {
    let doc = kode_parser::xml::parse(text, true);
    if doc.root().is_none() {
        // 无根文档:TS analyzeDefDocument 早退空面,同口径。
        return Ok(Vec::new());
    }
    let line_map = LineMap::new(text);
    let mut known: BTreeSet<String> = BTreeSet::new();
    for name in crate::definition::BUILTIN_TYPES {
        known.insert(name.to_string());
    }
    for name in known_types {
        known.insert(name.to_string());
    }
    let ctx = RuleContext {
        text,
        doc: &doc,
        line_map: &line_map,
        inherited,
        known_types: &known,
    };
    Ok(all_rules().run(&ctx))
}

// ---------------------------------------------------------------------------
// finding 构造助手(规则共用)
// ---------------------------------------------------------------------------

/// 字节 span → UTF-16 码元偏移(与 vscode positionAt 同坐标系;span 为
/// 字符边界,parser 产出保证)。
pub(crate) fn byte_offset_to_utf16(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    let mut count = 0usize;
    let mut cur = 0usize;
    for ch in text.chars() {
        if cur >= offset {
            break;
        }
        count += ch.len_utf16();
        cur += ch.len_utf8();
    }
    count
}

/// 由字节 span 构造 finding:换算 UTF-16 offset/length 与 1 基行号。
pub(crate) fn make_finding(
    check: &'static str,
    severity: &'static str,
    span: Span,
    name: Option<String>,
    message: String,
    ctx: &RuleContext,
) -> Finding {
    let start = span.start.min(ctx.text.len());
    let end = span.end.min(ctx.text.len());
    let offset = byte_offset_to_utf16(ctx.text, start);
    let offset_end = byte_offset_to_utf16(ctx.text, end);
    let length = offset_end.saturating_sub(offset);
    let line = ctx.line_map.line_of(start);
    Finding {
        check,
        code: check,
        severity,
        line,
        offset,
        length,
        name,
        message,
        range: RangeFace { offset, length },
    }
}
