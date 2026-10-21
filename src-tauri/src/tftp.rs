//! Built-in TFTP server (RFC 1350 with the blksize, tsize and timeout options
//! of RFCs 2347–2349) for the everyday network jobs: `copy tftp: flash:` to
//! load an image, `copy running-config tftp:` to back up a config.
//!
//! The packet codec, option negotiation, file-name checks and netascii
//! translation are pure and unit tested; `start` runs them over UDP. Every
//! transfer gets its own socket (its TID), and a stop signal reaches each one.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use std::io::{ErrorKind, Read as _, Write as _};
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::watch;

const RRQ: u16 = 1;
const WRQ: u16 = 2;
const DATA: u16 = 3;
const ACK: u16 = 4;
const ERROR: u16 = 5;
const OACK: u16 = 6;

/// RFC 1350 error codes.
pub mod code {
    pub const NOT_DEFINED: u16 = 0;
    pub const NOT_FOUND: u16 = 1;
    pub const ACCESS: u16 = 2;
    pub const DISK_FULL: u16 = 3;
    pub const ILLEGAL: u16 = 4;
    pub const UNKNOWN_TID: u16 = 5;
    pub const EXISTS: u16 = 6;
    pub const OPTIONS: u16 = 8;
}

pub const DEFAULT_BLKSIZE: usize = 512;
/// The largest block that fits a UDP datagram (RFC 2348).
pub const MAX_BLKSIZE: usize = 65464;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);
/// Retransmissions before giving up on a quiet device.
const RETRIES: u32 = 5;
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

// ---------------------------------------------------------------------------
// Packets

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Octet,
    Netascii,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    Rrq { file: String, mode: Mode, options: Vec<(String, String)> },
    Wrq { file: String, mode: Mode, options: Vec<(String, String)> },
    Data { block: u16, data: Vec<u8> },
    Ack { block: u16 },
    Error { code: u16, message: String },
    Oack { options: Vec<(String, String)> },
}

/// Why a packet couldn't be used, as the TFTP error to send back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: u16,
    pub message: String,
}

impl Refusal {
    fn new(code: u16, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn strings(mut b: &[u8]) -> Option<Vec<String>> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let end = b.iter().position(|&c| c == 0)?;
        out.push(String::from_utf8_lossy(&b[..end]).into_owned());
        b = &b[end + 1..];
    }
    Some(out)
}

pub fn parse(b: &[u8]) -> Result<Packet, Refusal> {
    let bad = || Refusal::new(code::ILLEGAL, "Malformed TFTP packet");
    if b.len() < 2 {
        return Err(bad());
    }
    let op = u16::from_be_bytes([b[0], b[1]]);
    let rest = &b[2..];
    let num = || if rest.len() >= 2 { Ok(u16::from_be_bytes([rest[0], rest[1]])) } else { Err(bad()) };
    match op {
        RRQ | WRQ => {
            let parts = strings(rest).ok_or_else(bad)?;
            if parts.len() < 2 || parts.len() % 2 != 0 {
                return Err(bad());
            }
            let mode = match parts[1].to_ascii_lowercase().as_str() {
                "octet" => Mode::Octet,
                "netascii" => Mode::Netascii,
                other => return Err(Refusal::new(code::ILLEGAL, format!("Transfer mode \"{other}\" isn't supported"))),
            };
            let options = parts[2..].chunks(2).map(|kv| (kv[0].to_ascii_lowercase(), kv[1].clone())).collect();
            let file = parts[0].clone();
            Ok(if op == RRQ { Packet::Rrq { file, mode, options } } else { Packet::Wrq { file, mode, options } })
        }
        DATA => Ok(Packet::Data { block: num()?, data: rest[2..].to_vec() }),
        ACK => Ok(Packet::Ack { block: num()? }),
        ERROR => {
            let code = num()?;
            let msg = rest[2..].split(|&c| c == 0).next().unwrap_or_default();
            Ok(Packet::Error { code, message: String::from_utf8_lossy(msg).into_owned() })
        }
        OACK => {
            let parts = strings(rest).ok_or_else(bad)?;
            Ok(Packet::Oack {
                options: parts.chunks(2).filter(|kv| kv.len() == 2).map(|kv| (kv[0].clone(), kv[1].clone())).collect(),
            })
        }
        _ => Err(Refusal::new(code::ILLEGAL, "Illegal TFTP operation")),
    }
}

