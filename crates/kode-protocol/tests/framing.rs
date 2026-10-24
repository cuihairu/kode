//! CORE-001 帧解码单测:短读、分包、单 chunk 多帧、非法帧重同步。

use kode_protocol::{
    encode_frame, FrameDecoder, FrameOutcome, Request, RequestId, HEADER_DELIMITER,
};
use serde_json::json;

fn frame_raw(body: &[u8]) -> Vec<u8> {
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(body);
    frame
}

fn msg_body(id: i64) -> Vec<u8> {
    serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":"$/kode/ping"})).unwrap()
}

/// 帧头结束位置(测试切字节流用)。
fn header_end(frame: &[u8]) -> usize {
    frame
        .windows(HEADER_DELIMITER.len())
        .position(|w| w == HEADER_DELIMITER)
        .unwrap()
        + HEADER_DELIMITER.len()
}

#[test]
fn encodes_lsp_framed_message() {
    let value = json!({"jsonrpc":"2.0","id":1,"method":"initialize"});
    let frame = encode_frame(&value).unwrap();
    let header_end = header_end(&frame);
    let body_len = frame.len() - header_end;
    let header = std::str::from_utf8(&frame[..header_end]).unwrap();
    assert_eq!(header, format!("Content-Length: {body_len}\r\n\r\n"));
}

#[test]
fn decodes_single_frame() {
    let mut decoder = FrameDecoder::new();
    let out = decoder.push(&frame_raw(&msg_body(1)));
    assert_eq!(out.len(), 1);
    assert!(matches!(&out[0], FrameOutcome::Message(v) if v["id"] == 1));
    assert_eq!(decoder.buffered_len(), 0);
}

#[test]
fn handles_short_read_header_split_across_chunks() {
    let frame = frame_raw(&msg_body(2));
    let (a, b) = frame.split_at(7); // "Content" 切断
    let mut decoder = FrameDecoder::new();
    assert!(decoder.push(a).is_empty());
    assert!(decoder.push(&b[..3]).is_empty());
    let out = decoder.push(&b[3..]);
    assert_eq!(out.len(), 1);
    assert!(matches!(&out[0], FrameOutcome::Message(v) if v["id"] == 2));
}

#[test]
fn handles_short_read_body_split_across_chunks() {
    let frame = frame_raw(&msg_body(3));
    let split_at = header_end(&frame);
    let mut decoder = FrameDecoder::new();
    assert!(decoder.push(&frame[..split_at]).is_empty());
    assert!(decoder.push(&frame[split_at..split_at + 1]).is_empty());
    let out = decoder.push(&frame[split_at + 1..]);
    assert_eq!(out.len(), 1);
    assert!(matches!(&out[0], FrameOutcome::Message(v) if v["id"] == 3));
}

#[test]
fn decodes_multiple_frames_in_single_chunk() {
    let mut chunk = frame_raw(&msg_body(4));
    chunk.extend_from_slice(&frame_raw(&msg_body(5)));
    let mut decoder = FrameDecoder::new();
    let out = decoder.push(&chunk);
    assert_eq!(out.len(), 2);
    assert!(matches!(&out[0], FrameOutcome::Message(v) if v["id"] == 4));
    assert!(matches!(&out[1], FrameOutcome::Message(v) if v["id"] == 5));
}

#[test]
fn frame_spanning_multiple_chunks_never_yields_partial_message() {
    let frame = frame_raw(&msg_body(6));
    let mut decoder = FrameDecoder::new();
    let mut messages = 0;
    for byte in &frame {
        messages += decoder.push(std::slice::from_ref(byte)).len();
    }
    assert_eq!(messages, 1);
}

#[test]
fn illegal_frame_reports_error_and_resyncs_to_next_valid_frame() {
    let mut chunk = b"GARBAGE without any header\r\n\r\n".to_vec();
    chunk.extend_from_slice(&frame_raw(&msg_body(7)));
    let mut decoder = FrameDecoder::new();
    let out = decoder.push(&chunk);
    assert_eq!(out.len(), 2);
    assert!(matches!(&out[0], FrameOutcome::InvalidHeader(_)));
    assert!(matches!(&out[1], FrameOutcome::Message(v) if v["id"] == 7));
}

#[test]
fn missing_content_length_reports_invalid_header() {
    let mut chunk = b"Content-Type: application/vscode-jsonrpc\r\n\r\n{}".to_vec();
    chunk.extend_from_slice(&frame_raw(&msg_body(8)));
    let mut decoder = FrameDecoder::new();
    let out = decoder.push(&chunk);
    assert_eq!(out.len(), 2);
    assert!(matches!(&out[0], FrameOutcome::InvalidHeader(err) if err.contains("Content-Length")));
    assert!(matches!(&out[1], FrameOutcome::Message(v) if v["id"] == 8));
}

#[test]
fn non_numeric_content_length_reports_invalid_header() {
    let chunk = b"Content-Length: abc\r\n\r\n{}".to_vec();
    let mut decoder = FrameDecoder::new();
    let out = decoder.push(&chunk);
    assert_eq!(out.len(), 1);
    assert!(matches!(&out[0], FrameOutcome::InvalidHeader(err) if err.contains("abc")));
}

#[test]
fn invalid_json_body_surfaces_as_invalid_body() {
    let mut chunk = frame_raw(b"{not json");
    chunk.extend_from_slice(&frame_raw(&msg_body(9)));
    let mut decoder = FrameDecoder::new();
    let out = decoder.push(&chunk);
    assert_eq!(out.len(), 2);
    assert!(matches!(&out[0], FrameOutcome::InvalidBody));
    assert!(matches!(&out[1], FrameOutcome::Message(v) if v["id"] == 9));
}

#[test]
fn request_id_round_trips_number_and_string_forms() {
    let number: Request =
        serde_json::from_value(json!({"jsonrpc":"2.0","id":42,"method":"m"})).unwrap();
    assert_eq!(number.id, RequestId::Number(42));
    let string: Request =
        serde_json::from_value(json!({"jsonrpc":"2.0","id":"abc-1","method":"m"})).unwrap();
    assert_eq!(string.id, RequestId::String("abc-1".into()));
    // 响应保真回显,禁止归一化
    let echoed = serde_json::to_value(&string.id).unwrap();
    assert_eq!(echoed, json!("abc-1"));
}
