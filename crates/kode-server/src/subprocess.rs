//! KODE-FULL-004:有截止时间、可收割、限输出字节的子进程执行器。
//!
//! ruff 探测/check/format 旧实现用阻塞 `output()`/`wait_with_output`,无
//! 超时无取消:外部进程挂起 = worker 执行位被无限占死(客户端 cancel 只置
//! 令牌,子进程不响应),shutdown 也跟着等 join。本模块统一执行面:
//! - stdin 写入与 stdout/stderr 排空各占一线程(管道互等死锁面不存在);
//! - 墙钟 deadline 到点 kill+wait 收尸,无遗留进程,如实报 Deadline;
//! - 输出字节封顶(防失控进程吐爆内存),超顶继续排空但结果作废;
//! - stdin 走 `null`(与 `Command::output` 同口径:子进程读 stdin 立即 EOF)。
//!
//! 回收范围说明:kill 直击直接子进程;ruff 自身不再 fork 孙进程,若未来
//! shell 包装层引入孙进程,需 unix 进程组 kill(此处不预设)。

use std::io::Read;
use std::process::{Command, Stdio};

/// 单流输出字节上限(64 MiB:ruff check 2000 文件的 JSON 输出远低于此;
/// 失控吐字节的进程在此被截停,如实报 OutputTooLarge)。
pub(crate) const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

/// 有界执行的结果:退出状态 + 封顶后的两路输出。
#[derive(Debug)]
pub(crate) struct BoundedOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// 有界执行失败面。Deadline=到点 kill+wait 后仍如实报超时;Spawn=起进程
/// 失败(保留原始 io::Error,调用方按暂态族退避);OutputTooLarge=stdout
/// 超上限(防吞内存,不静默截断)。
#[derive(Debug)]
pub(crate) enum BoundedError {
    Deadline,
    Spawn(std::io::Error),
    OutputTooLarge,
}

/// 有界运行子进程:并发写 stdin(如有)/排空 stdout/stderr,主循环
/// `try_wait` 轮询,到点 kill+wait。任何返回路径(含 Deadline)三个线程
/// 都会被 join(kill/退出后管道破裂,线程必能返回),绝无线程/进程泄漏。
pub(crate) fn run_bounded(
    command: &mut Command,
    stdin_data: Option<Vec<u8>>,
    deadline: std::time::Duration,
) -> Result<BoundedOutput, BoundedError> {
    command
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(BoundedError::Spawn)?;

    let stdin_handle = child.stdin.take();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        if let (Some(mut pipe), Some(data)) = (stdin_handle, stdin_data.as_deref()) {
            // Broken pipe(子进程提前退出)= 非失败,与既有口径一致。
            let _ = pipe.write_all(data);
        }
    }); // 闭包结束 drop 管道 → 子进程读到 EOF

    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_capped(out_pipe));
    let err_reader = std::thread::spawn(move || read_capped(err_pipe));

    let deadline_at = std::time::Instant::now() + deadline;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline_at {
                    let _ = child.kill();
                    let _ = child.wait(); // 收尸:无遗留进程
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            // try_wait 罕见失败:kill+wait 后按 Deadline 面如实降级。
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let _ = writer.join();
    // stderr 溢出只丢诊断字节(空串顶上);stdout 溢出才是结果作废。
    let stderr = err_reader.join().ok().flatten().unwrap_or_default();
    let Some(status) = status else {
        return Err(BoundedError::Deadline);
    };
    match out_reader.join() {
        Ok(Some(stdout)) => Ok(BoundedOutput {
            status,
            stdout,
            stderr,
        }),
        Ok(None) => Err(BoundedError::OutputTooLarge),
        Err(_) => Err(BoundedError::Deadline),
    }
}

/// 暂态 fork 失败族(EAGAIN/ENOMEM/ENFILE/EMFILE)判定——满载 CI 下 spawn
/// 瞬败是暂态而非「未安装」(2026-11-08..16 三次 nightly 实测钉死;
/// raw_os_error 数值判定因 std ErrorKind 无稳定映射,仅 unix)。
pub(crate) fn is_transient_spawn(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::OutOfMemory
    ) || (cfg!(unix) && matches!(error.raw_os_error(), Some(11 | 12 | 23 | 24)))
}

