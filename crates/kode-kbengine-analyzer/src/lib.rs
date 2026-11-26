//! kode2 KBEngine analysis engine (todo PA-005 Phase 3).
//!
//! Acceptance wording: "independently analyze a set of decoded messages and produce a JSON
//! report". Input = a set of decoded records (the PA-004 `capture analyze --records` JSON
//! shape; a field subset, and serde tolerates extra fields); output = [`report::Report`]
//! JSON. Capability faces:
//!
//! - `stats`: message/traffic statistics (by name/by direction, unknown message counts are
//!   never dropped);
//! - `correlate`: request/response correlation — **protocol-confirmed identifiers only**:
//!   only the request->response pairs confirmed by the forensic document
//!   (docs/kbengine-wire-protocol.md §6), FIFO pairing of the same type within one Flow;
//!   neighbouring messages are never guess-matched;
//! - `latency`: P50/P95/P99 (nearest-rank) when both sides of a pair have timestamps;
//! - `anomalies`: unknown messages / illegal length (the forensic minimum length table) /
//!   decode-time anomalies passed through (Schema mismatch);
//! - `timeline`: Entity events and the RPC timeline (keyed by entity);
//! - `connections`: login / Baseapp switch / reconnection event face.
//!
//! Zero third-party dependencies (serde/serde_json only for report serialization, per the
//! PA-002 precedent).

pub mod connections;
pub mod correlate;
pub mod latency;
pub mod record;
pub mod report;
pub mod stats;

pub use record::{Direction, Record, RecordAnomaly};
pub use report::{AnalysisOptions, Report};
pub use stats::{analyze, PairSpec};

/// Protocol-confirmed request -> response pairs (docs/kbengine-wire-protocol.md §6; only
/// this forensic table is trusted, so a downlink whose response name is not in the table is
/// never paired).
pub const CONFIRMED_PAIRS: &[PairSpec] = &[
    PairSpec {
        request: "Loginapp::hello",
        responses: &["Client::onHelloCB"],
    },
    PairSpec {
        request: "Baseapp::hello",
        responses: &["Client::onHelloCB"],
    },
    PairSpec {
        request: "Loginapp::login",
        responses: &["Client::onLoginSuccessfully", "Client::onLoginFailed"],
    },
    PairSpec {
        request: "Baseapp::loginBaseapp",
        responses: &["Client::onCreatedProxies", "Client::onLoginBaseappFailed"],
    },
    PairSpec {
        request: "Baseapp::reloginBaseapp",
        responses: &[
            "Client::onReloginBaseappSuccessfully",
            "Client::onReloginBaseappFailed",
        ],
    },
];
