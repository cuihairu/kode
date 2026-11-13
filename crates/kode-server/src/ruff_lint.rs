//! .py 源码 lint via ruff(IDE-RUST-005,A 案:shell out 到 ruff 二进制)。
//!
//! 命令面 `$/kode/ruff/lint`(经 `$/kode/rpc` 单臂派发):入参
//! `{files: string[], ruffPath?: string}`,出
//! `{available, version?, diags: [{file,line,col,endLine,endCol,code,message,
//! severity,fixable}]}`。
//!
//! - **零 API 耦合**:不嵌 ruff_linter crate,只 spawn 二进制;升级 ruff 不动本模块。
//! - **py37 锁死**:KBEngine 3.7.3 的 Python 面向 3.7,恒传
//!   `--target-version py37`(ruff 按此裁规则集)。
//! - **不写用户工作区**:`--no-cache`——绝不落 `.ruff_cache/` 进 KBEngine 工程。
//! - **缺 ruff 如实回退不报错**:`available:false`(A 案口径「无 ruff 回退不报」);
//!   TS 侧据此提供 pip 安装入口(同意式,绝不静默装)。
//! - `ruffPath` 由 TS 显式传(解释器 bin 下定位);缺省回落 PATH 上的 `ruff`。
//! - 输出按 (file,line,col) 稳定排序;severity:E9xx(ruff 语法/IO 错误族)→
//!   error,其余 warning。

use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

/// 单次 lint 的文件数上限(有界;超限如实报错让 TS 分批,不静默截断)。
const MAX_FILES_PER_CALL: usize = 2000;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/ruff/lint", ruff_lint_handler);
}

fn ruff_lint_handler(params: Value) -> Result<Value, String> {
    let ruff_path = params
        .get("ruffPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let files: Vec<String> = params
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    lint(&files, ruff_path.as_deref())
}

/// 探测可用性并执行 lint。缺二进制 → `available:false`(不报错);文件空 →
/// 只探测版本;其余失败(present 但坏输出/坏旗标/非零退出)如实 Err。
/// spawn 出完整输出;满载下 fork 偶发 EAGAIN(WouldBlock)/ENOMEM(OutOfMemory)
/// 是暂态而非「未安装」,短退避重试(20/60/150ms 三拍),仍败才按原错误回落
/// (2026-11-08 CI 观察:llvm-cov 全 workspace 并行下 probe spawn 瞬败被
/// `.ok()?` 吞成 available:false,误报 ruff 未安装;2026-11-13 nightly
/// linux-arm64 实测单拍 20ms 仍可被打穿,同测试上一轮全绿、下一轮红=纯暂态)。
fn spawn_output(command: &mut std::process::Command) -> std::io::Result<std::process::Output> {
    const BACKOFF_MS: [u64; 3] = [20, 60, 150];
    for backoff in BACKOFF_MS {
        match command.output() {
            Ok(output) => return Ok(output),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::OutOfMemory
                ) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(backoff));
            }
            Err(error) => return Err(error),
        }
    }
    command.output()
}

