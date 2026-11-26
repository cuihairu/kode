//! RUST-133:索引缺口报告(索引缺口记录 + 按需补齐)server 分派层全链。
//!
//! 覆盖:聚合报告三族恒装配(unindexed/partial/stale);partial 族 = 解析
//! 失败负缓存(非声明文件)+ 有界样本带 reason;stale 族 = 刷新在途
//! (didOpen 未泵,per-URI pendingRefresh + 聚合 queued);per-URI 四态
//! 裁定(unindexed / stale / partial / none)与裁定序;fill 按需补齐
//! (request_close 执行时刻真相重放,盘上合法文件回读入库);根外/不可
//! 解析 URI 诚实 unindexed 且 fill 不越权。

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::server::Outgoing;
use kode_server::{handle_message, ServerState};
use kode_vfs::CanonicalUri;

fn unique_dir(tag: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "kode-r133-{}-{}-{}",
        tag,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).expect("create tmpdir");
    dir
}

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn init_state(dir: &std::path::Path) -> ServerState {
    let mut state = ServerState::new();
    let out = handle_message(
        &mut state,
        request(
            0,
            "initialize",
            json!({"capabilities": {}, "workspaceFolders": [
                {"uri": format!("file://{}", dir.display())}
            ]}),
        ),
    );
    assert_eq!(out.len(), 1, "initialize 应有回执");
    state
}

fn uri_for(dir: &std::path::Path, name: &str) -> String {
    format!("file://{}", dir.join(name).display())
}

/// 索引缺口请求回执(聚合或 per-URI 裁定)。
fn gaps(state: &mut ServerState, params: Value, id: i64) -> Value {
    let out = handle_message(state, request(id, "$/kode/indexGaps", params));
    assert_eq!(out.len(), 1, "indexGaps 应恰一回执");
    match out.into_iter().next().unwrap() {
        Outgoing::Response(response) => {
            assert!(response.error.is_none(), "indexGaps 不应报错: {response:?}");
            response.result.expect("indexGaps 必有结果")
        }
        other => panic!("indexGaps 回执形状异常: {other:?}"),
    }
}

fn did_open(state: &mut ServerState, uri: &str, text: &str) {
    let out = handle_message(
        state,
        IncomingMessage::Notification(kode_protocol::Notification {
            jsonrpc: "2.0".into(),
            method: "textDocument/didOpen".into(),
            params: Some(json!({
                "textDocument": {"uri": uri, "languageId": "plaintext", "version": 1, "text": text}
            })),
        }),
    );
    assert!(out.is_empty(), "didOpen 无回执");
}

fn pump(state: &mut ServerState) {
    // RESP-001b:泵=生产形态(墙钟界;读线程往返在预算内交货应用)。
    state
        .index
        .pump_budgeted_until(64, Instant::now() + Duration::from_millis(2000));
}

const DEF_TEXT: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";

/// 聚合报告三族恒装配(消费者不猜形状);fresh server 零缺口,暖扫之外
/// known/missing 诚实 null 不虚构 0。
#[test]
fn aggregate_report_always_has_three_families() {
    let dir = unique_dir("agg");
    let mut state = init_state(&dir);
    let report = gaps(&mut state, json!({}), 1);
    let unindexed = report.get("unindexed").expect("unindexed 族恒在");
    assert_eq!(
        unindexed.get("known"),
        Some(&Value::Null),
        "暖扫外 known=null"
    );
    assert_eq!(
        unindexed.get("missing"),
        Some(&Value::Null),
        "暖扫外 missing=null"
    );
    assert_eq!(unindexed.get("indexed"), Some(&json!(0)));
    let partial = report.get("partial").expect("partial 族恒在");
    assert_eq!(
        partial.get("count"),
        Some(&json!(0)),
        "fresh server 无负缓存"
    );
    assert_eq!(partial.get("samples"), Some(&json!([])));
    let stale = report.get("stale").expect("stale 族恒在");
    assert!(stale.get("queued").and_then(|v| v.as_u64()).is_some());
    assert!(
        stale
            .get("stormBuffered")
            .and_then(|v| v.as_u64())
            .is_some(),
        "stale 族形状齐全"
    );
}

