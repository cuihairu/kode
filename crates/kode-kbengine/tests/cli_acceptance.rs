//! kode2 PA-004 (todo.md Phase 3): KBEngine CLI acceptance tests.
//!
//! Every acceptance clause from todo.md PA-004 has one test:
//! - `schema validate` / `schema build` / `schema diff` / `schema inspect`
//! - `decode --hex`
//! - `capture analyze` with stdin pcap streaming through the TShark input
//!   layer (a hermetic fake tshark keeps the test environment-free) and a
//!   direct raw-flow input for byte-exact framing checks.
//!
//! Tests run the real binary (`CARGO_BIN_EXE_kode-kbengine`), so the CLI
//! surface itself is what is under test.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn demo_assets() -> PathBuf {
    repo_root().join("tests/fixtures/kbengine-demo-assets")
}

fn engine_defaults_xml() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/messages_fixed_defaults.xml")
}

struct Cli {
    out: String,
    err: String,
    code: i32,
}

fn run_cli(args: &[&str]) -> Cli {
    run_cli_with(args, None, None, &[])
}

/// stdin_bytes: piped to the CLI process; extra_env: added to the child env.
fn run_cli_with(
    args: &[&str],
    stdin_bytes: Option<&[u8]>,
    _cwd: Option<&std::path::Path>,
    extra_env: &[(&str, &str)],
) -> Cli {
    let exe = env!("CARGO_BIN_EXE_kode-kbengine");
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin_bytes.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn kode-kbengine");
    if let Some(bytes) = stdin_bytes {
        let mut si = child.stdin.take().expect("stdin piped");
        si.write_all(bytes).expect("write stdin");
        drop(si);
    }
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output().expect("wait cli");
    Cli {
        out: String::from_utf8_lossy(&stdout).into_owned(),
        err: String::from_utf8_lossy(&stderr).into_owned(),
        code: status.code().unwrap_or(-1),
    }
}

fn json_field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    // Minimal string-field probe ("key":"value") for asserting CLI output
    // without pulling a JSON parser into the test harness.
    let pat = format!("\"{key}\":\"");
    let start = json.find(&pat)? + pat.len();
    let rest = &json[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn json_has_key(json: &str, key: &str) -> bool {
    json.contains(&format!("\"{key}\""))
}

// ---------------------------------------------------------------------------
// schema validate
// ---------------------------------------------------------------------------

#[test]
fn version_flag_prints_one_line_and_exits_zero() {
    // PA-007 版本检测对端契约:任何位置出现 --version 即优先,
    // 一行 `kode-kbengine <semver>`,exit 0,不解析其余参数。
    let cli = run_cli(&["--version"]);
    assert_eq!(cli.code, 0, "stderr={}", cli.err);
    assert!(
        cli.out.trim().starts_with("kode-kbengine "),
        "stdout={:?}",
        cli.out
    );
    assert_eq!(cli.out.lines().count(), 1, "stdout={:?}", cli.out);
    // 与子命令混排仍生效(版本优先)。
    let cli2 = run_cli(&["schema", "validate", "--version"]);
    assert_eq!(cli2.code, 0, "stderr={}", cli2.err);
    assert!(cli2.out.trim().starts_with("kode-kbengine "));
}

#[test]
fn schema_validate_ok_over_demo_assets() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let proj_buf = demo_assets();
    let proj = proj_buf.to_str().unwrap();
    let cli = run_cli(&["schema", "validate", "--project", proj, "--defaults", dp]);
    assert_eq!(cli.code, 0, "stdout={} stderr={}", cli.out, cli.err);
    assert!(json_has_key(&cli.out, "sha256"), "stdout={}", cli.out);
    assert!(json_has_key(&cli.out, "valid"), "stdout={}", cli.out);
}

#[test]
fn schema_validate_rejects_non_project_dir() {
    let tmp = std::env::temp_dir().join("kode-pa45-not-a-project");
    std::fs::create_dir_all(&tmp).unwrap();
    let proj = tmp.to_str().unwrap();
    let cli = run_cli(&["schema", "validate", "--project", proj]);
    assert_ne!(
        cli.code, 0,
        "must fail on a dir without scripts/ (stdout={} stderr={})",
        cli.out, cli.err
    );
}

