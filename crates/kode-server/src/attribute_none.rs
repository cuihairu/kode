//! attributeNone 诊断词法面(AUDIT-005 B2 车道批 6,LANG-NAR-1 自管属性可能
//! None 诊断):入参 text 为 TS 预掩码文本(maskPythonNonCode 同源——注释/字符
//! 串字面量已替换为同长空白,行/列偏移不变),本模块只做词法扫描:
//! `\bself\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)` 手工展开 + 内建 receiver
//! (cell/base/client,receiverNone 专责)跳过 + 0 起行号与成员列计算
//! (UTF-16 码元基底)。流敏感 None 证据面已于 RUST-MIGRATION-AUDIT-006 批 1
//! 收编 Rust(引擎 kode-python::self_flow);批 2 起本面**内联逐项流事实**——
//! 响应条目携带 flow:{types,annotation,hasNone,narrowed}(每 (行,属性) 一次
//! 引擎查询,项间克隆;入参 versionKey 直传 KODE-PERF-001 版本键控解析缓存),
//! TS render 退位为事实校验+同键矛盾整面作废,双调用缝消除。行数组取
//! self_flow::split_crlf(= TS `maskedText.split(/\r?\n/)` 同法,掩码行)。
//! 成员列沿用 TS `match[0].indexOf(member)` 首次出现语义逐字对齐(含
//! self.<a>.<a> 命中 attr 段的既有口径)。回结构面
//! [{code,line,character,length,attr,member,flow}],消息不出 Rust。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub const CODE_ATTRIBUTE_NONE: &str = "kbengine.attributeNone";

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/lint/analyzeAttributeNone", analyze_attribute_none);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct AttributeNoneParams {
    /// TS 预掩码文本(maskPythonNonCode 输出)
    text: String,
    /// KODE-PERF-001 版本键控解析缓存键(TS flowVersionKeyForDocument 产物;
    /// 缺省 = 现解析不缓存,与流引擎纯函数回退同语义)
    version_key: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttributeNoneItem {
    code: &'static str,
    line: usize,
    character: usize,
    length: usize,
    attr: String,
    member: String,
}

/// 内联流事实面(与 `$/kode/python/selfAttributeFlow` 出参同形;批 2 起随
/// 词法条目下发,TS render 只做校验+同键矛盾检测,不再二次流查询)
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttributeNoneFlowFace {
    types: Vec<String>,
    annotation: Option<String>,
    has_none: bool,
    narrowed: bool,
}

/// 响应条目 = 词法结构面 + 内联流事实(引擎查询恒可解:行号来自同文本扫描
/// 恒在界内、attr 非空;None = 契约漂移,TS 侧整面作废)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AttributeNoneItemFace {
    #[serde(flatten)]
    item: AttributeNoneItem,
    flow: Option<AttributeNoneFlowFace>,
}

fn analyze_attribute_none(params: Value) -> Result<Value, String> {
    let params: AttributeNoneParams = serde_json::from_value(params).map_err(|err| err.to_string())?;
    let items = compute_attribute_none_items(&params.text);
    let faces = attach_flow_faces(&params.text, &items, params.version_key.as_deref());
    Ok(json!({ "items": faces }))
}

/// 每 (行, 属性) 一次流引擎查询(kode-python::self_flow 批 1 引擎,与
/// typeInlayHints 同源),项间克隆;行数组 = 掩码文本 split_crlf。
fn attach_flow_faces(
    masked_text: &str,
    items: &[AttributeNoneItem],
    version_key: Option<&str>,
) -> Vec<AttributeNoneItemFace> {
    let text: Vec<u16> = masked_text.encode_utf16().collect();
    let lines = kode_python::self_flow::split_crlf(&text);
    let mut cache: std::collections::HashMap<(usize, String), Option<AttributeNoneFlowFace>> =
        std::collections::HashMap::new();
    items
        .iter()
        .map(|item| {
            let flow = cache
                .entry((item.line, item.attr.clone()))
                .or_insert_with(|| {
                    kode_python::self_flow::infer_self_attribute_flow(
                        &lines,
                        item.line,
                        &item.attr.encode_utf16().collect::<Vec<u16>>(),
                        version_key,
                    )
                    .map(|flow| AttributeNoneFlowFace {
                        types: flow.types,
                        annotation: flow.annotation,
                        has_none: flow.has_none,
                        narrowed: flow.narrowed,
                    })
                })
                .clone();
            AttributeNoneItemFace {
                item: item.clone(),
                flow,
            }
        })
        .collect()
}

