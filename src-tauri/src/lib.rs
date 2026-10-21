//! Tether — an open-source terminal for SSH, Telnet, serial and local shells.

pub mod conn;
pub mod expect;
pub mod import;
pub mod local;
pub mod logger;
pub mod model;
pub mod secrets;
pub mod serial;
pub mod ssh;
pub mod store;
pub mod telnet;
pub mod window;

use conn::{CmdError, CmdResult, ConnHandle, Ctl, Manager, Output, StatusEvent};
use logger::{LogTarget, Logger};
use model::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use store::Store;
use tauri::ipc::Channel;
use tauri::{Manager as _, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::mpsc;

struct AppState {
    store: Store,
    manager: Manager,
    placement: window::Placement,
}

// ---------------------------------------------------------------------------
// Library: sessions, button bars, highlights, settings

#[tauri::command]
fn list_sessions(state: State<AppState>) -> CmdResult<Vec<Session>> {
    Ok(state.store.list_sessions()?)
}

#[tauri::command]
fn save_session(state: State<AppState>, session: Session) -> CmdResult<()> {
    Ok(state.store.save_session(&session)?)
}

#[tauri::command]
fn save_sessions(state: State<AppState>, sessions: Vec<Session>) -> CmdResult<()> {
    for s in &sessions {
        state.store.save_session(s)?;
    }
    Ok(())
}

#[tauri::command]
fn delete_session(state: State<AppState>, id: String) -> CmdResult<()> {
    state.store.delete_session(&id)?;
    for kind in SECRET_KINDS {
        let _ = secrets::delete(&id, kind);
    }
    Ok(())
}

#[tauri::command]
fn get_folders(state: State<AppState>) -> CmdResult<Vec<String>> {
    Ok(state.store.folders()?)
}

#[tauri::command]
fn save_folders(state: State<AppState>, folders: Vec<String>) -> CmdResult<()> {
    Ok(state.store.save_folders(&folders)?)
}

#[tauri::command]
fn get_workspace(state: State<AppState>) -> Workspace {
    state.store.workspace()
}

#[tauri::command]
fn save_workspace(state: State<AppState>, workspace: Workspace) -> CmdResult<()> {
    Ok(state.store.save_workspace(&workspace)?)
}

#[tauri::command]
fn get_button_bars(state: State<AppState>) -> CmdResult<Vec<ButtonBar>> {
    Ok(state.store.button_bars()?)
}

#[tauri::command]
fn save_button_bars(state: State<AppState>, bars: Vec<ButtonBar>) -> CmdResult<()> {
    Ok(state.store.save_button_bars(&bars)?)
}

#[tauri::command]
fn get_highlights(state: State<AppState>) -> CmdResult<Vec<HighlightSet>> {
    Ok(state.store.highlights()?)
}

#[tauri::command]
fn save_highlights(state: State<AppState>, sets: Vec<HighlightSet>) -> CmdResult<()> {
    Ok(state.store.save_highlights(&sets)?)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> CmdResult<Settings> {
    Ok(state.store.settings()?)
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> CmdResult<()> {
    Ok(state.store.save_settings(&settings)?)
}

const SECRET_KINDS: [&str; 3] = [secrets::PASSWORD, secrets::PASSPHRASE, secrets::ENABLE];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretStatus {
    password: bool,
    passphrase: bool,
    enable: bool,
}

#[tauri::command]
fn secret_status(id: String) -> SecretStatus {
    let has = |kind| secrets::get(&id, kind).ok().flatten().is_some();
    SecretStatus {
        password: has(secrets::PASSWORD),
        passphrase: has(secrets::PASSPHRASE),
        enable: has(secrets::ENABLE),
    }
}

/// Save (or, with an empty value, remove) one secret for a session.
#[tauri::command]
fn set_secret(id: String, kind: String, value: String) -> CmdResult<()> {
    let Some(kind) = SECRET_KINDS.into_iter().find(|k| *k == kind) else {
        return Err(CmdError::new("ARG", "Unknown kind of secret."));
    };
    let r = if value.is_empty() { secrets::delete(&id, kind) } else { secrets::set(&id, kind, &value) };
    r.map_err(|e| CmdError::new("KEYCHAIN", format!("The system keychain refused it: {e:#}")))
}

#[tauri::command]
fn forget_secrets(id: String) -> CmdResult<()> {
    for kind in SECRET_KINDS {
        secrets::delete(&id, kind)?;
    }
    Ok(())
}

#[tauri::command]
fn import_securecrt(path: String) -> CmdResult<import::ImportReport> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(CmdError::new("IMPORT", "Choose SecureCRT's Sessions folder (Config\\Sessions)."));
    }
    Ok(import::import_dir(&p)?)
}

#[tauri::command]
fn list_serial_ports() -> Vec<serial::PortInfo> {
    serial::list_ports()
}

#[tauri::command]
fn default_shell() -> String {
    local::default_shell()
}

#[tauri::command]
async fn list_shells() -> Vec<local::ShellInfo> {
    tokio::task::spawn_blocking(local::list_shells).await.unwrap_or_default()
}

#[tauri::command]
fn open_folder(app: tauri::AppHandle, state: State<AppState>, which: String) -> CmdResult<()> {
    let settings = state.store.settings()?;
    let path = match which.as_str() {
        "logs" => state.store.log_dir(&settings),
        "data" => state.store.root().to_path_buf(),
        _ => return Err(CmdError::new("ARG", "unknown folder")),
    };
    std::fs::create_dir_all(&path)?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| CmdError::new("OPEN", e.to_string()))
}

