//! The Files pane: SFTP over a tab's existing SSH connection, so browsing a
//! device's files never means logging in again. One SFTP session per
//! connection, opened on first use. Transfers run here rather than in the
//! webview; they report progress through a channel and can be cancelled.

use crate::conn::{CmdError, CmdResult};
use crate::ssh::{Link, SubsystemError};
use parking_lot::Mutex;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::File as RemoteFile;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BUF: usize = 256 * 1024;
const REPORT_EVERY: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// "dir", "file" or "other". A link reports what it points at.
    pub kind: &'static str,
    pub link: bool,
    pub size: u64,
    /// Seconds since the epoch, when the server says.
    pub modified: Option<u32>,
    /// "rwxr-xr-x", or empty when the server doesn't say.
    pub permissions: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    /// The file being transferred right now, for folder transfers.
    pub current: String,
}

struct Remote {
    link: Link,
    host: String,
    session: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
}

struct Upload {
    file: RemoteFile,
    path: String,
    session: Arc<SftpSession>,
}

type Stream = Arc<tokio::sync::Mutex<Upload>>;

#[derive(Default)]
pub struct Manager {
    remotes: Mutex<HashMap<String, Arc<Remote>>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Uploads fed chunk by chunk from the webview (files dropped on the pane).
    streams: Mutex<HashMap<String, Stream>>,
}

impl Manager {
    /// Make a connection's SFTP available. Replaces whatever a previous
    /// connection with the same id left behind (a reconnect).
    pub fn attach(&self, conn_id: &str, link: Link, host: &str) {
        let remote = Arc::new(Remote { link, host: host.to_string(), session: tokio::sync::Mutex::new(None) });
        self.remotes.lock().insert(conn_id.to_string(), remote);
    }

    pub fn detach(&self, conn_id: &str) {
        if let Some(r) = self.remotes.lock().remove(conn_id) {
            tokio::spawn(async move {
                if let Some(s) = r.session.lock().await.take() {
                    let _ = s.close().await;
                }
            });
        }
    }

    async fn session(&self, conn_id: &str) -> CmdResult<(Arc<SftpSession>, Arc<Remote>)> {
        let remote = self.remotes.lock().get(conn_id).cloned().ok_or_else(not_connected)?;
        if remote.link.is_closed() {
            return Err(not_connected());
        }
        let mut slot = remote.session.lock().await;
        if let Some(s) = slot.as_ref() {
            return Ok((s.clone(), remote.clone()));
        }
        let stream = remote.link.open_subsystem("sftp").await.map_err(|e| match e {
            SubsystemError::Refused => CmdError::new(
                "SFTP_REFUSED",
                format!(
                    "{} doesn't offer SFTP. Some network devices only support SCP, or need their SFTP server turned on.",
                    remote.host
                ),
            ),
            SubsystemError::Timeout => {
                CmdError::new("SFTP_REFUSED", format!("{} didn't answer the request to start SFTP.", remote.host))
            }
            SubsystemError::Channel(e) => {
                CmdError::new("SFTP", format!("Couldn't open a file channel to {}: {e}", remote.host))
            }
        })?;
        let session = SftpSession::new(stream)
            .await
            .map_err(|e| CmdError::new("SFTP", format!("{} started SFTP but then failed: {e}", remote.host)))?;
        session.set_timeout(30);
        let session = Arc::new(session);
        *slot = Some(session.clone());
        Ok((session, remote.clone()))
    }

    /// A dead session is dropped so the next request opens a fresh one.
    async fn forget_if_dead(&self, conn_id: &str, e: &SftpError) {
        if matches!(e, SftpError::IO(_) | SftpError::Timeout | SftpError::UnexpectedBehavior(_))
            || matches!(e, SftpError::Status(s) if matches!(s.status_code, StatusCode::NoConnection | StatusCode::ConnectionLost))
        {
            let remote = self.remotes.lock().get(conn_id).cloned();
            if let Some(r) = remote {
                r.session.lock().await.take();
            }
        }
    }