// ---------------------------------------------------------------------------
// schema build
// ---------------------------------------------------------------------------

#[test]
fn schema_build_emits_canonical_json_and_is_deterministic() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let proj_buf = demo_assets();
    let proj = proj_buf.to_str().unwrap();
    let cli1 = run_cli(&["schema", "build", "--project", proj, "--defaults", dp]);
    assert_eq!(cli1.code, 0, "stderr={}", cli1.err);
    let cli2 = run_cli(&["schema", "build", "--project", proj, "--defaults", dp]);
    assert_eq!(
        cli1.out, cli2.out,
        "same project must build byte-identical canonical JSON"
    );
    assert!(
        cli1.out.contains("\"Loginapp::login\""),
        "message table in JSON: {}",
        &cli1.out[..cli1.out.len().min(400)]
    );
    assert!(
        json_has_key(&cli1.out, "schema_version"),
        "stdout={}",
        &cli1.out[..cli1.out.len().min(400)]
    );

    // --out writes the same bytes to a file.
    let out_path = std::env::temp_dir().join("kode-pa45-schema-build.json");
    let out_str = out_path.to_str().unwrap();
    let cli3 = run_cli(&[
        "schema",
        "build",
        "--project",
        proj,
        "--defaults",
        dp,
        "--out",
        out_str,
    ]);
    assert_eq!(cli3.code, 0, "stderr={}", cli3.err);
    let written = std::fs::read_to_string(&out_path).unwrap();
    assert_eq!(
        written,
        cli1.out.trim_end_matches('\n'),
        "--out file must carry the canonical JSON"
    );
}

// ---------------------------------------------------------------------------
// schema diff
// ---------------------------------------------------------------------------

#[test]
fn schema_diff_self_is_compatible_and_drift_is_flagged() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let proj_buf = demo_assets();
    let proj = proj_buf.to_str().unwrap();

    let old_path = std::env::temp_dir().join("kode-pa45-diff-old.json");
    let new_path = std::env::temp_dir().join("kode-pa45-diff-new.json");
    run_cli(&[
        "schema",
        "build",
        "--project",
        proj,
        "--defaults",
        dp,
        "--out",
        old_path.to_str().unwrap(),
    ]);
    run_cli(&[
        "schema",
        "build",
        "--project",
        proj,
        "--defaults",
        dp,
        "--out",
        new_path.to_str().unwrap(),
    ]);

    let cli = run_cli(&[
        "schema",
        "diff",
        "--old",
        old_path.to_str().unwrap(),
        "--new",
        new_path.to_str().unwrap(),
    ]);
    assert_eq!(
        cli.code, 0,
        "identical schemas are compatible (stdout={} stderr={})",
        cli.out, cli.err
    );
    assert!(json_has_key(&cli.out, "compatible"), "stdout={}", cli.out);

    // Drift: mutate a copy of the project (swap a property wire type) and the
    // diff must report incompatible (exit code 1).
    let mutated = std::env::temp_dir().join("kode-pa45-mutated-assets");
    let _ = std::fs::remove_dir_all(&mutated);
    copy_dir_recursive(&demo_assets(), &mutated);
    let def_dir = mutated.join("scripts/entity_defs");
    let mut patched = false;
    let mut entries: Vec<PathBuf> = Vec::new();
    collect_files(&def_dir, &mut entries);
    for f in entries {
        let text = match std::fs::read_to_string(&f) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if text.contains("<Type>") && !text.contains("unrelated") {
            let patched_text = text.replace("<Type> UINT8 </Type>", "<Type> UINT64 </Type>");
            if patched_text != text {
                std::fs::write(&f, patched_text).unwrap();
                patched = true;
                break;
            }
        }
    }
    assert!(patched, "expected a UINT8 property in fixture .def files");
    run_cli(&[
        "schema",
        "build",
        "--project",
        mutated.to_str().unwrap(),
        "--defaults",
        dp,
        "--out",
        new_path.to_str().unwrap(),
    ]);
    let cli2 = run_cli(&[
        "schema",
        "diff",
        "--old",
        old_path.to_str().unwrap(),
        "--new",
        new_path.to_str().unwrap(),
    ]);
    assert_eq!(
        cli2.code, 1,
        "wire-type drift must be incompatible (stdout={} stderr={})",
        cli2.out, cli2.err
    );
    assert!(
        cli2.out.contains("property_type_changed"),
        "serde snake_case change tag expected: {}",
        cli2.out
    );
}