/// partial 族 = 解析失败负缓存:非声明文件入库后聚合 count+样本带 reason,
/// per-URI 裁定 gap="partial" 且 parseError 非 null;合法 def 同库 gap="none"。
#[test]
fn partial_family_reports_negative_cache_with_reason() {
    let dir = unique_dir("partial");
    let notes_uri = uri_for(&dir, "Notes.txt");
    let def_uri = uri_for(&dir, "Monster.def");
    let mut state = init_state(&dir);
    did_open(&mut state, &notes_uri, "随手记");
    did_open(&mut state, &def_uri, DEF_TEXT);
    pump(&mut state);

    let report = gaps(&mut state, json!({}), 1);
    let partial = report.get("partial").expect("partial 族");
    assert_eq!(
        partial.get("count"),
        Some(&json!(1)),
        "恰一条负缓存(非声明文件)"
    );
    let samples = partial.get("samples").and_then(|v| v.as_array()).unwrap();
    assert_eq!(samples.len(), 1);
    assert_eq!(
        samples[0].get("uri"),
        Some(&json!(notes_uri)),
        "样本 URI 按字典序产出"
    );
    let reason = samples[0]
        .get("reason")
        .and_then(|v| v.as_str())
        .expect("样本带 reason");
    assert!(!reason.is_empty());

    let verdict = gaps(&mut state, json!({"uri": notes_uri}), 2);
    assert_eq!(verdict.get("gap"), Some(&json!("partial")));
    assert_eq!(verdict.get("tracked"), Some(&json!(true)));
    let parse_error = verdict
        .get("parseError")
        .and_then(|v| v.as_str())
        .expect("partial 裁定带 parseError");
    assert_eq!(parse_error, reason, "parseError 与聚合样本同源");

    let ok = gaps(&mut state, json!({"uri": def_uri}), 3);
    assert_eq!(ok.get("gap"), Some(&json!("none")), "合法 def 无缺口");
    assert_eq!(ok.get("parseError"), Some(&Value::Null));
}

/// stale 族:didOpen 未泵 = 刷新在途,per-URI gap="stale" + pendingRefresh,
/// 聚合 stale.queued ≥ 1;裁定序 stale 先于 partial(并存时在途刷新先报)。
#[test]
fn stale_family_reports_pending_refresh() {
    let dir = unique_dir("stale");
    let uri = uri_for(&dir, "Pending.def");
    let mut state = init_state(&dir);
    did_open(&mut state, &uri, DEF_TEXT);
    // 不泵:任务在调度队列。

    let report = gaps(&mut state, json!({}), 1);
    let queued = report
        .get("stale")
        .and_then(|s| s.get("queued"))
        .and_then(|v| v.as_u64())
        .expect("stale 族");
    assert!(queued >= 1, "聚合 stale.queued 记账在途刷新,得 {queued}");

    let verdict = gaps(&mut state, json!({"uri": uri}), 2);
    assert_eq!(verdict.get("gap"), Some(&json!("stale")));
    assert_eq!(verdict.get("pendingRefresh"), Some(&json!(true)));
    assert_eq!(verdict.get("tracked"), Some(&json!(false)), "未泵未入库");

    // 泵后缺口归零(刷新完成)。
    pump(&mut state);
    let settled = gaps(&mut state, json!({"uri": uri}), 3);
    assert_eq!(settled.get("gap"), Some(&json!("none")));
    assert_eq!(settled.get("pendingRefresh"), Some(&json!(false)));
}