pub fn encode(p: &Packet) -> Vec<u8> {
    let mut out = Vec::new();
    let strs = |out: &mut Vec<u8>, items: &[&str]| {
        for s in items {
            out.extend_from_slice(s.as_bytes());
            out.push(0);
        }
    };
    match p {
        Packet::Rrq { file, mode, options } | Packet::Wrq { file, mode, options } => {
            out.extend_from_slice(&(if matches!(p, Packet::Rrq { .. }) { RRQ } else { WRQ }).to_be_bytes());
            let m = if *mode == Mode::Octet { "octet" } else { "netascii" };
            strs(&mut out, &[file, m]);
            for (k, v) in options {
                strs(&mut out, &[k, v]);
            }
        }
        Packet::Data { block, data } => {
            out.extend_from_slice(&DATA.to_be_bytes());
            out.extend_from_slice(&block.to_be_bytes());
            out.extend_from_slice(data);
        }
        Packet::Ack { block } => {
            out.extend_from_slice(&ACK.to_be_bytes());
            out.extend_from_slice(&block.to_be_bytes());
        }
        Packet::Error { code, message } => {
            out.extend_from_slice(&ERROR.to_be_bytes());
            out.extend_from_slice(&code.to_be_bytes());
            strs(&mut out, &[message]);
        }
        Packet::Oack { options } => {
            out.extend_from_slice(&OACK.to_be_bytes());
            for (k, v) in options {
                strs(&mut out, &[k, v]);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Options

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Negotiated {
    pub blksize: usize,
    pub timeout: Duration,
    /// For a write, the size the device announced; for a read, the file's size.
    pub tsize: Option<u64>,
    /// What goes in the OACK; empty means reply the RFC 1350 way.
    pub reply: Vec<(String, String)>,
}

/// Accept the options we understand. `file_size` is known for reads in octet
/// mode (netascii changes the size on the wire, so tsize is left out there).
pub fn negotiate(options: &[(String, String)], file_size: Option<u64>) -> Negotiated {
    let mut n = Negotiated { blksize: DEFAULT_BLKSIZE, timeout: DEFAULT_TIMEOUT, tsize: None, reply: Vec::new() };
    for (k, v) in options {
        match k.as_str() {
            "blksize" => {
                if let Ok(size) = v.trim().parse::<usize>() {
                    if size >= 8 {
                        n.blksize = size.min(MAX_BLKSIZE);
                        n.reply.push((k.clone(), n.blksize.to_string()));
                    }
                }
            }
            "timeout" => {
                if let Ok(secs @ 1..=255) = v.trim().parse::<u64>() {
                    n.timeout = Duration::from_secs(secs);
                    n.reply.push((k.clone(), secs.to_string()));
                }
            }
            "tsize" => {
                let Ok(announced) = v.trim().parse::<u64>() else { continue };
                // A read asks with 0 and is told the size; a write announces it.
                match (announced, file_size) {
                    (0, Some(size)) => {
                        n.tsize = Some(size);
                        n.reply.push((k.clone(), size.to_string()));
                    }
                    (0, None) => {}
                    (size, _) => {
                        n.tsize = Some(size);
                        n.reply.push((k.clone(), size.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    n
}

// ---------------------------------------------------------------------------
// File names

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Turn a requested name into a path relative to the TFTP folder, refusing
/// anything that could reach outside it or name a device file. Devices often
/// send `/name` or `dir\name`; both are treated as relative to the folder.
pub fn relative_path(name: &str) -> Result<PathBuf, String> {
    let cleaned = name.replace('\\', "/");
    let mut out = PathBuf::new();
    for part in cleaned.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("names can't go up a folder (..)".into());
        }
        if part.chars().any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
            return Err(format!("\"{part}\" has characters a file name can't use"));
        }
        // Windows quietly drops trailing dots and spaces, so "a.bin." would alias "a.bin".
        if part.ends_with('.') || part.ends_with(' ') {
            return Err(format!("\"{part}\" ends with a dot or space"));
        }
        let stem = part.split('.').next().unwrap_or_default().trim_end().to_ascii_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            return Err(format!("\"{part}\" is a reserved device name"));
        }
        out.push(part);
    }
    match out.components().next() {
        Some(Component::Normal(_)) => Ok(out),
        _ => Err("no file name was given".into()),
    }
}

/// The path to serve, checked to still be inside `root` after links are followed.
fn resolve_read(root: &Path, rel: &Path) -> Result<PathBuf, Refusal> {
    let root =
        root.canonicalize().map_err(|e| Refusal::new(code::NOT_FOUND, format!("TFTP folder unavailable: {e}")))?;
    let path = root.join(rel).canonicalize().map_err(|_| Refusal::new(code::NOT_FOUND, "File not found"))?;
    if !path.starts_with(&root) {
        return Err(Refusal::new(code::ACCESS, "Access violation"));
    }
    if !path.is_file() {
        return Err(Refusal::new(code::NOT_FOUND, "File not found"));
    }
    Ok(path)
}

/// Where a received file goes, creating sub-folders inside `root` as needed.
fn resolve_write(root: &Path, rel: &Path) -> Result<PathBuf, Refusal> {
    let root = root.canonicalize().map_err(|e| Refusal::new(code::ACCESS, format!("TFTP folder unavailable: {e}")))?;
    let target = root.join(rel);
    let parent = target.parent().unwrap_or(&root);
    std::fs::create_dir_all(parent).map_err(|e| Refusal::new(code::ACCESS, format!("Can't create the folder: {e}")))?;
    let parent = parent.canonicalize().map_err(|e| Refusal::new(code::ACCESS, e.to_string()))?;
    if !parent.starts_with(&root) {
        return Err(Refusal::new(code::ACCESS, "Access violation"));
    }
    let name = target.file_name().ok_or_else(|| Refusal::new(code::ACCESS, "Access violation"))?;
    let path = parent.join(name);
    if path.is_dir() {
        return Err(Refusal::new(code::ACCESS, "A folder has that name"));
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// Netascii (RFC 764 line endings: CR LF for a newline, CR NUL for a bare CR)

const CR: u8 = b'\r';
const LF: u8 = b'\n';

/// File bytes to netascii. `crlf_native` says the file already uses CR LF
/// line endings (Windows), so those pass through unchanged.
#[derive(Debug, Default)]
pub struct NetasciiEncoder {
    crlf_native: bool,
    cr: bool,
}

impl NetasciiEncoder {
    pub fn new(crlf_native: bool) -> Self {
        Self { crlf_native, cr: false }
    }

    pub fn push(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            if !self.crlf_native {
                match b {
                    CR => out.extend_from_slice(&[CR, 0]),
                    LF => out.extend_from_slice(&[CR, LF]),
                    _ => out.push(b),
                }
                continue;
            }
            if std::mem::take(&mut self.cr) {
                if b == LF {
                    out.extend_from_slice(&[CR, LF]);
                    continue;
                }
                out.extend_from_slice(&[CR, 0]);
            }
            match b {
                CR => self.cr = true,
                LF => out.extend_from_slice(&[CR, LF]),
                _ => out.push(b),
            }
        }
    }

    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if std::mem::take(&mut self.cr) {
            out.extend_from_slice(&[CR, 0]);
        }
    }
}

/// Netascii to file bytes with the platform's line endings.
#[derive(Debug, Default)]
pub struct NetasciiDecoder {
    crlf_native: bool,
    cr: bool,
}

impl NetasciiDecoder {
    pub fn new(crlf_native: bool) -> Self {
        Self { crlf_native, cr: false }
    }

    pub fn push(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            if std::mem::take(&mut self.cr) {
                match b {
                    LF if self.crlf_native => out.extend_from_slice(&[CR, LF]),
                    LF => out.push(LF),
                    0 => out.push(CR),
                    // Not valid netascii; keep the CR rather than lose a byte.
                    _ => {
                        out.push(CR);
                        if b == CR {
                            self.cr = true;
                        } else {
                            out.push(b);
                        }
                    }
                }
            } else if b == CR {
                self.cr = true;
            } else {
                out.push(b);
            }
        }
    }

    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if std::mem::take(&mut self.cr) {
            out.push(CR);
        }
    }
}

const CRLF_NATIVE: bool = cfg!(windows);

/// Reads a file as fixed-size blocks, translating to netascii if asked.
struct BlockReader {
    file: std::fs::File,
    enc: Option<NetasciiEncoder>,
    pending: Vec<u8>,
    eof: bool,
}

impl BlockReader {
    fn next(&mut self, size: usize) -> std::io::Result<Vec<u8>> {
        let mut chunk = vec![0u8; size.max(4096)];
        while self.pending.len() < size && !self.eof {
            let n = self.file.read(&mut chunk)?;
            if n == 0 {
                self.eof = true;
                if let Some(e) = self.enc.as_mut() {
                    e.finish(&mut self.pending);
                }
                break;
            }
            match self.enc.as_mut() {
                Some(e) => e.push(&chunk[..n], &mut self.pending),
                None => self.pending.extend_from_slice(&chunk[..n]),
            }
        }
        let take = self.pending.len().min(size);
        Ok(self.pending.drain(..take).collect())
    }
}

// ---------------------------------------------------------------------------
// Server

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// The device reads a file from the TFTP folder.
    Send,
    /// The device writes a file into the TFTP folder.
    Receive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Active,
    Done,
    Failed,
    Refused,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: u64,
    pub peer: String,
    pub file: String,
    pub direction: Direction,
    pub state: TransferState,
    pub bytes: u64,
    pub total: Option<u64>,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

pub type Sink = Arc<dyn Fn(&Transfer) + Send + Sync>;
/// Host names or addresses allowed to use the server, asked per request.
pub type AllowList = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

pub struct Config {
    pub root: PathBuf,
    pub bind: SocketAddr,
    pub allow_overwrite: bool,
    /// None accepts any device; Some limits requests to these hosts.
    pub allowed: Option<AllowList>,
}

/// A running server. Dropping it stops the server and every transfer.
pub struct Server {
    stop: watch::Sender<bool>,
    local: SocketAddr,
}

impl Server {
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

struct Shared {
    cfg: Config,
    sink: Sink,
    next_id: AtomicU64,
    /// Requests in progress, so a device's retransmitted request isn't a second transfer.
    active: Mutex<HashSet<(SocketAddr, String)>>,
    /// Files being received, so two devices can't write one name at once.
    writing: Mutex<HashSet<PathBuf>>,
}

pub async fn start(cfg: Config, sink: Sink) -> std::io::Result<Server> {
    let sock = UdpSocket::bind(cfg.bind).await?;
    let local = sock.local_addr()?;
    let (stop, stop_rx) = watch::channel(false);
    let shared = Arc::new(Shared {
        cfg,
        sink,
        next_id: AtomicU64::new(1),
        active: Mutex::new(HashSet::new()),
        writing: Mutex::new(HashSet::new()),
    });
    tokio::spawn(listen(sock, shared, stop_rx));
    Ok(Server { stop, local })
}

async fn listen(sock: UdpSocket, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let mut buf = vec![0u8; 2048];
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            r = sock.recv_from(&mut buf) => {
                // ICMP port-unreachable from an earlier reply shows up here on Windows; keep listening.
                let Ok((n, peer)) = r else { continue };
                match parse(&buf[..n]) {
                    Ok(Packet::Rrq { file, mode, options }) => {
                        spawn_transfer(&shared, &stop, peer, Direction::Send, file, mode, options);
                    }
                    Ok(Packet::Wrq { file, mode, options }) => {
                        spawn_transfer(&shared, &stop, peer, Direction::Receive, file, mode, options);
                    }
                    // Stray data or acks for a transfer that has ended: nothing to answer.
                    Ok(_) => {}
                    Err(r) => {
                        let _ = sock.send_to(&encode(&Packet::Error { code: r.code, message: r.message }), peer).await;
                    }
                }
            }
        }
    }
}

fn spawn_transfer(
    shared: &Arc<Shared>,
    stop: &watch::Receiver<bool>,
    peer: SocketAddr,
    direction: Direction,
    file: String,
    mode: Mode,
    options: Vec<(String, String)>,
) {
    let key = (peer, file.clone());
    if !shared.active.lock().insert(key.clone()) {
        return;
    }
    let shared = shared.clone();
    let stop = stop.clone();
    tokio::spawn(async move {
        let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
        let mut t = Transfer {
            id,
            peer: peer.ip().to_canonical().to_string(),
            file: file.clone(),
            direction,
            state: TransferState::Active,
            bytes: 0,
            total: None,
            elapsed_ms: 0,
            error: None,
        };
        run_transfer(&shared, stop, peer, &mut t, mode, options).await;
        shared.active.lock().remove(&key);
    });
}

/// One transfer's socket and bookkeeping.
struct Link<'a> {
    sock: UdpSocket,
    peer: SocketAddr,
    timeout: Duration,
    stop: watch::Receiver<bool>,
    shared: &'a Shared,
    started: Instant,
    last_progress: Instant,
}

enum Fail {
    /// Tell the device why, then report it.
    Send(Refusal),
    /// The device sent an error or went quiet; nothing more to send.
    Quiet(String),
}

impl From<Refusal> for Fail {
    fn from(r: Refusal) -> Self {
        Fail::Send(r)
    }
}

fn io_refusal(e: &std::io::Error) -> Refusal {
    if e.kind() == ErrorKind::StorageFull || e.raw_os_error() == Some(if cfg!(windows) { 112 } else { 28 }) {
        Refusal::new(code::DISK_FULL, "Disk full")
    } else {
        Refusal::new(code::NOT_DEFINED, e.to_string())
    }
}

impl Link<'_> {
    async fn send(&self, p: &Packet) {
        let _ = self.sock.send_to(&encode(p), self.peer).await;
    }

    /// The next packet from the device, or None after `timeout`. Packets from
    /// anyone else are told they have the wrong transfer id.
    async fn recv(&mut self) -> Result<Option<Packet>, Fail> {
        let deadline = tokio::time::Instant::now() + self.timeout;
        let mut buf = vec![0u8; MAX_BLKSIZE + 4];
        loop {
            let r = tokio::select! {
                _ = self.stop.changed() => {
                    self.send(&Packet::Error { code: code::NOT_DEFINED, message: "TFTP server stopped".into() }).await;
                    return Err(Fail::Quiet("The TFTP server was stopped".into()));
                }
                r = tokio::time::timeout_at(deadline, self.sock.recv_from(&mut buf)) => r,
            };
            let Ok(r) = r else { return Ok(None) };
            let Ok((n, from)) = r else { continue };
            if from != self.peer {
                let p = Packet::Error { code: code::UNKNOWN_TID, message: "Unknown transfer ID".into() };
                let _ = self.sock.send_to(&encode(&p), from).await;
                continue;
            }
            match parse(&buf[..n]) {
                Ok(Packet::Error { message, .. }) => {
                    let why = if message.is_empty() {
                        "The device cancelled the transfer".into()
                    } else {
                        format!("The device cancelled: {message}")
                    };
                    return Err(Fail::Quiet(why));
                }
                Ok(p) => return Ok(Some(p)),
                Err(_) => continue,
            }
        }
    }

    fn report(&mut self, t: &mut Transfer, force: bool) {
        if !force && self.last_progress.elapsed() < PROGRESS_EVERY {
            return;
        }
        self.last_progress = Instant::now();
        t.elapsed_ms = self.started.elapsed().as_millis() as u64;
        (self.shared.sink)(t);
    }
}

async fn allowed(shared: &Shared, ip: IpAddr) -> bool {
    let Some(list) = &shared.cfg.allowed else { return true };
    let ip = ip.to_canonical();
    for host in list() {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
        if let Ok(a) = host.parse::<IpAddr>() {
            if a.to_canonical() == ip {
                return true;
            }
            continue;
        }
        let found = tokio::time::timeout(Duration::from_secs(2), tokio::net::lookup_host((host.as_str(), 0))).await;
        if let Ok(Ok(mut addrs)) = found {
            if addrs.any(|a| a.ip().to_canonical() == ip) {
                return true;
            }
        }
    }
    false
}

async fn run_transfer(
    shared: &Shared,
    stop: watch::Receiver<bool>,
    peer: SocketAddr,
    t: &mut Transfer,
    mode: Mode,
    options: Vec<(String, String)>,
) {
    // Reply from the address the server listens on, on a fresh port (the TID).
    let bind = SocketAddr::new(shared.cfg.bind.ip(), 0);
    let sock = match UdpSocket::bind(bind).await {
        Ok(s) => s,
        Err(e) => {
            t.state = TransferState::Failed;
            t.error = Some(format!("Couldn't open a socket: {e}"));
            (shared.sink)(t);
            return;
        }
    };
    let now = Instant::now();
    let mut link = Link { sock, peer, timeout: DEFAULT_TIMEOUT, stop, shared, started: now, last_progress: now };

    if !allowed(shared, peer.ip()).await {
        let msg = "Access denied";
        link.send(&Packet::Error { code: code::ACCESS, message: msg.into() }).await;
        t.state = TransferState::Refused;
        t.error = Some("Not a device with an open tab. Change this in Settings > TFTP server.".into());
        link.report(t, true);
        return;
    }

    let result = match t.direction {
        Direction::Send => send_file(&mut link, t, mode, &options).await,
        Direction::Receive => receive_file(&mut link, t, mode, &options).await,
    };
    match result {
        Ok(()) => t.state = TransferState::Done,
        Err(Fail::Send(r)) => {
            link.send(&Packet::Error { code: r.code, message: r.message.clone() }).await;
            let refused = matches!(r.code, code::NOT_FOUND | code::ACCESS | code::EXISTS) && t.bytes == 0;
            t.state = if refused { TransferState::Refused } else { TransferState::Failed };
            t.error = Some(r.message);
        }
        Err(Fail::Quiet(why)) => {
            t.state = TransferState::Failed;
            t.error = Some(why);
        }
    }
    link.report(t, true);
}

fn timed_out(t: &Transfer) -> Fail {
    let what =
        if t.bytes == 0 { "The device stopped answering" } else { "The device stopped answering partway through" };
    Fail::Quiet(what.into())
}

/// Send `p` and wait for the matching reply, retransmitting on silence.
/// `want` returns Some when a packet is the expected reply.
async fn exchange<T>(
    link: &mut Link<'_>,
    t: &Transfer,
    p: &Packet,
    want: impl Fn(&Packet) -> Option<T>,
) -> Result<T, Fail> {
    link.send(p).await;
    let mut tries = 0;
    loop {
        match link.recv().await? {
            Some(reply) => {
                if let Some(v) = want(&reply) {
                    return Ok(v);
                }
                // A duplicate ack: ignore it rather than resend (the Sorcerer's Apprentice bug).
            }
            None => {
                tries += 1;
                if tries > RETRIES {
                    return Err(timed_out(t));
                }
                link.send(p).await;
            }
        }
    }
}

async fn send_file(
    link: &mut Link<'_>,
    t: &mut Transfer,
    mode: Mode,
    options: &[(String, String)],
) -> Result<(), Fail> {
    let rel = relative_path(&t.file).map_err(|e| Refusal::new(code::ACCESS, e))?;
    let path = resolve_read(&link.shared.cfg.root, &rel)?;
    let file = std::fs::File::open(&path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => Refusal::new(code::NOT_FOUND, "File not found"),
        ErrorKind::PermissionDenied => Refusal::new(code::ACCESS, "Access violation"),
        _ => io_refusal(&e),
    })?;
    let size = file.metadata().ok().map(|m| m.len());
    // Netascii changes the size on the wire, so there's no total to show.
    let size = if mode == Mode::Octet { size } else { None };
    t.total = size;
    let n = negotiate(options, size);
    link.timeout = n.timeout;
    link.report(t, true);

    if !n.reply.is_empty() {
        let oack = Packet::Oack { options: n.reply.clone() };
        exchange(link, t, &oack, |p| matches!(p, Packet::Ack { block: 0 }).then_some(())).await?;
    }
    let enc = (mode == Mode::Netascii).then(|| NetasciiEncoder::new(CRLF_NATIVE));
    let mut reader = BlockReader { file, enc, pending: Vec::new(), eof: false };
    let mut block: u16 = 1;
    loop {
        let data = reader.next(n.blksize).map_err(|e| io_refusal(&e))?;
        let last = data.len() < n.blksize;
        let len = data.len() as u64;
        let p = Packet::Data { block, data };
        exchange(link, t, &p, |r| matches!(r, Packet::Ack { block: b } if *b == block).then_some(())).await?;
        t.bytes += len;
        if last {
            return Ok(());
        }
        link.report(t, false);
        // Block numbers wrap to 0 for files over 65535 blocks, as most clients expect.
        block = block.wrapping_add(1);
    }
}

/// Removes a partly received file unless the transfer finishes.
struct Partial<'a> {
    path: PathBuf,
    target: PathBuf,
    writing: &'a Mutex<HashSet<PathBuf>>,
    keep: bool,
}

