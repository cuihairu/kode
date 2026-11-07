//! 输入记录(PA-004 records JSON 形状;多余字段 serde 忽略)。

use serde::{Deserialize, Serialize};

/// 流方向(缺省时由消息名 owner 推导:`Client::` = s2c,其余 = c2s;
/// PA-001 §6:上行消息以接收组件命名)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    #[serde(rename = "c2s")]
    ClientToServer,
    #[serde(rename = "s2c")]
    ServerToClient,
}

/// PA-004 解码面记录的异常字段(kind/offset/message 原样透传)。
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
    /// 方向:显式字段优先;否则按消息名 owner 推导(无名 → None)。
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
