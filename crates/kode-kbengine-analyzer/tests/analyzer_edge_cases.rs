//! kode-kbengine-analyzer edge tests: input-face defaults/direction derivation, a baseapp
//! hello before a successful login not counting as a switch, a response with no in-flight
//! request not being paired, and direction-less records not counted in per-direction traffic.
//!
//! Inputs are all constructed in kode-kbengine's (PA-004 `capture analyze --records`) JSON
//! record shape (flow/direction/id/name/payload_len/stream_offset/timestamp/args); on the
//! analyzer side `direction` is an Option, and when absent it is derived from the message
//! name's owner.

use kode_kbengine_analyzer::connections;
use kode_kbengine_analyzer::correlate;
use kode_kbengine_analyzer::record::{Direction, Record};
use kode_kbengine_analyzer::stats::{compute_stats, PairSpec};
use kode_kbengine_analyzer::CONFIRMED_PAIRS;
use serde_json::json;

/// Parse one record in the PA-004 record shape (the direction field absent -> the derivation face).
fn parse_record(v: &serde_json::Value) -> Record {
    let text = serde_json::to_string(v).unwrap();
    serde_json::from_str(&text).expect("PA-004 records JSON must deserialize into analyzer input")
}

/// A base record (with an explicit direction); when `dir` is None the direction field is omitted, taking the derivation face.
fn record(flow: &str, dir: Option<&str>, id: u16, name: Option<&str>) -> serde_json::Value {
    let mut v = json!({
        "flow": flow,
        "id": id,
        "name": name,
        "payload_len": 0,
        "stream_offset": 0,
        "args": [],
    });
    if let Some(d) = dir {
        v["direction"] = json!(d);
    }
    v
}

// ---------------------------------------------------------------------------
// record.rs: direction derivation (the explicit field takes priority, otherwise the message name's owner)
// ---------------------------------------------------------------------------

#[test]
fn derived_direction_from_message_owner() {
    // A `Client::` prefix -> s2c.
    let r = parse_record(&record("loginapp", None, 521, Some("Client::onHelloCB")));
    assert_eq!(
        r.direction_or_derived(),
        Some(Direction::ServerToClient),
        "Client:: 前缀推导为 s2c"
    );

    // A non-Client:: name (uplink messages are named after the receiving component) -> c2s.
    let r = parse_record(&record("loginapp", None, 4, Some("Loginapp::hello")));
    assert_eq!(
        r.direction_or_derived(),
        Some(Direction::ClientToServer),
        "上行组件名推导为 c2s"
    );

    // No name and no explicit direction -> None (never impersonating a direction).
    let r = parse_record(&record("loginapp", None, 7777, None));
    assert_eq!(r.direction_or_derived(), None);
}

#[test]
fn explicit_direction_overrides_name_owner() {
    // An explicit c2s overrides a `Client::` name (the forensic direction wins, no guessing).
    let r = parse_record(&record(
        "loginapp",
        Some("c2s"),
        521,
        Some("Client::onHelloCB"),
    ));
    assert_eq!(
        r.direction_or_derived(),
        Some(Direction::ClientToServer),
        "显式方向优先于消息名 owner 推导"
    );
}

// ---------------------------------------------------------------------------
// stats.rs: a direction-less record is not tallied into c2s/s2c traffic
// ---------------------------------------------------------------------------

#[test]
fn record_without_direction_is_not_tallied_per_direction() {
    // No name and no explicit direction: direction_or_derived = None -> not tallied into any
    // direction's traffic, but traffic.records and unknown_messages are still counted (never silently dropped).
    let records = vec![parse_record(&record("loginapp", None, 7777, None))];
    let stats = compute_stats(&records);
    assert_eq!(stats.traffic.records, 1);
    assert_eq!(stats.traffic.c2s.records, 0);
    assert_eq!(stats.traffic.s2c.records, 0);
    assert_eq!(stats.traffic.c2s.payload_bytes, 0);
    assert_eq!(stats.traffic.s2c.payload_bytes, 0);
    assert_eq!(stats.unknown_messages, 1);
    assert!(stats.message_stats.is_empty(), "无名不计入 message_stats");
}