// ---------------------------------------------------------------------------
// schema inspect
// ---------------------------------------------------------------------------

#[test]
fn schema_inspect_overview_and_message_entry() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let proj_buf = demo_assets();
    let proj = proj_buf.to_str().unwrap();
    let schema_path = std::env::temp_dir().join("kode-pa45-inspect.json");
    run_cli(&[
        "schema",
        "build",
        "--project",
        proj,
        "--defaults",
        dp,
        "--out",
        schema_path.to_str().unwrap(),
    ]);
    let sp = schema_path.to_str().unwrap();

    let cli = run_cli(&["schema", "inspect", "--schema", sp]);
    assert_eq!(cli.code, 0, "stderr={}", cli.err);
    assert!(
        json_has_key(&cli.out, "sha256"),
        "overview carries the schema digest: {}",
        cli.out
    );
    assert!(json_has_key(&cli.out, "messages"), "stdout={}", cli.out);
    assert!(json_has_key(&cli.out, "entities"), "stdout={}", cli.out);

    let cli2 = run_cli(&[
        "schema",
        "inspect",
        "--schema",
        sp,
        "--message",
        "Loginapp::login",
    ]);
    assert_eq!(cli2.code, 0, "stderr={}", cli2.err);
    assert!(
        cli2.out.contains("\"id\": 3,"),
        "fixed id from the engine table: {}",
        cli2.out
    );
    assert!(json_has_key(&cli2.out, "args"), "stdout={}", cli2.out);

    let cli3 = run_cli(&["schema", "inspect", "--schema", sp, "--message-id", "502"]);
    assert_eq!(cli3.code, 0, "stderr={}", cli3.err);
    assert!(
        cli3.out.contains("Client::onLoginSuccessfully"),
        "lookup by id: {}",
        cli3.out
    );

    let cli4 = run_cli(&[
        "schema",
        "inspect",
        "--schema",
        sp,
        "--message",
        "Nope::missing",
    ]);
    assert_ne!(cli4.code, 0, "unknown message must fail loudly");

    let cli5 = run_cli(&["schema", "inspect", "--schema", sp, "--entity", "Avatar"]);
    assert_eq!(cli5.code, 0, "stderr={}", cli5.err);
    assert!(
        json_has_key(&cli5.out, "properties"),
        "entity wire info: {}",
        cli5.out
    );
}

// ---------------------------------------------------------------------------
// decode --hex
// ---------------------------------------------------------------------------

/// Variable-length frame on the wire: `u16 id (LE) + u16 payload len (LE) +
/// payload` (kbengine-wire-protocol.md §4.2).
fn var_frame(id: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + payload.len());
    v.extend_from_slice(&id.to_le_bytes());
    v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

fn login_payload() -> Vec<u8> {
    // Loginapp::login args (fixture fixed table): STRING UINT8_ARRAY STRING STRING.
    let mut v = Vec::new();
    v.extend_from_slice(b"1\0"); // clientType STRING
    v.extend_from_slice(&4u32.to_le_bytes()); // blob len
    v.extend_from_slice(b"ABCD"); // blob bytes
    v.extend_from_slice(b"alice\0");
    v.extend_from_slice(b"pw\0");
    v
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Loginapp::hello payload per the engine interface overlay (PA-001 §6):
/// STRING verInfo + STRING scriptVer + BLOB encryptedKey.
fn hello_payload() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"2.5.10\0");
    v.extend_from_slice(b"1.0.0\0");
    v.extend_from_slice(&1u32.to_le_bytes());
    v.push(0x00);
    v
}

