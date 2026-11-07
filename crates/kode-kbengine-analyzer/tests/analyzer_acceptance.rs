//! kode2 PA-005 (todo.md Phase 3) acceptance tests: the analyzer consumes a
//! set of decoded messages (the PA-004 `capture analyze --records` JSON shape)
//! and produces a JSON report with every capability listed in the acceptance
//! clause:
//! - message/traffic stats
//! - request-response correlation (protocol-confirmed identities only - never
//!   adjacent-guess pairing)
//! - latency P50/P95/P99 over correlated pairs
//! - anomaly detection (unknown message / illegal length / schema mismatch)
//! - entity event + RPC timeline
//! - connection analysis (login / baseapp switch / relogin)

use kode_kbengine_analyzer::{analyze, AnalysisOptions, Record};
use serde_json::{json, Value};

/// PA-004 records JSON shape: a bare array of records.
fn rec(
    flow: &str,
    dir: &str,
    id: u16,
    name: Option<&str>,
    payload_len: usize,
    ts: Option<f64>,
) -> Value {
    let mut v = json!({
        "flow": flow,
        "direction": dir,
        "id": id,
        "name": name,
        "payload_len": payload_len,
        "stream_offset": 0,
        "args": [],
    });
    if let Some(t) = ts {
        v["timestamp"] = json!(t);
    }
    v
}

fn parse(records: &[Value]) -> Vec<Record> {
    let text = serde_json::to_string(records).unwrap();
    serde_json::from_str(&text).expect("PA-004 records JSON must deserialize into analyzer input")
}

fn report_json(records: &[Value]) -> Value {
    let report = analyze(&parse(records), &AnalysisOptions::default());
    serde_json::to_value(&report).expect("report serializes to JSON")
}

// ---------------------------------------------------------------------------
// message / traffic stats
// ---------------------------------------------------------------------------

#[test]
fn message_and_traffic_stats() {
    let records = vec![
        rec("loginapp", "c2s", 3, Some("Loginapp::login"), 19, None),
        rec(
            "loginapp",
            "s2c",
            502,
            Some("Client::onLoginSuccessfully"),
            23,
            None,
        ),
        rec(
            "loginapp",
            "s2c",
            502,
            Some("Client::onLoginSuccessfully"),
            23,
            None,
        ),
        rec("loginapp", "c2s", 7777, None, 9, None),
    ];
    let r = report_json(&records);
    // Per-message stats keyed by message name.
    let stats = &r["message_stats"]["Client::onLoginSuccessfully"];
    assert_eq!(stats["count"], 2, "per-message count: {r}");
    assert_eq!(stats["bytes"], 46, "per-message payload bytes: {r}");
    assert_eq!(stats["s2c"], 2, "{r}");
    // Traffic totals per direction.
    let traffic = &r["traffic"];
    assert_eq!(traffic["records"], 4, "{r}");
    assert_eq!(traffic["c2s"]["records"], 2, "{r}");
    assert_eq!(traffic["s2c"]["records"], 2, "{r}");
    assert_eq!(traffic["c2s"]["payload_bytes"], 28, "19+9: {r}");
    assert_eq!(traffic["s2c"]["payload_bytes"], 46, "{r}");
    // Unknown messages are counted, not dropped.
    assert_eq!(r["meta"]["unknown_messages"], 1, "{r}");
}

// ---------------------------------------------------------------------------
// request-response correlation: protocol-confirmed pairs only
// ---------------------------------------------------------------------------

/// Forensic pair set (docs/kbengine-wire-protocol.md §6): hello -> onHelloCB.
#[test]
fn correlates_protocol_confirmed_request_response_pairs() {
    let records = vec![
        rec(
            "loginapp",
            "c2s",
            4,
            Some("Loginapp::hello"),
            20,
            Some(100.0),
        ),
        // Noise in between must NOT become a correlated pair (no adjacency
        // guessing): onEntityEnterWorld is not in the pair table.
        rec(
            "loginapp",
            "s2c",
            507,
            Some("Client::onEntityEnterWorld"),
            8,
            Some(105.0),
        ),
        rec(
            "loginapp",
            "s2c",
            521,
            Some("Client::onHelloCB"),
            30,
            Some(110.0),
        ),
    ];
    let r = report_json(&records);
    let pairs = r["correlations"]["pairs"].as_array().unwrap();
    assert_eq!(pairs.len(), 1, "only hello->onHelloCB pairs: {r}");
    assert_eq!(pairs[0]["request"], "Loginapp::hello", "{r}");
    assert_eq!(pairs[0]["response"], "Client::onHelloCB", "{r}");
    assert_eq!(pairs[0]["delta_ms"], 10000.0, "110s - 100s: {r}");
    assert_eq!(r["correlations"]["unmatched_requests"], 0, "{r}");
}

