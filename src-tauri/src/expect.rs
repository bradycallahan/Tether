//! Expect/send login actions: wait for a prompt, send a reply, repeat.
//!
//! The parsing and matching are pure (and unit tested); `run` wires them to a
//! live connection. Secrets referenced by a step ({password}, {enable}) are
//! filled in here, so saved credentials never have to travel to the UI.

use crate::conn::{Ctl, Output};
use crate::model::{LoginStep, Session};
use regex::Regex;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{timeout, Instant};

/// Output is "settled" once nothing has arrived for this long. Steps with an
/// empty `expect` wait for that instead of a prompt.
const SETTLE: Duration = Duration::from_millis(300);
/// Keep this much recent output for matching; prompts are short.
const WINDOW: usize = 8192;

#[derive(Debug, PartialEq)]
pub enum Segment {
    Text(Vec<u8>),
    Pause(Duration),
}

/// Parse a send string. Mirrors `parseSendString` in src/escapes.ts:
///   \r \n \t \e \b \\  \xHH  \p (pause 500 ms)  \P (pause 2 s)  ^X control chars, ^^ caret
pub fn parse_send(input: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let push_char = |buf: &mut Vec<u8>, c: char| {
        let mut tmp = [0u8; 4];
        buf.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
    };
    let flush = |buf: &mut Vec<u8>, out: &mut Vec<Segment>| {
        if !buf.is_empty() {
            out.push(Segment::Text(std::mem::take(buf)));
        }
    };
    while i < chars.len() {
        let c = chars[i];
        if c == '^' && i + 1 < chars.len() {
            let n = chars[i + 1];
            if n == '^' {
                buf.push(b'^');
                i += 2;
                continue;
            }
            let code = n.to_ascii_uppercase() as u32;
            if (64..=95).contains(&code) {
                buf.push((code - 64) as u8);
                i += 2;
                continue;
            }
            buf.push(b'^');
            i += 1;
            continue;
        }
        if c != '\\' || i + 1 >= chars.len() {
            push_char(&mut buf, c);
            i += 1;
            continue;
        }
        let n = chars[i + 1];
        i += 2;
        match n {
            'r' => buf.push(b'\r'),
            'n' => buf.push(b'\n'),
            't' => buf.push(b'\t'),
            'e' => buf.push(0x1b),
            'b' => buf.push(0x7f),
            '\\' => buf.push(b'\\'),
            'p' => {
                flush(&mut buf, &mut out);
                out.push(Segment::Pause(Duration::from_millis(500)));
            }
            'P' => {
                flush(&mut buf, &mut out);
                out.push(Segment::Pause(Duration::from_secs(2)));
            }
            'x' => {
                let hex: String = chars.iter().skip(i).take(2).collect();
                match u8::from_str_radix(&hex, 16) {
                    Ok(b) if hex.len() == 2 && hex.chars().all(|c| c.is_ascii_hexdigit()) => {
                        buf.push(b);
                        i += 2;
                    }
                    _ => buf.extend_from_slice(b"\\x"),
                }
            }
            other => {
                buf.push(b'\\');
                push_char(&mut buf, other);
            }
        }
    }
    flush(&mut buf, &mut out);
    out
}

/// Values for the {username}, {password} and {enable} tokens.
#[derive(Default)]
pub struct Secrets {
    pub username: String,
    pub password: Option<String>,
    pub enable: Option<String>,
}

/// Fill tokens into an already-parsed send string. Done after escape parsing
/// so a password containing `\` or `^` is sent exactly as typed.
pub fn fill_tokens(segments: Vec<Segment>, s: &Secrets) -> Result<Vec<Segment>, &'static str> {
    let mut out = Vec::with_capacity(segments.len());
    for seg in segments {
        let Segment::Text(mut bytes) = seg else {
            out.push(seg);
            continue;
        };
        for (token, value, missing) in [
            ("{username}", Some(s.username.as_str()), "the username"),
            ("{password}", s.password.as_deref(), "a saved password"),
            ("{enable}", s.enable.as_deref(), "a saved enable password"),
        ] {
            if find(&bytes, token.as_bytes()).is_some() {
                let Some(v) = value else { return Err(missing) };
                bytes = replace_all(&bytes, token.as_bytes(), v.as_bytes());
            }
        }
        out.push(Segment::Text(bytes));
    }
    Ok(out)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn replace_all(hay: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(hay.len());
    let mut i = 0;
    while i < hay.len() {
        if hay[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(hay[i]);
            i += 1;
        }
    }
    out
}

pub enum Pattern {
    /// Lowercased; plain-text prompts match case-insensitively.
    Text(String),
    Regex(Regex),
}

impl Pattern {
    /// `None` for an empty expect (send once output settles).
    pub fn new(step: &LoginStep) -> Result<Option<Pattern>, String> {
        if step.expect.is_empty() {
            return Ok(None);
        }
        if step.regex {
            return Regex::new(&step.expect).map(|r| Some(Pattern::Regex(r))).map_err(|e| e.to_string());
        }
        Ok(Some(Pattern::Text(step.expect.to_lowercase())))
    }

