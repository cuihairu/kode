//! PCAP 输入层:复用 TShark 成熟能力(todo PA-004 验收原文)。
//!
//! 口径:CLI 不自己解 pcap 容器;`tshark -r <file|-> -T fields` 吐
//! `frame.time_epoch / tcp.srcport / tcp.dstport / tcp.payload` 行,本模块
//! 只做行解析 + 进程编排。`--pcap -` 时把 stdin 的 pcap 字节**流式**写入
//! tshark 的 stdin(tshark 原生支持 `-r -`),边到边出,不整包驻留。

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};

/// 一行 tshark 字段输出(一个 TCP 载荷包)。
#[derive(Debug, Clone, PartialEq)]
pub struct TsharkPacket {
    /// `frame.time_epoch`(秒.fraction;缺失/不可解析 → None,不编造)。
    pub timestamp: Option<f64>,
    pub srcport: u16,
    pub dstport: u16,
    pub payload: Vec<u8>,
}

#[derive(Debug)]
pub struct TsharkProcess {
    child: Child,
    stdout: BufReader<std::process::ChildStdout>,
}

/// 启动 tshark。`pcap == "-"` 时必须给 `stdin_source`(流式拷贝,后台线程);
/// 文件 pcap 时 stdin 置空(真实 tshark 不读 stdin,避免写管道死锁)。
pub fn spawn_tshark(
    bin: &str,
    pcap: &str,
    stdin_source: Option<Box<dyn Read + Send>>,
) -> Result<TsharkProcess, String> {
    let mut cmd = Command::new(bin);
    cmd.args([
        "-r",
        pcap,
        "-n",
        "-T",
        "fields",
        "-E",
        "separator=/t",
        "-E",
        "occurrence=f",
        "-e",
        "frame.time_epoch",
        "-e",
        "tcp.srcport",
        "-e",
        "tcp.dstport",
        "-e",
        "tcp.payload",
        "-Y",
        "tcp.payload",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null());

    let streaming = pcap == "-" && stdin_source.is_some();
    if streaming {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to launch tshark binary '{bin}' ({e}); install Wireshark/tshark \
             or pass --tshark <path>"
        )
    })?;

    if streaming {
        if let Some(mut si) = child.stdin.take() {
            let mut src = stdin_source.expect("checked above");
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match src.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if si.write_all(&buf[..n]).is_err() {
                                break; // 下游退出,停止灌入
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = si.flush();
            });
            // si 在线程闭包结束时 drop → stdin 关闭,tshark 收尾。
        }
    }

    let stdout = child.stdout.take().expect("tshark stdout piped");
    Ok(TsharkProcess {
        child,
        stdout: BufReader::new(stdout),
    })
}

impl TsharkProcess {
    /// 逐行驱动(流式:解析一行回调一行)。
    pub fn for_each_packet(
        &mut self,
        mut f: impl FnMut(Result<TsharkPacket, String>),
    ) -> Result<(), String> {
        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .stdout
                .read_line(&mut line)
                .map_err(|e| format!("read tshark stdout: {e}"))?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }
            f(parse_tshark_line(trimmed));
        }
        let status = self.child.wait().map_err(|e| format!("wait tshark: {e}"))?;
        if !status.success() {
            return Err(format!(
                "tshark exited with {status}; pcap input may be malformed"
            ));
        }
        Ok(())
    }
}

