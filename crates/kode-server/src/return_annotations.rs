//! 返回注解逐文件提取 RPC 面(RUST-MIGRATION-AUDIT-006 B1 车道批 3):
//! `$/kode/python/returnAnnotations`,薄面承载三事实——注解事实
//! (kode-python::return_annotations::collect_file_annotation_facts,首定义
//! 优先,`->` 缺记 null 遮蔽磁盘)、导入绑定(extract_file_imports,from/bare
//! 分列)、逐行单跳赋值调用(parse_local_assignment_call × 行,**输入=
//! python_lexical_mask 全文掩码后按 '\n' 切分**——与 TS matchingAssignments
//! KR-AUD-64 口径逐字对齐:全文掩跨行三引号体,split('\n') 保留行内孤立 \r)。
//! 前两事实收 TS 原文(提取核内单行掩码 maskCodeLine 自带,同 TS 逐字)。
//! 出参键 camelCase;消息/工作区机械不出 Rust,桶装配与查询级联留 TS。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/python/returnAnnotations", return_annotations);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReturnAnnotationsParams {
    /// python 文件原文(提取核内自带单行掩码;逐行调用面另做全文掩码)
    text: String,
}

fn return_annotations(params: Value) -> Result<Value, String> {
    let params: ReturnAnnotationsParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let text: Vec<u16> = params.text.encode_utf16().collect();
    let facts = kode_python::return_annotations::collect_file_annotation_facts(&text)
        .into_iter()
        .map(|fact| {
            json!({
                "name": fact.name,
                "annotation": fact.annotation,
            })
        })
        .collect::<Vec<_>>();
    let lines = kode_python::self_flow::split_crlf(&text);
    let imports = kode_python::return_annotations::extract_file_imports(&lines);
    let imports_value = json!({
        "names": imports
            .names
            .iter()
            .map(|binding| json!({
                "local": binding.local,
                "module": binding.module,
                "symbol": binding.symbol,
            }))
            .collect::<Vec<_>>(),
        "receivers": imports
            .receivers
            .iter()
            .map(|binding| json!({
                "local": binding.local,
                "module": binding.module,
            }))
            .collect::<Vec<_>>(),
    });
    // 逐行单跳调用:全文掩码(python_lexical_mask 单一来源)后 '\n' 切分——
    // 与 TS matchingAssignments 的 maskPythonNonCode(lines.join('\n')).split('\n')
    // 同法(非 split_crlf:行内孤立 \r 保留在行内,parse 面 `(.+)$` 同判失配)
    let masked = crate::python_lexical_mask::mask_python_non_code(&params.text);
    let mut local_assignment_calls: Vec<Value> = Vec::new();
    let mut line_start = 0usize;
    let mut line_no = 0usize;
    while line_start <= masked.len() {
        let end = masked[line_start..]
            .iter()
            .position(|&c| c == 0x0A)
            .map_or(masked.len(), |off| line_start + off);
        let line = &masked[line_start..end];
        if let Some(call) =
            kode_python::return_annotations::parse_local_assignment_call(line)
        {
            local_assignment_calls.push(json!({
                "line": line_no,
                "target": call.target,
                "receiver": call.receiver,
                "methodName": call.method_name,
            }));
        }
        if end == masked.len() {
            break;
        }
        line_start = end + 1;
        line_no += 1;
    }
    Ok(json!({
        "facts": facts,
        "imports": imports_value,
        "localAssignmentCalls": local_assignment_calls,
    }))
}

// ---- 单测 -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> Value {
        return_annotations(json!({ "text": text })).unwrap()
    }

    #[test]
    fn facts_and_unannotated_shape() {
        let out = run("def a() -> int:\n    return 1\ndef b():\n    return 2\n");
        let facts = out["facts"].as_array().unwrap();
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0]["name"], json!("a"));
        assert_eq!(facts[0]["annotation"], json!("int"));
        assert_eq!(facts[1]["annotation"], Value::Null);
    }

    #[test]
    fn imports_camel_shape() {
        let out = run("import pkg.good as g\nfrom mods import X\n");
        let names = out["imports"]["names"].as_array().unwrap();
        assert_eq!(names[0]["local"], json!("X"));
        let receivers = out["imports"]["receivers"].as_array().unwrap();
        assert_eq!(receivers[0]["local"], json!("g"));
        assert_eq!(receivers[0]["module"], json!("pkg/good"));
    }

    #[test]
    fn calls_over_masked_text() {
        let out = run("data = svc.get_data()\nx = \"f().g()\"\ny == 5\n");
        let calls = out["localAssignmentCalls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["line"], json!(0));
        assert_eq!(calls[0]["target"], json!("data"));
        assert_eq!(calls[0]["receiver"], json!("svc"));
        assert_eq!(calls[0]["methodName"], json!("get_data"));
    }

    #[test]
    fn calls_triple_quote_body_masked_out() {
        // 全文掩码跨行三引号体:体内 `x = f()` 形行不再成调用(词法掩码职责)
        let text = "s = \"\"\"\ninner = fake()\n\"\"\"\nok = real()\n";
        let out = run(text);
        let calls = out["localAssignmentCalls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["line"], json!(3));
        assert_eq!(calls[0]["target"], json!("ok"));
    }

    #[test]
    fn empty_text_zero_facts() {
        let out = run("");
        assert_eq!(out["facts"].as_array().unwrap().len(), 0);
        assert_eq!(
            out["imports"]["names"].as_array().unwrap().len(),
            0
        );
        assert_eq!(
            out["localAssignmentCalls"].as_array().unwrap().len(),
            0
        );
    }
}
