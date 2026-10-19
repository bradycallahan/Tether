//! End-to-end transport tests.
//!
//! The raw-TCP test always runs (it starts its own echo server). The SSH
//! tests need a real server and are ignored unless you opt in:
//!
//!   TETHER_TEST_SSH=127.0.0.1:2222 TETHER_TEST_USER=tethertest \
//!   TETHER_TEST_PASS=... TETHER_TEST_KEY=/path/id TETHER_TEST_KEYPASS=... \
//!   cargo test -- --ignored

use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;
use tether_lib::conn::{CmdError, Ctl, Output, StatusEvent};
use tether_lib::model::SshAuth;
use tether_lib::{ssh, telnet};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

#[derive(Clone, Default)]
struct Captured {
    data: Arc<Mutex<Vec<u8>>>,
    status: Arc<Mutex<Vec<StatusEvent>>>,
}

impl Captured {
    fn output(&self) -> Output {
        let d = self.data.clone();
        let s = self.status.clone();
        Output::new(move |b: &[u8]| d.lock().extend_from_slice(b), move |e| s.lock().push(e))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.data.lock()).into_owned()
    }
    async fn wait_for(&self, needle: &str) -> bool {
        for _ in 0..100 {
            if self.text().contains(needle) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }
}

#[tokio::test]
async fn raw_tcp_round_trip() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        sock.write_all(b"switch> ").await.unwrap();
        let mut buf = [0u8; 64];
        let n = sock.read(&mut buf).await.unwrap();
        sock.write_all(format!("echo:{}", String::from_utf8_lossy(&buf[..n])).as_bytes()).await.unwrap();
    });
    let cap = Captured::default();
    let (tx, rx) = mpsc::unbounded_channel();
    telnet::start("127.0.0.1".into(), port, false, "xterm".into(), 80, 24, cap.output(), rx).await.unwrap();
    assert!(cap.wait_for("switch> ").await);
    tx.send(Ctl::Write(b"show ver".to_vec())).unwrap();
    assert!(cap.wait_for("echo:show ver").await, "got {:?}", cap.text());
    assert!(cap.status.lock().iter().any(|s| s.state == "connected"));
}

#[tokio::test]
async fn refused_connection_reports_cleanly() {
    let cap = Captured::default();
    let (_tx, rx) = mpsc::unbounded_channel();
    let err = telnet::start("127.0.0.1".into(), 1, true, "xterm".into(), 80, 24, cap.output(), rx).await.unwrap_err();
    assert_eq!(err.code, "CONNECT");
}

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"))
}

fn target(auth: SshAuth, password: Option<String>, passphrase: Option<String>) -> ssh::Target {
    let addr = env("TETHER_TEST_SSH");
    let (host, port) = addr.rsplit_once(':').unwrap();
    ssh::Target {
        host: host.into(),
        port: port.parse().unwrap(),
        username: env("TETHER_TEST_USER"),
        auth,
        legacy: false,
        keepalive_secs: 0,
        password,
        passphrase,
    }
}

async fn run(t: ssh::Target, known_hosts: &std::path::Path) -> Result<(Captured, mpsc::UnboundedSender<Ctl>), CmdError> {
    let cap = Captured::default();
    let (tx, rx) = mpsc::unbounded_channel();
    let params = ssh::Params { target: t, jump: None, term: "xterm-256color".into(), cols: 100, rows: 30, known_hosts: known_hosts.to_path_buf() };
    ssh::start(params, cap.output(), rx).await?;
    Ok((cap, tx))
}

