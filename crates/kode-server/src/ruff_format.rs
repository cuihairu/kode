//! .py 源码 format via ruff(2026-11-18 批 A,巡检单
//! kode-ruff-format-statusbar.md;A 案 shell out,与 ruff_lint 同源口径)。
//!
//! 命令面 `$/kode/ruff/format`(经 `$/kode/rpc` 单臂派发):入参
//! `{content: string, fileName: string, ruffPath?: string}`,出
//! `{available, version?, formatted}`。
//!
//! - **stdin→stdout 管道**:`ruff format --stdin-filename <file> -`——文件
//!   不落盘,内容经 stdin 进、格式化结果经 stdout 回(内容无损 roundtrip)。
//! - **py37 锁死**:与 ruff_lint 同判——KBEngine 3.7.3 的 Python 面向 3.7,
//!   恒传 `--target-version py37`。
//! - **不写用户工作区**:`--no-cache`(与 ruff_lint 同口径,绝不落
//!   `.ruff_cache/` 进 KBEngine 工程)。
//! - **缺 ruff 如实回退不报错**:`available:false`(A 案口径;TS 侧据此走
//!   同意式安装先例)。
//! - **失败如实 Err**:present 但非零退出(坏旗标/IO/语法崩)带退出码与
//!   stderr,不静默吞(与 ruff_lint check 同面)。
//! - `ruffPath` 由 TS 显式传(解释器 bin 下定位);缺省回落 PATH 上的 `ruff`。
//! - 版本探测共用 ruff_lint(probe_version 提升 pub(crate) 共享);format 面
//!   stdin 形状不同,走 subprocess::run_bounded 有界管道(同暂态族同表退避,
//!   见 spawn_format_pipe)。

use serde_json::{json, Value};

use crate::rpc::RpcRegistry;
use crate::ruff_lint::{probe_version, ruff_deadline};
use crate::subprocess;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/ruff/format", ruff_format_handler);
}

fn ruff_format_handler(params: Value) -> Result<Value, String> {
    let ruff_path = params
        .get("ruffPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ruff format: missing content".to_string())?
        .to_string();
    let file_name = params
        .get("fileName")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ruff format: missing fileName".to_string())?
        .to_string();
    format_content(&content, &file_name, ruff_path.as_deref())
}

/// 单次 format 的墙钟 deadline(单文件快命令,60s 极端余量)。
const RUFF_FORMAT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// stdin 管道有界执行:subprocess::run_bounded 统一执行面(并发写 stdin 与
/// 排空 stdout/stderr——旧实现先写完再 wait,大文件双向塞满管道即互等
/// 死锁;deadline 到点 kill+wait,输出字节封顶),外层同表暂态 spawn 退避
/// (与 ruff_lint 同族同表);stdin 写入与等待本身不重试(真失败如实 Err)。
fn spawn_format_pipe(
    program: &str,
    args: &[&str],
    stdin_data: &str,
    deadline: std::time::Duration,
) -> Result<std::process::Output, String> {
    for backoff in subprocess::SPAWN_BACKOFF_MS {
        let mut command = std::process::Command::new(program);
        command.args(args);
        match subprocess::run_bounded(&mut command, Some(stdin_data.as_bytes().to_vec()), deadline)
        {
            Ok(bounded) => {
                return Ok(std::process::Output {
                    status: bounded.status,
                    stdout: bounded.stdout,
                    stderr: bounded.stderr,
                })
            }
            Err(subprocess::BoundedError::Spawn(error))
                if subprocess::is_transient_spawn(&error) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(backoff));
            }
            Err(subprocess::BoundedError::Spawn(error)) => {
                return Err(format!("spawn failed: {error}"))
            }
            Err(subprocess::BoundedError::Deadline) => {
                return Err(format!(
                    "timed out after {}ms (process killed)",
                    deadline.as_millis()
                ))
            }
            Err(subprocess::BoundedError::OutputTooLarge) => {
                return Err(format!(
                    "output exceeds {} bytes",
                    subprocess::MAX_OUTPUT_BYTES
                ))
            }
        }
    }
    Err("spawn retries exhausted".to_string())
}

