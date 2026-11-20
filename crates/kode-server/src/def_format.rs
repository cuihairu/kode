//! .def 原生格式化(Rust 核,KODE-SYN-006):评估结论见
//! docs/design/def-formatter-evaluation.md 方案 B——格式化收敛到
//! kode-parser 的精确 span 面,TS 侧只做薄 provider 适配(零外部依赖,
//! 不做 TS 端 XML 重排)。
//!
//! 命令面 `$/kode/def/format`(经 `$/kode/rpc` 单臂派发):入参
//! `{content: string, indentSize?: u64, start?: u64, end?: u64}`,出
//! `{edits, diagnostics}`。
//!
//! - **纯计算,不 spawn**:格式化核在 kode-parser 内同步返回,无子进程、
//!   无 IO、无工作区写入(与 ruff 的 shell out 面不同,故不占 IO 泳道)。
//! - **`edits` 是行级极小编辑集**(`[start, end)` 换成 `text`),区间在
//!   **原文本**的字节坐标系上;应用(逆序)后与整篇渲染逐字节相同
//!   (`format_def_edits` 的 roundtrip 单测钉住)。渲染结果与原文相同 →
//!   空编辑集(幂等落点)。
//! - **选区**:`start`/`end` 成对给出时只回「与选区相交」的编辑(行级编辑
//!   不越界裁切,跨边界的行整行替换——与行对齐的 formatter 常规口径)。
//! - **任何解析诊断 → 空编辑集**,绝不半改(残缺 XML 是活编辑器里的常态,
//!   不是错误);`diagnostics` 条数回带,供 TS 侧如实区分「已格式化」与
//!   「解析不通、安全退回」,零编辑不静默。

use serde_json::{json, Value};

use crate::rpc::RpcRegistry;
use kode_parser::def_format::{format_def_report, DefFormatOptions};

const METHOD: &str = "$/kode/def/format";

pub fn register(reg: &mut RpcRegistry) {
    reg.register(METHOD, def_format_handler);
}

/// 缩进尺寸的合理上限(再大就是误传,按错参如实 Err,不静默收紧)。
const INDENT_SIZE_MAX: u64 = 64;

fn def_format_handler(params: Value) -> Result<Value, String> {
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "def format: missing content".to_string())?;
    let indent_size = params
        .get("indentSize")
        .and_then(|v| v.as_u64())
        .unwrap_or(DefFormatOptions::default().indent_size as u64);
    if indent_size == 0 || indent_size > INDENT_SIZE_MAX {
        return Err(format!(
            "def format: indentSize must be in 1..={INDENT_SIZE_MAX}, got {indent_size}"
        ));
    }
    let range = selection_range(&params, content.len())?;
    let report = format_def_report(
        content,
        &DefFormatOptions {
            indent_size: indent_size as usize,
        },
    );
    let edits = report
        .edits
        .into_iter()
        .filter(|edit| match range.as_ref() {
            Some(&(start, end)) => edit_intersects(edit, start, end),
            None => true,
        })
        .map(|edit| {
            json!({
                "start": edit.start,
                "end": edit.end,
                "text": edit.text,
            })
        })
        .collect::<Vec<Value>>();
    Ok(json!({ "edits": edits, "diagnostics": report.diagnostics }))
}

/// 行级编辑不与选区裁切:相交即整条采纳(零宽选区=光标位,取覆盖该位的行)。
fn edit_intersects(edit: &kode_parser::DefFormatEdit, start: usize, end: usize) -> bool {
    if start == end {
        edit.start <= start && edit.end >= start
    } else {
        edit.start < end && edit.end > start
    }
}

