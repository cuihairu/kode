//! 编译期 golden 表与确定性快照序列化。
//!
//! [`build.rs`](../../build.rs) 读取 `tests/fixtures/python/golden.cases`,把 fixture
//! 原始字节和期望的编码/符号表编译成 [`GoldenCase`] 静态表;本模块只负责暴露该表并
//! 把运行结果渲染成稳定文本(不反序列化,避免测试自证)。

mod generated {
    include!(concat!(env!("OUT_DIR"), "/python_golden.rs"));
}

use crate::{DecodedSource, EncodingDetection, EncodingSource, PythonModule};

pub use generated::{
    GoldenAttribute, GoldenCase, GoldenClass, GoldenImport, GoldenInstance, GoldenMethod,
};

/// `build.rs` 生成的 fixture golden 表(按相对路径排序)。
pub fn python_golden() -> &'static [GoldenCase] {
    generated::PYTHON_GOLDEN
}

/// 渲染编码探测结论的稳定文本。
pub fn render_detection(detection: &EncodingDetection) -> String {
    format!(
        "encoding={} source={} bom_len={} declared={} cookie_line={}",
        detection.encoding.canonical_name(),
        encoding_source_name(detection.source),
        detection.bom_len,
        detection.declared.as_deref().unwrap_or("-"),
        detection
            .cookie_line
            .map_or_else(|| "-".to_string(), |line| line.to_string())
    )
}

/// 渲染四表与实例表的稳定文本(一行一条,顺序与解析结果一致)。
pub fn render_module(module: &PythonModule) -> String {
    let mut lines = vec![format!("line_count={}", module.line_count)];
    lines.extend(module.classes.iter().map(|class| {
        format!(
            "class={}|{}|{}|{}|{}",
            class.name,
            class.qualified_name,
            class.bases.join(","),
            class.start_line,
            class.end_line
        )
    }));
    lines.extend(module.methods.iter().map(|method| {
        format!(
            "method={}|{}|{}|{}|{}|{}",
            method.class,
            method.name,
            method.line,
            method.character,
            u8::from(method.is_async),
            method.decorators.join(",")
        )
    }));
    lines.extend(module.attributes.iter().map(|attribute| {
        format!(
            "attribute={}|{}|{}|{}",
            attribute.class, attribute.name, attribute.line, attribute.character
        )
    }));
    lines.extend(module.imports.iter().map(|import| {
        format!(
            "import={}|{}|{}|{}|{}",
            import.binding,
            import.module,
            import.symbol.as_deref().unwrap_or("-"),
            import.line,
            u8::from(import.is_from)
        )
    }));
    lines.extend(module.instances.iter().map(|instance| {
        format!(
            "instance={}|{}|{}",
            instance.variable, instance.class_name, instance.line
        )
    }));
    lines.join("\n")
}

/// 渲染一个 golden case 的完整快照(写入测试报告/diff 用)。
pub fn render_case(case: &GoldenCase, decoded: &DecodedSource) -> String {
    format!(
        "[{}]\n{}\n{}",
        case.relative_path,
        render_detection(&decoded.detection),
        render_module(&crate::parse_python_module(&decoded.text))
    )
}

fn encoding_source_name(source: EncodingSource) -> &'static str {
    match source {
        EncodingSource::Bom => "bom",
        EncodingSource::Cookie => "cookie",
        EncodingSource::Heuristic => "heuristic",
        EncodingSource::Default => "default",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_table_is_sorted_and_non_empty() {
        let cases = python_golden();
        assert!(!cases.is_empty());
        assert!(cases
            .windows(2)
            .all(|pair| pair[0].relative_path < pair[1].relative_path));
    }

    #[test]
    fn rendered_snapshot_is_deterministic() {
        let case = &python_golden()[0];
        let decoded = crate::decode_source(case.bytes).unwrap();
        let first = render_case(case, &decoded);
        let second = render_case(case, &decoded);
        assert_eq!(first, second);
        assert!(first.starts_with(&format!("[{}]", case.relative_path)));
        assert!(first.contains("line_count="));
    }
}
