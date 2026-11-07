//! 子命令实现(schema validate/build/diff/inspect、decode --hex、capture analyze)。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use kode_kbengine_schema::compat;
use kode_kbengine_schema::{build_schema_from_project, BuildOptions, Schema};

use crate::cli::Command;
use crate::records::{hex_decode, message_table, role_of, DecodeDriver};
use crate::tshark;

/// 子命令执行结果:stdout 文本 + 退出码。
#[derive(Debug)]
pub struct CmdOutcome {
    pub stdout: String,
    pub code: i32,
}

impl CmdOutcome {
    pub fn ok(stdout: String) -> Self {
        CmdOutcome { stdout, code: 0 }
    }
    pub fn fail(code: i32, stdout: String) -> Self {
        CmdOutcome { stdout, code }
    }
}

type CmdResult = Result<CmdOutcome, String>;

pub fn dispatch(cmd: Command) -> CmdResult {
    match cmd {
        Command::SchemaValidate { project, defaults } => {
            schema_validate(&project, defaults.as_deref())
        }
        Command::SchemaBuild {
            project,
            defaults,
            out,
        } => schema_build(&project, defaults.as_deref(), out.as_deref()),
        Command::SchemaDiff { old, new } => schema_diff(&old, &new),
        Command::SchemaInspect {
            schema,
            message,
            message_id,
            entity,
        } => schema_inspect(&schema, message.as_deref(), message_id, entity.as_deref()),
        Command::Decode {
            hex,
            defaults,
            flow,
            direction,
        } => decode_hex(&hex, defaults.as_deref(), &flow, &direction),
        Command::CaptureAnalyze {
            pcap,
            tshark,
            flow_map,
            raw_flows,
            defaults,
            records_out,
        } => capture_analyze(
            pcap.as_deref(),
            &tshark,
            &flow_map,
            &raw_flows,
            defaults.as_deref(),
            records_out.as_deref(),
        ),
    }
}

// ---------------------------------------------------------------------------
// schema 面
// ---------------------------------------------------------------------------

fn read_defaults(defaults: Option<&str>) -> Result<Option<String>, String> {
    match defaults {
        Some(p) => Ok(Some(
            std::fs::read_to_string(p).map_err(|e| format!("read defaults {p}: {e}"))?,
        )),
        None => Ok(None),
    }
}

fn build_schema(project: &str, defaults: Option<&str>) -> Result<Schema, String> {
    let engine_defaults = read_defaults(defaults)?;
    build_schema_from_project(
        Path::new(project),
        engine_defaults.as_deref(),
        &BuildOptions::default(),
    )
    .map_err(|e| e.to_string())
}

fn schema_validate(project: &str, defaults: Option<&str>) -> CmdResult {
    let schema = build_schema(project, defaults)?;
    let out = serde_json::json!({
        "valid": true,
        "project": project,
        "sha256": schema.hash_hex(),
        "schema_version": schema.schema_version,
        "messages": schema.messages.entries.len(),
        "entities": schema.entities.len(),
        // 可选资产缺失/坏文件是构建诊断(SYNTAX-005 同规),不否定 validate;
        // 结构性失败走 Err → exit 1。
        "diagnostics": schema.diagnostics,
    });
    Ok(CmdOutcome {
        stdout: serde_json::to_string_pretty(&out).expect("json"),
        code: 0,
    })
}

fn schema_build(project: &str, defaults: Option<&str>, out: Option<&str>) -> CmdResult {
    let schema = build_schema(project, defaults)?;
    let json = schema.to_canonical_json();
    if let Some(path) = out {
        std::fs::write(path, &json).map_err(|e| format!("write {path}: {e}"))?;
    }
    Ok(CmdOutcome::ok(json))
}

fn load_schema(path: &str) -> Result<Schema, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse schema {path}: {e}"))
}

fn schema_diff(old: &str, new: &str) -> CmdResult {
    let old_schema = load_schema(old)?;
    let new_schema = load_schema(new)?;
    let report = compat::check(&old_schema, &new_schema);
    let code = if report.compatible { 0 } else { 1 };
    Ok(CmdOutcome {
        stdout: serde_json::to_string_pretty(&report).expect("json"),
        code,
    })
}

fn schema_inspect(
    schema_path: &str,
    message: Option<&str>,
    message_id: Option<u16>,
    entity: Option<&str>,
) -> CmdResult {
    let schema = load_schema(schema_path)?;
    let not_found = |what: String| -> CmdResult { Err(format!("not found in schema: {what}")) };
    if let Some(name) = message {
        return match schema.messages.find(name) {
            Some(e) => Ok(CmdOutcome::ok(
                serde_json::to_string_pretty(e).expect("json"),
            )),
            None => not_found(format!("message {name}")),
        };
    }
    if let Some(id) = message_id {
        return match schema.messages.by_id(id) {
            Some(e) => Ok(CmdOutcome::ok(
                serde_json::to_string_pretty(e).expect("json"),
            )),
            None => not_found(format!("message id {id}")),
        };
    }
    if let Some(name) = entity {
        return match schema.entities.get(name) {
            Some(e) => Ok(CmdOutcome::ok(
                serde_json::to_string_pretty(e).expect("json"),
            )),
            None => not_found(format!("entity {name}")),
        };
    }
    let out = serde_json::json!({
        "sha256": schema.hash_hex(),
        "schema_version": schema.schema_version,
        "engine_baseline": schema.engine_baseline,
        "packet_always_contain_length": schema.packet_always_contain_length,
        "messages": schema.messages.entries.len(),
        "entities": schema.entities.len(),
        "aliases": schema.aliases.len(),
        "missing_entities": schema.missing_entities,
        "diagnostics": schema.diagnostics,
    });
    Ok(CmdOutcome::ok(
        serde_json::to_string_pretty(&out).expect("json"),
    ))
}