impl Drop for Partial<'_> {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
        self.writing.lock().remove(&self.target);
    }
}

async fn receive_file(
    link: &mut Link<'_>,
    t: &mut Transfer,
    mode: Mode,
    options: &[(String, String)],
) -> Result<(), Fail> {
    let rel = relative_path(&t.file).map_err(|e| Refusal::new(code::ACCESS, e))?;
    let target = resolve_write(&link.shared.cfg.root, &rel)?;
    if !link.shared.cfg.allow_overwrite && target.exists() {
        return Err(Refusal::new(code::EXISTS, "File already exists").into());
    }
    if !link.shared.writing.lock().insert(target.clone()) {
        return Err(Refusal::new(code::ACCESS, "Another device is sending a file with that name").into());
    }
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut partial = Partial {
        path: target.with_file_name(format!("{name}.tftp-part")),
        target: target.clone(),
        writing: &link.shared.writing,
        keep: false,
    };
    let file = std::fs::File::create(&partial.path).map_err(|e| match e.kind() {
        ErrorKind::PermissionDenied => Refusal::new(code::ACCESS, "Access violation"),
        _ => io_refusal(&e),
    })?;
    let mut out = std::io::BufWriter::with_capacity(256 * 1024, file);
    let n = negotiate(options, None);
    link.timeout = n.timeout;
    t.total = n.tsize;
    link.report(t, true);

    let first = if n.reply.is_empty() { Packet::Ack { block: 0 } } else { Packet::Oack { options: n.reply.clone() } };
    let mut dec = (mode == Mode::Netascii).then(|| NetasciiDecoder::new(CRLF_NATIVE));
    let mut decoded = Vec::new();
    let mut expect: u16 = 1;
    let mut reply = first;
    loop {
        let want = expect;
        let data = exchange(link, t, &reply, |p| match p {
            Packet::Data { block, data } if *block == want => Some(data.clone()),
            _ => None,
        })
        .await?;
        if data.len() > n.blksize {
            return Err(Refusal::new(code::ILLEGAL, "Block larger than negotiated").into());
        }
        match dec.as_mut() {
            Some(d) => {
                decoded.clear();
                d.push(&data, &mut decoded);
                out.write_all(&decoded)
            }
            None => out.write_all(&data),
        }
        .map_err(|e| io_refusal(&e))?;
        t.bytes += data.len() as u64;
        reply = Packet::Ack { block: expect };
        if data.len() < n.blksize {
            break;
        }
        link.report(t, false);
        expect = expect.wrapping_add(1);
    }

    if let Some(d) = dec.as_mut() {
        decoded.clear();
        d.finish(&mut decoded);
        out.write_all(&decoded).map_err(|e| io_refusal(&e))?;
    }
    let file = out.into_inner().map_err(|e| io_refusal(e.error()))?;
    file.sync_all().map_err(|e| io_refusal(&e))?;
    drop(file);
    if !link.shared.cfg.allow_overwrite && target.exists() {
        return Err(Refusal::new(code::EXISTS, "File already exists").into());
    }
    std::fs::rename(&partial.path, &target).map_err(|e| io_refusal(&e))?;
    partial.keep = true;
    link.send(&reply).await;
    // Linger a moment: if the final ack was lost the device resends the last
    // block, and it must be acked again or the device reports a failure.
    let last = expect;
    t.state = TransferState::Done;
    link.report(t, true);
    let deadline = Instant::now() + link.timeout;
    while Instant::now() < deadline {
        match link.recv().await {
            Ok(Some(Packet::Data { block, .. })) if block == last => link.send(&reply).await,
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    Ok(())
}

/// IPv4 and IPv6 addresses on this machine's interfaces, loopback last, for
/// telling the user what to type into the device.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAddress {
    pub address: String,
    pub interface: String,
}

pub fn local_addresses() -> Vec<LocalAddress> {
    let mut list: Vec<_> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback() && i.ip().is_ipv4() && !i.ip().to_string().starts_with("169.254."))
        .map(|i| LocalAddress { address: i.ip().to_string(), interface: i.name })
        .collect();
    list.sort_by(|a, b| a.interface.cmp(&b.interface).then(a.address.cmp(&b.address)));
    list.dedup_by(|a, b| a.address == b.address);
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn packets_round_trip() {
        let cases = vec![
            Packet::Rrq {
                file: "c2960.bin".into(),
                mode: Mode::Octet,
                options: opts(&[("blksize", "1468"), ("tsize", "0")]),
            },
            Packet::Wrq { file: "sw1-confg".into(), mode: Mode::Netascii, options: vec![] },
            Packet::Data { block: 7, data: vec![1, 2, 3] },
            Packet::Data { block: 65535, data: vec![] },
            Packet::Ack { block: 0 },
            Packet::Error { code: 1, message: "File not found".into() },
            Packet::Oack { options: opts(&[("blksize", "1468")]) },
        ];
        for p in cases {
            assert_eq!(parse(&encode(&p)).unwrap(), p);
        }
    }

    #[test]
    fn requests_are_parsed_leniently_but_safely() {
        // Mode and option names are case-insensitive.
        let raw = b"\x00\x01Image.BIN\x00OCTET\x00BLKSIZE\x008192\x00";
        assert_eq!(
            parse(raw).unwrap(),
            Packet::Rrq { file: "Image.BIN".into(), mode: Mode::Octet, options: opts(&[("blksize", "8192")]) }
        );
        assert_eq!(parse(b"\x00\x01f\x00mail\x00").unwrap_err().code, code::ILLEGAL);
        assert!(parse(b"\x00\x01f\x00octet").is_err(), "unterminated");
        assert!(parse(b"\x00\x01f\x00octet\x00blksize\x00").is_err(), "option without value");
        assert!(parse(b"\x00").is_err());
        assert!(parse(b"\x00\x09").is_err());
        assert!(parse(b"\x00\x04\x01").is_err(), "short ack");
    }

    #[test]
    fn options_are_negotiated() {
        let n =
            negotiate(&opts(&[("blksize", "1468"), ("tsize", "0"), ("timeout", "5"), ("windowsize", "4")]), Some(9000));
        assert_eq!(n.blksize, 1468);
        assert_eq!(n.timeout, Duration::from_secs(5));
        assert_eq!(n.tsize, Some(9000));
        assert_eq!(n.reply, opts(&[("blksize", "1468"), ("tsize", "9000"), ("timeout", "5")]));

        // Out-of-range values are capped or ignored.
        let n = negotiate(&opts(&[("blksize", "100000"), ("timeout", "0")]), None);
        assert_eq!(n.blksize, MAX_BLKSIZE);
        assert_eq!(n.timeout, DEFAULT_TIMEOUT);
        assert_eq!(n.reply, opts(&[("blksize", "65464")]));
        assert_eq!(negotiate(&opts(&[("blksize", "4")]), None).reply, vec![]);

        // A write announces its size; a read in netascii can't promise one.
        assert_eq!(negotiate(&opts(&[("tsize", "4096")]), None).tsize, Some(4096));
        assert!(negotiate(&opts(&[("tsize", "0")]), None).reply.is_empty());
        assert!(negotiate(&[], Some(1)).reply.is_empty());
    }

    #[test]
    fn file_names_stay_in_the_folder() {
        let ok = |n: &str| relative_path(n).unwrap();
        assert_eq!(ok("c2960.bin"), PathBuf::from("c2960.bin"));
        assert_eq!(ok("/c2960.bin"), PathBuf::from("c2960.bin"));
        assert_eq!(ok("backups/sw1-confg"), PathBuf::from("backups").join("sw1-confg"));
        assert_eq!(ok("backups\\sw1-confg"), PathBuf::from("backups").join("sw1-confg"));
        assert_eq!(ok("./a//b"), PathBuf::from("a").join("b"));
        for bad in [
            "",
            "/",
            "..",
            "../secret",
            "a/../../b",
            "C:\\Windows\\win.ini",
            "c:boot.ini",
            "file.bin:stream",
            "NUL",
            "con.txt",
            "com1",
            "lpt9.log",
            "a.bin.",
            "a.bin ",
            "a\0b",
            "what?",
        ] {
            assert!(relative_path(bad).is_err(), "{bad:?} should be refused");
        }
        // Names that merely start like a device are fine.
        assert!(relative_path("console.log").is_ok());
        assert!(relative_path("com10").is_ok());
    }

    #[test]
    fn reads_and_writes_follow_links_only_inside_the_folder() {
        let dir = std::env::temp_dir().join(format!("tether-tftp-paths-{}", std::process::id()));
        let root = dir.join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.bin"), b"x").unwrap();
        std::fs::write(dir.join("outside.txt"), b"secret").unwrap();
        assert!(resolve_read(&root, Path::new("sub/a.bin")).is_ok());
        assert_eq!(resolve_read(&root, Path::new("missing")).unwrap_err().code, code::NOT_FOUND);
        assert_eq!(resolve_read(&root, Path::new("sub")).unwrap_err().code, code::NOT_FOUND);
        let w = resolve_write(&root, Path::new("new/deeper/b.cfg")).unwrap();
        assert!(w.parent().unwrap().is_dir());
        assert_eq!(resolve_write(&root, Path::new("sub")).unwrap_err().code, code::ACCESS);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("outside.txt"), root.join("link.txt")).unwrap();
            std::os::unix::fs::symlink(&dir, root.join("up")).unwrap();
            assert_eq!(resolve_read(&root, Path::new("link.txt")).unwrap_err().code, code::ACCESS);
            assert_eq!(resolve_write(&root, Path::new("up/x.cfg")).unwrap_err().code, code::ACCESS);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn enc(native: bool, chunks: &[&[u8]]) -> Vec<u8> {
        let mut e = NetasciiEncoder::new(native);
        let mut out = Vec::new();
        for c in chunks {
            e.push(c, &mut out);
        }
        e.finish(&mut out);
        out
    }

    fn dec(native: bool, chunks: &[&[u8]]) -> Vec<u8> {
        let mut d = NetasciiDecoder::new(native);
        let mut out = Vec::new();
        for c in chunks {
            d.push(c, &mut out);
        }
        d.finish(&mut out);
        out
    }

    #[test]
    fn netascii_translates_line_endings() {
        // Unix files: LF is a newline, a lone CR is CR NUL.
        assert_eq!(enc(false, &[b"a\nb\rc"]), b"a\r\nb\r\0c");
        assert_eq!(dec(false, &[b"a\r\nb\r\0c"]), b"a\nb\rc");
        // Windows files: CR LF passes through, even split across reads.
        assert_eq!(enc(true, &[b"a\r", b"\nb\n", b"c\r"]), b"a\r\nb\r\nc\r\0");
        assert_eq!(dec(true, &[b"a\r", b"\nb\r", b"\0c\r"]), b"a\r\nb\rc\r");
        // Round trips.
        for native in [false, true] {
            let text: &[u8] = if native { b"line one\r\nline two\r\n\rend" } else { b"line one\nline two\n\rend" };
            assert_eq!(dec(native, &[&enc(native, &[text])]), text);
        }
        // Invalid CR followed by another byte keeps both.
        assert_eq!(dec(false, &[b"a\rb"]), b"a\rb");
        assert_eq!(dec(false, &[b"a\r\r\n"]), b"a\r\n");
    }

    #[test]
    fn netascii_blocks_are_full_until_the_end() {
        let dir = std::env::temp_dir().join(format!("tether-tftp-blocks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.txt");
        std::fs::write(&p, b"\n\n\n\n\n").unwrap();
        let mut r = BlockReader {
            file: std::fs::File::open(&p).unwrap(),
            enc: Some(NetasciiEncoder::new(false)),
            pending: vec![],
            eof: false,
        };
        assert_eq!(r.next(4).unwrap(), b"\r\n\r\n");
        assert_eq!(r.next(4).unwrap(), b"\r\n\r\n");
        assert_eq!(r.next(4).unwrap(), b"\r\n");
        assert_eq!(r.next(4).unwrap(), b"");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
