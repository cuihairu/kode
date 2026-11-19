//! CodeAction 装配 golden 重生成比对(RUST-143 批 2;Rust 侧真值;TS 侧
//! tests/kodeCodeActionAssemblyParity.test.ts 驱动生产 provider 对拍,
//! code-action 同构)。

use kode_server::code_action_assembly::{
    CODE_ACTION_ASSEMBLY_GOLDEN_REL_PATH, DEF_PYTHON_PARITY_DIAGNOSTIC_CODE,
    FIXED_DICT_NESTED_MUTATION_CODE, RECEIVER_NONE_DIAGNOSTIC_CODE, UNKNOWN_TYPE_DIAGNOSTIC_CODE,
};
use kode_server::dump_code_action_assembly_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn code_action_assembly_golden_matches_regenerated_dump() {
    let regenerated = dump_code_action_assembly_golden();
    let golden_path = repo_root().join(CODE_ACTION_ASSEMBLY_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path).expect(
        "golden 文件缺失: crates/kode-server/tests/golden/code-action-assembly-parity.json",
    );
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "code action assembly golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-code-action-assembly-golden > crates/kode-server/tests/golden/code-action-assembly-parity.json"
        );
    }
    assert!(committed.contains("\"actionCount\":"));
    assert!(committed.contains("dump-code-action-assembly-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    generator: String,
    case_count: usize,
    action_count: usize,
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    actions: Vec<Action>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Action {
    kind: String,
    title: String,
    edit: serde_json::Value,
    diagnostic_start_line: usize,
}

#[test]
fn code_action_assembly_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(CODE_ACTION_ASSEMBLY_GOLDEN_REL_PATH))
        .expect("golden");
    let value: Dump = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON");

    // 计数守恒:actionCount = 逐 case 和;四族案例齐;actionCount > 0。
    let case_sum: usize = value.cases.iter().map(|c| c.actions.len()).sum();
    assert_eq!(value.action_count, case_sum, "actionCount 与逐 case 和对账");
    assert_eq!(value.case_count, value.cases.len());
    assert_eq!(value.case_count, 4, "四族案例齐");
    assert!(value.action_count > 0);
    let names: Vec<&str> = value.cases.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "type-replacement",
            "parity-method",
            "receiver-none-guard",
            "fixed-dict-whole-reassign"
        ]
    );

    // 逐动作面:kind 值域/标题前缀与族对应/编辑形态域/诊断行在场。
    let mut saw_wrap_first = false;
    for case in &value.cases {
        for action in &case.actions {
            assert!(
                action.kind == "QuickFix" || action.kind == "Refactor",
                "kind 值域"
            );
            let edit_type = action
                .edit
                .get("type")
                .and_then(|v| v.as_str())
                .expect("编辑形态 tag");
            assert!(
                matches!(edit_type, "replaceRange" | "insertLine" | "replaceLines"),
                "编辑形态域: {edit_type}"
            );
            assert!(action.edit.get("file").is_some(), "编辑带目标文件");
            match case.name.as_str() {
                "type-replacement" => {
                    assert!(action.title.starts_with("Replace with registered type "));
                    assert_eq!(edit_type, "replaceRange");
                }
                "parity-method" => {
                    assert!(action.title.starts_with("Generate method "));
                    assert!(!action.title.contains("raise"));
                    assert_eq!(edit_type, "insertLine");
                    assert_eq!(
                        action.title, "Generate method onTalk \u{2192} /w/scripts/avatar.py:9",
                        "方法名真文本 + 1 基展示行"
                    );
                    assert_eq!(action.diagnostic_start_line, 5, "诊断对账行");
                }
                "receiver-none-guard" => {
                    // 包裹式在先(整行段替换),早退式在后(行首插入)。
                    if action.title.starts_with("Wrap with null guard") {
                        assert!(!saw_wrap_first, "包裹式只一条");
                        saw_wrap_first = true;
                        assert_eq!(edit_type, "replaceLines");
                    } else if action.title.starts_with("Insert None guard") {
                        assert!(saw_wrap_first, "早退式在包裹式之后");
                        assert_eq!(edit_type, "insertLine");
                    } else {
                        panic!("守卫族标题越界: {}", action.title);
                    }
                }
                "fixed-dict-whole-reassign" => {
                    assert!(action.title.starts_with("Whole reassign:"));
                    assert_eq!(edit_type, "replaceLines");
                }
                _ => panic!("未知案例: {}", case.name),
            }
        }
    }
    assert!(saw_wrap_first, "守卫族应有包裹式正臂");

    // 负臂在场:每族案例的动作数与真实语义一致(重臂去重/闸外归零)。
    let counts: std::collections::BTreeMap<&str, usize> = value
        .cases
        .iter()
        .map(|c| (c.name.as_str(), c.actions.len()))
        .collect();
    assert_eq!(
        counts["type-replacement"], 1,
        "UNIT64 距离 4 出闸,只 UINT32 dist1"
    );
    assert_eq!(counts["parity-method"], 1, "related 缺失 + 同键去重归一");
    assert_eq!(
        counts["receiver-none-guard"], 2,
        "wrap+guard 双动作,同键第二诊断去重"
    );
    assert_eq!(counts["fixed-dict-whole-reassign"], 1, "同行去重归一");
}

/// 诊断 code 常量与 TS 生产面同值(KODE-AUD-002 三方对账;lint id 族直通)。
#[test]
fn diagnostic_codes_match_ts_production_values() {
    assert_eq!(UNKNOWN_TYPE_DIAGNOSTIC_CODE, "kbengine.unknownType");
    assert_eq!(
        DEF_PYTHON_PARITY_DIAGNOSTIC_CODE,
        "def-method-missing-in-python"
    );
    assert_eq!(RECEIVER_NONE_DIAGNOSTIC_CODE, "kbengine.receiverNone");
    assert_eq!(
        FIXED_DICT_NESTED_MUTATION_CODE,
        "kbengine.fixedDictNestedMutation"
    );
}
