//! Connection analysis (PA-005 "login / Baseapp switch / reconnection").
//!
//! Event contract (docs/kbengine-wire-protocol.md §6):
//! - login_attempt  = the uplink `Loginapp::login`
//! - login_ok       = the downlink `Client::onLoginSuccessfully`
//! - login_failed   = the downlink `Client::onLoginFailed`
//! - baseapp_switch = a `Baseapp::hello` seen after login_ok (§6 step 8: switching
//!   gateway must repeat hello; a baseapp hello without a successful login is not a switch)
//! - relogin        = the uplink `Baseapp::reloginBaseapp` (§6 step 11)

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
                    None // A baseapp hello without a successful login (the handshake before direct connect/reconnect) is not a switch
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