    async fn run<T>(
        &self,
        conn_id: &str,
        what: &str,
        f: impl AsyncFnOnce(&SftpSession) -> Result<T, SftpError>,
    ) -> CmdResult<T> {
        let (s, _) = self.session(conn_id).await?;
        match f(&s).await {
            Ok(v) => Ok(v),
            Err(e) => {
                self.forget_if_dead(conn_id, &e).await;
                Err(fail(what, &e))
            }
        }
    }

    /// Open SFTP if needed and return the home folder.
    pub async fn open(&self, conn_id: &str) -> CmdResult<String> {
        self.run(conn_id, "find your home folder", async |s| s.canonicalize(".").await).await
    }

    pub async fn list(&self, conn_id: &str, path: &str) -> CmdResult<Vec<Entry>> {
        let what = format!("open {path}");
        let (s, _) = self.session(conn_id).await?;
        let dir = match s.read_dir(path).await {
            Ok(d) => d,
            Err(e) => {
                self.forget_if_dead(conn_id, &e).await;
                return Err(fail(&what, &e));
            }
        };
        let mut out = Vec::new();
        for item in dir {
            let meta = item.metadata();
            let link = meta.is_symlink();
            // Follow links so a link to a folder opens like one.
            let target = if link { s.metadata(item.path()).await.ok() } else { None };
            out.push(entry(item.file_name(), target.as_ref().unwrap_or(&meta), link));
        }
        Ok(out)
    }

    pub async fn mkdir(&self, conn_id: &str, path: &str) -> CmdResult<()> {
        self.run(conn_id, &format!("create {path}"), async |s| s.create_dir(path).await).await
    }

    pub async fn rename(&self, conn_id: &str, from: &str, to: &str) -> CmdResult<()> {
        let (s, _) = self.session(conn_id).await?;
        if s.try_exists(to).await.unwrap_or(false) {
            return Err(CmdError::new("EXISTS", format!("{} already exists.", base_name(to))));
        }
        self.run(conn_id, &format!("rename {}", base_name(from)), async |s| s.rename(from, to).await).await
    }

    /// Delete a file, or a folder and everything in it.
    pub async fn remove(&self, conn_id: &str, path: &str) -> CmdResult<()> {
        let what = format!("delete {}", base_name(path));
        self.run(conn_id, &what, async |s| {
            let meta = s.symlink_metadata(path).await?;
            if !meta.is_dir() {
                return s.remove_file(path).await;
            }
            // Depth first: collect folders on the way down, remove them on the way back.
            let mut stack = vec![path.to_string()];
            let mut dirs = Vec::new();
            while let Some(dir) = stack.pop() {
                for item in s.read_dir(dir.as_str()).await? {
                    if item.metadata().is_dir() {
                        stack.push(item.path());
                    } else {
                        s.remove_file(item.path()).await?;
                    }
                }
                dirs.push(dir);
            }
            for dir in dirs.into_iter().rev() {
                s.remove_dir(dir).await?;
            }
            Ok(())
        })
        .await
    }

