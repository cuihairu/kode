//! KBE-PY-008 角色错用收编(AUDIT-005 B2 车道批 2):`$/kode/lint/analyzeRoleMisuse`。
//!
//! TS 源 = src/backend/roleMisuseDiagnostics.ts,逐语义忠实移植(对拍纪律):
//!   - 掩码 = crate::python_lexical_mask::mask_python_non_code(与 TS 同源语义);
//!   - 行切分 = `\r?\n`(剥 `\n` 前至多一个 `\r`);词元 = ASCII `[A-Za-z0-9_]`;
//!   - 正则 `\bself\.(\w+)(?![\w.])`:lookaround 手工展开(`\b` 左界 = 前字符
//!     非词元或行首;`(?![\w.])` = 词元最大游程后一字符非 `.`——词元最大性
//!     已保证后一字符非词元,负向查仅剩 `.` 一义);
//!   - 消息/取证(source)不出 Rust:只回结构面(code/line/character/length +
//!     propertyName/registeredFaces),l10n 渲染与引擎取证留 TS(调用方逐字段
//!     校验,畸形整面作废回 TS,与 serveDiagnosticsFromRust 同口径)。
//! 入参 `{text, face, facePropertyNames:{baseapp,cellapp,client}}`(face 由 TS
//! 解析:目录域优先、def 归属唯一面、歧义/非实体为 null);出 `{items:[...]}`。
//! 面注册集与 TS FACE_PROPERTY_NAMES 同源(TS 桥接静态属性表)。

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::python_lexical_mask::{is_word, mask_python_non_code};
use crate::rpc::RpcRegistry;

pub const CODE_ROLE_MISUSE: &str = "kbengine.roleMisuse";

const FACES: [&str; 3] = ["baseapp", "cellapp", "client"];

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeRoleMisuse", analyze_role_misuse);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RoleMisuseParams {
    text: String,
    face: Option<String>,
    #[serde(default)]
    face_property_names: FacePropertyNames,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FacePropertyNames {
    #[serde(default)]
    baseapp: Vec<String>,
    #[serde(default)]
    cellapp: Vec<String>,
    #[serde(default)]
    client: Vec<String>,
}

/// 一条结构面产物(消息渲染与引擎取证在 TS)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoleMisuseItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    property_name: String,
    registered_faces: Vec<&'static str>,
}

fn analyze_role_misuse(params: Value) -> Result<Value, String> {
    let params: RoleMisuseParams =
        serde_json::from_value(params).map_err(|err| format!("invalid params: {err}"))?;
    let items = find_role_misuse_items(&params);
    Ok(json!({ "items": items }))
}

/// 全量判定(与 TS findRoleMisuseFindings 同语义;face=null 非实体/歧义零产出)
fn find_role_misuse_items(params: &RoleMisuseParams) -> Vec<RoleMisuseItem> {
    let Some(face) = params.face.as_deref() else {
        return Vec::new();
    };
    let Some(face_index) = FACES.iter().position(|candidate| *candidate == face) else {
        return Vec::new(); // 未知面 → 零产出(TS 侧 face 恒三面之一)
    };
    let face_sets: Vec<HashSet<&str>> = [
        &params.face_property_names.baseapp,
        &params.face_property_names.cellapp,
        &params.face_property_names.client,
    ]
    .iter()
    .map(|names| names.iter().map(String::as_str).collect())
    .collect();
    let all_builtin: HashSet<&str> = face_sets.iter().flatten().copied().collect();

    let masked = mask_python_non_code(&params.text);
    let lines = split_lines(&masked);
    let mut items = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        for (character, property_name) in find_self_property_accesses(line) {
            if face_sets[face_index].contains(property_name.as_str()) {
                continue; // 当前面注册 → 正常访问
            }
            if !all_builtin.contains(property_name.as_str()) {
                continue; // 任何面未注册 → 非内建,落回 def/普通符号
            }
            let registered_faces: Vec<&'static str> = FACES
                .iter()
                .enumerate()
                .filter(|(index, _)| face_sets[*index].contains(property_name.as_str()))
                .map(|(_, face)| *face)
                .collect();
            items.push(RoleMisuseItem {
                code: CODE_ROLE_MISUSE,
                line: line_index,
                character,
                length: "self.".len() + property_name.len(),
                property_name,
                registered_faces,
            });
        }
    }
    items
}

