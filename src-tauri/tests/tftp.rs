//! The TFTP server end to end over loopback UDP, with a small client written
//! here so every packet is under the test's control.

use parking_lot::Mutex;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tether_lib::tftp::{self, code, encode, parse, Direction, Mode, Packet, Transfer, TransferState};
use tokio::net::UdpSocket;

struct Fixture {
    root: PathBuf,
    server: Option<tftp::Server>,
    addr: SocketAddr,
    events: Arc<Mutex<Vec<Transfer>>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    async fn new(name: &str, overwrite: bool, allowed: Option<Vec<String>>) -> Self {
        let root = std::env::temp_dir().join(format!("tether-tftp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let cfg = tftp::Config {
            root: root.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            allow_overwrite: overwrite,
            allowed: allowed.map(|list| Arc::new(move || list.clone()) as tftp::AllowList),
        };
        let server = tftp::start(cfg, Arc::new(move |t: &Transfer| sink_events.lock().push(t.clone()))).await.unwrap();
        let addr = server.local_addr();
        Self { root, server: Some(server), addr, events }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// The final event for each transfer, once it has one.
    async fn finished(&self, count: usize) -> Vec<Transfer> {
        for _ in 0..200 {
            let done: Vec<_> =
                self.events.lock().iter().filter(|t| t.state != TransferState::Active).cloned().collect();
            if done.len() >= count {
                return done;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("transfers didn't finish: {:?}", self.events.lock());
    }
}

#[derive(Debug, PartialEq)]
enum ClientError {
    Tftp(u16, String),
    Timeout,
}

struct Client {
    sock: UdpSocket,
    server: SocketAddr,
    peer: Option<SocketAddr>,
}

impl Client {
    async fn new(server: SocketAddr) -> Self {
        Self { sock: UdpSocket::bind("127.0.0.1:0").await.unwrap(), server, peer: None }
    }

    async fn recv(&mut self) -> Result<Packet, ClientError> {
        let mut buf = vec![0u8; 70000];
        let (n, from) = tokio::time::timeout(Duration::from_secs(5), self.sock.recv_from(&mut buf))
            .await
            .map_err(|_| ClientError::Timeout)?
            .unwrap();
        assert_ne!(from, self.server, "replies come from a transfer port, not the listening one");
        if let Some(p) = self.peer {
            assert_eq!(p, from, "the transfer id stays the same");
        }
        self.peer = Some(from);
        match parse(&buf[..n]).unwrap() {
            Packet::Error { code, message } => Err(ClientError::Tftp(code, message)),
            p => Ok(p),
        }
    }

    async fn send(&self, p: &Packet) {
        let to = self.peer.unwrap_or(self.server);
        self.sock.send_to(&encode(p), to).await.unwrap();
    }

    async fn get(
        &mut self,
        file: &str,
        mode: Mode,
        options: &[(&str, &str)],
    ) -> Result<(Vec<u8>, Vec<(String, String)>), ClientError> {
        let options: Vec<_> = options.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let blksize = options.iter().find(|(k, _)| k == "blksize").map(|(_, v)| v.parse().unwrap()).unwrap_or(512);
        self.send(&Packet::Rrq { file: file.into(), mode, options: options.clone() }).await;
        let mut out = Vec::new();
        let mut oack = Vec::new();
        let mut expect: u16 = 1;
        loop {
            match self.recv().await? {
                Packet::Oack { options } => {
                    oack = options;
                    self.send(&Packet::Ack { block: 0 }).await;
                }
                Packet::Data { block, data } => {
                    assert_eq!(block, expect);
                    out.extend_from_slice(&data);
                    self.send(&Packet::Ack { block }).await;
                    if data.len() < blksize {
                        return Ok((out, oack));
                    }
                    expect = expect.wrapping_add(1);
                }
                p => panic!("unexpected {p:?}"),
            }
        }
    }

    async fn put(&mut self, file: &str, data: &[u8], options: &[(&str, &str)]) -> Result<(), ClientError> {
        let options: Vec<_> = options.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let blksize: usize =
            options.iter().find(|(k, _)| k == "blksize").map(|(_, v)| v.parse().unwrap()).unwrap_or(512);
        self.send(&Packet::Wrq { file: file.into(), mode: Mode::Octet, options: options.clone() }).await;
        match self.recv().await? {
            Packet::Ack { block: 0 } if options.is_empty() => {}
            Packet::Oack { .. } if !options.is_empty() => {}
            p => panic!("unexpected {p:?}"),
        }
        let mut block: u16 = 1;
        for chunk in data.chunks(blksize).chain(if data.len().is_multiple_of(blksize) { Some(&[][..]) } else { None }) {
            self.send(&Packet::Data { block, data: chunk.to_vec() }).await;
            match self.recv().await? {
                Packet::Ack { block: b } => assert_eq!(b, block),
                p => panic!("unexpected {p:?}"),
            }
            block = block.wrapping_add(1);
        }
        Ok(())
    }
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 251) as u8).collect()
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tftp-part"))
        .collect()
}

#[tokio::test]
async fn download_classic_and_with_options() {
    let f = Fixture::new("get", false, None).await;
    // Exactly two blocks: the device needs an empty third block to know it's over.
    let data = pattern(1024);
    std::fs::create_dir_all(f.path("images")).unwrap();
    std::fs::write(f.path("images/ios.bin"), &data).unwrap();

    let (got, oack) = Client::new(f.addr).await.get("images/ios.bin", Mode::Octet, &[]).await.unwrap();
    assert_eq!(got, data);
    assert!(oack.is_empty());

    let (got, oack) = Client::new(f.addr)
        .await
        .get("/images/ios.bin", Mode::Octet, &[("blksize", "1468"), ("tsize", "0")])
        .await
        .unwrap();
    assert_eq!(got, data);
    assert_eq!(oack, vec![("blksize".into(), "1468".into()), ("tsize".into(), "1024".into())]);

    let done = f.finished(2).await;
    assert!(done.iter().all(|t| t.state == TransferState::Done && t.bytes == 1024 && t.direction == Direction::Send));
    assert_eq!(done[1].total, Some(1024));
}

#[tokio::test]
async fn download_netascii() {
    let f = Fixture::new("ascii", false, None).await;
    let text: &[u8] = if cfg!(windows) { b"hostname sw1\r\n!\r\nend\r\n" } else { b"hostname sw1\n!\nend\n" };
    std::fs::write(f.path("base.cfg"), text).unwrap();
    let (got, _) = Client::new(f.addr).await.get("base.cfg", Mode::Netascii, &[]).await.unwrap();
    assert_eq!(got, b"hostname sw1\r\n!\r\nend\r\n");
}

#[tokio::test]
async fn block_numbers_wrap_on_big_files() {
    let f = Fixture::new("wrap", false, None).await;
    // 65,537 blocks of 8 bytes crosses block 65535 without a 32 MB file.
    let data = pattern(8 * 65_537 + 3);
    std::fs::write(f.path("big.bin"), &data).unwrap();
    let (got, _) = Client::new(f.addr).await.get("big.bin", Mode::Octet, &[("blksize", "8")]).await.unwrap();
    assert_eq!(got.len(), data.len());
    assert_eq!(got, data);

    let mut c = Client::new(f.addr).await;
    c.put("big-copy.bin", &data, &[("blksize", "8")]).await.unwrap();
    f.finished(2).await;
    assert_eq!(std::fs::read(f.path("big-copy.bin")).unwrap(), data);
}

#[tokio::test]
async fn upload_saves_the_file_and_never_overwrites_by_default() {
    let f = Fixture::new("put", false, None).await;
    let data = pattern(3000);
    Client::new(f.addr).await.put("backups/sw1-confg", &data, &[("tsize", "3000"), ("blksize", "1024")]).await.unwrap();
    let done = f.finished(1).await;
    assert_eq!(done[0].state, TransferState::Done);
    assert_eq!(done[0].direction, Direction::Receive);
    assert_eq!(done[0].total, Some(3000));
    assert_eq!(std::fs::read(f.path("backups/sw1-confg")).unwrap(), data);
    assert!(leftovers(&f.path("backups")).is_empty());

    let err = Client::new(f.addr).await.put("backups/sw1-confg", b"new", &[]).await.unwrap_err();
    assert_eq!(err, ClientError::Tftp(code::EXISTS, "File already exists".into()));
    assert_eq!(std::fs::read(f.path("backups/sw1-confg")).unwrap(), data, "the original is untouched");
    assert_eq!(f.finished(2).await[1].state, TransferState::Refused);
}

#[tokio::test]
async fn upload_can_overwrite_when_allowed() {
    let f = Fixture::new("overwrite", true, None).await;
    std::fs::write(f.path("sw1-confg"), b"old").unwrap();
    Client::new(f.addr).await.put("sw1-confg", b"new config", &[]).await.unwrap();
    f.finished(1).await;
    assert_eq!(std::fs::read(f.path("sw1-confg")).unwrap(), b"new config");
}

#[tokio::test]
async fn bad_requests_are_refused() {
    let f = Fixture::new("refuse", false, None).await;
    let get =
        |name: &'static str| async move { Client::new(f.addr).await.get(name, Mode::Octet, &[]).await.unwrap_err() };
    assert!(matches!(get("missing.bin").await, ClientError::Tftp(code::NOT_FOUND, _)));
    assert!(matches!(get("../escape").await, ClientError::Tftp(code::ACCESS, _)));
    assert!(matches!(get("C:\\Windows\\win.ini").await, ClientError::Tftp(code::ACCESS, _)));
    // An unsupported mode is answered straight from the listening port.
    let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sock.send_to(b"\x00\x01f\x00mail\x00", f.addr).await.unwrap();
    let mut buf = [0u8; 600];
    let (n, _) = tokio::time::timeout(Duration::from_secs(2), sock.recv_from(&mut buf)).await.unwrap().unwrap();
    assert!(matches!(parse(&buf[..n]).unwrap(), Packet::Error { code: code::ILLEGAL, .. }));
}

#[tokio::test]
async fn only_open_tabs_when_asked() {
    let f = Fixture::new("allow", false, Some(vec!["10.9.9.9".into()])).await;
    std::fs::write(f.path("a.bin"), b"x").unwrap();
    let err = Client::new(f.addr).await.get("a.bin", Mode::Octet, &[]).await.unwrap_err();
    assert!(matches!(err, ClientError::Tftp(code::ACCESS, _)));
    let done = f.finished(1).await;
    assert_eq!(done[0].state, TransferState::Refused);
    assert_eq!(done[0].peer, "127.0.0.1");

    let f = Fixture::new("allow-host", false, Some(vec!["localhost".into(), "10.9.9.9".into()])).await;
    std::fs::write(f.path("a.bin"), b"x").unwrap();
    assert_eq!(Client::new(f.addr).await.get("a.bin", Mode::Octet, &[]).await.unwrap().0, b"x");
}

#[tokio::test]
async fn a_stranger_cant_join_a_transfer() {
    let f = Fixture::new("tid", false, None).await;
    let data = pattern(2000);
    std::fs::write(f.path("a.bin"), &data).unwrap();
    let mut c = Client::new(f.addr).await;
    c.send(&Packet::Rrq { file: "a.bin".into(), mode: Mode::Octet, options: vec![] }).await;
    let Packet::Data { block: 1, .. } = c.recv().await.unwrap() else { panic!() };
    let stranger = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    stranger.send_to(&encode(&Packet::Ack { block: 1 }), c.peer.unwrap()).await.unwrap();
    let mut buf = [0u8; 600];
    let (n, _) = tokio::time::timeout(Duration::from_secs(2), stranger.recv_from(&mut buf)).await.unwrap().unwrap();
    assert!(matches!(parse(&buf[..n]).unwrap(), Packet::Error { code: code::UNKNOWN_TID, .. }));
    // The real device carries on.
    c.send(&Packet::Ack { block: 1 }).await;
    let Packet::Data { block: 2, .. } = c.recv().await.unwrap() else { panic!() };
}

#[tokio::test]
async fn lost_acks_are_retransmitted_and_duplicates_ignored() {
    let f = Fixture::new("retry", false, None).await;
    std::fs::write(f.path("a.bin"), pattern(700)).unwrap();
    let mut c = Client::new(f.addr).await;
    c.send(&Packet::Rrq { file: "a.bin".into(), mode: Mode::Octet, options: vec![("timeout".into(), "1".into())] })
        .await;
    let Packet::Oack { .. } = c.recv().await.unwrap() else { panic!() };
    c.send(&Packet::Ack { block: 0 }).await;
    let Packet::Data { block: 1, .. } = c.recv().await.unwrap() else { panic!() };
    // Say nothing: block 1 comes again after the timeout.
    let Packet::Data { block: 1, .. } = c.recv().await.unwrap() else { panic!() };
    c.send(&Packet::Ack { block: 1 }).await;
    c.send(&Packet::Ack { block: 1 }).await;
    let Packet::Data { block: 2, data } = c.recv().await.unwrap() else { panic!() };
    assert_eq!(data.len(), 188);
    c.send(&Packet::Ack { block: 2 }).await;
    assert_eq!(f.finished(1).await[0].state, TransferState::Done);
}

#[tokio::test]
async fn an_abandoned_upload_leaves_nothing_behind() {
    let f = Fixture::new("abandon", false, None).await;
    let mut c = Client::new(f.addr).await;
    c.send(&Packet::Wrq { file: "half.bin".into(), mode: Mode::Octet, options: vec![("timeout".into(), "1".into())] })
        .await;
    let Packet::Oack { .. } = c.recv().await.unwrap() else { panic!() };
    c.send(&Packet::Data { block: 1, data: pattern(512) }).await;
    let Packet::Ack { block: 1 } = c.recv().await.unwrap() else { panic!() };
    c.send(&Packet::Error { code: 0, message: "Aborted by user".into() }).await;
    let done = f.finished(1).await;
    assert_eq!(done[0].state, TransferState::Failed);
    assert_eq!(done[0].error.as_deref(), Some("The device cancelled: Aborted by user"));
    assert!(!f.path("half.bin").exists());
    assert!(leftovers(&f.root).is_empty());
}

#[tokio::test]
async fn stopping_the_server_cancels_transfers() {
    let mut f = Fixture::new("stop", false, None).await;
    std::fs::write(f.path("a.bin"), pattern(5000)).unwrap();
    let mut c = Client::new(f.addr).await;
    c.send(&Packet::Rrq { file: "a.bin".into(), mode: Mode::Octet, options: vec![] }).await;
    let Packet::Data { block: 1, .. } = c.recv().await.unwrap() else { panic!() };
    f.server.take();
    assert_eq!(c.recv().await.unwrap_err(), ClientError::Tftp(0, "TFTP server stopped".into()));
    assert_eq!(f.finished(1).await[0].state, TransferState::Failed);
    // And the port is free again.
    UdpSocket::bind(f.addr).await.unwrap();
}