    fn cancel_flag(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().insert(id.to_string(), flag.clone());
        flag
    }

    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.cancels.lock().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }

    /// Download a file or folder to `local` (the full destination path).
    pub async fn download(
        &self,
        conn_id: &str,
        id: &str,
        remote: &str,
        local: &Path,
        overwrite: bool,
        report: impl Fn(Progress),
    ) -> CmdResult<Summary> {
        let cancel = self.cancel_flag(id);
        let r = self.download_inner(conn_id, remote, local, overwrite, &cancel, &report).await;
        self.cancels.lock().remove(id);
        r
    }

    async fn download_inner(
        &self,
        conn_id: &str,
        remote: &str,
        local: &Path,
        overwrite: bool,
        cancel: &AtomicBool,
        report: &impl Fn(Progress),
    ) -> CmdResult<Summary> {
        let (s, _) = self.session(conn_id).await?;
        let name = base_name(remote);
        let sftp = |e: SftpError| fail(&format!("download {name}"), &e);
        let meta = s.metadata(remote).await.map_err(sftp)?;
        if !overwrite && local.exists() {
            return Err(exists(local));
        }
        // Plan the whole transfer first so progress has a real total.
        let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
        let mut summary = Summary::default();
        if meta.is_dir() {
            let mut stack = vec![(remote.to_string(), local.to_path_buf())];
            while let Some((rdir, ldir)) = stack.pop() {
                std::fs::create_dir_all(&ldir).map_err(|e| local_fail("create", &ldir, e))?;
                for item in s.read_dir(rdir.as_str()).await.map_err(sftp)? {
                    let Some(safe) = local_name(&item.file_name()) else {
                        summary.skipped.push(item.path());
                        continue;
                    };
                    let m = item.metadata();
                    if m.is_dir() {
                        stack.push((item.path(), ldir.join(safe)));
                    } else if m.is_regular() {
                        files.push((item.path(), ldir.join(safe), m.size.unwrap_or(0)));
                    } else {
                        summary.skipped.push(item.path());
                    }
                }
            }
        } else {
            files.push((remote.to_string(), local.to_path_buf(), meta.size.unwrap_or(0)));
        }

        let mut meter = Meter::new(files.iter().map(|f| f.2).sum(), report);
        for (rpath, lpath, _) in files {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            meter.current = base_name(&rpath).to_string();
            let part = part_path(&lpath);
            let r = copy_down(&s, &rpath, &part, cancel, &mut meter).await;
            if let Err(e) = r {
                let _ = std::fs::remove_file(&part);
                if let Copy::Remote(e) = &e {
                    self.forget_if_dead(conn_id, e).await;
                }
                return Err(e.into_cmd(&format!("download {}", base_name(&rpath)), &lpath));
            }
            std::fs::rename(&part, &lpath).map_err(|e| local_fail("save", &lpath, e))?;
            summary.files += 1;
        }
        meter.finish();
        Ok(summary)
    }

    /// Upload a local file or folder into the remote folder `remote_dir`.
    pub async fn upload(
        &self,
        conn_id: &str,
        id: &str,
        local: &Path,
        remote_dir: &str,
        overwrite: bool,
        report: impl Fn(Progress),
    ) -> CmdResult<Summary> {
        let cancel = self.cancel_flag(id);
        let r = self.upload_inner(conn_id, local, remote_dir, overwrite, &cancel, &report).await;
        self.cancels.lock().remove(id);
        r
    }

    async fn upload_inner(
        &self,
        conn_id: &str,
        local: &Path,
        remote_dir: &str,
        overwrite: bool,
        cancel: &AtomicBool,
        report: &impl Fn(Progress),
    ) -> CmdResult<Summary> {
        let (s, _) = self.session(conn_id).await?;
        let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let target = join(remote_dir, &name);
        let sftp = |e: SftpError| fail(&format!("upload {name}"), &e);
        let meta = std::fs::metadata(local).map_err(|e| local_fail("read", local, e))?;
        if !overwrite && s.try_exists(target.as_str()).await.map_err(sftp)? {
            return Err(CmdError::new("EXISTS", format!("{name} already exists in {remote_dir}."))
                .with_detail(json!({ "path": target })));
        }
        let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
        let mut dirs: Vec<String> = Vec::new();
        let mut summary = Summary::default();
        if meta.is_dir() {
            let mut stack = vec![(local.to_path_buf(), target.clone())];
            while let Some((ldir, rdir)) = stack.pop() {
                dirs.push(rdir.clone());
                let read = std::fs::read_dir(&ldir).map_err(|e| local_fail("read", &ldir, e))?;
                for item in read.flatten() {
                    let n = item.file_name().to_string_lossy().into_owned();
                    match item.file_type() {
                        Ok(t) if t.is_dir() => stack.push((item.path(), join(&rdir, &n))),
                        Ok(t) if t.is_file() => {
                            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
                            files.push((item.path(), join(&rdir, &n), size));
                        }
                        // Links and devices are left behind rather than guessed at.
                        _ => summary.skipped.push(item.path().to_string_lossy().into_owned()),
                    }
                }
            }
        } else {
            files.push((local.to_path_buf(), target.clone(), meta.len()));
        }

        for dir in dirs {
            if !s.try_exists(dir.as_str()).await.map_err(sftp)? {
                s.create_dir(dir.as_str()).await.map_err(sftp)?;
            }
        }
        let mut meter = Meter::new(files.iter().map(|f| f.2).sum(), report);
        for (lpath, rpath, _) in files {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            meter.current = base_name(&rpath).to_string();
            if let Err(e) = copy_up(&s, &lpath, &rpath, cancel, &mut meter).await {
                // Don't leave half a file behind on the device.
                let _ = s.remove_file(remote_part(&rpath).as_str()).await;
                if let Copy::Remote(e) = &e {
                    self.forget_if_dead(conn_id, e).await;
                }
                return Err(e.into_cmd(&format!("upload {}", base_name(&rpath)), &lpath));
            }
            summary.files += 1;
        }
        meter.finish();
        Ok(summary)
    }

    /// Start an upload whose bytes come from the webview (a dropped file).
    pub async fn stream_begin(&self, conn_id: &str, id: &str, path: &str, overwrite: bool) -> CmdResult<()> {
        let name = base_name(path).to_string();
        let (s, _) = self.session(conn_id).await?;
        let sftp = |e: SftpError| fail(&format!("upload {name}"), &e);
        if !overwrite && s.try_exists(path).await.map_err(sftp)? {
            return Err(CmdError::new("EXISTS", format!("{name} already exists.")).with_detail(json!({ "path": path })));
        }
        let parent = parent(path);
        if !parent.is_empty() && !s.try_exists(parent.as_str()).await.map_err(sftp)? {
            mkdir_all(&s, &parent).await.map_err(sftp)?;
        }
        let file = s.create(remote_part(path).as_str()).await.map_err(sftp)?;
        let upload = Upload { file, path: path.to_string(), session: s };
        self.streams.lock().insert(id.to_string(), Arc::new(tokio::sync::Mutex::new(upload)));
        Ok(())
    }

    pub async fn stream_chunk(&self, id: &str, bytes: &[u8]) -> CmdResult<()> {
        let stream = self.streams.lock().get(id).cloned().ok_or_else(cancelled)?;
        let mut up = stream.lock().await;
        if let Err(e) = up.file.write_all(bytes).await {
            let path = up.path.clone();
            drop(up);
            self.stream_end(id, false).await?;
            return Err(CmdError::new("SFTP", format!("Couldn't upload {}: {e}", base_name(&path))));
        }
        Ok(())
    }

    /// Finish a streamed upload, or (`ok` false) abandon it and remove the partial file.
    pub async fn stream_end(&self, id: &str, ok: bool) -> CmdResult<()> {
        let Some(stream) = self.streams.lock().remove(id) else { return Ok(()) };
        let mut up = stream.lock().await;
        let part = remote_part(&up.path);
        let r = match up.file.shutdown().await {
            Ok(()) if ok => put_in_place(&up.session, &part, &up.path)
                .await
                .map_err(|e| fail(&format!("upload {}", base_name(&up.path)), &e)),
            Ok(()) => Ok(()),
            Err(e) => Err(CmdError::new("SFTP", format!("Couldn't finish the upload: {e}"))),
        };
        if !ok || r.is_err() {
            let _ = up.session.remove_file(part.as_str()).await;
        }
        r
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files: u32,
    /// Items left out: links, devices, names this computer can't use.
    pub skipped: Vec<String>,
}