    /// End offset of the first match in `text`.
    fn find_end(&self, text: &str) -> Option<usize> {
        match self {
            Pattern::Text(t) => {
                let lower = text.to_lowercase();
                // Lowercasing can change byte lengths for non-ASCII text; only
                // trust the offset when it didn't.
                lower.find(t.as_str()).map(|i| if lower.len() == text.len() { i + t.len() } else { text.len() })
            }
            Pattern::Regex(r) => r.find(text).map(|m| m.end()),
        }
    }
}

/// Recent output, with terminal escapes stripped, for prompt matching.
#[derive(Default)]
pub struct Matcher {
    text: String,
}

impl Matcher {
    pub fn push(&mut self, bytes: &[u8]) {
        let clean = strip_ansi_escapes::strip(bytes);
        self.text.push_str(&String::from_utf8_lossy(&clean));
        if self.text.len() > WINDOW {
            let mut cut = self.text.len() - WINDOW;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
        }
    }

    /// If the pattern is in the buffer, consume everything up to the end of
    /// the match (so the next step only sees newer output) and return true.
    pub fn take(&mut self, p: &Pattern) -> bool {
        match p.find_end(&self.text) {
            Some(end) => {
                self.text.drain(..end);
                true
            }
            None => false,
        }
    }

    pub fn clear(&mut self) {
        self.text.clear();
    }
}

/// The steps to run for a session: its expect/send steps, or the legacy
/// one-command-per-line login script turned into "wait, then send" steps.
pub fn effective_steps(s: &Session) -> Vec<LoginStep> {
    if !s.login_steps.is_empty() {
        return s.login_steps.iter().filter(|st| !st.expect.is_empty() || !st.send.is_empty()).cloned().collect();
    }
    s.login_script
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .map(|l| LoginStep {
            expect: String::new(),
            send: if l.ends_with("\\r") || l.ends_with("\\n") { l.to_string() } else { format!("{l}\\r") },
            regex: false,
        })
        .collect()
}

