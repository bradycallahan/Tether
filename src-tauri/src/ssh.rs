//! SSH transport built on russh. Supports password, keyboard-interactive
//! (what most Cisco/Aruba/Juniper gear asks for), public keys, jump hosts,
//! an opt-in legacy algorithm set for old devices, and strict host-key
//! checking against Tether's own OpenSSH-format known_hosts file.

use crate::conn::{CmdError, CmdResult, Ctl, Output};
use crate::model::SshAuth;
use crate::store::expand_home;
use parking_lot::Mutex;
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{cipher, kex, mac, ChannelMsg, Preferred};
use serde_json::json;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub legacy: bool,
    pub keepalive_secs: u32,
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

pub struct Params {
    pub target: Target,
    pub jump: Option<Target>,
    pub term: String,
    pub cols: u16,
    pub rows: u16,
    pub known_hosts: PathBuf,
}

#[derive(Debug, Clone)]
enum HostKeyIssue {
    Unknown { fingerprint: String, key: String, algorithm: String },
    Changed { fingerprint: String, key: String, line: usize },
}

struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    issue: Arc<Mutex<Option<HostKeyIssue>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // We never advertise certificate host-key algorithms.
            PublicKeyOrCertificate::Certificate(_) => return Ok(false),
        };
        let fingerprint = key.fingerprint(keys::HashAlg::Sha256).to_string();
        let openssh = key.to_openssh().unwrap_or_default();
        match keys::check_known_hosts_path(&self.host, self.port, &key, &self.known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                *self.issue.lock() =
                    Some(HostKeyIssue::Unknown { fingerprint, key: openssh, algorithm: key.algorithm().to_string() });
                Ok(false)
            }
            Err(keys::Error::KeyChanged { line }) => {
                *self.issue.lock() = Some(HostKeyIssue::Changed { fingerprint, key: openssh, line });
                Ok(false)
            }
            Err(e) => {
                log::warn!("known_hosts check failed: {e}");
                Ok(false)
            }
        }
    }
}

fn config(t: &Target) -> Arc<client::Config> {
    let mut cfg = client::Config {
        keepalive_interval: (t.keepalive_secs > 0).then(|| Duration::from_secs(t.keepalive_secs as u64)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    };
    if t.legacy {
        let mut kexes: Vec<kex::Name> = Preferred::DEFAULT.kex.to_vec();
        // Insert the old ones before the extension markers.
        let pos = kexes.iter().position(|k| *k == kex::EXTENSION_SUPPORT_AS_CLIENT).unwrap_or(kexes.len());
        for k in [kex::DH_GEX_SHA1, kex::DH_G14_SHA1, kex::DH_G1_SHA1].into_iter().rev() {
            kexes.insert(pos, k);
        }
        let mut ciphers: Vec<cipher::Name> = Preferred::DEFAULT.cipher.to_vec();
        ciphers.extend([cipher::AES_256_CBC, cipher::AES_192_CBC, cipher::AES_128_CBC, cipher::TRIPLE_DES_CBC]);
        let mut macs: Vec<mac::Name> = Preferred::DEFAULT.mac.to_vec();
        macs.extend([mac::HMAC_SHA1, mac::HMAC_SHA1_ETM]);
        cfg.preferred = Preferred {
            kex: Cow::Owned(kexes),
            cipher: Cow::Owned(ciphers),
            mac: Cow::Owned(macs),
            ..Preferred::DEFAULT
        };
    }
    Arc::new(cfg)
}

fn host_key_error(issue: Option<HostKeyIssue>, host: &str, port: u16, fallback: russh::Error) -> CmdError {
    match issue {
        Some(HostKeyIssue::Unknown { fingerprint, key, algorithm }) => CmdError::new(
            "HOSTKEY_UNKNOWN",
            format!("{host} presented a host key Tether hasn't seen before."),
        )
        .with_detail(json!({ "host": host, "port": port, "fingerprint": fingerprint, "key": key, "algorithm": algorithm })),
        Some(HostKeyIssue::Changed { fingerprint, key, line }) => CmdError::new(
            "HOSTKEY_CHANGED",
            format!("The host key for {host} does not match the one on record (known_hosts line {line}). This can mean the device was replaced — or that someone is intercepting the connection."),
        )
        .with_detail(json!({ "host": host, "port": port, "fingerprint": fingerprint, "key": key, "line": line })),
        None => {
            let io = if let russh::Error::IO(e) = &fallback { Some(e) } else { None };
            crate::conn::connect_error(host, port, io, &fallback)
        }
    }
}

async fn open_handle<S>(t: &Target, known_hosts: &Path, stream: Option<S>) -> CmdResult<Handle<Client>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let issue = Arc::new(Mutex::new(None));
    let handler =
        Client { host: t.host.clone(), port: t.port, known_hosts: known_hosts.to_path_buf(), issue: issue.clone() };
    let cfg = config(t);
    let result = match stream {
        Some(s) => client::connect_stream(cfg, s, handler).await,
        None => {
            let addr = (t.host.as_str(), t.port);
            match tokio::time::timeout(Duration::from_secs(15), client::connect(cfg, addr, handler)).await {
                Ok(r) => r,
                Err(_) => {
                    return Err(CmdError::new(
                        "TIMEOUT",
                        format!("{}:{} did not answer within 15 seconds.", t.host, t.port),
                    ))
                }
            }
        }
    };
    let mut handle = result.map_err(|e| {
        let i = issue.lock().clone();
        host_key_error(i, &t.host, t.port, e)
    })?;
    authenticate(&mut handle, t).await?;
    Ok(handle)
}

