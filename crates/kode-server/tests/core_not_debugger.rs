//! RUST-182 验收钉:语义 Core 不兼任 debugger。
//!
//! 两层命名固化:
//! ① RPC 注册表面——`$/kode/*` 生产注册表零 debug 承载方法:Python 调试
//!    (KODE-DBG-001 注入 / autoDebugpy 三件套 / waitAtStartup 早期断点)、
//!    远端 attach(端口探测 + 隧道 + attachWithDeadline 截止取消闸)全部
//!    住在 TS 扩展宿主,经 VS Code debug API 驱动外部 debugpy;Core 的
//!    RPC 面不给 debug 开口(注册一个即红)。
//! ② 源面陈旧防——kode-server 与 kode-python 两个核 crate 的源码不携带
//!    任何 debugger 实现记号(debugpy/breakpoint/DebugAdapter/
//!    debug_adapter/startDebugging)。注释行(// 开头)豁免——头注可以
//!    如实描述「调试面在 TS」的架构事实,实现记号不许出现在代码里。
//!    非空守卫钉住文件数下限,防静默走空目录造假绿。

use kode_server::ServerState;
use std::path::{Path, PathBuf};

/// debugger 实现记号(实现即携带,注释豁免)。
const DEBUGGER_TOKENS: &[&str] = &[
    "debugpy",
    "breakpoint",
    "DebugAdapter",
    "debug_adapter",
    "startDebugging",
];

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("读目录 {} 失败: {e}", dir.display()));
    for entry in entries {
        let entry = entry.unwrap_or_else(|e| panic!("目录项读取失败: {e}"));
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// 逐文件剥 // 注释行后做记号扫描;返回 (文件数, 违例清单)。
fn scan_for_debugger_tokens(dir: &Path) -> (usize, Vec<String>) {
    let mut files = Vec::new();
    collect_rs_files(dir, &mut files);
    let mut violations = Vec::new();
    for file in &files {
        let text =
            std::fs::read_to_string(file).unwrap_or_else(|e| panic!("读 {} 失败: {e}", file.display()));
        for (idx, raw) in text.lines().enumerate() {
            let line = raw.trim_start();
            if line.starts_with("//") {
                continue;
            }
            for token in DEBUGGER_TOKENS {
                if line.contains(token) {
                    violations.push(format!("{}:{} 记号 `{token}`", file.display(), idx + 1));
                }
            }
        }
    }
    (files.len(), violations)
}

#[test]
fn rpc_registry_exposes_no_debugging_methods() {
    let state = ServerState::new();
    let snapshot = state.rpc.snapshot();
    let names: Vec<String> = snapshot.methods().map(|s| s.to_string()).collect();
    // 非空守卫:注册表是真读到了生产面(防静默空表造假绿)
    assert!(
        names.len() >= 20,
        "注册表方法数异常少({}),快照面可能失效",
        names.len()
    );
    assert!(
        names.iter().any(|m| m == "$/kode/databaseSchema/build"),
        "serving 基准面缺失,快照不可信"
    );
    for name in &names {
        assert!(
            !name.to_lowercase().contains("debug"),
            "语义 Core RPC 注册表出现 debug 承载方法 `{name}`:调试编排归 TS 扩展宿主(外部 debugpy),Core 不兼任 debugger"
        );
    }
}

#[test]
fn core_crates_source_carries_no_debugger_tokens() {
    let server_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let (server_files, server_hits) = scan_for_debugger_tokens(&server_dir);
    assert!(
        server_files >= 100,
        "kode-server 源文件数异常少({server_files}),扫描面失效"
    );
    assert!(server_hits.is_empty(), "kode-server 源面出现 debugger 记号:\n{}", server_hits.join("\n"));

    let python_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../kode-python/src");
    let (python_files, python_hits) = scan_for_debugger_tokens(&python_dir);
    assert!(
        python_files >= 10,
        "kode-python 源文件数异常少({python_files}),扫描面失效"
    );
    assert!(python_hits.is_empty(), "kode-python 源面出现 debugger 记号:\n{}", python_hits.join("\n"));
}