struct Meter<'a, F: Fn(Progress)> {
    done: u64,
    total: u64,
    current: String,
    last: Instant,
    report: &'a F,
}

impl<'a, F: Fn(Progress)> Meter<'a, F> {
    fn new(total: u64, report: &'a F) -> Self {
        Self { done: 0, total, current: String::new(), last: Instant::now() - REPORT_EVERY, report }
    }
    fn add(&mut self, n: usize) {
        self.done += n as u64;
        if self.last.elapsed() >= REPORT_EVERY {
            self.last = Instant::now();
            self.send();
        }
    }
    fn send(&self) {
        (self.report)(Progress { done: self.done, total: self.total.max(self.done), current: self.current.clone() });
    }
    fn finish(&mut self) {
        self.send();
    }
}

enum Copy {
    Remote(SftpError),
    Local(std::io::Error),
    Cancelled,
}

impl Copy {
    fn into_cmd(self, what: &str, local: &Path) -> CmdError {
        match self {
            Copy::Remote(e) => fail(what, &e),
            Copy::Local(e) => local_fail("write", local, e),
            Copy::Cancelled => cancelled(),
        }
    }
}

async fn copy_down<F: Fn(Progress)>(
    s: &SftpSession,
    remote: &str,
    part: &Path,
    cancel: &AtomicBool,
    meter: &mut Meter<'_, F>,
) -> Result<(), Copy> {
    let mut src = s.open(remote).await.map_err(Copy::Remote)?;
    let mut dst = tokio::fs::File::create(part).await.map_err(Copy::Local)?;
    let mut buf = vec![0u8; BUF];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Copy::Cancelled);
        }
        let n = src.read(&mut buf).await.map_err(|e| Copy::Remote(SftpError::IO(e.to_string())))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(Copy::Local)?;
        meter.add(n);
    }
    dst.flush().await.map_err(Copy::Local)?;
    Ok(())
}