/// 选区口径:`start`/`end` 必须成对给出(单给按错参 Err,不猜半个区间),
/// 越界 clamp 到文档边界。返回 `(start, end)` 或 `None`(整文档)。
fn selection_range(params: &Value, content_len: usize) -> Result<Option<(usize, usize)>, String> {
    let start = params.get("start").and_then(|v| v.as_u64());
    let end = params.get("end").and_then(|v| v.as_u64());
    match (start, end) {
        (None, None) => Ok(None),
        (Some(s), Some(e)) => {
            let s = (s as usize).min(content_len);
            let e = (e as usize).min(content_len).max(s);
            Ok(Some((s, e)))
        }
        _ => Err("def format: start and end must be given together".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSY: &str =
        "<root>\n<Properties>\n<hp>\n<Type>UINT32</Type>\n</hp>\n</Properties>\n</root>";

    /// 整文档面:非空编辑集、诊断 0;逆序应用后与整篇渲染逐字节相同。
    #[test]
    fn whole_document_returns_edit_set_and_zero_diagnostics() {
        let face = def_format_handler(json!({ "content": MESSY })).expect("整文档面");
        let edits = face["edits"].as_array().expect("edits 是数组");
        assert!(!edits.is_empty(), "未格式化文档必须有编辑");
        assert_eq!(face["diagnostics"], 0);
        // 逆序应用编辑集 → 与渲染产物相同(载荷可自洽落回原文)
        let rendered = kode_parser::format_def_text(MESSY, &DefFormatOptions::default());
        let mut out = String::from(MESSY);
        let mut max_start = usize::MAX;
        for edit in edits.iter().rev() {
            let start = edit["start"].as_u64().unwrap() as usize;
            assert!(
                edit["end"].as_u64().unwrap() as usize <= max_start,
                "编辑区间不得重叠"
            );
            out.replace_range(
                start..edit["end"].as_u64().unwrap() as usize,
                edit["text"].as_str().unwrap(),
            );
            max_start = start;
        }
        assert_eq!(out, rendered);
    }

    /// 已格式化 → 零编辑、零诊断(幂等落点,前端据此不写文档)。
    #[test]
    fn already_formatted_document_reports_zero_edits() {
        let rendered = kode_parser::format_def_text(MESSY, &DefFormatOptions::default());
        let face = def_format_handler(json!({ "content": rendered })).expect("幂等面");
        assert_eq!(face["edits"], json!([]));
        assert_eq!(face["diagnostics"], 0);
    }

    /// 残缺 XML → 零编辑**且**诊断条数如实回带(不静默当「已格式化」)。
    #[test]
    fn incomplete_xml_returns_no_edits_with_diagnostics() {
        let face = def_format_handler(json!({ "content": "<root><a></b>" })).expect("残缺面");
        assert_eq!(face["edits"], json!([]));
        assert!(
            face["diagnostics"].as_u64().unwrap() > 0,
            "残缺文档必须带诊断条数,供前端区分口径"
        );
    }

    /// 选区面:只回与选区相交的编辑,且成对缺一半按错参 Err。
    #[test]
    fn selection_range_filters_and_half_range_is_rejected() {
        // 半个选区按错参 Err(不猜另一头)
        assert!(def_format_handler(json!({ "content": MESSY, "start": 4 })).is_err());
        assert!(def_format_handler(json!({ "content": MESSY, "end": 4 })).is_err());

        let whole = def_format_handler(json!({ "content": MESSY })).unwrap();
        let whole_count = whole["edits"].as_array().unwrap().len();
        assert!(whole_count > 0, "未格式化文档必须有编辑");

        // 选区 = 首行(渲染后逐字节不变)→ 零编辑:证明过滤是真过滤,非照搬整篇
        let first_line = "<root>\n".len();
        let face =
            def_format_handler(json!({ "content": MESSY, "start": 0, "end": first_line })).unwrap();
        assert_eq!(face["edits"], json!([]), "未变行上的选区不得回带编辑");

        // 选区 = 整文档 → 与整篇面同数(过滤不丢编辑)
        let full = def_format_handler(json!({
            "content": MESSY,
            "start": 0,
            "end": MESSY.len()
        }))
        .unwrap();
        assert_eq!(full["edits"].as_array().unwrap().len(), whole_count);

        // 中段选区:不相交的编辑不得出现
        let mid = first_line + "<Properties>\n".len();
        let mid_face =
            def_format_handler(json!({ "content": MESSY, "start": 0, "end": mid })).unwrap();
        for edit in mid_face["edits"].as_array().unwrap() {
            let s = edit["start"].as_u64().unwrap() as usize;
            let e = edit["end"].as_u64().unwrap() as usize;
            assert!(s < mid && e > 0, "选区外的编辑不得回带: [{s},{e})");
        }

        // 全越界 clamp 到文档尾:不 Err,按「光标停在文末」处理(末行若在改,编辑照常回带)
        let clamped =
            def_format_handler(json!({ "content": MESSY, "start": 10_000, "end": 20_000 }))
                .unwrap();
        assert_eq!(
            clamped["edits"].as_array().unwrap().len(),
            whole_count,
            "clamp 后的零宽区间=文档尾光标,不得静默丢编辑"
        );

        // 零宽选区落在未变行上 → 零编辑(光标不牵连不相干的行)
        let cursor = def_format_handler(json!({ "content": MESSY, "start": 3, "end": 3 })).unwrap();
        assert_eq!(cursor["edits"], json!([]));
    }

    /// 错参如实 Err:缺 content / 非字符串 content / indentSize 越界。
    #[test]
    fn bad_params_are_rejected_honestly() {
        assert!(def_format_handler(json!({})).is_err());
        assert!(def_format_handler(json!({ "content": 7 })).is_err());
        assert!(def_format_handler(json!({ "content": MESSY, "indentSize": 0 })).is_err());
        assert!(
            def_format_handler(json!({ "content": MESSY, "indentSize": INDENT_SIZE_MAX + 1 }))
                .is_err()
        );
        // 合法缩进尺寸按参数生效(不静默收紧也不忽略)
        let face = def_format_handler(json!({ "content": MESSY, "indentSize": 2 })).unwrap();
        assert!(
            face["edits"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["text"].as_str().unwrap().contains("  <Properties>")),
            "indentSize 必须透传到渲染"
        );
    }

    /// 注册不重名:METHOD 常量即注册键。
    #[test]
    fn registers_under_the_def_format_method_name() {
        let mut reg = RpcRegistry::new();
        register(&mut reg);
        assert!(reg.dispatch(METHOD, json!({ "content": MESSY })).is_ok());
        assert!(reg.snapshot().methods().any(|m| m == METHOD));
    }
}
