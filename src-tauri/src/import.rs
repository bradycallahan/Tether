//! Import an existing SecureCRT session library so switching costs nothing.
//!
//! SecureCRT stores each saved session as a plain-text `.ini` file inside its
//! `Config/Sessions` folder, with sub-folders mirroring the session tree.
//! Lines look like `S:"Hostname"=10.0.0.1` (string) or `D:"[SSH2] Port"=00000016`
//! (hex dword). We read only the connection basics; passwords are never
//! imported (SecureCRT encrypts them, and they belong in your OS keychain).

use crate::model::*;
use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub sessions: Vec<Session>,
    pub skipped: Vec<String>,
}

pub fn import_dir(root: &Path) -> Result<ImportReport> {
    let mut report = ImportReport::default();
    walk(root, root, &mut report)?;
    Ok(report)
}

fn walk(root: &Path, dir: &Path, report: &mut ImportReport) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, report)?;
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if !name.to_lowercase().ends_with(".ini") || name.starts_with("__") || name.eq_ignore_ascii_case("Default.ini") {
            continue;
        }
        let folder = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
            .unwrap_or_default();
        let session_name = name[..name.len() - 4].to_string();
        match fs::read(&path).map(|b| decode(&b)) {
            Ok(text) => match parse_session(&text, &session_name, &folder) {
                Some(s) => report.sessions.push(s),
                None => report.skipped.push(format!("{folder}/{session_name}: unsupported protocol")),
            },
            Err(e) => report.skipped.push(format!("{folder}/{session_name}: {e}")),
        }
    }
    Ok(())
}

/// Session files are usually UTF-8 (sometimes with a BOM) but older installs
/// may write UTF-16LE.
fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(b).into_owned()
}

enum Val {
    S(String),
    D(u32),
}

fn parse_values(text: &str) -> HashMap<String, Val> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((kind, rest)) = line.split_once(":\"") else { continue };
        let Some((key, value)) = rest.split_once("\"=") else { continue };
        let v = match kind {
            "S" => Val::S(value.to_string()),
            "D" => match u32::from_str_radix(value.trim(), 16) {
                Ok(n) => Val::D(n),
                Err(_) => continue,
            },
            _ => continue,
        };
        map.insert(key.to_lowercase(), v);
    }
    map
}

pub fn parse_session(text: &str, name: &str, folder: &str) -> Option<Session> {
    let v = parse_values(text);
    let s = |k: &str| match v.get(&k.to_lowercase()) {
        Some(Val::S(x)) => x.clone(),
        _ => String::new(),
    };
    let d = |k: &str| match v.get(&k.to_lowercase()) {
        Some(Val::D(x)) => Some(*x),
        _ => None,
    };
    let proto = s("Protocol Name").to_lowercase();
    let protocol = match proto.as_str() {
        "ssh2" | "ssh1" => {
            let key = s("Identity Filename V2");
            let key = key.split('*').next().unwrap_or("").trim().to_string();
            let use_key = !key.is_empty() && s("SSH2 Authentications V2").to_lowercase().starts_with("publickey");
            Protocol::Ssh {
                host: s("Hostname"),
                port: d("[SSH2] Port").or(d("[SSH1] Port")).unwrap_or(22) as u16,
                username: s("Username"),
                auth: if use_key { SshAuth::PublicKey { key_path: key } } else { SshAuth::Password },
                jump_session: None,
                legacy_algorithms: false,
                keepalive_secs: 30,
            }
        }
        "telnet" => Protocol::Telnet { host: s("Hostname"), port: d("Port").unwrap_or(23) as u16 },
        "raw" => Protocol::Raw { host: s("Hostname"), port: d("Port").unwrap_or(23) as u16 },
        "serial" => Protocol::Serial {
            port: s("Com Port"),
            baud: d("Baud Rate").unwrap_or(9600),
            data_bits: d("Data Bits").unwrap_or(8) as u8,
            parity: match d("Parity") {
                Some(1) => Parity::Odd,
                Some(2) => Parity::Even,
                _ => Parity::None,
            },
            stop_bits: if d("Stop Bits") == Some(2) { 2 } else { 1 },
            flow: if d("DTR Flow Control") == Some(1) || d("CTS Flow Control") == Some(1) {
                FlowControl::Hardware
            } else if d("XON Flow Control") == Some(1) {
                FlowControl::Software
            } else {
                FlowControl::None
            },
        },
        "local shell" => Protocol::Local { shell: String::new() },
        _ => return None,
    };
    if let Protocol::Ssh { host, .. } | Protocol::Telnet { host, .. } | Protocol::Raw { host, .. } = &protocol {
        if host.is_empty() {
            return None;
        }
    }
    let mut terminal = TerminalOptions::default();
    let log = s("Log Filename V2");
    if d("Start Log Upon Connect") == Some(1) && !log.is_empty() {
        terminal.log_enabled = true;
    }
    Some(Session {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        folder: folder.to_string(),
        protocol,
        terminal,
        notes: s("Description"),
        button_bar: None,
        login_script: String::new(),
        color_tag: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_session() {
        let text = "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=10.20.0.1\nD:\"[SSH2] Port\"=00000016\nS:\"Username\"=netadmin\n";
        let s = parse_session(text, "core-sw1", "BSU/Core").unwrap();
        assert_eq!(s.folder, "BSU/Core");
        match s.protocol {
            Protocol::Ssh { host, port, username, .. } => {
                assert_eq!((host.as_str(), port, username.as_str()), ("10.20.0.1", 22, "netadmin"))
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parses_serial_session() {
        let text = "S:\"Protocol Name\"=Serial\nS:\"Com Port\"=COM4\nD:\"Baud Rate\"=00002580\nD:\"Data Bits\"=00000008\nD:\"Parity\"=00000000\n";
        let s = parse_session(text, "console", "").unwrap();
        match s.protocol {
            Protocol::Serial { port, baud, parity, .. } => {
                assert_eq!(port, "COM4");
                assert_eq!(baud, 9600);
                assert_eq!(parity, Parity::None);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn skips_unsupported_and_reads_utf16() {
        assert!(parse_session("S:\"Protocol Name\"=TAPI\n", "x", "").is_none());
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("S:\"Hostname\"=h".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        assert_eq!(decode(&utf16), "S:\"Hostname\"=h");
    }
}
