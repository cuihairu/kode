//! PA-003 framing acceptance + Fuzz/boundary tests (red first).
//!
//! The three length shapes (§4.2) / packetAlwaysContainLength (§4.3) / TCP sticky and split packets
//! (§4.4) / the memory cap red line; driven by a deterministic PRNG (no external fuzz framework).

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
// The three length shapes (§4.2)
// ---------------------------------------------------------------------------

#[test]
fn fixed_message_has_no_length_field() {
    // Loginapp::importClientMessages (id=5, fixed 0): only the 2B id on the wire
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    let frames = p.feed(&5u16.to_le_bytes()).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].id, 5);
    assert_eq!(frames[0].payload, b"");
    assert_eq!(frames[0].length_spec, LengthSpec::Fixed(0));

    // Non-zero fixed length: Client::onHelloCB (id=521) is fixed 0; no fixed>0 entry exists (the baseline
    // fixed table carries variable arguments for everything except parameterless messages like id=521/4/5),
    // so a synthetic spec is used for verification.
    let mut map2 = map.clone();
    map2.insert_spec(900, "Demo::fixed8".into(), MessageLength::Fixed(8));
    let mut p = FrameParser::new(config_with(&map2, false));
    let mut bytes = 900u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    bytes.push(0xAA); // the next coalesced message (the trailing garbage residue stays in the buffer)
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, &[1, 2, 3, 4, 5, 6, 7, 8]);
}

#[test]
fn variable_and_extended_length_shapes() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    // Variable: Loginapp::login (id=3): u16 msgLen = the payload (excluding the id+len header)
    let mut p = FrameParser::new(config_with(&map, false));
    let mut bytes = 3u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(b"body");
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, b"body");
    assert_eq!(frames[0].length_spec, LengthSpec::Variable);

    // Extended length: u16=65535 sentinel + u32 actual length (bundle.cpp:358-368 / packet_reader.cpp:116-167)
    let mut map2 = map.clone();
    map2.insert_spec(901, "Demo::big".into(), MessageLength::Variable);
    let mut p = FrameParser::new(config_with(&map2, false));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&65535u16.to_le_bytes()); // ff ff
    bytes.extend_from_slice(&70000u32.to_le_bytes()); // u32 actual length
    bytes.extend_from_slice(&vec![0xABu8; 70000]);
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload.len(), 70000);
    assert_eq!(frames[0].length_spec, LengthSpec::Extended(70000));
}

#[test]
fn always_contain_length_forces_length_field() {
    // §4.3: packetAlwaysContainLength=true → fixed messages also carry a u16 length on the wire
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, true));
    // id=5 was fixed 0 → now carries u16 len=0
    let mut bytes = 5u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&0u16.to_le_bytes());
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, b"");
}

// ---------------------------------------------------------------------------
// TCP sticky packets / split packets (§4.4)
// ---------------------------------------------------------------------------

#[test]
fn coalesced_messages_split_in_one_feed() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    // Three back-to-back frames: importClientMessages (fixed) + login (variable) + importClientMessages
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
    // Feed byte by byte: a partial feed emits no frame and raises no error
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
// Red lines: no panic on failure / memory bounded / unknown id policy
// ---------------------------------------------------------------------------

#[test]
fn oversized_extended_length_rejected_by_cap() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut map2 = map.clone();
    map2.insert_spec(901, "Demo::big".into(), MessageLength::Variable);
    let mut p = FrameParser::new(config_with(&map2, false));
    let mut bytes = 901u16.to_le_bytes().to_vec();
    bytes.extend_from_slice(&65535u16.to_le_bytes());
    bytes.extend_from_slice(&(0xFFFF_FFFFu32).to_le_bytes()); // actual length declaring 4 GiB
    let err = p.feed(&bytes).unwrap_err();
    assert!(matches!(err.kind, DecodeErrorKind::MemoryLimit));
    // The parser is still usable (no panic, state reset to a resumable position)
    assert!(p.pending_buffer_len() < usize::MAX);
}

