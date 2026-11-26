//! CORE-001 message-shape unit tests: the two arms of the untagged `IncomingMessage`
//! request/notification dispatch.
//! The kode-server main.rs protocol loop dispatches on this (requests go to handle_request,
//! notifications to the fileChanged bypass); dispatching to the wrong arm means the whole
//! notification stream is silently lost.

use kode_protocol::IncomingMessage;
use serde_json::json;

#[test]
fn untagged_incoming_message_routes_request_and_notification_arms() {
    // Untagged tries Request first: an id present means the Request arm
    let request: IncomingMessage =
        serde_json::from_value(json!({"jsonrpc":"2.0","id":7,"method":"$/kode/ping"})).unwrap();
    let IncomingMessage::Request(request) = request else {
        panic!("有 id 的消息必须走 Request 臂");
    };
    assert_eq!(request.method, "$/kode/ping");
    assert!(matches!(request.id, kode_protocol::RequestId::Number(7)));
    assert!(request.params.is_none());

    // No id: Request deserialization fails (the id field is required) -> falls to the Notification arm
    let notification: IncomingMessage =
        serde_json::from_value(json!({"jsonrpc":"2.0","method":"$/kode/fileChanged"})).unwrap();
    let IncomingMessage::Notification(notification) = notification else {
        panic!("无 id 的消息必须走 Notification 臂");
    };
    assert_eq!(notification.method, "$/kode/fileChanged");
    assert!(notification.params.is_none());
}
