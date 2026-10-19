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

/// Where a transport sends what it receives. In the app these forward to
/// Tauri IPC channels; in tests they can collect into a buffer.
#[derive(Clone)]
pub struct Output {
    data: Arc<DataFn>,
    status: Arc<StatusFn>,
    pub logger: Arc<Mutex<Option<Logger>>>,
}

impl Output {
    pub fn new(
        data: impl Fn(&[u8]) + Send + Sync + 'static,
        status: impl Fn(StatusEvent) + Send + Sync + 'static,
    ) -> Self {
        Self { data: Arc::new(data), status: Arc::new(status), logger: Arc::new(Mutex::new(None)) }
    }

    pub fn data(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if let Some(l) = self.logger.lock().as_mut() {
            l.write(bytes);
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
