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
