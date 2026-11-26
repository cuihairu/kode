//! RUST-183 验收钉:运行时管理(Process/Telnet/Watcher/Log)留在 service
//! adapter 层,语义 Core 零承载。
//!
//! 运行时四面的编排全部住在 TS 扩展宿主的 adapter 面:Telnet 协议客户端
//! (src/backend/telnetClient.ts,纯核零 vscode,对齐引擎 telnet_server.cpp
//! 密码协商与 IAC;断线回探测态+`isCommandAllowed` 白名单+`:quit` 恒拒)、
//! Process(processManager)、Log(logCollector autoReconnect+在册 socket
//! 只拆自己)、Watcher(实体映射/调试配置 watch)。Core 对它们零承载,两层
//! 固化:
//! ① RPC 注册表面——`$/kode/*` 生产注册表零连接/派生类运行时管理方法
//!    (telnet/connect/spawn 片段);process 相关只允许定义期静态校验面
//!    `$/kode/processTopology/validate`(C-17:校验 process_topology.xml
//!    部署清单出 lint 预警,读声明文件、零活体进程接触)——该面在此显式
//!    白名单,出现第二个 process 方法即红。
//! ② 源面陈旧防——两核 crate 源码零引擎侧传输记号(TcpStream/TcpListener/
//!    tokio::net):Core 只讲 stdio LSP,不开引擎侧 socket。派生面唯一例外
//!    是 ruff lint 工具调起(ruff_lint.rs 的 Command::new,IO 泳道),不在
//!    记号钉范围;config 面的 caps.telnet.enabled 是能力事实回报(读配置
//!    得布尔),也不是连接管理。

use kode_server::ServerState;
use std::path::{Path, PathBuf};

/// 连接/派生类运行时管理方法名禁入片段(注册一个即红)。
const FORBIDDEN_METHOD_FRAGMENTS: &[&str] = &["telnet", "connect", "spawn"];

/// process 相关方法的唯一白名单面(定义期静态校验,非活体管理)。
const ALLOWED_PROCESS_METHOD: &str = "$/kode/processTopology/validate";

/// Core 源面禁入的引擎侧传输记号(实现即携带,注释豁免)。
const FORBIDDEN_SOURCE_TOKENS: &[&str] = &["TcpStream", "TcpListener", "tokio::net"];

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("读目录 {} 失败: {e}", dir.display()));
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
fn scan_for_tokens(dir: &Path, tokens: &[&str]) -> (usize, Vec<String>) {
    let mut files = Vec::new();
    collect_rs_files(dir, &mut files);
    let mut violations = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file)
            .unwrap_or_else(|e| panic!("读 {} 失败: {e}", file.display()));
        for (idx, raw) in text.lines().enumerate() {
            let line = raw.trim_start();
            if line.starts_with("//") {
                continue;
            }
            for token in tokens {
                if line.contains(token) {
                    violations.push(format!("{}:{} 记号 `{token}`", file.display(), idx + 1));
                }
            }
        }
    }
    (files.len(), violations)
}

#[test]
fn rpc_registry_exposes_no_runtime_management_methods() {
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
    assert!(
        names.iter().any(|m| m == ALLOWED_PROCESS_METHOD),
        "定义期拓扑校验面 {ALLOWED_PROCESS_METHOD} 应在注册表(它读部署清单出预警,是语义面非运行时管理)"
    );
    for name in &names {
        for fragment in FORBIDDEN_METHOD_FRAGMENTS {
            assert!(
                !name.to_lowercase().contains(fragment),
                "语义 Core RPC 注册表出现运行时管理方法 `{name}`(禁入片段 `{fragment}`):Telnet/连接/派生编排归 TS service adapter"
            );
        }
        if name.to_lowercase().contains("process") {
            assert_eq!(
                name, ALLOWED_PROCESS_METHOD,
                "process 相关方法只允许定义期校验面 {ALLOWED_PROCESS_METHOD},出现第二个即越界"
            );
        }
    }
}

#[test]
fn core_crates_source_carries_no_engine_transport_tokens() {
    let server_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let (server_files, server_hits) = scan_for_tokens(&server_dir, FORBIDDEN_SOURCE_TOKENS);
    assert!(
        server_files >= 100,
        "kode-server 源文件数异常少({server_files}),扫描面失效"
    );
    assert!(
        server_hits.is_empty(),
        "kode-server 源面出现引擎侧传输记号:\n{}",
        server_hits.join("\n")
    );

    let python_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../kode-python/src");
    let (python_files, python_hits) = scan_for_tokens(&python_dir, FORBIDDEN_SOURCE_TOKENS);
    assert!(
        python_files >= 10,
        "kode-python 源文件数异常少({python_files}),扫描面失效"
    );
    assert!(
        python_hits.is_empty(),
        "kode-python 源面出现引擎侧传输记号:\n{}",
        python_hits.join("\n")
    );
}