#[test]
fn decode_hex_decodes_coalesced_frames_with_args() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    // Two frames in one TCP segment (coalescing): Loginapp::login (id 3) then
    // Loginapp::hello (id 4).
    let mut stream = var_frame(3, &login_payload());
    stream.extend_from_slice(&var_frame(4, &hello_payload()));
    let cli = run_cli(&["decode", "--hex", &to_hex(&stream), "--defaults", dp]);
    assert_eq!(cli.code, 0, "stderr={}", cli.err);
    assert!(cli.out.contains("\"records\""), "stdout={}", cli.out);
    assert!(cli.out.contains("Loginapp::login"), "stdout={}", cli.out);
    assert!(cli.out.contains("Loginapp::hello"), "stdout={}", cli.out);
    // Decoded STRING arg carries the account name.
    assert!(
        cli.out.contains("alice"),
        "decoded arg value present: {}",
        cli.out
    );
    assert!(
        json_field(&cli.out, "flow").is_none() || cli.out.contains("\"flow\":\"loginapp\""),
        "stdout={}",
        cli.out
    );
}

#[test]
fn decode_hex_reports_unknown_id_as_anomaly_not_crash() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let stream = var_frame(7777, b"whatever");
    let cli = run_cli(&["decode", "--hex", &to_hex(&stream), "--defaults", dp]);
    assert_eq!(
        cli.code, 0,
        "unknown id is an anomaly, not a crash: {}",
        cli.err
    );
    assert!(cli.out.contains("\"anomalies\""), "stdout={}", cli.out);
    assert!(cli.out.contains("unknown_message_id"), "stdout={}", cli.out);
}

// ---------------------------------------------------------------------------
// capture analyze
// ---------------------------------------------------------------------------

#[test]
fn capture_analyze_raw_flow_both_directions() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    // Uplink: login. Downlink: Client::onLoginSuccessfully (id 502, variable):
    // STRING accountName + STRING baseappIP + UINT16 port + blob.
    let mut down_payload = Vec::new();
    down_payload.extend_from_slice(b"alice\0");
    down_payload.extend_from_slice(b"127.0.0.1\0");
    down_payload.extend_from_slice(&30050u16.to_le_bytes());
    down_payload.extend_from_slice(&1u32.to_le_bytes());
    down_payload.push(0x00);
    let up = var_frame(3, &login_payload());
    let down = var_frame(502, &down_payload);
    let flows = format!("loginapp={}", to_hex(&up));
    let flows_down = format!("loginapp.down={}", to_hex(&down));
    let cli = run_cli(&[
        "capture",
        "analyze",
        "--raw-flow",
        &flows,
        "--raw-flow",
        &flows_down,
        "--defaults",
        dp,
    ]);
    assert_eq!(cli.code, 0, "stderr={}", cli.err);
    assert!(cli.out.contains("\"records\""), "stdout={}", cli.out);
    assert!(
        cli.out.contains("\"direction\": \"c2s\""),
        "stdout={}",
        cli.out
    );
    assert!(
        cli.out.contains("\"direction\": \"s2c\""),
        "stdout={}",
        cli.out
    );
    assert!(
        cli.out.contains("Client::onLoginSuccessfully"),
        "stdout={}",
        cli.out
    );
}

/// Writes a hermetic fake tshark: it swallows stdin (the pcap bytes) and
/// prints pre-baked `tshark -T fields` lines from a file, so the CLI's TShark
/// input layer (args + field parsing + stdin streaming) is exercised without
/// a real Wireshark install.
#[cfg(unix)]
fn write_fake_tshark(dir: &std::path::Path, lines_file: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("fake-tshark.sh");
    let lines = lines_file.to_str().unwrap();
    std::fs::write(
        &script,
        format!("#!/bin/sh\ncat > /dev/null\ncat '{lines}'\n"),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&script, perms).unwrap();
    script
}