async fn authenticate(h: &mut Handle<Client>, t: &Target) -> CmdResult<()> {
    let user = if t.username.is_empty() {
        return Err(CmdError::new("NEED_USERNAME", "This session has no username."));
    } else {
        t.username.clone()
    };
    let ssh_err = |e: russh::Error| CmdError::new("AUTH", format!("Authentication error: {e}"));
    match &t.auth {
        SshAuth::PublicKey { key_path } => {
            let path = expand_home(key_path);
            let key = match keys::load_secret_key(&path, t.passphrase.as_deref()) {
                Ok(k) => k,
                Err(keys::Error::KeyIsEncrypted) => {
                    return Err(CmdError::new(
                        "NEED_PASSPHRASE",
                        format!("{} is protected by a passphrase.", path.display()),
                    ))
                }
                Err(e) if t.passphrase.is_some() => {
                    return Err(CmdError::new("NEED_PASSPHRASE", format!("Could not unlock {}: {e}", path.display())))
                }
                Err(e) => return Err(CmdError::new("KEY", format!("Could not read {}: {e}", path.display()))),
            };
            let hash = h.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
            let res = h
                .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(ssh_err)?;
            if res.success() {
                return Ok(());
            }
            // Fall through to password if the server allows it and we have one.
            if t.password.is_none() {
                return Err(CmdError::new("AUTH_FAILED", format!("{} rejected the key for {user}.", t.host)));
            }
        }
        SshAuth::Password => {}
    }

    let Some(password) = t.password.clone() else {
        return Err(CmdError::new("NEED_PASSWORD", format!("Password for {user}@{}", t.host)));
    };
    if h.authenticate_password(&user, &password).await.map_err(ssh_err)?.success() {
        return Ok(());
    }
    // Many network devices only offer keyboard-interactive.
    let mut resp = h.authenticate_keyboard_interactive_start(&user, None::<String>).await.map_err(ssh_err)?;
    for _ in 0..6 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => break,
            KeyboardInteractiveAuthResponse::InfoRequest { ref prompts, .. } => {
                let answers = prompts
                    .iter()
                    .map(|p| {
                        let q = p.prompt.to_lowercase();
                        if p.echo && (q.contains("user") || q.contains("login")) {
                            user.clone()
                        } else {
                            password.clone()
                        }
                    })
                    .collect();
                resp = h.authenticate_keyboard_interactive_respond(answers).await.map_err(ssh_err)?;
            }
        }
    }
    Err(CmdError::new("AUTH_FAILED", format!("{} rejected the password for {user}.", t.host)))
}

/// A live, authenticated SSH connection that more channels can be opened on
/// (the Files pane's SFTP subsystem), without logging in again.
#[derive(Clone)]
pub struct Link(Arc<Handle<Client>>);

impl Link {
    /// Open the `sftp` subsystem and wait for the server's answer, so a device
    /// without SFTP is reported as such instead of as a protocol error later.
    pub async fn open_subsystem(&self, name: &str) -> Result<russh::ChannelStream<client::Msg>, SubsystemError> {
        let mut ch = self.0.channel_open_session().await.map_err(SubsystemError::Channel)?;
        ch.request_subsystem(true, name).await.map_err(SubsystemError::Channel)?;
        let answer = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match ch.wait().await {
                    Some(ChannelMsg::Success) => return Ok(()),
                    Some(ChannelMsg::Failure) | Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                        return Err(SubsystemError::Refused)
                    }
                    Some(_) => {}
                }
            }
        })
        .await
        .unwrap_or(Err(SubsystemError::Timeout));
        answer.map(|_| ch.into_stream())
    }

    pub fn is_closed(&self) -> bool {
        self.0.is_closed()
    }
}

