//! Live connections. Every open tab owns one connection, addressed by an id the
//! UI picks. Transports (SSH, Telnet/raw TCP, serial, local shell) all share the
//! same shape: bytes out through `Output`, control messages in through `Ctl`.

use crate::logger::Logger;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug)]
pub enum Ctl {
    Write(Vec<u8>),
    Resize(u16, u16),
    Break,
    Close,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub state: &'static str,
    pub message: String,
}

type DataFn = dyn Fn(&[u8]) + Send + Sync;
type StatusFn = dyn Fn(StatusEvent) + Send + Sync;

type Tap = mpsc::UnboundedSender<Vec<u8>>;

/// Where a transport sends what it receives. In the app these forward to
/// Tauri IPC channels; in tests they can collect into a buffer.
#[derive(Clone)]
pub struct Output {
    data: Arc<DataFn>,
    status: Arc<StatusFn>,
    pub logger: Arc<Mutex<Option<Logger>>>,
    /// A copy of received bytes for the login-action engine while it runs.
    tap: Arc<Mutex<Option<Tap>>>,
}

impl Output {
    pub fn new(
        data: impl Fn(&[u8]) + Send + Sync + 'static,
        status: impl Fn(StatusEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            data: Arc::new(data),
            status: Arc::new(status),
            logger: Arc::new(Mutex::new(None)),
            tap: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_tap(&self, tap: Option<Tap>) {
        *self.tap.lock() = tap;
    }

    pub fn data(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if let Some(l) = self.logger.lock().as_mut() {
            l.write(bytes);
        }
        if let Some(t) = self.tap.lock().as_ref() {
            let _ = t.send(bytes.to_vec());
        }
        (self.data)(bytes);
    }

    pub fn status(&self, state: &'static str, message: impl Into<String>) {
        (self.status)(StatusEvent { state, message: message.into() });
    }
}

pub struct ConnHandle {
    pub tx: mpsc::UnboundedSender<Ctl>,
    pub output: Output,
    pub session_name: String,
    pub host_label: String,
    /// The device's host name or address, for network sessions.
    pub host: Option<String>,
    pub terminal: crate::model::TerminalOptions,
}

#[derive(Default)]
pub struct Manager {
    conns: Mutex<HashMap<String, ConnHandle>>,
}

impl Manager {
    pub fn insert(&self, id: String, handle: ConnHandle) {
        if let Some(old) = self.conns.lock().insert(id, handle) {
            let _ = old.tx.send(Ctl::Close);
        }
    }

    pub fn send(&self, id: &str, ctl: Ctl) -> bool {
        match self.conns.lock().get(id) {
            Some(h) => h.tx.send(ctl).is_ok(),
            None => false,
        }
    }

    pub fn remove(&self, id: &str) {
        if let Some(h) = self.conns.lock().remove(id) {
            let _ = h.tx.send(Ctl::Close);
        }
    }

    /// Host names of open network connections.
    pub fn hosts(&self) -> Vec<String> {
        self.conns.lock().values().filter_map(|h| h.host.clone()).collect()
    }

    pub fn with<R>(&self, id: &str, f: impl FnOnce(&ConnHandle) -> R) -> Option<R> {
        self.conns.lock().get(id).map(f)
    }
}

/// Error type returned to the UI. `code` lets the UI react (ask for a
/// password, show the host-key dialog) instead of just printing text.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl CmdError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: None }
    }
    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<anyhow::Error> for CmdError {
    fn from(e: anyhow::Error) -> Self {
        CmdError::new("ERROR", format!("{e:#}"))
    }
}

impl From<std::io::Error> for CmdError {
    fn from(e: std::io::Error) -> Self {
        CmdError::new("IO", e.to_string())
    }
}

pub type CmdResult<T> = Result<T, CmdError>;

/// A failed TCP connect, in words a network admin can act on. The OS text
/// ("actively refused it. (os error 10061)") goes in `detail` for the record.
pub fn connect_error(host: &str, port: u16, io: Option<&std::io::Error>, raw: &dyn std::fmt::Display) -> CmdError {
    use std::io::ErrorKind::*;
    let raw = raw.to_string();
    // Name lookups fail with an uncategorized error: WSAHOST_NOT_FOUND / WSANO_DATA
    // on Windows, a getaddrinfo message elsewhere.
    let lookup = io.and_then(|e| e.raw_os_error()).is_some_and(|c| c == 11001 || c == 11004)
        || raw.contains("failed to lookup address");
    let message = match io.map(|e| e.kind()) {
        _ if lookup => format!("Couldn't find {host}. Check the name, or use its IP address."),
        Some(ConnectionRefused) => {
            format!("Nothing answered on {host} port {port}. Check the port, or that the service is running there.")
        }
        Some(HostUnreachable | NetworkUnreachable) => {
            format!("{host} can't be reached from this computer. Check the address, VPN or routing.")
        }
        Some(ConnectionReset | ConnectionAborted) => {
            format!(
                "{host} closed the connection on port {port} at once. A firewall or access list may be blocking it."
            )
        }
        Some(TimedOut) => format!("{host}:{port} did not answer within 15 seconds."),
        _ => format!("Could not connect to {host}:{port}: {raw}"),
    };
    CmdError::new("CONNECT", message).with_detail(serde_json::json!({ "os": raw }))
}

#[cfg(test)]
mod tests {
    use super::connect_error;
    use std::io::{Error, ErrorKind};

    #[test]
    fn connect_errors_are_plain() {
        let refused = Error::from(ErrorKind::ConnectionRefused);
        let e = connect_error("10.0.0.1", 2222, Some(&refused), &refused);
        assert_eq!(
            e.message,
            "Nothing answered on 10.0.0.1 port 2222. Check the port, or that the service is running there."
        );
        let dns = Error::other("failed to lookup address information: Name or service not known");
        assert!(connect_error("sw1", 22, Some(&dns), &dns).message.starts_with("Couldn't find sw1."));
        let odd = Error::other("something else");
        assert_eq!(connect_error("h", 23, Some(&odd), &odd).message, "Could not connect to h:23: something else");
    }
}
