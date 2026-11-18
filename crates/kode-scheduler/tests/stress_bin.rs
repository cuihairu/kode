//! 压力车道 CLI 冒烟(COV-004):真实拉起 kode-scheduler-stress 二进制,
//! 走 main 全链(参数/环境解析 → 风暴合并探针 → run_stress → STRESS-OK 报告)。
//! 违规臂(exit 1)只在真实不变量破坏时可达,不伪造。

use std::process::Command;

fn run_bin(args: &[&str], env: &[(&str, &str)]) -> (bool, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_kode-scheduler-stress"));
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("spawn kode-scheduler-stress");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn stress_bin_cli_args_full_run() {
    let (ok, stdout, stderr) = run_bin(
        &[
            "--ops",
            "200",
            "--check-every",
            "50",
            "--cooldown",
            "0",
            "--starvation",
            "2000",
            "--cancel-pct",
            "20",
            "--max-queued",
            "64",
            "--seed",
            "7",
        ],
        &[],
    );
    assert!(ok, "exit!=0 stderr={stderr}");
    assert!(stdout.contains("STRESS-OK created="), "stdout={stdout}");
    assert!(
        stdout.contains("checks=5 "),
        "200/50 → 5 次不变量断言: {stdout}"
    );
    assert!(
        stderr.contains("STRESS-ENV seed=7 ops=200"),
        "stderr={stderr}"
    );
    assert!(stderr.contains("max_queued=64"), "stderr={stderr}");
    assert!(stderr.contains("STORM-OK"), "stderr={stderr}");
}

#[test]
fn stress_bin_env_overrides_and_parse_fallback() {
    // 环境变量注入(cooldown 需显式 0,否则 50ms/op 拖慢);
    // --seed 非数字 → parse 失败回退缺省 1。
    let (ok, stdout, stderr) = run_bin(
        &["--cooldown", "0", "--seed", "xyz"],
        &[("KODE_STRESS_OPS", "50"), ("KODE_STRESS_CHECK_EVERY", "25")],
    );
    assert!(ok, "stderr={stderr}");
    assert!(stdout.contains("STRESS-OK"), "stdout={stdout}");
    assert!(
        stderr.contains("seed=1 ops=50"),
        "env 值生效 + 坏种子回退 1: {stderr}"
    );
}

#[test]
fn dump_scheduler_golden_bin_emits_decision_surface_json() {
    let out = Command::new(env!("CARGO_BIN_EXE_dump-scheduler-golden"))
        .output()
        .expect("spawn dump-scheduler-golden");
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.starts_with('{'), "golden 应为 JSON 对象: {stdout}");
    assert!(stdout.contains("kode-scheduler dump-scheduler-golden"));
}
