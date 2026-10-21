//! Telnet and raw TCP. Telnet still matters for console servers (Opengear,
//! Lantronix, Cisco terminal servers on ports 2001+) and lab gear.

use crate::conn::{CmdError, CmdResult, Ctl, Output};
use std::collections::HashSet;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_BINARY: u8 = 0;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

#[derive(Clone, Copy, PartialEq, Debug)]
enum State {
    Data,
    Iac,
    Verb(u8),
    Sb,
    SbIac,
}

/// Telnet protocol state machine, kept free of I/O so it can be unit tested.
pub struct Telnet {
    state: State,
    sb: Vec<u8>,
    sent: HashSet<(u8, u8)>,
    pub naws: bool,
    pub size: (u16, u16),
    term: String,
}

impl Telnet {
    pub fn new(term: &str, cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sb: Vec::new(),
            sent: HashSet::new(),
            naws: false,
            size: (cols, rows),
            term: term.to_uppercase(),
        }
    }

    /// Feed bytes from the network. Returns (display bytes, reply bytes).
    pub fn input(&mut self, data: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut shown = Vec::with_capacity(data.len());
        let mut reply = Vec::new();
        for &b in data {
            self.state = match (self.state, b) {
                (State::Data, IAC) => State::Iac,
                (State::Data, _) => {
                    shown.push(b);
                    State::Data
                }
                (State::Iac, IAC) => {
                    shown.push(IAC);
                    State::Data
                }
                (State::Iac, v @ (DO | DONT | WILL | WONT)) => State::Verb(v),
                (State::Iac, SB) => {
                    self.sb.clear();
                    State::Sb
                }
                (State::Iac, _) => State::Data, // NOP, GA, etc.
                (State::Verb(v), opt) => {
                    self.negotiate(v, opt, &mut reply);
                    State::Data
                }
                (State::Sb, IAC) => State::SbIac,
                (State::Sb, _) => {
                    if self.sb.len() < 512 {
                        self.sb.push(b);
                    }
                    State::Sb
                }
                (State::SbIac, SE) => {
                    self.subnegotiation(&mut reply);
                    State::Data
                }
                (State::SbIac, IAC) => {
                    self.sb.push(IAC);
                    State::Sb
                }
                (State::SbIac, _) => State::Sb,
            };
        }
        (shown, reply)
    }

    fn send_once(&mut self, verb: u8, opt: u8, out: &mut Vec<u8>) {
        if self.sent.insert((verb, opt)) {
            out.extend([IAC, verb, opt]);
        }
    }

    fn negotiate(&mut self, verb: u8, opt: u8, out: &mut Vec<u8>) {
        match verb {
            WILL => match opt {
                OPT_ECHO | OPT_SGA | OPT_BINARY => self.send_once(DO, opt, out),
                _ => self.send_once(DONT, opt, out),
            },
            DO => match opt {
                OPT_TTYPE | OPT_SGA | OPT_BINARY => self.send_once(WILL, opt, out),
                OPT_NAWS => {
                    self.send_once(WILL, opt, out);
                    self.naws = true;
                    out.extend(self.naws_bytes());
                }
                _ => self.send_once(WONT, opt, out),
            },
            DONT if opt == OPT_NAWS => self.naws = false,
            _ => {}
        }
    }

    fn subnegotiation(&mut self, out: &mut Vec<u8>) {
        // TTYPE SEND
        if self.sb.first() == Some(&OPT_TTYPE) && self.sb.get(1) == Some(&1) {
            out.extend([IAC, SB, OPT_TTYPE, 0]);
            out.extend(self.term.as_bytes());
            out.extend([IAC, SE]);
        }
    }

    pub fn naws_bytes(&self) -> Vec<u8> {
        let (c, r) = self.size;
        let mut v = vec![IAC, SB, OPT_NAWS];
        for byte in [(c >> 8) as u8, c as u8, (r >> 8) as u8, r as u8] {
            v.push(byte);
            if byte == IAC {
                v.push(IAC);
            }
        }
        v.extend([IAC, SE]);
        v
    }

    /// Prepare user keystrokes for the wire: double IAC, CR -> CR NUL.
    pub fn encode(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 4);
        for (i, &b) in data.iter().enumerate() {
            match b {
                IAC => out.extend([IAC, IAC]),
                b'\r' if data.get(i + 1) != Some(&b'\n') => out.extend([b'\r', 0]),
                _ => out.push(b),
            }
        }
        out
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn start(
    host: String,
    port: u16,
    telnet: bool,
    term: String,
    cols: u16,
    rows: u16,
    out: Output,
    mut rx: mpsc::UnboundedReceiver<Ctl>,
) -> CmdResult<()> {
    out.status("connecting", format!("Connecting to {host}:{port}…"));
    let stream = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| CmdError::new("TIMEOUT", format!("{host}:{port} did not answer within 15 seconds.")))?
        .map_err(|e| crate::conn::connect_error(&host, port, Some(&e), &e))?;
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let proto = std::sync::Arc::new(parking_lot::Mutex::new(Telnet::new(&term, cols, rows)));
    let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let reader_out = out.clone();
    let reader_proto = proto.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if telnet {
                        let (shown, reply) = reader_proto.lock().input(&buf[..n]);
                        if !reply.is_empty() {
                            let _ = reply_tx.send(reply);
                        }
                        reader_out.data(&shown);
                    } else {
                        reader_out.data(&buf[..n]);
                    }
                }
            }
        }
        reader_out.status("closed", "Connection closed by remote host.");
    });

    tokio::spawn(async move {
        loop {
            let bytes = tokio::select! {
                Some(reply) = reply_rx.recv() => reply,
                ctl = rx.recv() => match ctl {
                    Some(Ctl::Write(b)) => if telnet { Telnet::encode(&b) } else { b },
                    Some(Ctl::Resize(c, r)) => {
                        let mut p = proto.lock();
                        p.size = (c, r);
                        if telnet && p.naws { p.naws_bytes() } else { continue }
                    }
                    Some(Ctl::Break) => if telnet { vec![IAC, 243] } else { continue },
                    Some(Ctl::Close) | None => break,
                },
            };
            if wr.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });

    out.status("connected", format!("Connected to {host}:{port}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_and_strips_commands() {
        let mut t = Telnet::new("xterm", 80, 24);
        let (shown, reply) = t.input(&[IAC, WILL, OPT_ECHO, b'h', b'i', IAC, DO, OPT_NAWS, IAC, DO, 39]);
        assert_eq!(shown, b"hi");
        assert!(reply.windows(3).any(|w| w == [IAC, DO, OPT_ECHO]));
        assert!(reply.windows(3).any(|w| w == [IAC, WILL, OPT_NAWS]));
        assert!(reply.windows(3).any(|w| w == [IAC, WONT, 39]));
        assert!(reply.windows(7).any(|w| w == [IAC, SB, OPT_NAWS, 0, 80, 0, 24]));
        assert!(t.naws);
    }

    #[test]
    fn does_not_loop_on_repeated_requests() {
        let mut t = Telnet::new("xterm", 80, 24);
        let (_, first) = t.input(&[IAC, WILL, OPT_SGA]);
        let (_, second) = t.input(&[IAC, WILL, OPT_SGA]);
        assert_eq!(first, vec![IAC, DO, OPT_SGA]);
        assert!(second.is_empty());
    }

    #[test]
    fn answers_terminal_type() {
        let mut t = Telnet::new("xterm-256color", 80, 24);
        let (_, reply) = t.input(&[IAC, SB, OPT_TTYPE, 1, IAC, SE]);
        assert_eq!(&reply[..4], &[IAC, SB, OPT_TTYPE, 0]);
        assert!(reply.ends_with(&[IAC, SE]));
        assert!(String::from_utf8_lossy(&reply).contains("XTERM-256COLOR"));
    }

    #[test]
    fn handles_split_sequences_and_escaped_iac() {
        let mut t = Telnet::new("xterm", 80, 24);
        let (a, _) = t.input(&[b'x', IAC]);
        let (b, reply) = t.input(&[WILL, OPT_ECHO, IAC, IAC]);
        assert_eq!(a, b"x");
        assert_eq!(b, vec![IAC]);
        assert_eq!(reply, vec![IAC, DO, OPT_ECHO]);
    }

    #[test]
    fn encodes_cr_and_iac() {
        assert_eq!(Telnet::encode(b"a\r"), vec![b'a', b'\r', 0]);
        assert_eq!(Telnet::encode(b"\r\n"), b"\r\n".to_vec());
        assert_eq!(Telnet::encode(&[IAC]), vec![IAC, IAC]);
    }
}