/// unindexed 族 + fill 按需补齐:盘上文件从未入库 → tracked=false
/// gap="unindexed";fill=true 经 request_close 回读盘入库,泵后 gap="none";
/// 无 fill 时纯观测零侧效。
#[test]
fn unindexed_fill_reads_disk_file_into_index() {
    let dir = unique_dir("fill");
    let path = dir.join("Late.def");
    std::fs::write(&path, DEF_TEXT).expect("write def");
    let uri = uri_for(&dir, "Late.def");
    let mut state = init_state(&dir);

    // 纯观测(fill 缺省 false):unindexed 如实,零侧效。
    let observed = gaps(&mut state, json!({"uri": uri}), 1);
    assert_eq!(observed.get("gap"), Some(&json!("unindexed")));
    assert_eq!(observed.get("tracked"), Some(&json!(false)));
    assert_eq!(observed.get("filled"), Some(&json!(false)));

    let queued_before = state.index.snapshot().queued;
    let filled = gaps(&mut state, json!({"uri": uri, "fill": true}), 2);
    assert_eq!(filled.get("gap"), Some(&json!("unindexed")));
    assert_eq!(filled.get("filled"), Some(&json!(true)), "fill 入队成功");
    assert!(
        state.index.snapshot().queued > queued_before,
        "fill 侧效 = 刷新入队"
    );

    pump(&mut state);
    let settled = gaps(&mut state, json!({"uri": uri}), 3);
    assert_eq!(settled.get("gap"), Some(&json!("none")), "回读入库后无缺口");
    assert_eq!(settled.get("tracked"), Some(&json!(true)));
}

/// 根外/不可解析 URI 诚实 unindexed:tracked=false 且 fill 不越权(无键
/// 可铸,零侧效),绝不给 UNROOTED 身份。
#[test]
fn out_of_root_uri_honest_unindexed_and_fill_noop() {
    let dir = unique_dir("outroot");
    let mut state = init_state(&dir);
    // 真·根外:另一个未注册目录(注册根的子目录仍算根内,前缀归属)。
    let other_root = unique_dir("elsewhere");
    let outside = format!("file://{}", other_root.join("Stray.def").display());
    let verdict = gaps(&mut state, json!({"uri": outside, "fill": true}), 1);
    assert_eq!(verdict.get("gap"), Some(&json!("unindexed")));
    assert_eq!(verdict.get("tracked"), Some(&json!(false)));
    assert_eq!(
        verdict.get("filled"),
        Some(&json!(false)),
        "根外 fill 不越权"
    );
    assert_eq!(state.index.snapshot().queued, 0, "零侧效");

    let verdict2 = gaps(
        &mut state,
        json!({"uri": "not a uri at all", "fill": true}),
        2,
    );
    assert_eq!(verdict2.get("gap"), Some(&json!("unindexed")));
    assert_eq!(verdict2.get("filled"), Some(&json!(false)));
}

/// fill 只对 unindexed 生效:partial/stale 各有既有处置链(负缓存重解析 /
/// 刷新在途),fill 不越权重放。
#[test]
fn fill_does_not_override_partial_or_stale() {
    let dir = unique_dir("nofill");
    let notes_uri = uri_for(&dir, "Notes.txt");
    let pending_uri = uri_for(&dir, "Pending.def");
    let mut state = init_state(&dir);
    did_open(&mut state, &notes_uri, "随手记");
    did_open(&mut state, &pending_uri, DEF_TEXT);
    pump(&mut state);

    let partial = gaps(&mut state, json!({"uri": notes_uri, "fill": true}), 1);
    assert_eq!(partial.get("gap"), Some(&json!("partial")));
    assert_eq!(
        partial.get("filled"),
        Some(&json!(false)),
        "partial 的处置链是改文件重解析,fill 不重放"
    );

    // stale 形态:入库后再改(风暴缓冲在途)。
    let out = handle_message(
        &mut state,
        IncomingMessage::Notification(kode_protocol::Notification {
            jsonrpc: "2.0".into(),
            method: "textDocument/didChange".into(),
            params: Some(json!({
                "textDocument": {"uri": pending_uri, "version": 2},
                "contentChanges": [{"text": DEF_TEXT}]
            })),
        }),
    );
    assert!(out.is_empty(), "didChange 无回执");
    let stale = gaps(&mut state, json!({"uri": pending_uri, "fill": true}), 2);
    assert_eq!(stale.get("gap"), Some(&json!("stale")));
    assert_eq!(
        stale.get("filled"),
        Some(&json!(false)),
        "stale 已有在途刷新,fill 不叠加"
    );
}

