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

/// 单次 `ruff check`(2000 文件上限)的墙钟 deadline:正常批次秒级完成,
/// 120s 是含 CI 慢机的极端余量;到点 kill+wait 并如实报超时。
const RUFF_CHECK_DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);
/// `ruff --version` 探测的墙钟 deadline(快命令,10s 极端余量)。
const RUFF_PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// 读取 `KODE_RUFF_DEADLINE_MS`(测试窄化窗)。并行测试下只 set 不 remove:
/// remove 会与其他测试的读取竞态,把别人的窗误读回默认值(2026-11-19 实测
/// 假红:remove_var 被并行读到中间态,挂起测试回落 120s 默认,单测 120.83s)。
pub(crate) fn ruff_deadline(default: std::time::Duration) -> std::time::Duration {
    std::env::var("KODE_RUFF_DEADLINE_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or(default)
}

/// 有界 ruff 执行:[`crate::subprocess::run_bounded`] 统一执行面(并发写
/// stdin/排空 stdout+stderr,deadline 到点 kill+wait,输出字节封顶),外层
/// 套同表暂态 spawn 退避——满载下 fork 偶发 EAGAIN(WouldBlock)/ENOMEM
/// (OutOfMemory)是暂态而非「未安装」(2026-11-08 CI 观察:llvm-cov 全
/// workspace 并行下 probe spawn 瞬败被 `.ok()?` 吞成 available:false,误报
/// ruff 未安装;2026-11-13 nightly linux-arm64 与 2026-11-16 linux-x64 再证,
/// 补 EMFILE/ENFILE(文件表耗尽,raw_os_error 数值判定——std ErrorKind 无
/// 稳定映射,仅 unix)同入暂态族,退避 20/60/150/400ms 四拍)。
fn run_ruff_bounded(
    command: &mut std::process::Command,
    deadline: std::time::Duration,
) -> Result<std::process::Output, String> {
    for backoff in crate::subprocess::SPAWN_BACKOFF_MS {
        match crate::subprocess::run_bounded(command, None, deadline) {
            Ok(bounded) => {
                return Ok(std::process::Output {
                    status: bounded.status,
                    stdout: bounded.stdout,
                    stderr: bounded.stderr,
                })
            }
            Err(crate::subprocess::BoundedError::Spawn(error))
                if crate::subprocess::is_transient_spawn(&error) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(backoff));
            }
            Err(crate::subprocess::BoundedError::Spawn(error)) => {
                return Err(format!("spawn failed: {error}"))
            }
            Err(crate::subprocess::BoundedError::Deadline) => {
                return Err(format!(
                    "timed out after {}ms (process killed)",
                    deadline.as_millis()
                ))
            }
            Err(crate::subprocess::BoundedError::OutputTooLarge) => {
                return Err(format!(
                    "output exceeds {} bytes",
                    crate::subprocess::MAX_OUTPUT_BYTES
                ))
            }
        }
    }
    Err("spawn retries exhausted".to_string())
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
    let output = run_ruff_bounded(&mut cmd, ruff_deadline(RUFF_CHECK_DEADLINE))
        .map_err(|e| format!("ruff check: {e}"))?;
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

/// `ruff --version` 探测;挂起/失败(未安装/不可执行)= None(降级可用面,
/// 不无限等;暂态 fork 失败由 run_ruff_bounded 重试,不在此误判)。
pub(crate) fn probe_version(program: &str) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command.arg("--version");
    let output = run_ruff_bounded(&mut command, ruff_deadline(RUFF_PROBE_DEADLINE)).ok()?;
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

    /// 缺二进制(NotFound,永久性失败)不进退避重试,如实回落
    /// `available:false` 面(2026-11-16 nightly linux-x64 暂态族修复同笔钉:
    /// 重试族只收暂态错误,NotFound 必须短路)。
    #[test]
    fn missing_binary_falls_back_to_unavailable_face() {
        let dir = temp_dir("missing");
        let missing = dir.join("no-such-ruff");
        let face = lint(
            &["/w/x.py".to_string()],
            Some(missing.to_str().expect("utf8 path")),
        )
        .expect("缺二进制如实回退不报错");
        assert_eq!(face["available"], serde_json::json!(false));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// KODE-FULL-004:挂起面有界收割。探测 stub 永挂 → probe 降级 None;
    /// check stub 版本即回、check 永挂 → 到点 kill+wait,如实报超时(不吞成
    /// available:false)。KODE_RUFF_DEADLINE_MS 窄化窗只 set 不 remove(并行
    /// 测试竞态判例:remove_var 会被别的测试读走,窗漂回默认造成假红)。
    #[test]
    fn hanging_stub_times_out_and_probe_degrades() {
        let version_dir = temp_dir("hang-v");
        #[cfg(unix)]
        let version_stub = {
            let script = version_dir.join("hang.sh");
            std::fs::write(&script, "#!/bin/sh\nexec sleep 300\n").expect("write hang stub");
            std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .expect("chmod");
            script
        };
        #[cfg(windows)]
        let version_stub = compile_stub(
            &version_dir,
            "fn main() { std::thread::sleep(std::time::Duration::from_secs(300)); }",
        );
        std::env::set_var("KODE_RUFF_DEADLINE_MS", "300");
        // 探测面挂起:降级 None,不无限等(墙钟 ~300ms 级)。
        assert_eq!(
            probe_version(version_stub.to_str().expect("utf8 path")),
            None
        );

        let check_dir = temp_dir("hang-c");
        #[cfg(unix)]
        let check_stub = {
            let script = check_dir.join("hang.sh");
            std::fs::write(
                &script,
                "#!/bin/sh\n\
                 if [ \"$1\" = \"--version\" ]; then echo \"ruff 0.0.0-fake\"; exit 0; fi\n\
                 exec sleep 300\n",
            )
            .expect("write hang stub");
            std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .expect("chmod");
            script
        };
        #[cfg(windows)]
        let check_stub = compile_stub(
            &check_dir,
            "fn main() { \
             if std::env::args().any(|a| a == \"--version\") { println!(\"ruff 0.0.0-fake\"); return; } \
             std::thread::sleep(std::time::Duration::from_secs(300)); }",
        );
        // check 面:probe 即回,check 挂起 → Deadline 如实报错(非 available:false)。
        let error = lint(
            &["/w/x.py".to_string()],
            Some(check_stub.to_str().expect("utf8 path")),
        )
        .expect_err("挂起 check 必须报超时");
        assert!(error.contains("ruff check"), "{error}");
        assert!(error.contains("timed out"), "{error}");
        std::fs::remove_dir_all(&version_dir).ok();
        std::fs::remove_dir_all(&check_dir).ok();
    }
}