fn format_content(
    content: &str,
    file_name: &str,
    ruff_path: Option<&str>,
) -> Result<Value, String> {
    let program = ruff_path.unwrap_or("ruff");
    let version = match probe_version(program) {
        Some(version) => version,
        None => {
            // spawn 失败(NotFound/权限)= 未安装,如实回退不报。
            return Ok(json!({ "available": false }));
        }
    };
    let deadline = ruff_deadline(RUFF_FORMAT_DEADLINE);
    let output = spawn_format_pipe(
        program,
        &[
            "format",
            "--target-version",
            "py37",
            "--no-cache",
            "--stdin-filename",
            file_name,
            "-",
        ],
        content,
        deadline,
    )
    .map_err(|e| format!("ruff format: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ruff format failed (exit {:?}, ruff {version}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    let formatted = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(json!({ "available": true, "version": version, "formatted": formatted }))
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
            .arg("kode_ruff_fmt_fixture")
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

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kode-ruff-fmt-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        dir
    }

    /// roundtrip 契约:stub format 收 stdin,加工(前后各加一行)后回 stdout
    /// ——钉「内容经管道无损往返」(中间体由 stub 决定,ruff 语义不在此测)。
    #[test]
    fn stdin_pipe_roundtrips_content() {
        let dir = temp_dir("roundtrip");
        #[cfg(unix)]
        let script = dir.join("fake-ruff.sh");
        #[cfg(unix)]
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo \"ruff 0.0.0-fake\"; exit 0; fi\n\
             echo \"# head\"; cat; echo \"# tail\"\n",
        )
        .expect("write fake ruff");
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("chmod");
        #[cfg(windows)]
        let script = compile_stub(
            &dir,
            "fn main() { \
             if std::env::args().any(|a| a == \"--version\") { println!(\"ruff 0.0.0-fake\"); return; } \
             println!(\"# head\"); \
             let mut s = String::new(); std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).unwrap(); \
             print!(\"{s}\"); println!(\"# tail\"); }",
        );
        let face = format_content(
            "x=1\n",
            "/w/a.py",
            Some(script.to_str().expect("utf8 path")),
        )
        .expect("roundtrip face");
        assert_eq!(face["available"], serde_json::json!(true));
        assert_eq!(
            face["formatted"],
            serde_json::json!("# head\nx=1\n# tail\n")
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// 缺二进制(NotFound)→ available:false,不报错(与 ruff_lint 同面)。
    #[test]
    fn missing_binary_falls_back_to_unavailable_face() {
        let dir = temp_dir("missing");
        let missing = dir.join("no-such-ruff");
        let face = format_content(
            "x=1\n",
            "/w/a.py",
            Some(missing.to_str().expect("utf8 path")),
        )
        .expect("缺二进制如实回退不报错");
        assert_eq!(face["available"], serde_json::json!(false));
        assert!(face.get("formatted").is_none());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// present 但非零退出 → 如实 Err 带退出码/stderr/版本(不静默吞)。
    #[test]
    fn nonzero_format_exit_is_surfaced_as_err() {
        let dir = temp_dir("fmt-fail");
        #[cfg(unix)]
        let script = dir.join("fake-ruff.sh");
        #[cfg(unix)]
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo \"ruff 0.0.0-fake\"; exit 0; fi\n\
             cat > /dev/null\n\
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
            "fn main() { \
             if std::env::args().any(|a| a == \"--version\") { println!(\"ruff 0.0.0-fake\"); return; } \
             let mut s = String::new(); std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).unwrap(); \
             eprintln!(\"boom\"); std::process::exit(3); }",
        );
        let error = format_content(
            "x=1\n",
            "/w/a.py",
            Some(script.to_str().expect("utf8 path")),
        )
        .expect_err("非零退出应报错");
        assert!(error.contains("ruff format failed"), "{error}");
        assert!(error.contains("Some(3)"), "{error}");
        assert!(error.contains("boom"), "{error}");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// 入参缺 content/fileName → 如实 Err(载荷契约不静默默认)。
    #[test]
    fn handler_requires_content_and_file_name() {
        assert!(ruff_format_handler(serde_json::json!({ "fileName": "/w/a.py" })).is_err());
        assert!(ruff_format_handler(serde_json::json!({ "content": "x=1" })).is_err());
    }

    /// KODE-FULL-004:挂起 stub(版本即回、format 永挂)到点 kill+wait,如实
    /// Err 带超时面;窄化窗 env 只 set 不 remove(并行竞态判例)。
    #[test]
    fn hanging_format_stub_times_out_bounded() {
        let dir = temp_dir("hang");
        #[cfg(unix)]
        let script = {
            let script = dir.join("hang.sh");
            std::fs::write(
                &script,
                "#!/bin/sh\n\
                 if [ \"$1\" = \"--version\" ]; then echo \"ruff 0.0.0-fake\"; exit 0; fi\n\
                 exec sleep 300\n",
            )
            .expect("write hang stub");
            std::fs::set_permissions(
                &script,
                std::os::unix::fs::PermissionsExt::from_mode(0o755),
            )
            .expect("chmod");
            script
        };
        #[cfg(windows)]
        let script = compile_stub(
            &dir,
            "fn main() { \
             if std::env::args().any(|a| a == \"--version\") { println!(\"ruff 0.0.0-fake\"); return; } \
             std::thread::sleep(std::time::Duration::from_secs(300)); }",
        );
        std::env::set_var("KODE_RUFF_DEADLINE_MS", "300");
        let error = format_content("x=1\n", "/w/a.py", Some(script.to_str().expect("utf8 path")))
            .expect_err("挂起 format 必须报超时");
        assert!(error.contains("ruff format"), "{error}");
        assert!(error.contains("timed out"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