#[tauri::command]
fn data_dir(state: State<AppState>) -> String {
    state.store.root().to_string_lossy().into_owned()
}

/// The UI calls this once its first frame is ready, so the window never
/// appears blank or flashes white.
#[tauri::command]
fn window_ready(win: tauri::WebviewWindow, state: State<AppState>) {
    window::show(&win, &state.placement);
}

#[tauri::command]
fn set_title_bar_colors(win: tauri::WebviewWindow, caption: String, text: String) {
    window::set_title_bar_colors(&win, &caption, &text);
}

#[tauri::command]
fn trust_host_key(state: State<AppState>, host: String, port: u16, key: String, replace: bool) -> CmdResult<()> {
    Ok(ssh::trust(&state.store.known_hosts_path(), &host, port, &key, replace)?)
}

// ---------------------------------------------------------------------------
// Connections

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    conn_id: String,
    session: Session,
    cols: u16,
    rows: u16,
    password: Option<String>,
    passphrase: Option<String>,
    jump_password: Option<String>,
    /// Store the supplied password/passphrase in the OS keychain on success.
    remember: bool,
    /// Whether `session` is saved in the library (quick-connects aren't).
    saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectInfo {
    log_path: Option<String>,
}

fn host_label(p: &Protocol) -> String {
    match p {
        Protocol::Ssh { host, port, username, .. } => {
            let user = if username.is_empty() { String::new() } else { format!("{username}@") };
            if *port == 22 {
                format!("{user}{host}")
            } else {
                format!("{user}{host}:{port}")
            }
        }
        Protocol::Telnet { host, port } | Protocol::Raw { host, port } => format!("{host}:{port}"),
        Protocol::Serial { port, baud, .. } => format!("{port} @ {baud}"),
        Protocol::Local { shell } => {
            if shell.is_empty() {
                "local shell".into()
            } else {
                shell.clone()
            }
        }
    }
}

fn open_logger(store: &Store, session: &str, host: &str, t: &TerminalOptions) -> anyhow::Result<Logger> {
    let settings = store.settings()?;
    let dir = store.log_dir(&settings);
    Logger::open(LogTarget {
        dir: &dir,
        template: &t.log_template,
        session,
        host,
        timestamps: t.log_timestamps,
        strip_ansi: t.log_strip_ansi,
    })
}