#[cfg(windows)]
fn write_fake_tshark(dir: &std::path::Path, lines_file: &std::path::Path) -> PathBuf {
    // Use a real executable: Windows cannot execute a Unix shebang script.
    let source = dir.join("fake_tshark.rs");
    let executable = dir.join("fake-tshark.exe");
    std::fs::write(
        &source,
        format!(
            "use std::io::{{Read, Write}}; fn main() {{ \
             let mut input = Vec::new(); std::io::stdin().read_to_end(&mut input).unwrap(); \
             let bytes = std::fs::read({:?}).unwrap(); \
             std::io::stdout().write_all(&bytes).unwrap(); }}",
            lines_file.to_str().unwrap()
        ),
    )
    .unwrap();
    let result = Command::new("rustc")
        .arg("--crate-name")
        .arg("kode_fake_tshark")
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    executable
}

/// One tshark line: frame.time_epoch \t tcp.srcport \t tcp.dstport \t
/// tcp.payload (colon-separated hex, tshark's field format).
fn tshark_line(ts: &str, sport: u16, dport: u16, payload: &[u8]) -> String {
    let hex: Vec<String> = payload.iter().map(|b| format!("{b:02x}")).collect();
    format!("{ts}\t{sport}\t{dport}\t{}\n", hex.join(":"))
}

#[test]
fn capture_analyze_streams_stdin_pcap_through_tshark_layer() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let tmp = std::env::temp_dir().join("kode-pa45-fake-tshark");
    std::fs::create_dir_all(&tmp).unwrap();

    let up = var_frame(3, &login_payload());
    let mut down_payload = Vec::new();
    down_payload.extend_from_slice(b"alice\0");
    down_payload.extend_from_slice(b"127.0.0.1\0");
    down_payload.extend_from_slice(&30050u16.to_le_bytes());
    down_payload.extend_from_slice(&1u32.to_le_bytes());
    down_payload.push(0x00);
    let down = var_frame(502, &down_payload);

    let lines = tmp.join("lines.txt");
    std::fs::write(
        &lines,
        format!(
            "{}{}",
            tshark_line("1759000000.100000", 51023, 20013, &up),
            tshark_line("1759000000.250000", 20013, 51023, &down),
        ),
    )
    .unwrap();
    let fake = write_fake_tshark(&tmp, &lines);

    let mut stream = var_frame(3, &login_payload());
    stream.extend_from_slice(&var_frame(502, &down_payload));
    let cli = run_cli_with(
        &[
            "capture",
            "analyze",
            "--pcap",
            "-", // stdin: streamed pcap bytes
            "--tshark",
            fake.to_str().unwrap(),
            "--flow-map",
            "loginapp=20013",
            "--defaults",
            dp,
        ],
        Some(b"PCAP-BYTES-STREAMED-THROUGH-STDIN"),
        None,
        &[],
    );
    assert_eq!(cli.code, 0, "stderr={}", cli.err);
    assert!(cli.out.contains("Loginapp::login"), "stdout={}", cli.out);
    assert!(
        cli.out.contains("Client::onLoginSuccessfully"),
        "stdout={}",
        cli.out
    );
    // Timestamps ride on the records (latency analysis input, PA-005).
    assert!(json_has_key(&cli.out, "timestamp"), "stdout={}", cli.out);
    assert!(cli.out.contains("1759000000.1"), "stdout={}", cli.out);

    // Missing tshark binary must fail with a clear message, not a panic.
    let cli2 = run_cli(&[
        "capture",
        "analyze",
        "--pcap",
        "-",
        "--tshark",
        "/nonexistent/tshark",
    ]);
    assert_ne!(cli2.code, 0);
    assert!(cli2.err.contains("tshark"), "stderr={}", cli2.err);
}

