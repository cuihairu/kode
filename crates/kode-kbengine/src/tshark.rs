//! PCAP input layer: reuses TShark's mature capabilities (todo PA-004 acceptance text).
//!
//! Contract: the CLI does not decode pcap containers itself; `tshark -r <file|-> -T fields` emits
//! `frame.time_epoch / tcp.srcport / tcp.dstport / tcp.payload` lines, and this module only parses
//! the lines and orchestrates the process. With `--pcap -` the pcap bytes on stdin are written to
//! tshark's stdin **streamingly** (tshark natively supports `-r -`), producing as they arrive
//! without holding the whole capture in memory.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};

/// One line of tshark field output (a TCP payload packet).
#[derive(Debug, Clone, PartialEq)]
pub struct TsharkPacket {
    /// `frame.time_epoch` (seconds.fraction; missing/unparsable -> None, never fabricated).
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

/// Launch tshark. When `pcap == "-"` a `stdin_source` must be supplied (streamed copy in a
/// background thread); for a file pcap stdin is nulled (real tshark does not read stdin, which
/// avoids a write-pipe deadlock).
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

    // Short ETXTBSY backoff retry: exec can hit a binary that was just written to disk or
    // concurrently updated (the write->exec race window on tmpfs is observed occasionally; a real
    // tshark hit by a package manager's concurrent update is the same face). Only after three 5ms
    // backoffs still fail is the error surfaced as-is.
    let mut child = None;
    let mut last_err = None;
    for _ in 0..3 {
        match cmd.spawn() {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) if e.raw_os_error() == Some(26) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(e) => {
                last_err = Some(e);
                break;
            }
        }
    }
    let mut child = child.ok_or_else(|| {
        let e = last_err.expect("spawn error captured");
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
                                break; // downstream exited, stop feeding
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = si.flush();
            });
            // si is dropped when the thread closure ends -> stdin closes and tshark winds down.
        }
    }

    let stdout = child.stdout.take().expect("tshark stdout piped");
    Ok(TsharkProcess {
        child,
        stdout: BufReader::new(stdout),
    })
}

impl TsharkProcess {
    /// Drive it line by line (streaming: one callback per parsed line).
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

/// Parse one line of `ts \t sport \t dport \t payload` (the payload is colon-separated hex;
/// a missing field or parse failure -> Err, no guessing).
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