fn ssh_target(id: &str, p: &Protocol, password: Option<String>, passphrase: Option<String>) -> CmdResult<ssh::Target> {
    let Protocol::Ssh { host, port, username, auth, legacy_algorithms, keepalive_secs, .. } = p else {
        return Err(CmdError::new("ARG", "Jump host must be an SSH session."));
    };
    Ok(ssh::Target {
        host: host.clone(),
        port: *port,
        username: username.clone(),
        auth: auth.clone(),
        legacy: *legacy_algorithms,
        keepalive_secs: *keepalive_secs,
        password: password.or_else(|| secrets::get(id, secrets::PASSWORD).ok().flatten()),
        passphrase: passphrase.or_else(|| secrets::get(id, secrets::PASSPHRASE).ok().flatten()),
    })
}

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    args: ConnectArgs,
    data: Channel<String>,
    status: Channel<StatusEvent>,
) -> CmdResult<ConnectInfo> {
    let s = &args.session;
    let out = Output::new(
        move |b: &[u8]| {
            // Base64 over the JSON path: the raw-bytes channel path can hold
            // back the last chunk when several channels are busy at once.
            use base64::Engine;
            let _ = data.send(base64::engine::general_purpose::STANDARD.encode(b));
        },
        move |e: StatusEvent| {
            let _ = status.send(e);
        },
    );
    let label = host_label(&s.protocol);

    let mut log_path = None;
    if s.terminal.log_enabled {
        match open_logger(&state.store, &s.name, &label, &s.terminal) {
            Ok(l) => {
                log_path = Some(l.path().to_string_lossy().into_owned());
                *out.logger.lock() = Some(l);
            }
            Err(e) => out.status("warning", format!("Logging is off: {e:#}")),
        }
    }

    // Install the login-action tap before the transport starts so the first
    // prompt can't slip past it.
    let steps = expect::effective_steps(s);
    let tap_rx = if steps.is_empty() {
        None
    } else {
        let (tap_tx, tap_rx) = mpsc::unbounded_channel();
        out.set_tap(Some(tap_tx));
        Some(tap_rx)
    };

    let (tx, rx) = mpsc::unbounded_channel();
    let term = s.terminal.term_type.clone();
    let result = match &s.protocol {
        Protocol::Ssh { jump_session, .. } => {
            let jump = match jump_session.as_deref().filter(|j| !j.is_empty()) {
                Some(jid) => {
                    let js = state
                        .store
                        .get_session(jid)
                        .map_err(|_| CmdError::new("JUMP", "The jump host session no longer exists."))?;
                    let mut t = ssh_target(&js.id, &js.protocol, args.jump_password.clone(), None)?;
                    if t.password.is_none() && matches!(t.auth, SshAuth::Password) {
                        return Err(CmdError::new("NEED_PASSWORD", format!("Password for jump host {}", js.name))
                            .with_detail(serde_json::json!({ "target": "jump" })));
                    }
                    t.keepalive_secs = t.keepalive_secs.max(15);
                    Some((js.id.clone(), t))
                }
                None => None,
            };
            let target = ssh_target(&s.id, &s.protocol, args.password.clone(), args.passphrase.clone())?;
            let used_saved_password = args.password.is_none() && target.password.is_some();
            let params = ssh::Params {
                target,
                jump: jump.as_ref().map(|(_, t)| t.clone()),
                term,
                cols: args.cols,
                rows: args.rows,
                known_hosts: state.store.known_hosts_path(),
            };
            let r = ssh::start(params, out.clone(), rx).await;
            if r.is_ok() && args.remember && args.saved {
                let mut results = Vec::new();
                if let Some(pw) = &args.password {
                    results.push(secrets::set(&s.id, secrets::PASSWORD, pw));
                }
                if let Some(pp) = &args.passphrase {
                    results.push(secrets::set(&s.id, secrets::PASSPHRASE, pp));
                }
                if let (Some((jid, _)), Some(jp)) = (&jump, &args.jump_password) {
                    results.push(secrets::set(jid, secrets::PASSWORD, jp));
                }
                if let Some(Err(e)) = results.into_iter().find(|r| r.is_err()) {
                    out.status("warning", format!("Couldn't save to the system keychain ({e:#}). Tether will remember it until this tab closes."));
                }
            }
            r.map_err(|mut e| {
                if e.code == "AUTH_FAILED" && used_saved_password {
                    e.detail = Some(serde_json::json!({ "usedSaved": true }));
                }
                e
            })
        }
        Protocol::Telnet { host, port } => {
            telnet::start(host.clone(), *port, true, term, args.cols, args.rows, out.clone(), rx).await
        }
        Protocol::Raw { host, port } => {
            telnet::start(host.clone(), *port, false, term, args.cols, args.rows, out.clone(), rx).await
        }
        Protocol::Serial { port, baud, data_bits, parity, stop_bits, flow } => {
            let p = serial::Params {
                port: port.clone(),
                baud: *baud,
                data_bits: *data_bits,
                parity: *parity,
                stop_bits: *stop_bits,
                flow: *flow,
            };
            serial::start(p, out.clone(), rx).await
        }
        Protocol::Local { shell } => local::start(shell.clone(), args.cols, args.rows, out.clone(), rx).await,
    };

    if let Err(e) = result {
        out.set_tap(None);
        out.status("error", e.message.clone());
        return Err(e);
    }
    if let Some(tap_rx) = tap_rx {
        let username = match &s.protocol {
            Protocol::Ssh { username, .. } => username.clone(),
            _ => s.login_username.clone(),
        };
        let creds = expect::Secrets {
            username,
            password: args.password.clone().or_else(|| secrets::get(&s.id, secrets::PASSWORD).ok().flatten()),
            enable: secrets::get(&s.id, secrets::ENABLE).ok().flatten(),
        };
        let timeout = std::time::Duration::from_secs(s.login_timeout_secs.clamp(1, 600) as u64);
        tokio::spawn(expect::run(steps, timeout, tap_rx, tx.clone(), out.clone(), creds));
    }
    state.manager.insert(
        args.conn_id,
        ConnHandle { tx, output: out, session_name: s.name.clone(), host_label: label, terminal: s.terminal.clone() },
    );
    Ok(ConnectInfo { log_path })
}