#[test]
fn capture_analyze_persists_records_for_analyze_step() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let tmp = std::env::temp_dir().join("kode-pa45-fake-tshark-records");
    std::fs::create_dir_all(&tmp).unwrap();
    let lines = tmp.join("lines.txt");
    let up = var_frame(4, &hello_payload());
    std::fs::write(&lines, tshark_line("1759000001.000000", 51023, 20013, &up)).unwrap();
    let fake = write_fake_tshark(&tmp, &lines);
    let records_path = tmp.join("records.json");
    let cli = run_cli(&[
        "capture",
        "analyze",
        "--pcap",
        "-",
        "--tshark",
        fake.to_str().unwrap(),
        "--flow-map",
        "loginapp=20013",
        "--defaults",
        dp,
        "--records",
        records_path.to_str().unwrap(),
    ]);
    assert_eq!(cli.code, 0, "stderr={}", cli.err);
    let written = std::fs::read_to_string(&records_path).unwrap();
    assert!(
        written.contains("Loginapp::hello"),
        "records file: {written}"
    );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn collect_files(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_files(&p, out);
            } else {
                out.push(p);
            }
        }
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
    std::fs::create_dir_all(dst).unwrap();
    for e in std::fs::read_dir(src).unwrap().flatten() {
        let p = e.path();
        let target = dst.join(e.file_name());
        if p.is_dir() {
            copy_dir_recursive(&p, &target);
        } else {
            std::fs::copy(&p, &target).unwrap();
        }
    }
}

// ---------------------------------------------------------------------------
// analyze (PA-005): records JSON -> analyzer report via the CLI
// ---------------------------------------------------------------------------

#[test]
fn analyze_runs_pa005_report_over_captured_records() {
    let defaults = engine_defaults_xml();
    let dp = defaults.to_str().unwrap();
    let tmp = std::env::temp_dir().join("kode-pa45-analyze-e2e");
    std::fs::create_dir_all(&tmp).unwrap();
    let records_path = tmp.join("records.json");

    // capture: login then login-success (timestamps from the fake tshark layer)
    let up = var_frame(3, &login_payload());
    let mut down_payload = Vec::new();
    down_payload.extend_from_slice(b"alice\0");
    down_payload.extend_from_slice(b"127.0.0.1\0");
    down_payload.extend_from_slice(&30050u16.to_le_bytes());
    down_payload.extend_from_slice(&1u32.to_le_bytes());
    down_payload.push(0x00);
    let down = var_frame(502, &down_payload);
    let lines = tmp.join("lines.txt");
    std::fs::write(
        &lines,
        format!(
            "{}{}",
            tshark_line("1759000000.100000", 51023, 20013, &up),
            tshark_line("1759000000.400000", 20013, 51023, &down),
        ),
    )
    .unwrap();
    let fake = write_fake_tshark(&tmp, &lines);
    let cli = run_cli(&[
        "capture",
        "analyze",
        "--pcap",
        "-",
        "--tshark",
        fake.to_str().unwrap(),
        "--flow-map",
        "loginapp=20013",
        "--defaults",
        dp,
        "--records",
        records_path.to_str().unwrap(),
    ]);
    assert_eq!(cli.code, 0, "stderr={}", cli.err);

    // analyze: the captured records drive the PA-005 report.
    let cli2 = run_cli(&["analyze", "--records", records_path.to_str().unwrap()]);
    assert_eq!(cli2.code, 0, "stderr={}", cli2.err);
    assert!(
        cli2.out.contains("Loginapp::login"),
        "message stats: {}",
        cli2.out
    );
    assert!(
        cli2.out.contains("Client::onLoginSuccessfully"),
        "{}",
        cli2.out
    );
    assert!(
        cli2.out.contains("login_ok"),
        "connection events: {}",
        cli2.out
    );
    assert!(cli2.out.contains("p50_ms"), "latency section: {}", cli2.out);
    // stdin variant too
    let cli3 = run_cli_with(
        &["analyze", "--records", "-"],
        Some(cli2.out.trim().as_bytes()),
        None,
        &[],
    );
    assert_ne!(
        cli3.code, 0,
        "report JSON is not records JSON - stdin expects records"
    );
    let records_text = std::fs::read_to_string(&records_path).unwrap();
    let cli4 = run_cli_with(
        &["analyze", "--records", "-"],
        Some(records_text.as_bytes()),
        None,
        &[],
    );
    assert_eq!(cli4.code, 0, "stderr={}", cli4.err);
    assert_eq!(cli4.out, cli2.out, "stdin records produce the same report");
}
