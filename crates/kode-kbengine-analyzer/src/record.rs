//! Input records (the PA-004 records JSON shape; extra fields are ignored by serde).

use serde::{Deserialize, Serialize};

/// Flow direction (when absent it is derived from the message name's owner: `Client::` =
/// s2c, anything else = c2s; PA-001 §6: uplink messages are named after the receiving
/// component).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    #[serde(rename = "c2s")]
    ClientToServer,
    #[serde(rename = "s2c")]
    ServerToClient,
}

/// The anomaly field recorded by the PA-004 decode face (kind/offset/message passed
/// through as-is).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordAnomaly {
    pub kind: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub flow: String,
    #[serde(default)]
    pub direction: Option<Direction>,
    pub id: u16,
    pub name: Option<String>,
    #[serde(default)]
    pub payload_len: usize,
    #[serde(default)]
    pub stream_offset: usize,
    pub timestamp: Option<f64>,
    #[serde(default)]
    pub entity_id: Option<i32>,
    #[serde(default)]
    pub method_id: Option<u16>,
    #[serde(default)]
    pub anomaly: Option<RecordAnomaly>,
}

impl Record {
    /// Direction: the explicit field takes priority; otherwise derive it from the message
    /// name's owner (no name -> None).
    pub fn direction_or_derived(&self) -> Option<Direction> {
        if let Some(d) = self.direction {
            return Some(d);
        }
        self.name.as_deref().map(|n| {
            if n.starts_with("Client::") {
                Direction::ServerToClient
            } else {
                Direction::ClientToServer
            }
        })
    }
}