#[test]
fn request_without_response_is_unmatched_not_guessed() {
    let records = vec![
        rec("loginapp", "c2s", 3, Some("Loginapp::login"), 19, Some(1.0)),
        // A later downlink that is NOT the protocol response for login
        // (onLoginFailed/onLoginSuccessfully are) must not pair with it.
        rec(
            "loginapp",
            "s2c",
            517,
            Some("Client::onKicked"),
            2,
            Some(2.0),
        ),
    ];
    let r = report_json(&records);
    assert_eq!(
        r["correlations"]["pairs"].as_array().unwrap().len(),
        0,
        "{r}"
    );
    assert_eq!(r["correlations"]["unmatched_requests"], 1, "{r}");
}

#[test]
fn fifo_pairs_across_two_outstanding_requests() {
    // Two hello requests before both acks arrive: protocol-confirmed
    // one-outstanding FIFO matching within the pair type (no cross-flow or
    // cross-type mixing).
    let records = vec![
        rec(
            "loginapp",
            "c2s",
            4,
            Some("Loginapp::hello"),
            20,
            Some(10.0),
        ),
        rec(
            "loginapp",
            "c2s",
            4,
            Some("Loginapp::hello"),
            20,
            Some(20.0),
        ),
        rec(
            "loginapp",
            "s2c",
            521,
            Some("Client::onHelloCB"),
            30,
            Some(30.0),
        ),
        rec(
            "loginapp",
            "s2c",
            521,
            Some("Client::onHelloCB"),
            30,
            Some(45.0),
        ),
    ];
    let r = report_json(&records);
    let pairs = r["correlations"]["pairs"].as_array().unwrap();
    assert_eq!(pairs.len(), 2, "{r}");
    assert_eq!(pairs[0]["delta_ms"], 20000.0, "first-request FIFO: {r}");
    assert_eq!(pairs[1]["delta_ms"], 25000.0, "second-request FIFO: {r}");
}

// ---------------------------------------------------------------------------
// latency P50/P95/P99 over correlated pairs
// ---------------------------------------------------------------------------

#[test]
fn latency_percentiles_over_pair_deltas() {
    let mut records = Vec::new();
    // 5 hello pairs with exact-f64 deltas 1, 2, 3, 4, 5 s (integer seconds on
    // both sides keep the subtraction exact).
    for (i, delta) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
        let t = 100.0 + (i as f64) * 10.0;
        records.push(rec(
            "loginapp",
            "c2s",
            4,
            Some("Loginapp::hello"),
            20,
            Some(t),
        ));
        records.push(rec(
            "loginapp",
            "s2c",
            521,
            Some("Client::onHelloCB"),
            30,
            Some(t + delta),
        ));
    }
    let r = report_json(&records);
    let lat = &r["latency"];
    assert_eq!(lat["pair_count"], 5, "{r}");
    // nearest-rank over sorted [1000,2000,3000,4000,5000] ms
    assert_eq!(lat["p50_ms"], 3000.0, "ceil(0.5*5)=3rd: {r}");
    assert_eq!(lat["p95_ms"], 5000.0, "ceil(0.95*5)=5th: {r}");
    assert_eq!(lat["p99_ms"], 5000.0, "ceil(0.99*5)=5th: {r}");
    assert_eq!(lat["max_ms"], 5000.0, "{r}");
}

#[test]
fn latency_absent_without_timestamps() {
    let records = vec![
        rec("loginapp", "c2s", 4, Some("Loginapp::hello"), 20, None),
        rec("loginapp", "s2c", 521, Some("Client::onHelloCB"), 30, None),
    ];
    let r = report_json(&records);
    assert_eq!(
        r["correlations"]["pairs"].as_array().unwrap().len(),
        1,
        "pairing works: {r}"
    );
    assert_eq!(
        r["latency"]["pair_count"], 0,
        "no timestamps -> no latency claims: {r}"
    );
}

// ---------------------------------------------------------------------------
// anomaly detection
// ---------------------------------------------------------------------------

