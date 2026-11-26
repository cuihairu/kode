//! dump-protocol-schema CLI smoke test: CARGO_BIN_EXE really launches the binary, and stdout must be
//! a valid JSON Schema with a version header (the bin leg of the RUST-055 single-source export chain;
//! isomorphic to kode-index/tests/bin_cli.rs).

use std::process::Command;

#[test]
fn dump_protocol_schema_cli_emits_versioned_schema() {
    let output = Command::new(env!("CARGO_BIN_EXE_dump-protocol-schema"))
        .output()
        .expect("拉起 dump-protocol-schema");
    assert!(output.status.success(), "退出码非零: {:?}", output.status);
    let stdout = String::from_utf8(output.stdout).expect("stdout 非法 UTF-8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("stdout 必须是合法 JSON");
    assert_eq!(value["title"], "KodeProtocol", "根标题固定字面量");
    assert_eq!(
        value["x-kode-protocol-version"],
        kode_protocol::PROTOCOL_VERSION,
        "版本头与 Rust 常量同源(TS 门三方对账的 Rust 腿)"
    );
    // The aggregation root's fields are the type inventory: the wire top-level faces are complete,
    // and `$defs` collects all sub-types.
    for key in [
        "request",
        "notification",
        "server_notification",
        "response",
        "response_error",
    ] {
        assert!(
            value["properties"].get(key).is_some(),
            "聚合根缺 {key} 字段"
        );
    }
    assert!(
        value["definitions"]
            .as_object()
            .is_some_and(|defs| !defs.is_empty()),
        "definitions 必须收全部 wire 子类型(draft-07)"
    );
}