// ---------------------------------------------------------------------------
// decode --hex
// ---------------------------------------------------------------------------

fn decode_hex(hex: &str, defaults: Option<&str>, flow: &str, direction: &str) -> CmdResult {
    let table = message_table(defaults)?;
    let role = role_of(flow).ok_or_else(|| format!("unknown flow '{flow}' (loginapp|baseapp)"))?;
    let dir = parse_direction(direction)?;
    let bytes = hex_decode(hex)?;
    let mut driver = DecodeDriver::new(table);
    driver.feed(role, dir, &bytes, None);
    Ok(CmdOutcome::ok(driver_report(&driver)))
}

fn parse_direction(s: &str) -> Result<kode_kbengine_protocol::Direction, String> {
    match s {
        "c2s" | "up" => Ok(kode_kbengine_protocol::Direction::ClientToServer),
        "s2c" | "down" => Ok(kode_kbengine_protocol::Direction::ServerToClient),
        _ => Err(format!("unknown direction '{s}' (c2s|s2c)")),
    }
}

fn driver_report(driver: &DecodeDriver) -> String {
    let out = serde_json::json!({
        "records": driver.records,
        "anomalies": driver.anomalies,
    });
    serde_json::to_string_pretty(&out).expect("json")
}

// ---------------------------------------------------------------------------
// capture analyze
// ---------------------------------------------------------------------------

/// `--raw-flow loginapp=<hex>`(上行)/ `loginapp.down=<hex>`(下行)。
fn raw_flow_spec(spec: &str) -> Result<(String, bool, Vec<u8>), String> {
    let (flow_key, hex) = spec
        .split_once('=')
        .ok_or_else(|| format!("bad --raw-flow: {spec}"))?;
    let (flow, down) = match flow_key.split_once('.') {
        Some((f, "down")) => (f, true),
        Some((f, "up")) => (f, false),
        Some((_, other)) => {
            return Err(format!(
                "bad --raw-flow direction '{other}' in {spec} (up|down)"
            ))
        }
        None => (flow_key, false),
    };
    role_of(flow)
        .ok_or_else(|| format!("unknown flow '{flow}' in --raw-flow (loginapp|baseapp)"))?;
    Ok((flow.to_string(), down, hex_decode(hex)?))
}

fn capture_analyze(
    pcap: Option<&str>,
    tshark_bin: &str,
    flow_map: &[(String, u16)],
    raw_flows: &[(String, String)],
    defaults: Option<&str>,
    records_out: Option<&str>,
) -> CmdResult {
    let table = message_table(defaults)?;
    let mut driver = DecodeDriver::new(table);

    // 1. raw-flow:直接喂 TCP 流字节(字节级组帧对拍/无 tshark 环境)。
    for (key, hex) in raw_flows {
        let (flow, down, bytes) = raw_flow_spec(&format!("{key}={hex}"))?;
        let role = role_of(&flow).expect("validated above");
        let dir = if down {
            kode_kbengine_protocol::Direction::ServerToClient
        } else {
            kode_kbengine_protocol::Direction::ClientToServer
        };
        driver.feed(role, dir, &bytes, None);
    }

    // 2. pcap:TShark 输入层(stdin `-` 走流式)。
    if let Some(pcap_path) = pcap {
        let mut ports: BTreeMap<u16, String> = BTreeMap::new();
        for (flow, port) in flow_map {
            role_of(flow).ok_or_else(|| format!("unknown flow '{flow}' in --flow-map"))?;
            ports.insert(*port, flow.clone());
        }
        let mut tshark_proc = if pcap_path == "-" {
            let stdin_src: Box<dyn Read + Send> = Box::new(std::io::stdin());
            tshark::spawn_tshark(tshark_bin, "-", Some(stdin_src))?
        } else {
            tshark::spawn_tshark(tshark_bin, pcap_path, None)?
        };
        let mut packet_err: Option<String> = None;
        tshark_proc.for_each_packet(|line_res| {
            let packet = match line_res {
                Ok(p) => p,
                Err(e) => {
                    if packet_err.is_none() {
                        packet_err = Some(e);
                    }
                    return;
                }
            };
            let flow = ports
                .get(&packet.srcport)
                .or_else(|| ports.get(&packet.dstport));
            let Some(flow) = flow else {
                driver.anomalies.push(crate::records::Anomaly {
                    kind: "unmapped_stream".into(),
                    flow: format!("{}->{}", packet.srcport, packet.dstport),
                    offset: 0,
                    message: "tcp ports not in --flow-map; packet skipped".into(),
                });
                return;
            };
            let role = role_of(flow).expect("validated");
            let dir = if ports.contains_key(&packet.srcport) {
                kode_kbengine_protocol::Direction::ServerToClient
            } else {
                kode_kbengine_protocol::Direction::ClientToServer
            };
            driver.feed(role, dir, &packet.payload, packet.timestamp);
        })?;
        if let Some(e) = packet_err {
            return Err(e);
        }
    }

    if let Some(path) = records_out {
        let json = serde_json::to_string_pretty(&driver.records).expect("json");
        std::fs::write(path, json).map_err(|e| format!("write {path}: {e}"))?;
    }
    Ok(CmdOutcome::ok(driver_report(&driver)))
}