/// health indexGaps 顶层键与聚合同源(同一 state 同一报告面)。
#[test]
fn health_carries_index_gaps_key() {
    let dir = unique_dir("health");
    let mut state = init_state(&dir);
    let out = handle_message(&mut state, request(1, "$/kode/health", json!({})));
    assert_eq!(out.len(), 1);
    let result = match out.into_iter().next().unwrap() {
        Outgoing::Response(response) => response.result.expect("health 必有结果"),
        other => panic!("health 回执形状异常: {other:?}"),
    };
    let gaps_value = result.get("indexGaps").expect("health 带 indexGaps 键");
    assert!(gaps_value.get("unindexed").is_some());
    assert!(gaps_value.get("partial").is_some());
    assert!(gaps_value.get("stale").is_some());
    // 与无 uri 聚合请求同源(同一函数产出,形状一致)。
    let aggregate = gaps(&mut state, json!({}), 2);
    assert_eq!(
        gaps_value.get("partial").and_then(|p| p.get("count")),
        aggregate.get("partial").and_then(|p| p.get("count"))
    );
    let _ = CanonicalUri::parse("file:///x").expect("uri api smoke");
}

/// fill 的消费者面:已打开 Probe.def 的 <Parent> 引用做定义探针,目标
/// Late.def 全程未打开——fill 前定义 miss(语料无该 def),fill 后请求入口
/// pump 执行入库任务,定义命中(todo 行口径:避免误报无法找到定义)。
#[test]
fn fill_enables_definition_hit_on_unopened_corpus_file() {
    let dir = unique_dir("defhit");
    let late_path = dir.join("Late.def");
    std::fs::write(&late_path, DEF_TEXT).expect("write late def");
    let probe_uri = uri_for(&dir, "Probe.def");
    let probe_text = "<root>\n\t<Parent> Late </Parent>\n</root>\n";
    // defs_root 探测锚=entities.xml 所在目录(父落点链的前置)。
    let entities_text = "<root>\n\t<Late> Late.def </Late>\n</root>\n";
    let entities_uri = uri_for(&dir, "entities.xml");
    std::fs::write(dir.join("entities.xml"), entities_text).expect("write entities");
    let mut state = init_state(&dir);
    did_open(&mut state, &entities_uri, entities_text);
    did_open(&mut state, &probe_uri, probe_text);
    pump(&mut state);

    let late_uri = uri_for(&dir, "Late.def");
    fn definition(state: &mut ServerState, uri: &str, id: i64) -> Option<Value> {
        let out = handle_message(
            state,
            request(
                id,
                "textDocument/definition",
                json!({
                    "textDocument": {"uri": uri},
                    "position": {"line": 1, "character": 10}
                }),
            ),
        );
        assert_eq!(out.len(), 1);
        match out.into_iter().next().unwrap() {
            Outgoing::Response(response) => response.result,
            other => panic!("definition 回执形状异常: {other:?}"),
        }
    }

    // fill 前:语料无 Late.def,定义 miss(诚实 null)。
    let pre = definition(&mut state, &probe_uri, 1);
    assert_eq!(pre, Some(Value::Null), "fill 前定义缺口");

    // 纯观测 + fill。
    let observed = gaps(&mut state, json!({"uri": late_uri}), 2);
    assert_eq!(observed.get("gap"), Some(&json!("unindexed")));
    let filled = gaps(&mut state, json!({"uri": late_uri, "fill": true}), 3);
    assert_eq!(filled.get("filled"), Some(&json!(true)));

    // 请求入口 pump 顺带执行 fill 任务,定义命中。
    pump(&mut state);
    let hit = definition(&mut state, &probe_uri, 4);
    assert_ne!(hit, Some(Value::Null), "fill 后定义命中,得 {hit:?}");
    // 落点=语料 def 文件首行;语料面 uri 形态=纯路径(definition 既有
    // 约定,非 file:// scheme)。
    assert_eq!(
        hit.unwrap().get("uri"),
        Some(&json!(late_path.display().to_string())),
        "落点=语料 def 文件首行"
    );
}