async fn copy_up<F: Fn(Progress)>(
    s: &SftpSession,
    local: &Path,
    remote: &str,
    cancel: &AtomicBool,
    meter: &mut Meter<'_, F>,
) -> Result<(), Copy> {
    let mut src = tokio::fs::File::open(local).await.map_err(Copy::Local)?;
    // Written under a temporary name so a dropped connection can't leave a truncated file
    // that looks complete; renamed into place once the device has acknowledged every byte.
    let part = remote_part(remote);
    let mut dst = s.create(part.as_str()).await.map_err(Copy::Remote)?;
    let mut buf = vec![0u8; BUF];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Copy::Cancelled);
        }
        let n = src.read(&mut buf).await.map_err(Copy::Local)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| Copy::Remote(SftpError::IO(e.to_string())))?;
        meter.add(n);
    }
    // Waits for the device to acknowledge every write.
    dst.shutdown().await.map_err(|e| Copy::Remote(SftpError::IO(e.to_string())))?;
    put_in_place(s, &part, remote).await.map_err(Copy::Remote)
}

/// Rename a finished upload over its target. SFTP v3 rename refuses to replace an existing
/// file, and only reaches here once the user agreed to replace it, so the old one goes first.
async fn put_in_place(s: &SftpSession, part: &str, target: &str) -> Result<(), SftpError> {
    if s.try_exists(target).await? {
        s.remove_file(target).await?;
    }
    s.rename(part, target).await
}

async fn mkdir_all(s: &SftpSession, path: &str) -> Result<(), SftpError> {
    let mut built = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            if built.is_empty() {
                built.push('/');
            }
            continue;
        }
        built = join(&built, part);
        if !s.try_exists(built.as_str()).await? {
            s.create_dir(built.as_str()).await?;
        }
    }
    Ok(())
}

fn entry(name: String, meta: &FileAttributes, link: bool) -> Entry {
    let kind = if meta.is_dir() {
        "dir"
    } else if meta.is_regular() {
        "file"
    } else {
        "other"
    };
    Entry {
        name,
        kind,
        link,
        size: meta.size.unwrap_or(0),
        modified: meta.mtime,
        permissions: meta.permissions.map(permissions).unwrap_or_default(),
    }
}

/// "rwxr-x---" from a mode.
pub fn permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

/// Remote paths always use `/`.
pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent(path: &str) -> String {
    if path == "/" {
        return "/".into();
    }
    match path.trim_end_matches('/').rfind('/') {
        Some(0) => "/".into(),
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

pub fn base_name(path: &str) -> &str {
    let p = path.trim_end_matches('/');
    p.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(path)
}

/// A remote name made safe to create on this computer, or None when it could
/// climb out of the destination folder (a hostile server's "../x" or "a/b").
pub fn local_name(name: &str) -> Option<String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return None;
    }
    // Characters Windows can't put in a name; harmless to replace everywhere.
    let mut safe: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || c < ' ' { '_' } else { c })
        .collect();
    // Windows also refuses trailing dots and spaces.
    while safe.ends_with(['.', ' ']) {
        safe.pop();
    }
    if safe.is_empty() {
        return None;
    }
    let stem = safe.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        safe.insert(0, '_');
    }
    Some(safe)
}