#[derive(Debug)]
pub enum SubsystemError {
    Channel(russh::Error),
    Refused,
    Timeout,
}

/// Connect, authenticate and start the shell. Returns once the shell is up;
/// I/O then continues on background tasks until `Ctl::Close` or EOF.
pub async fn start(p: Params, out: Output, mut rx: mpsc::UnboundedReceiver<Ctl>) -> CmdResult<Link> {
    let (jump_handle, handle) = match &p.jump {
        Some(j) => {
            out.status("connecting", format!("Connecting to jump host {}…", j.host));
            let jh = open_handle::<tokio::net::TcpStream>(j, &p.known_hosts, None).await?;
            out.status("connecting", format!("Tunneling to {}:{}…", p.target.host, p.target.port));
            let ch = jh
                .channel_open_direct_tcpip(p.target.host.clone(), p.target.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| CmdError::new("JUMP", format!("Jump host could not reach {}: {e}", p.target.host)))?;
            let h = open_handle(&p.target, &p.known_hosts, Some(ch.into_stream())).await?;
            (Some(jh), h)
        }
        None => {
            out.status("connecting", format!("Connecting to {}:{}…", p.target.host, p.target.port));
            (None, open_handle::<tokio::net::TcpStream>(&p.target, &p.known_hosts, None).await?)
        }
    };

    let chan_err = |e: russh::Error| CmdError::new("CHANNEL", format!("Could not open a shell: {e}"));
    let channel = handle.channel_open_session().await.map_err(chan_err)?;
    channel.request_pty(false, &p.term, p.cols as u32, p.rows as u32, 0, 0, &[]).await.map_err(chan_err)?;
    channel.request_shell(true).await.map_err(chan_err)?;
    let (mut read, write) = channel.split();
    let handle = Arc::new(handle);
    let link = Link(handle.clone());

    let reader_out = out.clone();
    tokio::spawn(async move {
        let mut exit: Option<u32> = None;
        while let Some(msg) = read.wait().await {
            match msg {
                ChannelMsg::Data { data } => reader_out.data(&data),
                ChannelMsg::ExtendedData { data, .. } => reader_out.data(&data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let msg = match exit {
            Some(code) => format!("Session ended (exit status {code})."),
            None => "Connection closed by remote host.".into(),
        };
        reader_out.status("closed", msg);
    });

    tokio::spawn(async move {
        let _jump = jump_handle; // keep the tunnel alive for the life of the session
        while let Some(ctl) = rx.recv().await {
            let r = match ctl {
                Ctl::Write(bytes) => write.data_bytes(bytes).await,
                Ctl::Resize(c, r) => write.window_change(c as u32, r as u32, 0, 0).await,
                Ctl::Break => Ok(()), // RFC 4335 break isn't exposed by russh yet
                Ctl::Close => break,
            };
            if r.is_err() {
                break;
            }
        }
        let _ = write.close().await;
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    });

    out.status("connected", format!("Connected to {}", p.target.host));
    Ok(link)
}

/// Record a host key the user chose to trust.
pub fn trust(known_hosts: &Path, host: &str, port: u16, key_openssh: &str, replace: bool) -> anyhow::Result<()> {
    let key = keys::ssh_key::PublicKey::from_openssh(key_openssh)?;
    if replace {
        remove_host(known_hosts, host, port)?;
    }
    keys::known_hosts::learn_known_hosts_path(host, port, &key, known_hosts)?;
    Ok(())
}

/// Drop every plain-text known_hosts entry for host:port (used when the user
/// accepts a changed key). Hashed entries we didn't write are left alone.
fn remove_host(known_hosts: &Path, host: &str, port: u16) -> anyhow::Result<()> {
    let Ok(text) = std::fs::read_to_string(known_hosts) else { return Ok(()) };
    let pattern = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            let hosts = line.split_whitespace().next().unwrap_or("");
            !hosts.split(',').any(|h| h == pattern)
        })
        .collect();
    std::fs::write(known_hosts, kept.join("\n") + "\n")?;
    Ok(())
}