/// 解析一行 `ts \t sport \t dport \t payload`(payload 为冒号分隔 hex;
/// 字段缺失/解析失败 → Err,不猜)。
pub fn parse_tshark_line(line: &str) -> Result<TsharkPacket, String> {
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 4 {
        return Err(format!(
            "unexpected tshark field line ({} fields): {line}",
            parts.len()
        ));
    }
    let timestamp = parts[0].parse::<f64>().ok();
    let srcport: u16 = parts[1]
        .parse()
        .map_err(|_| format!("bad tcp.srcport: {}", parts[1]))?;
    let dstport: u16 = parts[2]
        .parse()
        .map_err(|_| format!("bad tcp.dstport: {}", parts[2]))?;
    let hex: String = parts[3].chars().filter(|c| *c != ':').collect();
    let mut payload = Vec::with_capacity(hex.len() / 2);
    let hb = hex.as_bytes();
    if !hb.len().is_multiple_of(2) {
        return Err(format!("odd tcp.payload hex length in line: {line}"));
    }
    for i in (0..hb.len()).step_by(2) {
        let hi = (hb[i] as char)
            .to_digit(16)
            .ok_or_else(|| format!("bad hex at {i}"))?;
        let lo = (hb[i + 1] as char)
            .to_digit(16)
            .ok_or_else(|| format!("bad hex at {}", i + 1))?;
        payload.push(((hi << 4) | lo) as u8);
    }
    Ok(TsharkPacket {
        timestamp,
        srcport,
        dstport,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kode-kbengine-tshark-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 可执行脚本落盘(hermetic fake tshark 的载体)。
    #[cfg(unix)]
    fn write_script(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        std::fs::write(&script, body).unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[test]
    fn parse_tshark_line_accepts_ts_ports_and_colon_hex() {
        let p = parse_tshark_line("1759000000.100000\t51023\t20013\tde:ad:be:ef").unwrap();
        assert_eq!(p.timestamp, Some(1759000000.1));
        assert_eq!(p.srcport, 51023);
        assert_eq!(p.dstport, 20013);
        assert_eq!(p.payload, vec![0xde, 0xad, 0xbe, 0xef]);
        // 无时间戳(不可解析)→ None,不编造。
        let p = parse_tshark_line("not-a-ts\t1\t2\t00").unwrap();
        assert_eq!(p.timestamp, None);
        assert_eq!(p.payload, vec![0x00]);
    }

    #[test]
    fn parse_tshark_line_rejects_bad_fields_explicitly() {
        // 字段数不足(<4)。
        let err = parse_tshark_line("1\t2\t3").unwrap_err();
        assert!(
            err.contains("unexpected tshark field line (3 fields)"),
            "{err}"
        );
        // srcport / dstport 不是 u16。
        let err = parse_tshark_line("1.0\t99999\t2\t00").unwrap_err();
        assert!(err.contains("bad tcp.srcport: 99999"), "{err}");
        let err = parse_tshark_line("1.0\t1\t70000\t00").unwrap_err();
        assert!(err.contains("bad tcp.dstport: 70000"), "{err}");
        // 载荷 hex 奇数长度。
        let err = parse_tshark_line("1.0\t1\t2\td:ea").unwrap_err();
        assert!(err.contains("odd tcp.payload hex length"), "{err}");
        // 载荷 hex 含非 hex 字符。
        let err = parse_tshark_line("1.0\t1\t2\tzz").unwrap_err();
        assert!(err.contains("bad hex at 0"), "{err}");
        // 空 payload 也合法(纯 ACK/握手包,tshark -Y tcp.payload 会滤掉,
        // 但解析层仍容忍空列)。
        let p = parse_tshark_line("1.0\t1\t2\t").unwrap();
        assert!(p.payload.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_tshark_reads_file_pcap_with_null_stdin() {
        let dir = temp_dir("file");
        let lines = dir.join("lines.txt");
        std::fs::write(&lines, "1759000000.100000\t51023\t20013\t00:11\n").unwrap();
        // 文件 pcap:stdin 置空(真实 tshark 不读 stdin,防管道死锁)。
        let script = write_script(
            &dir,
            "fake.sh",
            &format!(
                "#!/bin/sh\ncat > /dev/null\ncat '{}'\n",
                lines.to_str().unwrap()
            ),
        );
        let pcap = dir.join("capture.pcap");
        std::fs::write(&pcap, b"pcap-bytes").unwrap();

        let mut proc =
            spawn_tshark(script.to_str().unwrap(), pcap.to_str().unwrap(), None).unwrap();
        let mut packets = Vec::new();
        proc.for_each_packet(|p| packets.push(p.unwrap())).unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].srcport, 51023);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn spawn_tshark_streams_stdin_bytes_through_background_thread() {
        let dir = temp_dir("stream");
        let lines = dir.join("lines.txt");
        std::fs::write(&lines, "1759000000.100000\t51023\t20013\t00\n").unwrap();
        // fake tshark 先吞 stdin 到 EOF(证明后台拷贝线程把字节送到了),
        // 再输出预置行。
        let script = write_script(
            &dir,
            "fake.sh",
            &format!(
                "#!/bin/sh\ncat > /dev/null\ncat '{}'\n",
                lines.to_str().unwrap()
            ),
        );
        let stdin_bytes: Box<dyn Read + Send> =
            Box::new(std::io::Cursor::new(b"PCAP-BYTES".to_vec()));
        let mut proc = spawn_tshark(script.to_str().unwrap(), "-", Some(stdin_bytes)).unwrap();
        let mut packets = Vec::new();
        proc.for_each_packet(|p| packets.push(p.unwrap())).unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].dstport, 20013);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spawn_tshark_missing_binary_reports_install_hint() {
        let err = spawn_tshark("/nonexistent/tshark", "x.pcap", None).unwrap_err();
        assert!(
            err.contains("failed to launch tshark binary '/nonexistent/tshark'"),
            "{err}"
        );
        assert!(err.contains("--tshark <path>"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn for_each_packet_skips_blank_lines_and_reports_nonzero_exit() {
        let dir = temp_dir("exit");
        let lines = dir.join("lines.txt");
        // 空行必须跳过(不当作坏包),其余行为正常包。
        std::fs::write(
            &lines,
            "\n1759000000.100000\t1\t2\t00\n\n1759000000.200000\t2\t1\tff\n",
        )
        .unwrap();
        let script = write_script(
            &dir,
            "fake.sh",
            &format!(
                "#!/bin/sh\ncat > /dev/null\ncat '{}'\nexit 3\n",
                lines.to_str().unwrap()
            ),
        );
        let pcap = dir.join("capture.pcap");
        std::fs::write(&pcap, b"x").unwrap();

        let mut proc =
            spawn_tshark(script.to_str().unwrap(), pcap.to_str().unwrap(), None).unwrap();
        let mut packets = Vec::new();
        let err = proc
            .for_each_packet(|p| {
                packets.push(p.expect("valid packets first"));
            })
            .expect_err("non-zero tshark exit must surface");
        assert!(err.contains("tshark exited with exit status: 3"), "{err}");
        assert_eq!(packets.len(), 2, "blank lines skipped, packets parsed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn for_each_packet_propagates_read_errors_of_wellformed_output() {
        // 正常行 + 退出 0:回调收到 Ok;整包成功收尾。
        let dir = temp_dir("ok");
        let lines = dir.join("lines.txt");
        std::fs::write(&lines, "1759000000.100000\t7\t8\t0102\n").unwrap();
        let script = write_script(
            &dir,
            "fake.sh",
            &format!(
                "#!/bin/sh\ncat > /dev/null\ncat '{}'\n",
                lines.to_str().unwrap()
            ),
        );
        let pcap = dir.join("capture.pcap");
        std::fs::write(&pcap, b"x").unwrap();
        let mut proc =
            spawn_tshark(script.to_str().unwrap(), pcap.to_str().unwrap(), None).unwrap();
        let mut got = Vec::new();
        proc.for_each_packet(|p| got.push(p.unwrap())).unwrap();
        assert_eq!(
            got,
            vec![TsharkPacket {
                timestamp: Some(1759000000.1),
                srcport: 7,
                dstport: 8,
                payload: vec![0x01, 0x02],
            }]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
