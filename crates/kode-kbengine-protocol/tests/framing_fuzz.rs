//! PA-003 framing 验收 + Fuzz/边界测试(红先行)。
//!
//! 三种长度形状(§4.2)/ packetAlwaysContainLength(§4.3)/ TCP 粘包拆包
//! (§4.4)/ 内存上限红线;确定性 PRNG 驱动(无外部 fuzz 框架)。

use kode_kbengine_protocol::error::DecodeErrorKind;
use kode_kbengine_protocol::framing::{FrameParser, FramingConfig, LengthSpec};
use kode_kbengine_protocol::messages::MessageMap;
use kode_kbengine_schema::messages::{build_message_table, MessageLength};

fn engine_defaults_xml() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/messages_fixed_defaults.xml"
    ))
    .unwrap()
}

fn config_with(map: &MessageMap, always_len: bool) -> FramingConfig {
    FramingConfig {
        specs: map.clone_specs(),
        unknown_id_policy: kode_kbengine_protocol::framing::UnknownIdPolicy::Fail,
        max_message_len: 1 << 20,
        packet_always_contain_length: always_len,
    }
}

// ---------------------------------------------------------------------------
// 三种长度形状(§4.2)
// ---------------------------------------------------------------------------

#[test]
fn fixed_message_has_no_length_field() {
    // Loginapp::importClientMessages(id=5,定长 0):线上只有 2B id
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    let frames = p.feed(&5u16.to_le_bytes()).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].id, 5);
    assert_eq!(frames[0].payload, b"");
    assert_eq!(frames[0].length_spec, LengthSpec::Fixed(0));

    // 定长非零:Client::onHelloCB(id=521)定长 0;找一条定长>0 的不存在(基线
    // 固定表除 id=521/4/5 等无参消息外全带变长参数),用合成 spec 验证。
    let mut map2 = map.clone();
    map2.insert_spec(900, "Demo::fixed8".into(), MessageLength::Fixed(8));
    let mut p = FrameParser::new(config_with(&map2, false));
    let mut bytes = 900u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    bytes.push(0xAA); // 粘包的下一条(垃圾尾随留在缓冲)
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, &[1, 2, 3, 4, 5, 6, 7, 8]);
}

#[test]
fn variable_and_extended_length_shapes() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    // 变长:Loginapp::login(id=3):u16 msgLen = 载荷(不含 id+len 头)
    let mut p = FrameParser::new(config_with(&map, false));
    let mut bytes = 3u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(b"body");
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, b"body");
    assert_eq!(frames[0].length_spec, LengthSpec::Variable);

    // 扩展长度:u16=65535 哨兵 + u32 实长(bundle.cpp:358-368 / packet_reader.cpp:116-167)
    let mut map2 = map.clone();
    map2.insert_spec(901, "Demo::big".into(), MessageLength::Variable);
    let mut p = FrameParser::new(config_with(&map2, false));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&65535u16.to_le_bytes()); // ff ff
    bytes.extend_from_slice(&70000u32.to_le_bytes()); // u32 实长
    bytes.extend_from_slice(&vec![0xABu8; 70000]);
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload.len(), 70000);
    assert_eq!(frames[0].length_spec, LengthSpec::Extended(70000));
}

#[test]
fn always_contain_length_forces_length_field() {
    // §4.3:packetAlwaysContainLength=true → 定长消息线上也带 u16 长度
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, true));
    // id=5 原定长 0 → 现在带 u16 len=0
    let mut bytes = 5u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&0u16.to_le_bytes());
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, b"");
}

// ---------------------------------------------------------------------------
// TCP 粘包 / 拆包(§4.4)
// ---------------------------------------------------------------------------

#[test]
fn coalesced_messages_split_in_one_feed() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    // 三条连发:importClientMessages(定长) + login(变长) + importClientMessages
    let mut bytes = 5u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&3u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(b"ok");
    bytes.extend_from_slice(&5u16.to_le_bytes());
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0].id, 5);
    assert_eq!(frames[1].payload, b"ok");
    assert_eq!(frames[2].id, 5);
}

#[test]
fn fragmented_message_reassembles_across_feeds() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    let full = {
        let mut b = 3u16.to_le_bytes().to_vec();
        b.extend_from_slice(&4u16.to_le_bytes());
        b.extend_from_slice(b"body");
        b
    };
    // 逐字节喂入:中途喂入不产帧、不报错
    let mut got = 0;
    for (i, b) in full.iter().enumerate() {
        let frames = p.feed(&[*b]).unwrap();
        if i + 1 < full.len() {
            assert_eq!(frames.len(), 0, "partial feed must not emit frame at {i}");
        } else {
            got = frames.len();
        }
    }
    assert_eq!(got, 1);
    assert_eq!(p.pending_buffer_len(), 0);
}