fn lint(files: &[String], ruff_path: Option<&str>) -> Result<Value, String> {
    if files.len() > MAX_FILES_PER_CALL {
        return Err(format!(
            "ruff lint: too many files in one call ({} > {MAX_FILES_PER_CALL}); batch on the TS side",
            files.len()
        ));
    }
    let program = ruff_path.unwrap_or("ruff");
    let version = match probe_version(program) {
        Some(version) => version,
        None => {
            // spawn 失败(NotFound/权限)= 未安装,如实回退不报。
            return Ok(json!({ "available": false, "diags": [] }));
        }
    };
    if files.is_empty() {
        return Ok(json!({ "available": true, "version": version, "diags": [] }));
    }

    let mut cmd = std::process::Command::new(program);
    cmd.args([
        "check",
        "--target-version",
        "py37",
        "--output-format",
        "json",
        "--exit-zero",
        "--no-cache",
        "--",
    ]);
    cmd.args(files);
    let output = spawn_output(&mut cmd).map_err(|e| format!("ruff check: spawn failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ruff check failed (exit {:?}, ruff {version}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Vec<Value> = serde_json::from_str(&stdout)
        .map_err(|e| format!("ruff check: failed to parse JSON output (ruff {version}): {e}"))?;
    let mut diags: Vec<Value> = parsed
        .iter()
        .map(|item| {
            let code = item.get("code").and_then(|v| v.as_str()).unwrap_or("");
            json!({
                "file": item.get("filename").and_then(|v| v.as_str()).unwrap_or(""),
                "line": item.get("location").and_then(|l| l.get("row")).and_then(|v| v.as_u64()).unwrap_or(0),
                "col": item.get("location").and_then(|l| l.get("column")).and_then(|v| v.as_u64()).unwrap_or(0),
                "endLine": item.get("end_location").and_then(|l| l.get("row")).and_then(|v| v.as_u64()).unwrap_or(0),
                "endCol": item.get("end_location").and_then(|l| l.get("column")).and_then(|v| v.as_u64()).unwrap_or(0),
                "code": code,
                "message": item.get("message").and_then(|v| v.as_str()).unwrap_or(""),
                // E9xx = ruff 语法/IO 错误族(E902 IO/E999 syntax),其余按 warning 报。
                "severity": if code.starts_with("E9") { "error" } else { "warning" },
                "fixable": item.get("fix").map(|f| !f.is_null()).unwrap_or(false),
            })
        })
        .collect();
    diags.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                v.get("file")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                v.get("line").and_then(|x| x.as_u64()).unwrap_or(0),
                v.get("col").and_then(|x| x.as_u64()).unwrap_or(0),
            )
        };
        key(a).cmp(&key(b))
    });
    Ok(json!({ "available": true, "version": version, "diags": diags }))
}

/// `ruff --version` 探测;spawn 失败(未安装/不可执行)= None(暂态 fork 失败
/// 由 spawn_output 重试,不在此误判)。
fn probe_version(program: &str) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command.arg("--version");
    let output = spawn_output(&mut command).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn compile_stub(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        let source = dir.join("stub.rs");
        let executable = dir.join("stub.exe");
        std::fs::write(&source, body).expect("write native fixture");
        let output = std::process::Command::new("rustc")
            .arg("--crate-name")
            .arg("kode_ruff_fixture")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("compile native fixture");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        executable
    }

    /// 唯一临时目录(进程 id 隔离),测试后清理。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kode-ruff-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        dir
    }

    /// 探测失败如实回 None:非零退出与空输出两种。
    #[test]
    fn probe_version_rejects_failing_and_silent_programs() {
        assert_eq!(probe_version("/bin/false"), None);
        // exit 0 但 --version 无输出 → 同样不算可用版本。
        let dir = temp_dir("silent");
        #[cfg(unix)]
        let script = dir.join("silent.sh");
        #[cfg(unix)]
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").expect("write silent script");
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("chmod");
        #[cfg(windows)]
        let script = compile_stub(&dir, "fn main() {}");
        assert_eq!(probe_version(script.to_str().expect("utf8 path")), None);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// ruff 存在但 check 非零退出(--exit-zero 也压不住的失败,如坏旗标/IO)
    /// → 如实 Err,带退出码与 stderr,不静默吞。
    #[test]
    fn nonzero_check_exit_is_surfaced_as_err() {
        let dir = temp_dir("check-fail");
        #[cfg(unix)]
        let script = dir.join("fake-ruff.sh");
        #[cfg(unix)]
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo \"ruff 0.0.0-fake\"; exit 0; fi\n\
             echo boom >&2\n\
             exit 3\n",
        )
        .expect("write fake ruff");
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("chmod");
        #[cfg(windows)]
        let script = compile_stub(
            &dir,
            "fn main() { if std::env::args().any(|a| a == \"--version\") { \
             println!(\"ruff 0.0.0-fake\"); return; } \
             eprintln!(\"boom\"); std::process::exit(3); }",
        );
        let error = lint(
            &["/w/x.py".to_string()],
            Some(script.to_str().expect("utf8 path")),
        )
        .expect_err("非零退出应报错");
        assert!(error.contains("ruff check failed"), "{error}");
        assert!(error.contains("Some(3)"), "{error}");
        assert!(error.contains("ruff 0.0.0-fake"), "{error}");
        assert!(error.contains("boom"), "{error}");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