// ---------------------------------------------------------------------------
// connections.rs: a baseapp hello before a successful login is not a switch
// ---------------------------------------------------------------------------

#[test]
fn baseapp_hello_before_login_ok_is_not_a_switch() {
    // The handshake hello before direct connect/reconnect (login not yet successful) is not a switch (the §6 step 8 contract).
    let records = vec![
        // A baseapp hello already before login -> not counted in baseapp_switches, and no event is produced.
        parse_record(&record("baseapp", Some("c2s"), 200, Some("Baseapp::hello"))),
        // Another hello after a genuine successful login -> counts as one switch.
        parse_record(&record(
            "loginapp",
            Some("s2c"),
            502,
            Some("Client::onLoginSuccessfully"),
        )),
        parse_record(&record("baseapp", Some("c2s"), 200, Some("Baseapp::hello"))),
    ];
    let report = connections::analyze(&records);
    assert_eq!(
        report.baseapp_switches, 1,
        "仅登录成功后的一次 hello 算切换"
    );
    assert_eq!(report.logins_ok, 1);
    let kinds: Vec<&str> = report.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        ["login_ok", "baseapp_switch"],
        "登录前的 hello 不产事件"
    );
    // The message name and flow values carried by the event.
    assert_eq!(report.events[1].message, "Baseapp::hello");
    assert_eq!(report.events[1].flow, "baseapp");
}

#[test]
fn login_failed_does_not_grant_switch() {
    // A baseapp hello after a failed login is likewise not a switch (the login did not succeed).
    let records = vec![
        parse_record(&record(
            "loginapp",
            Some("s2c"),
            503,
            Some("Client::onLoginFailed"),
        )),
        parse_record(&record("baseapp", Some("c2s"), 200, Some("Baseapp::hello"))),
    ];
    let report = connections::analyze(&records);
    assert_eq!(report.logins_failed, 1);
    assert_eq!(report.baseapp_switches, 0, "登录失败后 hello 不切换");
    assert_eq!(report.events.len(), 1, "仅 login_failed 事件");
    assert_eq!(report.events[0].kind, "login_failed");
}

// ---------------------------------------------------------------------------
// correlate.rs: a response with no in-flight request is not paired (no guessing)
// ---------------------------------------------------------------------------

#[test]
fn response_without_outstanding_request_is_not_paired() {
    // onHelloCB arrives but no in-flight hello/login request exists in the same flow -> no
    // pairing, and unmatched_requests does not grow either (the response belongs to no issued request).
    let records = vec![parse_record(&record(
        "loginapp",
        Some("s2c"),
        521,
        Some("Client::onHelloCB"),
    ))];
    let report = correlate::correlate(&records, CONFIRMED_PAIRS);
    assert!(report.pairs.is_empty(), "无请求的响应不产配对");
    assert_eq!(report.unmatched_requests, 0);
}

#[test]
fn response_for_other_flow_is_not_paired_with_this_flow_request() {
    // The request is in flow A, the response in flow B (the two process tables are independent) -> no cross-flow pairing.
    let pairs: &[PairSpec] = CONFIRMED_PAIRS;
    let records = vec![
        parse_record(&record("loginapp", Some("c2s"), 4, Some("Loginapp::hello"))),
        parse_record(&record(
            "baseapp",
            Some("s2c"),
            521,
            Some("Client::onHelloCB"),
        )),
    ];
    let report = correlate::correlate(&records, pairs);
    assert!(report.pairs.is_empty(), "跨 flow 不配对");
    assert_eq!(report.unmatched_requests, 1, "原 flow 请求仍未匹配");
}
