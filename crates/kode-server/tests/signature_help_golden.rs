//! SignatureHelp 决策核 golden 重生成比对(RUST-140 批 2;Rust 侧真值;
//! TS 侧 tests/kodeSignatureHelpParity.test.ts 用生产词法面 + 生产注解链
//! 复算同一 golden,形成双向对拍,references/python-call-at 同构)。

use kode_server::dump_signature_help_golden;
use kode_server::signature_help::{clamp_active_parameter, format_def_method_signature};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn signature_help_golden_matches_regenerated_dump() {
    let regenerated = dump_signature_help_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::signature_help::SIGNATURE_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/signature-help-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "signature help golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-signature-help-golden -- . > crates/kode-server/tests/golden/signature-help-parity.json"
        );
    }
    assert!(committed.contains("\"hitCount\":"));
    assert!(committed.contains("dump-signature-help-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    generator: String,
    file_count: usize,
    probe_count: usize,
    hit_count: usize,
    resolved_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    probe_count: usize,
    hit_count: usize,
    entries: Vec<GoldenEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenEntry {
    line: u32,
    call: GoldenCall,
    help: GoldenHelp,
    activations: Vec<GoldenActivation>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCall {
    method_name: String,
    section: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenHelp {
    label: String,
    parameters: Vec<String>,
    documentation: String,
    definition: GoldenDef,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDef {
    #[allow(dead_code)]
    file: String,
    #[allow(dead_code)]
    line: u32,
    section: String,
    exposed: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenActivation {
    #[allow(dead_code)]
    character: usize,
    active_argument: u32,
    active_parameter: u32,
}

#[test]
fn signature_help_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::signature_help::SIGNATURE_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Dump = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON");

    // 与批 1 词法 golden 逐字对账:同一语料同一探测口径,词法命中全集必须
    // 同值(决策核消费面 anchored 在批 1 面上,不另起探测)。
    let call_at: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            repo_root().join("crates/kode-server/tests/golden/python-call-at-parity.json"),
        )
        .expect("批 1 golden"),
    )
    .expect("批 1 golden JSON");
    assert_eq!(
        value.file_count,
        call_at["fileCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        value.probe_count,
        call_at["probeCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        value.hit_count,
        call_at["hitCount"].as_u64().unwrap() as usize
    );

    // 逐文件对账 + 组内完整性。
    assert!(
        value.hit_count > 0 && value.resolved_count > 0,
        "语料上应有词法命中与解析命中"
    );
    assert!(
        value.resolved_count < value.hit_count,
        "未解析命中位应真实存在(边界面不虚报)"
    );
    let mut activation_total = 0usize;
    let mut hit_total = 0usize;
    let mut probe_total = 0usize;
    const SECTIONS: &[&str] = &["BaseMethods", "CellMethods", "ClientMethods"];
    for file in &value.files {
        hit_total += file.hit_count;
        probe_total += file.probe_count;
        for entry in &file.entries {
            assert!(!entry.activations.is_empty(), "条目必有激活位");
            assert!(
                entry
                    .activations
                    .windows(2)
                    .all(|w| w[0].character < w[1].character),
                "激活位按 character 升序"
            );
            // 组内确定性:解析只依赖 (python 文件, 方法名, 段),签名四件
            // 组内唯一;activeParameter 逐位夹取一致。
            for activation in &entry.activations {
                assert_eq!(
                    activation.active_parameter,
                    clamp_active_parameter(activation.active_argument, entry.help.parameters.len()),
                    "activeParameter 夹取口径(行 {})",
                    entry.line
                );
            }
            // label 组装重算:与 call 方法名 + parameters 逐字一致。
            assert_eq!(
                entry.help.label,
                format_def_method_signature(&entry.call.method_name, &entry.help.parameters),
                "label 组装面(行 {})",
                entry.line
            );
            assert!(
                SECTIONS.contains(&entry.help.definition.section.as_str()),
                "声明段越界: {}",
                entry.help.definition.section
            );
            // documentation 三段拼接。
            let mut expected = format!(
                "此调用是实体 def 声明的 {} 方法",
                entry.help.definition.section
            );
            if let Some(receiver) = &entry.call.section {
                expected.push_str(&format!("(接收者 self.{receiver})"));
            }
            if entry.help.definition.exposed {
                expected.push_str(" · **Exposed**: 可被客户端远程调用");
            }
            assert_eq!(
                entry.help.documentation, expected,
                "documentation 拼接(行 {})",
                entry.line
            );
            activation_total += entry.activations.len();
        }
    }
    assert_eq!(hit_total, value.hit_count, "逐文件命中和对账");
    assert_eq!(probe_total, value.probe_count, "逐文件探针和对账");
    assert_eq!(
        activation_total, value.resolved_count,
        "resolvedCount 与逐条激活位和不一致"
    );
    // 区分度真分布钉:至少一个 exposed 声明与一个带形参签名的条目在场,
    // 组装面退化(恒空参/恒非 exposed)会在此红。
    let any_exposed = value
        .files
        .iter()
        .any(|f| f.entries.iter().any(|e| e.help.definition.exposed));
    let any_params = value
        .files
        .iter()
        .any(|f| f.entries.iter().any(|e| !e.help.parameters.is_empty()));
    let any_bare = value.files.iter().any(|f| {
        f.entries
            .iter()
            .any(|e| e.help.parameters.iter().any(|p| !p.contains(": ")))
    });
    assert!(any_exposed, "语料上应有 Exposed 声明条目");
    assert!(any_params, "语料上应有带形参签名条目");
    // 语料自洽口径:全部已解析 `<Arg>` 都经内建直查命中(无链断降级形参),
    // 只出名不造型臂由合成单测钉(parameter_annotation_boundaries)闭环,
    // 不在此强设真分布断言。
    let _ = any_bare;
}