#[tauri::command]
fn write(state: State<AppState>, conn_id: String, data: String) -> bool {
    state.manager.send(&conn_id, Ctl::Write(data.into_bytes()))
}

#[tauri::command]
fn write_bytes(state: State<AppState>, conn_id: String, data: Vec<u8>) -> bool {
    state.manager.send(&conn_id, Ctl::Write(data))
}

#[tauri::command]
fn resize(state: State<AppState>, conn_id: String, cols: u16, rows: u16) -> bool {
    state.manager.send(&conn_id, Ctl::Resize(cols.max(1), rows.max(1)))
}

#[tauri::command]
fn send_break(state: State<AppState>, conn_id: String) -> bool {
    state.manager.send(&conn_id, Ctl::Break)
}

#[tauri::command]
fn disconnect(state: State<AppState>, conn_id: String) {
    state.manager.remove(&conn_id);
}

/// Turn logging on or off for a live tab. Returns the log file path when on.
#[tauri::command]
fn set_logging(state: State<AppState>, conn_id: String, enabled: bool) -> CmdResult<Option<String>> {
    let found = state.manager.with(&conn_id, |h| {
        if !enabled {
            *h.output.logger.lock() = None;
            return Ok(None);
        }
        if let Some(l) = h.output.logger.lock().as_ref() {
            return Ok(Some(l.path().to_string_lossy().into_owned()));
        }
        let l = open_logger(&state.store, &h.session_name, &h.host_label, &h.terminal)?;
        let path = l.path().to_string_lossy().into_owned();
        *h.output.logger.lock() = Some(l);
        Ok::<_, anyhow::Error>(Some(path))
    });
    match found {
        Some(r) => Ok(r?),
        None => Err(CmdError::new("NOT_CONNECTED", "That tab isn't connected.")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Store::locate().expect("could not open Tether's data directory");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { store, manager: Manager::default(), placement: window::Placement::default() })
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let state = app.state::<AppState>();
                window::restore(&win, &state.store, &state.placement);
                // If the UI never reports in (a script error, say), show the
                // window anyway rather than leave an invisible process.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    let state = win.state::<AppState>();
                    window::show(&win, &state.placement);
                });
            }
            Ok(())
        })
        .on_window_event(|win, event| {
            if let Some(webview) = win.app_handle().get_webview_window(win.label()) {
                let state = webview.state::<AppState>();
                window::on_event(&webview, event, &state.store, &state.placement);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            save_session,
            save_sessions,
            delete_session,
            get_button_bars,
            save_button_bars,
            get_highlights,
            save_highlights,
            get_settings,
            save_settings,
            get_folders,
            save_folders,
            get_workspace,
            save_workspace,
            secret_status,
            set_secret,
            forget_secrets,
            import_securecrt,
            list_serial_ports,
            default_shell,
            list_shells,
            open_folder,
            data_dir,
            window_ready,
            set_title_bar_colors,
            trust_host_key,
            connect,
            write,
            write_bytes,
            resize,
            send_break,
            disconnect,
            set_logging,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tether");
}