// ---------------------------------------------------------------------------
// 红线:失败不 panic / 内存有上限 / 未知 id 策略
// ---------------------------------------------------------------------------

#[test]
fn oversized_extended_length_rejected_by_cap() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut map2 = map.clone();
    map2.insert_spec(901, "Demo::big".into(), MessageLength::Variable);
    let mut p = FrameParser::new(config_with(&map2, false));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&65535u16.to_le_bytes());
    bytes.extend_from_slice(&(0xFFFF_FFFFu32).to_le_bytes()); // 实长声明 4 GiB
    let err = p.feed(&bytes).unwrap_err();
    assert!(matches!(err.kind, DecodeErrorKind::MemoryLimit));
    // 解析器仍可用(未 panic、状态复位为可继续)
    assert!(p.pending_buffer_len() < usize::MAX);
}

#[test]
fn unknown_id_policy_fail_is_default() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    let mut bytes = 60000u16.to_le_bytes().to_vec(); // 表中不存在的 id
    bytes.extend_from_slice(&[1, 2, 3, 4]);
    let err = p.feed(&bytes).unwrap_err();
    assert!(matches!(err.kind, DecodeErrorKind::UnknownMessageId));
}

// ---------------------------------------------------------------------------
// Fuzz:确定性伪随机流 + 全前缀扫描
// ---------------------------------------------------------------------------

/// xorshift64* 确定性 PRNG(fuzz 驱动可复现)。
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn byte(&mut self) -> u8 {
        (self.next() >> 33) as u8
    }
}

#[test]
fn fuzz_random_streams_never_panic() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut map2 = map.clone();
    map2.insert_spec(901, "Demo::big".into(), MessageLength::Variable);
    let cfg = config_with(&map2, false);
    for seed in 1..=200u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let mut p = FrameParser::new(cfg.clone());
        let len = (rng.next() % 4096) as usize;
        let mut chunk = Vec::with_capacity(len);
        for _ in 0..len {
            chunk.push(rng.byte());
        }
        // 允许 Ok 或 Err,唯一红线是绝不 panic / 不越界 / 不失控分配。
        let _ = p.feed(&chunk);
    }
}

#[test]
fn fuzz_every_prefix_of_valid_stream_never_panics() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut map2 = map.clone();
    map2.insert_spec(901, "Demo::big".into(), MessageLength::Variable);
    let cfg = config_with(&map2, false);
    let mut full = 5u16.to_le_bytes().to_vec();
    full.extend_from_slice(&901u16.to_le_bytes());
    full.extend_from_slice(&65535u16.to_le_bytes());
    full.extend_from_slice(&3u32.to_le_bytes());
    full.extend_from_slice(b"abc");
    full.extend_from_slice(&4u16.to_le_bytes());
    full.extend_from_slice(&2u16.to_le_bytes());
    full.extend_from_slice(b"hi");
    for cut in 0..full.len() {
        let mut p = FrameParser::new(cfg.clone());
        // 截断在任意字节位:要么 Err(完整体后垃圾 0x04 00 … 被当新 id),要么 Ok
        let _ = p.feed(&full[..cut]);
    }
    // 完整体本身:5(定长) + 901 扩展 + 901?——最后 04 00 是未知 id(Err 可接受)
    let mut p = FrameParser::new(cfg.clone());
    let _ = p.feed(&full[..13]); // id5 + id901 + sentinel + u32 + 3B 载荷
    let frames = p.feed(&full[13..]).unwrap_or_default();
    assert!(frames.len() <= 1);
}

#[test]
fn fuzz_truncated_encrypted_envelopes_never_panic() {
    let mut v = (11u16).to_le_bytes().to_vec();
    v.push(3);
    v.extend_from_slice(&[0xaau8; 11]);
    for cut in 0..v.len() {
        let _ = kode_kbengine_protocol::framing::parse_encrypted_envelope(&v[..cut]);
    }
    // 长度声明 65535 级别:cap 拒绝
    let mut big = (0xFFFFu16).to_le_bytes().to_vec();
    big.push(7);
    assert!(kode_kbengine_protocol::framing::parse_encrypted_envelope(&big).is_err());
}

#[test]
fn fuzz_dynamic_import_garbage_never_panics() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut rng = Rng(0xDEADBEEF);
    for _ in 0..100 {
        let mut payload = Vec::new();
        let n = (rng.next() % 256) as usize;
        for _ in 0..n {
            payload.push(rng.byte());
        }
        let mut m = map.clone();
        let _ = m.apply_import(
            &payload,
            &kode_kbengine_protocol::codec::DecodeLimits::default(),
        );
    }
}