/// Run login steps against a live connection. `rx` receives a copy of
/// everything the device sends; writes go out through `tx`. Stops quietly if
/// the connection closes, and with a warning in the terminal if a prompt
/// never shows up.
pub async fn run(
    steps: Vec<LoginStep>,
    step_timeout: Duration,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    tx: mpsc::UnboundedSender<Ctl>,
    out: Output,
    secrets: Secrets,
) {
    let _tap = TapGuard(out.clone());
    let mut m = Matcher::default();
    for (i, step) in steps.iter().enumerate() {
        let n = i + 1;
        let pattern = match Pattern::new(step) {
            Ok(p) => p,
            Err(e) => {
                out.status(
                    "warning",
                    format!("Login actions stopped: step {n} isn't a valid regular expression ({e})."),
                );
                return;
            }
        };
        let deadline = Instant::now() + step_timeout;
        match &pattern {
            Some(p) => loop {
                if m.take(p) {
                    break;
                }
                match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(Some(bytes)) => m.push(&bytes),
                    Ok(None) => return,
                    Err(_) => {
                        out.status(
                            "warning",
                            format!(
                                "Login actions stopped at step {n}: \u{201c}{}\u{201d} didn't appear within {} s. Edit the session's login actions if the prompt is different.",
                                step.expect,
                                step_timeout.as_secs()
                            ),
                        );
                        return;
                    }
                }
            },
            None => {
                // Wait for the device to go quiet, but don't wait forever on
                // a chatty one.
                while Instant::now() < deadline {
                    match timeout(SETTLE, rx.recv()).await {
                        Ok(Some(bytes)) => m.push(&bytes),
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                m.clear();
            }
        }
        let segments = match fill_tokens(parse_send(&step.send), &secrets) {
            Ok(s) => s,
            Err(missing) => {
                out.status(
                    "warning",
                    format!("Login actions stopped: step {n} needs {missing}. Add it in the session's login actions."),
                );
                return;
            }
        };
        for seg in segments {
            match seg {
                Segment::Text(bytes) => {
                    if tx.send(Ctl::Write(bytes)).is_err() {
                        return;
                    }
                }
                Segment::Pause(d) => tokio::time::sleep(d).await,
            }
        }
    }
}

/// Stops copying output to the login engine once it finishes, so the
/// output path goes back to doing nothing extra.
struct TapGuard(Output);

impl Drop for TapGuard {
    fn drop(&mut self) {
        self.0.set_tap(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Segment {
        Segment::Text(s.as_bytes().to_vec())
    }

    #[test]
    fn parses_escapes_like_the_ui() {
        assert_eq!(parse_send("show run\\r"), vec![text("show run\r")]);
        assert_eq!(parse_send("^C^Z^^x"), vec![text("\x03\x1a^x")]);
        assert_eq!(parse_send("a\\x41\\\\b"), vec![text("aA\\b")]);
        assert_eq!(
            parse_send("wr\\r\\p\\r"),
            vec![text("wr\r"), Segment::Pause(Duration::from_millis(500)), text("\r")]
        );
        assert_eq!(parse_send("c:\\qa\\z"), vec![text("c:\\qa\\z")]);
        assert_eq!(parse_send("\\xff"), vec![Segment::Text(vec![0xff])]);
        assert_eq!(parse_send("\\x+1"), vec![text("\\x+1")]);
    }

    #[test]
    fn tokens_are_filled_after_escapes() {
        let s = Secrets { username: "admin".into(), password: Some("p\\r^C".into()), enable: None };
        let out = fill_tokens(parse_send("{username}\\r{password}\\r"), &s).unwrap();
        assert_eq!(out, vec![text("admin\rp\\r^C\r")], "the password goes out literally");
        assert_eq!(fill_tokens(parse_send("{enable}\\r"), &s).unwrap_err(), "a saved enable password");
    }

    #[test]
    fn matches_prompts_through_escapes_and_chunks() {
        let mut m = Matcher::default();
        let p = Pattern::new(&LoginStep { expect: "password:".into(), ..Default::default() }).unwrap().unwrap();
        m.push(b"\x1b[1mUser Access Verification\x1b[0m\r\n\r\nPass");
        assert!(!m.take(&p));
        m.push(b"word: ");
        assert!(m.take(&p));
        assert!(!m.take(&p), "a match is consumed");
    }

    #[test]
    fn regex_steps() {
        let mut m = Matcher::default();
        let p = Pattern::new(&LoginStep { expect: r"[>#]\s*$".into(), regex: true, ..Default::default() })
            .unwrap()
            .unwrap();
        m.push(b"\r\nSwitch>");
        assert!(m.take(&p));
        assert!(Pattern::new(&LoginStep { expect: "(".into(), regex: true, ..Default::default() }).is_err());
    }

    #[test]
    fn window_stays_bounded() {
        let mut m = Matcher::default();
        for _ in 0..100 {
            m.push(&[b'x'; 1000]);
        }
        m.push("é#".as_bytes());
        assert!(m.text.len() <= WINDOW + 4);
        let p = Pattern::new(&LoginStep { expect: "é#".into(), ..Default::default() }).unwrap().unwrap();
        assert!(m.take(&p));
    }

    #[test]
    fn legacy_script_becomes_steps() {
        let mut s: Session = toml::from_str("id='x'\nname='n'\n[protocol]\nkind='telnet'\nhost='h'\n").unwrap();
        s.login_script = "terminal length 0\n\nshow clock\\r\n".into();
        let steps = effective_steps(&s);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].send, "terminal length 0\\r");
        assert_eq!(steps[1].send, "show clock\\r");
        assert!(steps.iter().all(|st| st.expect.is_empty()));
        s.login_steps = vec![LoginStep { expect: "#".into(), send: "x\\r".into(), regex: false }];
        assert_eq!(effective_steps(&s), s.login_steps, "steps win over the old script");
    }

    #[tokio::test]
    async fn runs_steps_against_a_fake_device() {
        let sent = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<u8>::new()));
        let out = Output::new(|_| {}, |_| {});
        let (tap_tx, tap_rx) = mpsc::unbounded_channel();
        let (tx, mut ctl_rx) = mpsc::unbounded_channel();
        let steps = vec![
            LoginStep { expect: "Username:".into(), send: "{username}\\r".into(), regex: false },
            LoginStep { expect: "Password:".into(), send: "{password}\\r".into(), regex: false },
            LoginStep { expect: ">".into(), send: "enable\\r".into(), regex: false },
        ];
        let secrets = Secrets { username: "netops".into(), password: Some("hunter2".into()), enable: None };
        let task = tokio::spawn(run(steps, Duration::from_secs(5), tap_rx, tx, out, secrets));
        let collector = sent.clone();
        let device = tokio::spawn(async move {
            tap_tx.send(b"\r\nUsername: ".to_vec()).unwrap();
            for reply in [&b"\r\nPassword: "[..], &b"\r\nsw1>"[..]] {
                if let Some(Ctl::Write(b)) = ctl_rx.recv().await {
                    collector.lock().extend_from_slice(&b);
                }
                tap_tx.send(reply.to_vec()).unwrap();
            }
            if let Some(Ctl::Write(b)) = ctl_rx.recv().await {
                collector.lock().extend_from_slice(&b);
            }
        });
        task.await.unwrap();
        device.await.unwrap();
        assert_eq!(&*sent.lock(), b"netops\rhunter2\renable\r");
    }

    #[tokio::test]
    async fn missing_prompt_times_out_with_a_warning() {
        let warnings = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let w = warnings.clone();
        let out = Output::new(|_| {}, move |e| w.lock().push(e.message));
        let (_tap_tx, tap_rx) = mpsc::unbounded_channel();
        let (tx, _ctl_rx) = mpsc::unbounded_channel();
        let steps = vec![LoginStep { expect: "Password:".into(), send: "x\\r".into(), regex: false }];
        run(steps, Duration::from_secs(1), tap_rx, tx, out, Secrets::default()).await;
        let w = warnings.lock();
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("didn't appear within 1 s"), "{w:?}");
    }
}