/// 单行 `\bself\.(\w+)(?![\w.])` 命中:(匹配起点列(UTF-16 码元), 属性名)
fn find_self_property_accesses(line: &[u16]) -> Vec<(usize, String)> {
    let mut matches = Vec::new();
    let mut i = 0usize;
    while i < line.len() {
        // `\b` 左界:前码元非词元或行首;`self` 后须紧跟 `.`(ASCII 码元序列)
        if line[i] == b's' as u16
            && (i == 0 || !is_word(line[i - 1]))
            && line[i..].starts_with(&[b's' as u16, b'e' as u16, b'l' as u16, b'f' as u16, b'.' as u16])
        {
            // `(\w+)`:词元最大游程(至少 1;`\b` 已在 `self` 前判)
            let run_start = i + "self.".len();
            let mut end = run_start;
            while end < line.len() && is_word(line[end]) {
                end += 1;
            }
            if end > run_start {
                // `(?![\w.])`:词元游程后一码元非 `.`(非词元由最大性保证)
                if end >= line.len() || line[end] != b'.' as u16 {
                    matches.push((i, String::from_utf16(&line[run_start..end]).unwrap()));
                    i = end; // lastIndex = 匹配终点
                    continue;
                }
            }
        }
        i += 1;
    }
    matches
}

/// TS `text.split(/\r?\n/)`:剥掉每个 `\n` 前至多一个 `\r`(单个 \r 留行内)。
fn split_lines(text: &[u16]) -> Vec<&[u16]> {
    text.split(|&code| code == b'\n' as u16)
        .map(|line| line.strip_suffix(&[b'\r' as u16]).unwrap_or(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(text: &str, face: Option<&str>) -> RoleMisuseParams {
        RoleMisuseParams {
            text: text.to_string(),
            face: face.map(str::to_string),
            face_property_names: FacePropertyNames {
                baseapp: vec!["name".into(), "global".into()],
                cellapp: vec!["name".into(), "position".into()],
                client: vec!["name".into(), "position".into(), "hp".into()],
            },
        }
    }

    #[test]
    fn reports_property_registered_on_other_face_only() {
        let text = "class Avatar:\n    def f(self):\n        self.position = 1\n        self.name = 1\n        self.hp = 1\n";
        // baseapp 面:name 注册 → 不报;position 注册于 cellapp/client → 报;
        // hp 注册于 client → 报
        let items = find_role_misuse_items(&params(text, Some("baseapp")));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].property_name, "position");
        assert_eq!(items[0].line, 2);
        assert_eq!(items[0].registered_faces, vec!["cellapp", "client"]);
        assert_eq!(items[1].property_name, "hp");
        assert_eq!(items[1].registered_faces, vec!["client"]);
    }

    #[test]
    fn null_face_yields_nothing() {
        let items = find_role_misuse_items(&params("self.position = 1", None));
        assert!(items.is_empty());
    }

    #[test]
    fn unknown_face_yields_nothing() {
        let items = find_role_misuse_items(&params("self.position = 1", Some("space")));
        assert!(items.is_empty());
    }

    #[test]
    fn non_builtin_property_is_skipped() {
        let items = find_role_misuse_items(&params("self.weird = 1", Some("baseapp")));
        assert!(items.is_empty());
    }

    #[test]
    fn handles_boundary_and_lookahead_cases() {
        // `myself.position` 无 `\b` 左界 → 不命中;`self.position.x` 后随 `.`
        // → 负向查失败;`self.` 空属性 → 不命中;字符串/注释已由掩码清掉
        let text = "myself.position = 1\nself.position.x = 1\nself. = 1\n' self.position = 1 '\n# self.position = 1\n";
        let items = find_role_misuse_items(&params(text, Some("baseapp")));
        assert!(items.is_empty());
    }

    #[test]
    fn analyze_role_misuse_params_and_items_shape() {
        let result = analyze_role_misuse(json!({
            "text": "self.position = 1",
            "face": "baseapp",
            "facePropertyNames": {
                "baseapp": ["name"],
                "cellapp": ["name", "position"],
                "client": ["position"]
            }
        }))
        .unwrap();
        let items = result["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["code"], CODE_ROLE_MISUSE);
        assert_eq!(items[0]["line"], 0);
        assert_eq!(items[0]["propertyName"], "position");
        assert_eq!(items[0]["registeredFaces"], serde_json::json!(["cellapp", "client"]));
    }
}