/// 内建 receiver 属性(receiverNone 专责,此处跳过避免重复/口径分叉)
const BUILTIN_RECEIVERS: [&str; 3] = ["cell", "base", "client"];

/// TS 词首字符类 `[A-Za-z_]`(不含数字)
fn is_name_start(code: u16) -> bool {
    code == 0x5F || (0x41..=0x5A).contains(&code) || (0x61..=0x7A).contains(&code)
}

/// TS `\w` = `[A-Za-z0-9_]`
fn is_name_char(code: u16) -> bool {
    is_name_start(code) || (0x30..=0x39).contains(&code)
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

/// `\bself\.` 扫描(预掩码文本,UTF-16 码元基底)。greedy attr 贪吃全部词元后
/// 若下一码元非 `.`,回溯无效(缩短 attr 只会留下词元,`.` 仍不成立)→ 不需要
/// 回溯;member 空则整位匹配失败,引擎前进 1(与 g 正则 lastIndex 语义一致)。
fn compute_attribute_none_items(masked_text: &str) -> Vec<AttributeNoneItem> {
    let text: Vec<u16> = masked_text.encode_utf16().collect();
    // 行起始偏移表(每 '\n' 后一位置;与 TS buildLineStarts 等值)
    let mut line_starts: Vec<usize> = vec![0];
    for (idx, code) in text.iter().enumerate() {
        if *code == 10 {
            line_starts.push(idx + 1);
        }
    }
    let mut items: Vec<AttributeNoneItem> = Vec::new();
    let mut line_idx = 0usize;
    let mut i = 0usize;
    while i < text.len() {
        // `\b` 左界:行首/前码元非词元;'self' 逐码元;'.' 紧随
        let self_dot = i == 0 || !is_name_char(text[i - 1]);
        if self_dot && starts_with(&text, i, "self") && text.get(i + 4) == Some(&0x2E) {
            // attr:[A-Za-z_] 起头,词元 greedy
            let attr_start = i + 5;
            if let Some(&first) = text.get(attr_start) {
                if is_name_start(first) {
                    let mut j = attr_start;
                    while j < text.len() && is_name_char(text[j]) {
                        j += 1;
                    }
                    // greedy attr 后需 '.'(回溯无效,见模块注释)
                    if text.get(j) == Some(&0x2E) {
                        // member:[A-Za-z_] 起头,词元 greedy
                        let member_start = j + 1;
                        if let Some(&mfirst) = text.get(member_start) {
                            if is_name_start(mfirst) {
                                let mut k = member_start;
                                while k < text.len() && is_name_char(text[k]) {
                                    k += 1;
                                }
                                let attr =
                                    String::from_utf16(&text[attr_start..j]).unwrap_or_default();
                                let member =
                                    String::from_utf16(&text[member_start..k]).unwrap_or_default();
                                // 内建 receiver 跳过(按 attr 名集)
                                let attr_u16: Vec<u16> = attr.encode_utf16().collect();
                                let is_builtin = BUILTIN_RECEIVERS
                                    .iter()
                                    .any(|name| attr_u16.as_slice() == name.encode_utf16().collect::<Vec<u16>>().as_slice());
                                if !is_builtin {
                                    while line_idx + 1 < line_starts.len()
                                        && line_starts[line_idx + 1] <= i
                                    {
                                        line_idx += 1;
                                    }
                                    // 成员列 = 匹配起点 + 匹配段内 member 首次出现
                                    // (TS `match[0].indexOf(member)` 逐字对齐)
                                    let member_u16: Vec<u16> = member.encode_utf16().collect();
                                    let mut offset = 0usize;
                                    for s in i..=(k - member_u16.len()) {
                                        if text[s..s + member_u16.len()] == member_u16[..] {
                                            offset = s - i;
                                            break;
                                        }
                                    }
                                    items.push(AttributeNoneItem {
                                        code: CODE_ATTRIBUTE_NONE,
                                        line: line_idx,
                                        character: i + offset,
                                        length: member_u16.len(),
                                        attr,
                                        member,
                                    });
                                }
                                // g 正则 lastIndex:匹配成立即越过整段(含内建跳过)
                                i = k;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        // 本位不成立:引擎前进 1
        i += 1;
    }
    items
}

// ---- 单测 -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn items_of(text: &str) -> Vec<AttributeNoneItem> {
        compute_attribute_none_items(text)
    }

    #[test]
    fn bare_access_reports() {
        let items = items_of("    self.TalentTree.get(0)\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].code, CODE_ATTRIBUTE_NONE);
        assert_eq!(items[0].line, 0);
        // 列 = 匹配起点(4) + 'self.TalentTree.get' 内 indexOf('get') = 16
        assert_eq!(items[0].character, 20);
        assert_eq!(items[0].length, 3);
        assert_eq!(items[0].attr, "TalentTree");
        assert_eq!(items[0].member, "get");
    }

    #[test]
    fn builtin_receivers_skipped() {
        assert!(items_of("self.cell.tick()\n").is_empty());
        assert!(items_of("self.base.create()\n").is_empty());
        assert!(items_of("self.client.req()\n").is_empty());
    }

    #[test]
    fn same_line_two_members_both_report() {
        let items = items_of("self.x.a(1); self.x.b(2)\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].member, "a");
        assert_eq!(items[1].member, "b");
        assert_eq!(items[0].character, 7);
        // 第二匹配起点 13 + 'self.x.b' 内 indexOf('b') = 7
        assert_eq!(items[1].character, 20);
    }

    #[test]
    fn member_column_uses_first_occurrence_semantics() {
        // TS `match[0].indexOf(member)`:self.id.id 的 indexOf('id') = 5(attr
        // 段首中)→ character = 匹配起点 + 5(既有口径逐字对齐,非成员真位)
        let items = items_of("self.id.id\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].character, 5);
        assert_eq!(items[0].length, 2);
    }

    #[test]
    fn member_column_first_occurrence_in_self_word() {
        // member='lf' 首中 'self' 段内(indexOf = 2)
        let items = items_of("self.ab.lf\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].character, 2);
    }

    #[test]
    fn attr_empty_no_match() {
        // self.5x / self.( → attr 形不符,零匹配
        assert!(items_of("self.5x.y\n").is_empty());
        assert!(items_of("self.(x.y\n").is_empty());
    }

    #[test]
    fn member_empty_whole_match_fails() {
        // self.x.() member 形不符 → 整位失败(不是 attr 单报)
        assert!(items_of("self.x.(1)\n").is_empty());
    }

    #[test]
    fn attr_without_member_dot_no_match() {
        assert!(items_of("self.x\n").is_empty());
    }

    #[test]
    fn left_word_boundary_respected() {
        // myself.x.y:\b 失败;_self.x.y:前码元词元失败
        assert!(items_of("myself.x.y\n").is_empty());
        assert!(items_of("_self.x.y\n").is_empty());
    }

    #[test]
    fn line_number_tracks_newlines() {
        let items = items_of("a = 1\nb = 2\nself.foo.bar()\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, 2);
        // 匹配起点 12 + 'self.foo.bar' 内 indexOf('bar') = 9
        assert_eq!(items[0].character, 21);
    }

    #[test]
    fn non_ascii_prefix_column_is_utf16() {
        // 掩码后中文串占位同长(UTF-16 码元),列按码元计
        let items = items_of("s = \"庆祝\" ; self.cfg.load()\n");
        assert_eq!(items.len(), 1);
        // 匹配起点 11(掩码同长占位,UTF-16 码元列)+ 'self.cfg.load' 内
        // indexOf('load') = 9
        assert_eq!(items[0].character, 20);
    }

    #[test]
    fn multiple_lines_sequential() {
        let items = items_of("self.a.one()\nself.b.two()\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].line, 0);
        assert_eq!(items[1].line, 1);
        assert_eq!(items[1].attr, "b");
    }

    #[test]
    fn encoded_shape_is_camel_case() {
        let items = items_of("self.v.read()\n");
        let encoded = serde_json::to_value(&items[0]).unwrap();
        assert_eq!(encoded["code"], json!("kbengine.attributeNone"));
        assert_eq!(encoded["line"], json!(0));
        // 'self.v.read' 内 indexOf('read') = 7
        assert_eq!(encoded["character"], json!(7));
        assert_eq!(encoded["length"], json!(4));
        assert_eq!(encoded["attr"], json!("v"));
        assert_eq!(encoded["member"], json!("read"));
    }
    // ---- 批 2:内联流事实 ---------------------------------------------------

    #[test]
    fn flow_face_none_evidence_inline() {
        // __init__ 仅 = None,无守卫 → hasNone true
        let text = "class Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        self.TalentTree.get(0)\n";
        let items = compute_attribute_none_items(text);
        let faces = attach_flow_faces(text, &items, None);
        assert_eq!(faces.len(), 1);
        let flow = faces[0].flow.as_ref().expect("flow face present");
        assert!(flow.has_none);
        assert!(!flow.narrowed);
        assert_eq!(flow.annotation.as_deref(), Some("None"));
    }

    #[test]
    fn flow_face_narrowed_inline() {
        // 守卫后收窄 → hasNone false/narrowed true,条目流事实即裁定依据
        let text = "class Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        if self.TalentTree is None:\n            self.TalentTree = make_tree()\n        self.TalentTree.get(0)\n";
        let items = compute_attribute_none_items(text);
        let faces = attach_flow_faces(text, &items, None);
        let flow = faces[0].flow.as_ref().expect("flow face present");
        assert!(!flow.has_none);
        assert!(flow.narrowed);
    }

    #[test]
    fn flow_face_shared_across_same_line_attr() {
        // 同行同属性两条目共享一次引擎查询(hasNone 一致,克隆同值)
        let text = "class Foo:\n    def __init__(self):\n        self.x = None\n    def m(self):\n        self.x.a(); self.x.b()\n";
        let items = compute_attribute_none_items(text);
        assert_eq!(items.len(), 2);
        let faces = attach_flow_faces(text, &items, None);
        let f0 = faces[0].flow.as_ref().unwrap();
        let f1 = faces[1].flow.as_ref().unwrap();
        assert!(f0.has_none && f1.has_none);
    }

    #[test]
    fn flow_face_encoded_shape_is_camel_case() {
        let text = "class Foo:\n    def __init__(self):\n        self.v = None\n    def m(self):\n        self.v.read()\n";
        let items = compute_attribute_none_items(text);
        let faces = attach_flow_faces(text, &items, None);
        let encoded = serde_json::to_value(&faces[0]).unwrap();
        assert_eq!(encoded["flow"]["hasNone"], json!(true));
        assert_eq!(encoded["flow"]["narrowed"], json!(false));
        assert_eq!(encoded["flow"]["annotation"], json!("None"));
        assert_eq!(encoded["flow"]["types"], json!(["None"]));
    }

}