fn remote_part(path: &str) -> String {
    format!("{path}.part")
}

fn part_path(p: &Path) -> PathBuf {
    let mut name = p.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    p.with_file_name(name)
}

fn not_connected() -> CmdError {
    CmdError::new("NOT_CONNECTED", "This tab isn't connected. Reconnect to browse its files.")
}

fn cancelled() -> CmdError {
    CmdError::new("CANCELLED", "Cancelled.")
}

fn exists(local: &Path) -> CmdError {
    CmdError::new("EXISTS", format!("{} already exists.", local.display()))
        .with_detail(json!({ "path": local.to_string_lossy() }))
}

fn local_fail(verb: &str, path: &Path, e: std::io::Error) -> CmdError {
    let why = match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        std::io::ErrorKind::NotFound => "it doesn't exist".to_string(),
        std::io::ErrorKind::StorageFull => "the disk is full".to_string(),
        _ => e.to_string(),
    };
    CmdError::new("LOCAL", format!("Couldn't {verb} {}: {why}.", path.display()))
}

/// An SFTP failure in plain words: "Couldn't open /etc/x: permission denied."
fn fail(what: &str, e: &SftpError) -> CmdError {
    let (code, why) = match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => ("NOT_FOUND", "it doesn't exist".to_string()),
            StatusCode::PermissionDenied => ("DENIED", "permission denied".to_string()),
            StatusCode::OpUnsupported => ("SFTP", "the device doesn't support that".to_string()),
            StatusCode::NoConnection | StatusCode::ConnectionLost => ("SFTP", "the connection dropped".to_string()),
            // OpenSSH sends a bare "Failure" for things like an existing folder.
            _ if s.error_message.is_empty() || s.error_message.eq_ignore_ascii_case("failure") => {
                ("SFTP", "the device refused".to_string())
            }
            _ => ("SFTP", s.error_message.trim_end_matches('.').to_string()),
        },
        SftpError::Timeout => ("SFTP", "the device stopped answering".to_string()),
        SftpError::IO(m) => ("SFTP", format!("the connection failed ({m})")),
        other => ("SFTP", other.to_string()),
    };
    CmdError::new(code, format!("Couldn't {what}: {why}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/admin", "a.txt"), "/home/admin/a.txt");
        assert_eq!(join("flash:", "x"), "flash:/x");
        assert_eq!(parent("/home/admin/a.txt"), "/home/admin");
        assert_eq!(parent("/etc"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("a"), "");
        assert_eq!(base_name("/home/admin/"), "admin");
        assert_eq!(base_name("/"), "/");
        assert_eq!(base_name("x.bin"), "x.bin");
    }

    #[test]
    fn modes() {
        assert_eq!(permissions(0o100644), "rw-r--r--");
        assert_eq!(permissions(0o40755), "rwxr-xr-x");
        assert_eq!(permissions(0o600), "rw-------");
    }

    #[test]
    fn hostile_names_cant_escape() {
        for bad in ["..", ".", "", "../x", "a/b", "a\\b", "x\0y", "..."] {
            assert_eq!(local_name(bad), None, "{bad:?}");
        }
        assert_eq!(local_name("cat9k.bin").as_deref(), Some("cat9k.bin"));
        assert_eq!(local_name("show tech: 10/20?").as_deref(), None);
        assert_eq!(local_name("run: 10-20?.txt").as_deref(), Some("run_ 10-20_.txt"));
        assert_eq!(local_name("con.txt").as_deref(), Some("_con.txt"));
        assert_eq!(local_name("COM1").as_deref(), Some("_COM1"));
        assert_eq!(local_name("console.log").as_deref(), Some("console.log"));
        assert_eq!(local_name("notes. ").as_deref(), Some("notes"));
    }

    #[test]
    fn part_files_sit_beside_the_target() {
        assert_eq!(part_path(Path::new("/tmp/a.bin")), PathBuf::from("/tmp/a.bin.part"));
    }
}