/// 暂态 spawn 四拍退避表(20/60/150/400ms,与原 ruff 面实测口径一致)。
pub(crate) const SPAWN_BACKOFF_MS: [u64; 4] = [20, 60, 150, 400];

/// 排空一路管道并封顶:超顶后继续读到 EOF(防子进程卡在管道上等读)但
/// 返回 None(结果作废);读误差返回已收字节(交由退出码/解析面裁决)。
fn read_capped<R: Read>(mut pipe: Option<R>) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    let Some(pipe) = pipe.as_mut() else {
        return Some(Vec::new());
    };
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return Some(buf),
            Ok(n) => {
                if buf.len() + n > MAX_OUTPUT_BYTES {
                    loop {
                        match pipe.read(&mut chunk) {
                            Ok(0) | Err(_) => return None,
                            Ok(_) => {}
                        }
                    }
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return Some(buf),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kode-subprocess-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 正常完成:stdout 收全,stdin 写入生效(cat 回显;unix 面)。
    #[test]
    #[cfg(unix)]
    fn completes_and_returns_outputs() {
        let mut command = Command::new("cat");
        let result = run_bounded(
            &mut command,
            Some(b"hello".to_vec()),
            std::time::Duration::from_secs(10),
        )
        .expect("cat must complete");
        assert!(result.status.success());
        assert_eq!(result.stdout, b"hello");
    }

    /// 挂起子进程:到点 kill+wait,如实 Deadline,墙钟有界,无遗留。
    #[test]
    fn hanging_process_is_killed_at_deadline() {
        let dir = temp_dir("hang");
        #[cfg(unix)]
        let script = {
            let script = dir.join("hang.sh");
            std::fs::write(&script, "#!/bin/sh\nexec sleep 300\n").unwrap();
            std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
            script
        };
        #[cfg(windows)]
        let script = {
            let source = dir.join("hang.rs");
            let exe = dir.join("hang.exe");
            std::fs::write(
                &source,
                "fn main() { std::thread::sleep(std::time::Duration::from_secs(300)); }",
            )
            .unwrap();
            let out = Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&exe)
                .output()
                .unwrap();
            assert!(out.status.success());
            exe
        };
        let mut command = Command::new(&script);
        let start = std::time::Instant::now();
        let result = run_bounded(&mut command, None, std::time::Duration::from_millis(300));
        assert!(
            matches!(result, Err(BoundedError::Deadline)),
            "挂起进程必须 Deadline: {result:?}"
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// stdin 挂起面(读也不读、写也不写):写线程随 kill 解锁,不泄漏线程。
    #[test]
    fn hanging_process_with_large_stdin_still_bounded() {
        let dir = temp_dir("hang-stdin");
        #[cfg(unix)]
        let script = {
            let script = dir.join("hang.sh");
            std::fs::write(&script, "#!/bin/sh\nexec sleep 300\n").unwrap();
            std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
            script
        };
        #[cfg(windows)]
        let script = {
            let source = dir.join("hang.rs");
            let exe = dir.join("hang.exe");
            std::fs::write(
                &source,
                "fn main() { std::thread::sleep(std::time::Duration::from_secs(300)); }",
            )
            .unwrap();
            let out = Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&exe)
                .output()
                .unwrap();
            assert!(out.status.success());
            exe
        };
        // 8 MiB stdin:远超管道容量,写线程必然阻塞在 write;kill 后管道
        // 破裂解除阻塞,join 返回——整个调用仍墙钟有界。
        let payload = vec![b'x'; 8 * 1024 * 1024];
        let mut command = Command::new(&script);
        let result = run_bounded(
            &mut command,
            Some(payload),
            std::time::Duration::from_millis(300),
        );
        assert!(matches!(result, Err(BoundedError::Deadline)));
        std::fs::remove_dir_all(&dir).ok();
    }
}