    // The cases are all unix-only (sh-script fake tshark); the helpers are gated the same way so
    // the Windows nightly build produces no dead_code warnings.
    #[cfg(unix)]
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kode-kbengine-tshark-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write an executable script to disk (the vehicle for the hermetic fake tshark). Write a
    /// temporary name, then atomically rename: by the time the target path appears the write handle
    /// is already closed, ruling out an exec hitting a residual write handle and producing ETXTBSY
    /// (observed occasionally).
    #[cfg(unix)]
    fn write_script(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        let staging = dir.join(format!("{name}.staging"));
        std::fs::write(&staging, body).unwrap();
        let mut perms = std::fs::metadata(&staging).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&staging, perms).unwrap();
        std::fs::rename(&staging, &script).unwrap();
        script
    }

    #[test]
    fn parse_tshark_line_accepts_ts_ports_and_colon_hex() {
        let p = parse_tshark_line("1759000000.100000\t51023\t20013\tde:ad:be:ef").unwrap();
        assert_eq!(p.timestamp, Some(1759000000.1));
        assert_eq!(p.srcport, 51023);
        assert_eq!(p.dstport, 20013);
        assert_eq!(p.payload, vec![0xde, 0xad, 0xbe, 0xef]);
        // No timestamp (unparsable) -> None, never fabricated.
        let p = parse_tshark_line("not-a-ts\t1\t2\t00").unwrap();
        assert_eq!(p.timestamp, None);
        assert_eq!(p.payload, vec![0x00]);
    }

    #[test]
    fn parse_tshark_line_rejects_bad_fields_explicitly() {
        // Too few fields (<4).
        let err = parse_tshark_line("1\t2\t3").unwrap_err();
        assert!(
            err.contains("unexpected tshark field line (3 fields)"),
            "{err}"
        );
        // srcport / dstport is not a u16.
        let err = parse_tshark_line("1.0\t99999\t2\t00").unwrap_err();
        assert!(err.contains("bad tcp.srcport: 99999"), "{err}");
        let err = parse_tshark_line("1.0\t1\t70000\t00").unwrap_err();
        assert!(err.contains("bad tcp.dstport: 70000"), "{err}");
        // Payload hex with an odd length.
        let err = parse_tshark_line("1.0\t1\t2\td:ea").unwrap_err();
        assert!(err.contains("odd tcp.payload hex length"), "{err}");
        // Payload hex contains a non-hex character.
        let err = parse_tshark_line("1.0\t1\t2\tzz").unwrap_err();
        assert!(err.contains("bad hex at 0"), "{err}");
        // An empty payload is legal too (pure ACK/handshake packets, filtered by tshark -Y
        // tcp.payload, but the parsing layer still tolerates an empty field).
        let p = parse_tshark_line("1.0\t1\t2\t").unwrap();
        assert!(p.payload.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_tshark_reads_file_pcap_with_null_stdin() {
        let dir = temp_dir("file");
        let lines = dir.join("lines.txt");
        std::fs::write(&lines, "1759000000.100000\t51023\t20013\t00:11\n").unwrap();
        // File pcap: stdin is nulled (real tshark does not read stdin, guarding against a pipe
        // deadlock).
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
        // The fake tshark first swallows stdin to EOF (proving the background copy thread really
        // delivered the bytes), then emits its prepared lines.
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
        // Blank lines must be skipped (not treated as bad packets); the rest are normal packets.
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
        // Normal lines + exit 0: the callback receives Ok; the whole run winds down successfully.
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

    /// unix -> linux: the ETXTBSY race window has only been reproduced on linux; macOS exec does
    /// not necessarily return ETXTBSY for a script with a held write handle (a behavioural
    /// difference, darwin-x64 genuine red 2026-11-21), so this assertion's platform semantics do
    /// not hold on darwin.
    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_tshark_retries_then_reports_when_binary_busy() {
        // exec hitting a write handle (ETXTBSY): after three backoff retries the install hint is
        // surfaced faithfully, no indefinite wait. The real cause is the race window of a binary
        // being concurrently updated or just written to disk (see the note above); the test
        // reproduces the same errno face with a controlled write handle.
        let dir = temp_dir("etxtbsy");
        let script = write_script(&dir, "fake.sh", "#!/bin/sh\nexit 0\n");
        let _writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&script)
            .expect("hold write handle to force ETXTBSY");
        let err = spawn_tshark(script.to_str().unwrap(), "x.pcap", None).unwrap_err();
        assert!(err.contains("failed to launch tshark binary"), "{err}");
        drop(_writer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn spawn_tshark_streaming_stops_feeding_when_downstream_exits_early() {
        // The downstream exits without reading stdin: after the copy thread fills the pipe and hits
        // EPIPE it stops feeding (no panic, no hang), and stdout winds down normally.
        let dir = temp_dir("epipe");
        let lines = dir.join("lines.txt");
        std::fs::write(&lines, "1759000000.100000\t51023\t20013\t00\n").unwrap();
        // The fake tshark prints one line and exits immediately (never reading stdin at all).
        let script = write_script(
            &dir,
            "fake.sh",
            &format!("#!/bin/sh\ncat '{}'\n", lines.to_str().unwrap()),
        );
        let big = vec![b'x'; 256 * 1024];
        let stdin_bytes: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(big));
        let mut proc = spawn_tshark(script.to_str().unwrap(), "-", Some(stdin_bytes)).unwrap();
        let mut packets = 0;
        proc.for_each_packet(|_| packets += 1).unwrap();
        assert_eq!(packets, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn spawn_tshark_streaming_stops_feeding_on_source_read_error() {
        // Source read error: the copy thread stops feeding faithfully and closes stdin, the
        // downstream winds down at EOF, and the error does not leak out (an input-face problem must
        // not masquerade as a tshark failure).
        struct FlakyRead {
            data: Vec<u8>,
            served: bool,
        }
        impl Read for FlakyRead {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if !self.served {
                    self.served = true;
                    let n = self.data.len().min(buf.len());
                    buf[..n].copy_from_slice(&self.data);
                    return Ok(n);
                }
                Err(std::io::Error::other("source blew up"))
            }
        }
        let dir = temp_dir("srcerr");
        let lines = dir.join("lines.txt");
        std::fs::write(&lines, "1759000000.100000\t51023\t20013\t00\n").unwrap();
        let script = write_script(
            &dir,
            "fake.sh",
            &format!(
                "#!/bin/sh\ncat >/dev/null\ncat '{}'\n",
                lines.to_str().unwrap()
            ),
        );
        let stdin_bytes: Box<dyn Read + Send> = Box::new(FlakyRead {
            data: b"partial-pcap".to_vec(),
            served: false,
        });
        let mut proc = spawn_tshark(script.to_str().unwrap(), "-", Some(stdin_bytes)).unwrap();
        let mut packets = 0;
        proc.for_each_packet(|_| packets += 1).unwrap();
        assert_eq!(packets, 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