fn temp_known_hosts() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("tether-kh-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
#[ignore]
async fn ssh_host_key_then_password_then_shell() {
    let kh = temp_known_hosts();
    let pass = Some(env("TETHER_TEST_PASS"));

    // First contact: unknown host key must be refused with details.
    let err = run(target(SshAuth::Password, pass.clone(), None), &kh).await.err().expect("must ask about host key");
    assert_eq!(err.code, "HOSTKEY_UNKNOWN");
    let detail = err.detail.unwrap();
    let (host, port, key) = (detail["host"].as_str().unwrap(), detail["port"].as_u64().unwrap() as u16, detail["key"].as_str().unwrap());
    assert!(detail["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
    ssh::trust(&kh, host, port, key, false).unwrap();

    // Wrong password is reported as an auth failure, not a crash.
    let err = run(target(SshAuth::Password, Some("nope".into()), None), &kh).await.err().unwrap();
    assert_eq!(err.code, "AUTH_FAILED");

    // Missing password asks for one.
    let err = run(target(SshAuth::Password, None, None), &kh).await.err().unwrap();
    assert_eq!(err.code, "NEED_PASSWORD");

    // Right password gets a working, resizable shell.
    let (cap, tx) = run(target(SshAuth::Password, pass, None), &kh).await.unwrap();
    tx.send(Ctl::Resize(132, 40)).unwrap();
    tx.send(Ctl::Write(b"stty size; echo tether-$((6*7))\n".to_vec())).unwrap();
    assert!(cap.wait_for("tether-42").await, "shell output: {:?}", cap.text());
    assert!(cap.text().contains("40 132"), "resize not applied: {:?}", cap.text());
    tx.send(Ctl::Write(b"exit\n".to_vec())).unwrap();
    for _ in 0..60 {
        if cap.status.lock().iter().any(|s| s.state == "closed") { break }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(cap.status.lock().iter().any(|s| s.state == "closed"));
}

#[tokio::test]
#[ignore]
async fn ssh_encrypted_key() {
    let kh = temp_known_hosts();
    let auth = SshAuth::PublicKey { key_path: env("TETHER_TEST_KEY") };
    let first = run(target(auth.clone(), None, None), &kh).await.err().unwrap();
    let d = first.detail.unwrap();
    ssh::trust(&kh, d["host"].as_str().unwrap(), d["port"].as_u64().unwrap() as u16, d["key"].as_str().unwrap(), false).unwrap();

    let err = run(target(auth.clone(), None, None), &kh).await.err().unwrap();
    assert_eq!(err.code, "NEED_PASSPHRASE");

    let (cap, tx) = run(target(auth, None, Some(env("TETHER_TEST_KEYPASS"))), &kh).await.unwrap();
    tx.send(Ctl::Write(b"echo key-ok\n".to_vec())).unwrap();
    assert!(cap.wait_for("key-ok").await);
}

#[tokio::test]
#[ignore]
async fn ssh_changed_host_key_is_blocked() {
    let kh = temp_known_hosts();
    let addr = env("TETHER_TEST_SSH");
    let (host, port) = addr.rsplit_once(':').unwrap();
    // Record a bogus key for this host.
    let bogus = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    ssh::trust(&kh, host, port.parse().unwrap(), bogus, false).unwrap();
    let err = run(target(SshAuth::Password, Some(env("TETHER_TEST_PASS")), None), &kh).await.err().unwrap();
    assert_eq!(err.code, "HOSTKEY_CHANGED");
}

#[tokio::test]
#[ignore]
async fn ssh_many_tiny_writes_arrive_in_order() {
    let kh = temp_known_hosts();
    let pass = Some(env("TETHER_TEST_PASS"));
    let first = run(target(SshAuth::Password, pass.clone(), None), &kh).await.err().unwrap();
    let d = first.detail.unwrap();
    ssh::trust(&kh, d["host"].as_str().unwrap(), d["port"].as_u64().unwrap() as u16, d["key"].as_str().unwrap(), false).unwrap();
    let (a, ta) = run(target(SshAuth::Password, pass.clone(), None), &kh).await.unwrap();
    let (b, tb) = run(target(SshAuth::Password, pass, None), &kh).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    for round in 0..5 {
        for c in format!("echo order-{round}-ok\r").bytes() {
            ta.send(Ctl::Write(vec![c])).unwrap();
            tb.send(Ctl::Write(vec![c])).unwrap();
        }
        assert!(a.wait_for(&format!("\norder-{round}-ok")).await || a.wait_for(&format!("order-{round}-ok\r\n$")).await, "a round {round}: {:?}", a.text());
        assert!(b.wait_for(&format!("order-{round}-ok\r\n$")).await, "b round {round}: {:?}", b.text());
    }
}
