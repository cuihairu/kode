//! kode-kbengine-analyzer 边界测试:输入面缺省/方向推导、未登录成功的
//! baseapp hello 不计切换、无在途请求的响应不配对、无方向记录不计流量。
//!
//! 输入均按 kode-kbengine(PA-004 `capture analyze --records`)的 JSON 记录形状
//! 构造(flow/direction/id/name/payload_len/stream_offset/timestamp/args);
//! analyzer 侧 `direction` 为 Option,缺省时由消息名 owner 推导。

use kode_kbengine_analyzer::connections;
use kode_kbengine_analyzer::correlate;
use kode_kbengine_analyzer::record::{Direction, Record};
use kode_kbengine_analyzer::stats::{compute_stats, PairSpec};
use kode_kbengine_analyzer::CONFIRMED_PAIRS;
use serde_json::json;

/// 按 PA-004 记录形状解析一条记录(缺 direction 字段 → 推导面)。
fn parse_record(v: &serde_json::Value) -> Record {
    let text = serde_json::to_string(v).unwrap();
    serde_json::from_str(&text).expect("PA-004 records JSON must deserialize into analyzer input")
}

/// 基础记录(含显式方向);`dir` 传 None 时省略 direction 字段走推导面。
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
// record.rs:方向推导(显式字段优先,否则按消息名 owner)
// ---------------------------------------------------------------------------

#[test]
fn derived_direction_from_message_owner() {
    // `Client::` 前缀 → s2c。
    let r = parse_record(&record("loginapp", None, 521, Some("Client::onHelloCB")));
    assert_eq!(
        r.direction_or_derived(),
        Some(Direction::ServerToClient),
        "Client:: 前缀推导为 s2c"
    );

    // 非 Client:: 名(上行以接收组件命名)→ c2s。
    let r = parse_record(&record("loginapp", None, 4, Some("Loginapp::hello")));
    assert_eq!(
        r.direction_or_derived(),
        Some(Direction::ClientToServer),
        "上行组件名推导为 c2s"
    );

    // 无名且无显式方向 → None(不冒充方向)。
    let r = parse_record(&record("loginapp", None, 7777, None));
    assert_eq!(r.direction_or_derived(), None);
}

#[test]
fn explicit_direction_overrides_name_owner() {
    // 显式 c2s 覆盖 `Client::` 名(取证方向为准,不猜)。
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
// stats.rs:无方向记录不计入 c2s/s2c 流量
// ---------------------------------------------------------------------------

#[test]
fn record_without_direction_is_not_tallied_per_direction() {
    // 无名且无显式方向:direction_or_derived = None → 不计入任何方向流量,
    // 但 traffic.records 与 unknown_messages 仍计(不静默丢弃)。
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
// connections.rs:登录成功前的 baseapp hello 不计切换
// ---------------------------------------------------------------------------

#[test]
fn baseapp_hello_before_login_ok_is_not_a_switch() {
    // 直连/重连前的握手 hello(登录尚未成功)不算切换(§6 步骤 8 口径)。
    let records = vec![
        // 登录前就有 baseapp hello → 不计 baseapp_switches,也不产事件。
        parse_record(&record("baseapp", Some("c2s"), 200, Some("Baseapp::hello"))),
        // 真正登录成功后再来一个 hello → 计一次切换。
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
    // 事件携带的消息名与 flow 真实值。
    assert_eq!(report.events[1].message, "Baseapp::hello");
    assert_eq!(report.events[1].flow, "baseapp");
}

#[test]
fn login_failed_does_not_grant_switch() {
    // 登录失败后的 baseapp hello 同样不算切换(登录未成功)。
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
// correlate.rs:无在途请求的响应不配对(不猜测)
// ---------------------------------------------------------------------------

#[test]
fn response_without_outstanding_request_is_not_paired() {
    // onHelloCB 到达但同 flow 无任何在途 hello/login 请求 → 不配对,
    // unmatched_requests 也不增长(该响应不属于任何已发请求)。
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
    // 请求在 flow A,响应在 flow B(两进程表独立)→ 不跨 flow 配对。
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
