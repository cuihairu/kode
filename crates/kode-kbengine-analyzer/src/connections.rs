//! 连接分析(PA-005「登录/切 Baseapp/重连」)。
//!
//! 事件口径(docs/kbengine-wire-protocol.md §6):
//! - login_attempt  = 上行 `Loginapp::login`
//! - login_ok       = 下行 `Client::onLoginSuccessfully`
//! - login_failed   = 下行 `Client::onLoginFailed`
//! - baseapp_switch = login_ok 后见到的 `Baseapp::hello`(§6 步骤 8:切网关
//!   必重走 hello;未登录成功的 baseapp hello 不计切换)
//! - relogin        = 上行 `Baseapp::reloginBaseapp`(§6 步骤 11)

use serde::Serialize;

use crate::record::Record;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConnectionEvent {
    pub kind: &'static str,
    pub flow: String,
    pub timestamp: Option<f64>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ConnectionReport {
    pub events: Vec<ConnectionEvent>,
    pub login_attempts: usize,
    pub logins_ok: usize,
    pub logins_failed: usize,
    pub baseapp_switches: usize,
    pub relogin_attempts: usize,
}

pub fn analyze(records: &[Record]) -> ConnectionReport {
    let mut out = ConnectionReport::default();
    let mut logged_in = false;
    for r in records {
        let Some(name) = &r.name else { continue };
        let kind = match name.as_str() {
            "Loginapp::login" => {
                out.login_attempts += 1;
                Some("login_attempt")
            }
            "Client::onLoginSuccessfully" => {
                out.logins_ok += 1;
                logged_in = true;
                Some("login_ok")
            }
            "Client::onLoginFailed" => {
                out.logins_failed += 1;
                Some("login_failed")
            }
            "Baseapp::hello" => {
                if logged_in {
                    out.baseapp_switches += 1;
                    Some("baseapp_switch")
                } else {
                    None // 未登录成功的 baseapp hello(直连/重连前的握手)不算切换
                }
            }
            "Baseapp::reloginBaseapp" => {
                out.relogin_attempts += 1;
                Some("relogin")
            }
            _ => None,
        };
        if let Some(kind) = kind {
            out.events.push(ConnectionEvent {
                kind,
                flow: r.flow.clone(),
                timestamp: r.timestamp,
                message: name.clone(),
            });
        }
    }
    out
}
