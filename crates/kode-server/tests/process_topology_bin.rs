//! `validate-process-topology` CI bin 测(C-17)。
//!
//! 对夹具 workspace:五进程正确拓扑 exit 0、缺 dbmgr 拓扑 exit 1(CI 拦截);
//! 无清单目录 exit 0(静默零发现)。

use std::path::PathBuf;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_validate-process-topology")
}

fn ws(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p.push("tests/fixtures/process-topology");
    p.push(name);
    p
}

#[test]
fn correct_topology_exits_zero() {
    let out = Command::new(bin()).arg(ws("ws")).output().unwrap();
    assert!(
        out.status.success(),
        "正确拓扑应 exit 0, stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("ok"));
}

#[test]
fn missing_dbmgr_exits_one() {
    let out = Command::new(bin()).arg(ws("ws-no-dbmgr")).output().unwrap();
    assert!(
        !out.status.success(),
        "缺 dbmgr 拓扑应 exit 1(CI 拦截), stdout={}",
        String::from_utf8_lossy(&out.stdout)
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("processTopologyMissingDbmgr"),
        "stderr 应含 D3 码, got: {stderr}"
    );
}

#[test]
fn no_manifest_exits_zero() {
    // 指向不含 process_topology.xml 的目录(demo-assets 脚本目录)。
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p.push("tests/fixtures/kbengine-demo-assets");
    let out = Command::new(bin()).arg(p).output().unwrap();
    assert!(out.status.success(), "无清单应 exit 0");
}