#[test]
fn anomaly_detection_unknown_length_schema() {
    let records = vec![
        rec("loginapp", "c2s", 7777, None, 9, None), // unknown message id
        rec(
            "loginapp",
            "s2c",
            502,
            Some("Client::onLoginSuccessfully"),
            2,
            None,
        ), // illegal length (variable with 2-byte payload against schema shape)
        json!({
            "flow": "loginapp", "direction": "c2s", "id": 3,
            "name": "Loginapp::login", "payload_len": 19, "stream_offset": 0,
            "args": [], "anomaly": {"kind": "invalid_string", "offset": 7, "message": "NUL missing"}
        }),
    ];
    let r = report_json(&records);
    let anomalies = r["anomalies"]["items"].as_array().unwrap();
    let kinds: Vec<&str> = anomalies
        .iter()
        .map(|a| a["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"unknown_message"), "unknown id: {r}");
    assert!(
        kinds.contains(&"illegal_length"),
        "payload below schema minimum: {r}"
    );
    assert!(
        kinds.contains(&"invalid_string"),
        "decode-stage schema mismatch rides through: {r}"
    );
    assert_eq!(r["anomalies"]["total"], 3, "{r}");
}

// ---------------------------------------------------------------------------
// entity event + RPC timeline
// ---------------------------------------------------------------------------

#[test]
fn entity_event_and_rpc_timeline() {
    let records = vec![
        json!({
            "flow": "baseapp", "direction": "s2c", "id": 507,
            "name": "Client::onEntityEnterWorld", "payload_len": 8, "stream_offset": 0,
            "args": [], "entity_id": 1001, "timestamp": 1.0
        }),
        json!({
            "flow": "baseapp", "direction": "c2s", "id": 205,
            "name": "Baseapp::onRemoteCallCellMethodFromClient", "payload_len": 12,
            "stream_offset": 0, "args": [], "entity_id": 1001, "timestamp": 2.0
        }),
        json!({
            "flow": "baseapp", "direction": "s2c", "id": 506,
            "name": "Client::onRemoteMethodCall", "payload_len": 14, "stream_offset": 0,
            "args": [], "entity_id": 1001, "method_id": 7, "timestamp": 3.0
        }),
        rec("loginapp", "c2s", 4, Some("Loginapp::hello"), 20, Some(1.5)), // not an entity event
    ];
    let r = report_json(&records);
    let events = r["entity_timeline"]["events"].as_array().unwrap();
    assert_eq!(events.len(), 3, "{r}");
    assert_eq!(events[0]["entity_id"], 1001, "{r}");
    assert_eq!(events[0]["event"], "Client::onEntityEnterWorld", "{r}");
    assert_eq!(
        events[1]["event"], "Baseapp::onRemoteCallCellMethodFromClient",
        "{r}"
    );
    assert_eq!(events[2]["method_id"], 7, "rpc keeps method id: {r}");
    let rpcs = r["entity_timeline"]["rpcs"].as_array().unwrap();
    assert_eq!(rpcs.len(), 2, "both remote-call messages are rpcs: {r}");
    assert_eq!(
        r["entity_timeline"]["entities"], 1,
        "distinct entity count: {r}"
    );
}

// ---------------------------------------------------------------------------
// connection analysis
// ---------------------------------------------------------------------------

#[test]
fn connection_analysis_login_switch_relogin() {
    let records = vec![
        rec("loginapp", "c2s", 4, Some("Loginapp::hello"), 20, Some(1.0)),
        rec(
            "loginapp",
            "s2c",
            521,
            Some("Client::onHelloCB"),
            30,
            Some(1.1),
        ),
        rec("loginapp", "c2s", 3, Some("Loginapp::login"), 19, Some(2.0)),
        rec(
            "loginapp",
            "s2c",
            502,
            Some("Client::onLoginSuccessfully"),
            23,
            Some(2.2),
        ),
        // switch: baseapp hello right after login success (PA-001 §6 step 8)
        rec("baseapp", "c2s", 200, Some("Baseapp::hello"), 20, Some(3.0)),
        rec(
            "baseapp",
            "s2c",
            521,
            Some("Client::onHelloCB"),
            30,
            Some(3.1),
        ),
        rec(
            "baseapp",
            "c2s",
            204,
            Some("Baseapp::reloginBaseapp"),
            12,
            Some(4.0),
        ),
        rec(
            "baseapp",
            "s2c",
            503,
            Some("Client::onLoginFailed"),
            5,
            Some(4.5),
        ),
    ];
    let r = report_json(&records);
    let conn = &r["connections"];
    assert_eq!(conn["login_attempts"], 1, "{r}");
    assert_eq!(conn["logins_ok"], 1, "onLoginSuccessfully: {r}");
    assert_eq!(
        conn["logins_failed"], 1,
        "onLoginFailed counts the failure side: {r}"
    );
    assert_eq!(
        conn["baseapp_switches"], 1,
        "baseapp hello after login ok: {r}"
    );
    assert_eq!(conn["relogin_attempts"], 1, "{r}");
    let events = conn["events"].as_array().unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"login_ok"), "{r}");
    assert!(kinds.contains(&"baseapp_switch"), "{r}");
    assert!(kinds.contains(&"relogin"), "{r}");
}

// ---------------------------------------------------------------------------
// report shape + determinism
// ---------------------------------------------------------------------------

#[test]
fn report_is_deterministic_json_with_all_sections() {
    let records = vec![
        rec("loginapp", "c2s", 3, Some("Loginapp::login"), 19, Some(1.0)),
        rec(
            "loginapp",
            "s2c",
            502,
            Some("Client::onLoginSuccessfully"),
            23,
            Some(1.2),
        ),
    ];
    let r1 = report_json(&records);
    let r2 = report_json(&records);
    assert_eq!(
        serde_json::to_string(&r1).unwrap(),
        serde_json::to_string(&r2).unwrap(),
        "same records -> byte-identical report"
    );
    for section in [
        "meta",
        "message_stats",
        "traffic",
        "correlations",
        "latency",
        "anomalies",
        "entity_timeline",
        "connections",
    ] {
        assert!(r1.get(section).is_some(), "section {section} present: {r1}");
    }
}
