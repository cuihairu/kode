//! CORE-001 消息形单测:untagged `IncomingMessage` 请求/通知分派两臂。
//! kode-server main.rs 协议环按此分派(请求走 handle_request,通知走
//! fileChanged bypass),分派错臂=整条通知流静默丢失。

use kode_protocol::IncomingMessage;
use serde_json::json;

#[test]
fn untagged_incoming_message_routes_request_and_notification_arms() {
    // untagged 先试 Request:有 id → Request 臂
    let request: IncomingMessage =
        serde_json::from_value(json!({"jsonrpc":"2.0","id":7,"method":"$/kode/ping"})).unwrap();
    let IncomingMessage::Request(request) = request else {
        panic!("有 id 的消息必须走 Request 臂");
    };
    assert_eq!(request.method, "$/kode/ping");
    assert!(matches!(request.id, kode_protocol::RequestId::Number(7)));
    assert!(request.params.is_none());

    // 无 id:Request 反序列化失败(id 字段必填)→ 落到 Notification 臂
    let notification: IncomingMessage =
        serde_json::from_value(json!({"jsonrpc":"2.0","method":"$/kode/fileChanged"})).unwrap();
    let IncomingMessage::Notification(notification) = notification else {
        panic!("无 id 的消息必须走 Notification 臂");
    };
    assert_eq!(notification.method, "$/kode/fileChanged");
    assert!(notification.params.is_none());
}