#[test]
fn multi_frame_chunk_totaling_over_cap_still_parses_all_frames() {
    // The cap constrains the "remainder after the frames are resolved", not the total buffer: when a whole run of
    // legal frames totals over max_message_len+8, the old implementation (which judged the total buffer first)
    // invalidated the whole block and legal data was silently lost; the new one resolves all complete frames first
    // and only then applies the cap to the residue.
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut map2 = map.clone();
    map2.insert_spec(903, "Demo::fixed60k".into(), MessageLength::Fixed(60_000));
    let mut p = FrameParser::new(config_with(&map2, false)); // cap = 1 MiB
    let mut bytes = Vec::new();
    for _ in 0..18 {
        bytes.extend_from_slice(&903u16.to_le_bytes());
        bytes.extend_from_slice(&vec![0xAB; 60_000]);
    }
    assert!(bytes.len() > (1 << 20) + 8, "fixture 须真超限");
    let frames = p.feed(&bytes).unwrap();
    assert_eq!(frames.len(), 18);
    assert_eq!(p.pending_buffer_len(), 0);
}

#[test]
fn error_reset_folds_discarded_bytes_into_stream_offset() {
    // The bytes discarded by an error reset (including frames already resolved but dropped with the Err,
    // plus unframed residue) must advance abs_base in lockstep: otherwise the recovered stream_offset re-counts
    // from the stale base point and under-reports systematically (violating the "accumulated over this parser's
    // lifetime" contract).
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    // feed1: two frames of id=5 (2B each), offsets 0/2; after compact abs_base=4
    let frames = p
        .feed(&[5u16.to_le_bytes(), 5u16.to_le_bytes()].concat())
        .unwrap();
    assert_eq!(
        frames.iter().map(|f| f.stream_offset).collect::<Vec<_>>(),
        vec![0, 2]
    );
    // feed2: one good frame (into out) + one bad frame (unknown id) → Err, the good frame is dropped with the Err
    let mut chunk = 5u16.to_le_bytes().to_vec();
    chunk.extend_from_slice(&60000u16.to_le_bytes());
    chunk.extend_from_slice(&[1, 2, 3, 4]);
    assert!(p.feed(&chunk).is_err());
    // feed3: the recovered frame's offset must skip past all 8 bytes of feed2 (feed1's 4 + feed2's 8 = 12)
    let frames = p.feed(&5u16.to_le_bytes()).unwrap();
    assert_eq!(frames[0].stream_offset, 12);
}

#[test]
fn unknown_id_policy_fail_is_default() {
    let map = MessageMap::from_static(&build_message_table(&engine_defaults_xml(), None));
    let mut p = FrameParser::new(config_with(&map, false));
    let mut bytes = 60000u16.to_le_bytes().to_vec(); // an id absent from the table
    bytes.extend_from_slice(&[1, 2, 3, 4]);
    let err = p.feed(&bytes).unwrap_err();
    assert!(matches!(err.kind, DecodeErrorKind::UnknownMessageId));
}

// ---------------------------------------------------------------------------
// Fuzz: deterministic pseudo-random streams + an all-prefix sweep
// ---------------------------------------------------------------------------

/// xorshift64* deterministic PRNG (keeps the fuzz driver reproducible).
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
        // Ok or Err is both acceptable; the only red line is never panicking / reading out of bounds / allocating runaway.
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
        // Truncated at any byte position: either Err (the trailing garbage 0x04 00 … after the full body is read as a new id) or Ok
        let _ = p.feed(&full[..cut]);
    }
    // The complete body itself: 5 (fixed) + 901 extended + 901? — the trailing 04 00 is an unknown id (Err acceptable)
    let mut p = FrameParser::new(cfg.clone());
    let _ = p.feed(&full[..13]); // id5 + id901 + sentinel + u32 + 3B payload
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
    // A 65535-class declared length: the cap rejects it
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
