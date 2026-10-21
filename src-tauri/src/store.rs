//! On-disk storage. One TOML file per session plus a few small config files,
//! all human-editable and safe to keep in Git (passwords never land here).
//!
//! Layout (under the data directory):
//!   settings.toml
//!   button_bars.toml
//!   highlights.toml
//!   folders.toml         (folders, including empty ones)
//!   workspace.toml       (tabs open at last exit, recent sessions)
//!   window.toml          (main window size and position)
//!   known_hosts          (OpenSSH format)
//!   sessions/<slug>-<id8>.toml
//!   logs/

use crate::model::*;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Store {
    root: PathBuf,
}

#[derive(Serialize, Deserialize, Default)]
struct BarsFile {
    #[serde(default, rename = "bar")]
    bars: Vec<ButtonBar>,
}

#[derive(Serialize, Deserialize, Default)]
struct FoldersFile {
    #[serde(default)]
    folders: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct HighlightsFile {
    #[serde(default, rename = "set")]
    sets: Vec<HighlightSet>,
}

impl Store {
    /// Portable mode: if a file named `tether.portable` sits next to the
    /// executable, keep everything in `./data` beside it. Otherwise use the
    /// platform config directory. `TETHER_HOME` overrides both.
    pub fn locate() -> Result<Self> {
        if let Ok(home) = std::env::var("TETHER_HOME") {
            return Self::open(PathBuf::from(home));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                if dir.join("tether.portable").exists() {
                    return Self::open(dir.join("data"));
                }
            }
        }
        let base = dirs::config_dir().context("no config directory on this system")?;
        Self::open(base.join("Tether"))
    }

    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("sessions"))?;
        fs::create_dir_all(root.join("logs"))?;
        let store = Self { root };
        store.seed_defaults()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn known_hosts_path(&self) -> PathBuf {
        self.root.join("known_hosts")
    }

    pub fn log_dir(&self, settings: &Settings) -> PathBuf {
        if settings.log_directory.trim().is_empty() {
            self.root.join("logs")
        } else {
            expand_home(&settings.log_directory)
        }
    }

    fn seed_defaults(&self) -> Result<()> {
        if !self.root.join("button_bars.toml").exists() {
            self.save_button_bars(&default_button_bars())?;
        }
        if !self.root.join("highlights.toml").exists() {
            self.save_highlights(&default_highlights())?;
        }
        if !self.root.join("settings.toml").exists() {
            self.save_settings(&Settings::default())?;
        }
        Ok(())
    }

    // -- sessions -----------------------------------------------------------

    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(self.root.join("sessions"))? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            match fs::read_to_string(&path)
                .map_err(anyhow::Error::from)
                .and_then(|t| toml::from_str::<Session>(&t).map_err(anyhow::Error::from))
            {
                Ok(s) => out.push(s),
                Err(e) => log::warn!("skipping unreadable session {}: {e}", path.display()),
            }
        }
        out.sort_by(|a, b| {
            (a.folder.to_lowercase(), a.name.to_lowercase()).cmp(&(b.folder.to_lowercase(), b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        let path = self.find_session_file(id)?.context("session not found")?;
        Ok(toml::from_str(&fs::read_to_string(path)?)?)
    }

    pub fn save_session(&self, session: &Session) -> Result<()> {
        // Remove an older file for the same id (the name may have changed).
        if let Some(old) = self.find_session_file(&session.id)? {
            fs::remove_file(old)?;
        }
        let path = self.root.join("sessions").join(session_file_name(session));
        atomic_write(&path, &toml::to_string_pretty(session)?)
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        if let Some(path) = self.find_session_file(id)? {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    fn find_session_file(&self, id: &str) -> Result<Option<PathBuf>> {
        let suffix = format!("-{}.toml", short_id(id));
        for entry in fs::read_dir(self.root.join("sessions"))? {
            let path = entry?.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name.ends_with(&suffix) {
                // Confirm the full id, in case of an 8-char prefix collision.
                if let Ok(s) = toml::from_str::<Session>(&fs::read_to_string(&path)?) {
                    if s.id == id {
                        return Ok(Some(path));
                    }
                }
            }
        }
        Ok(None)
    }

    // -- button bars / highlights / settings -----------------------------

    pub fn button_bars(&self) -> Result<Vec<ButtonBar>> {
        Ok(read_toml::<BarsFile>(&self.root.join("button_bars.toml"))?.bars)
    }

    pub fn save_button_bars(&self, bars: &[ButtonBar]) -> Result<()> {
        let file = BarsFile { bars: bars.to_vec() };
        atomic_write(&self.root.join("button_bars.toml"), &toml::to_string_pretty(&file)?)
    }

    pub fn highlights(&self) -> Result<Vec<HighlightSet>> {
        Ok(read_toml::<HighlightsFile>(&self.root.join("highlights.toml"))?.sets)
    }

    pub fn save_highlights(&self, sets: &[HighlightSet]) -> Result<()> {
        let file = HighlightsFile { sets: sets.to_vec() };
        atomic_write(&self.root.join("highlights.toml"), &toml::to_string_pretty(&file)?)
    }

    pub fn settings(&self) -> Result<Settings> {
        read_toml(&self.root.join("settings.toml"))
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        atomic_write(&self.root.join("settings.toml"), &toml::to_string_pretty(s)?)
    }

    /// Folders the user created explicitly. Folders that only exist because
    /// a session lives in them aren't listed here.
    pub fn folders(&self) -> Result<Vec<String>> {
        Ok(read_toml::<FoldersFile>(&self.root.join("folders.toml"))?.folders)
    }

    pub fn save_folders(&self, folders: &[String]) -> Result<()> {
        let mut folders = folders.to_vec();
        folders.sort_by_key(|f| f.to_lowercase());
        folders.dedup();
        atomic_write(&self.root.join("folders.toml"), &toml::to_string_pretty(&FoldersFile { folders })?)
    }

    /// A damaged workspace file shouldn't stop the app from starting.
    pub fn workspace(&self) -> Workspace {
        read_toml(&self.root.join("workspace.toml")).unwrap_or_else(|e| {
            log::warn!("ignoring workspace.toml: {e:#}");
            Workspace::default()
        })
    }

    pub fn save_workspace(&self, w: &Workspace) -> Result<()> {
        atomic_write(&self.root.join("workspace.toml"), &toml::to_string_pretty(w)?)
    }

    pub fn window_placement(&self) -> Option<WindowPlacement> {
        let path = self.root.join("window.toml");
        if !path.exists() {
            return None;
        }
        read_toml(&path).map_err(|e| log::warn!("ignoring window.toml: {e:#}")).ok()
    }

    pub fn save_window_placement(&self, p: &WindowPlacement) -> Result<()> {
        atomic_write(&self.root.join("window.toml"), &toml::to_string_pretty(p)?)
    }
}

fn read_toml<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let text = fs::read_to_string(path)?;
    toml::from_str(&text).with_context(|| format!("could not parse {}", path.display()))
}

/// Write to a temp file then rename, so a crash never leaves half a file.
pub(crate) fn atomic_write(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn short_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect()
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() {
        "session".into()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn session_file_name(s: &Session) -> String {
    format!("{}-{}.toml", slug(&s.name), short_id(&s.id))
}

pub fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

pub fn default_button_bars() -> Vec<ButtonBar> {
    let b = |label: &str, send: &str| Button { label: label.into(), send: send.into(), color: None };
    vec![
        ButtonBar {
            name: "Cisco basics".into(),
            buttons: vec![
                b("term len 0", "terminal length 0\\r"),
                b("sh run", "show running-config\\r"),
                b("int brief", "show ip interface brief\\r"),
                b("int status", "show interfaces status\\r"),
                b("vlan brief", "show vlan brief\\r"),
                b("cdp nei", "show cdp neighbors\\r"),
                b("lldp nei", "show lldp neighbors\\r"),
                b("mac table", "show mac address-table\\r"),
                b("log", "show logging | last 50\\r"),
                b("wr mem", "copy running-config startup-config\\r\\p\\r"),
            ],
        },
        ButtonBar {
            name: "Linux".into(),
            buttons: vec![
                b("ip a", "ip -br addr\\r"),
                b("routes", "ip route\\r"),
                b("listening", "ss -tulpn\\r"),
                b("disk", "df -h\\r"),
                b("journal", "journalctl -n 50 --no-pager\\r"),
            ],
        },
    ]
}

pub fn default_highlights() -> Vec<HighlightSet> {
    let r = |pattern: &str, fg: &str| HighlightRule {
        pattern: pattern.into(),
        regex: true,
        case_sensitive: false,
        foreground: Some(fg.into()),
        background: None,
    };
    vec![HighlightSet {
        name: "Network gear".into(),
        rules: vec![
            r(
                r"\b(err-?disabled|down|notconnect|failed|failure|error|denied|invalid|%\s?[A-Z_]+-[0-3]-\w+)\b",
                "#ef7d6b",
            ),
            r(r"\b(up|connected|established|full|forwarding|success(ful)?)\b", "#8fd18a"),
            r(r"\b(warning|blocking|listening|learning|disabled|shutdown|administratively)\b", "#f2c25c"),
            r(r"\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b", "#8cc4ec"),
            r(r"\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b|\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b", "#c9a6f0"),
            r(r"\b(?:Gi|Te|Fa|Fo|Hu|Twe|Eth?|Po|Vl|Lo|Tu)\d+(?:/\d+)*(?:\.\d+)?\b", "#7fd3cf"),
        ],
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("tether-test-{}", uuid::Uuid::new_v4()));
        Store::open(dir).unwrap()
    }

    fn sample(name: &str) -> Session {
        Session {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            folder: "Lab".into(),
            protocol: Protocol::Telnet { host: "10.1.1.1".into(), port: 2003 },
            terminal: Default::default(),
            notes: String::new(),
            button_bar: None,
            login_script: String::new(),
            color_tag: None,
            login_steps: Vec::new(),
            login_timeout_secs: 15,
            auto_reconnect: false,
            anti_idle_secs: 0,
            anti_idle_send: String::new(),
            login_username: String::new(),
        }
    }

    #[test]
    fn save_rename_and_delete() {
        let store = temp_store();
        let mut s = sample("Access SW 1");
        store.save_session(&s).unwrap();
        assert_eq!(store.list_sessions().unwrap().len(), 1);
        s.name = "Access SW 01".into();
        store.save_session(&s).unwrap();
        let all = store.list_sessions().unwrap();
        assert_eq!(all.len(), 1, "rename must not leave the old file behind");
        assert_eq!(all[0].name, "Access SW 01");
        store.delete_session(&s.id).unwrap();
        assert!(store.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn defaults_are_seeded() {
        let store = temp_store();
        assert!(!store.button_bars().unwrap().is_empty());
        assert!(!store.highlights().unwrap().is_empty());
        assert_eq!(store.settings().unwrap(), Settings::default());
    }

    #[test]
    fn folders_and_workspace_persist() {
        let store = temp_store();
        assert!(store.folders().unwrap().is_empty());
        store.save_folders(&["Lab".into(), "Campus/Core".into(), "Lab".into()]).unwrap();
        assert_eq!(store.folders().unwrap(), vec!["Campus/Core".to_string(), "Lab".to_string()]);

        assert_eq!(store.workspace(), Workspace::default());
        let w = Workspace { recent: vec!["a".into()], tiled: true, ..Default::default() };
        store.save_workspace(&w).unwrap();
        assert_eq!(store.workspace(), w);
        fs::write(store.root().join("workspace.toml"), "not = [valid").unwrap();
        assert_eq!(store.workspace(), Workspace::default(), "a broken file falls back to empty");
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Core SW #1 (B-wing)"), "core-sw-1-b-wing");
        assert_eq!(slug("!!!"), "session");
    }
}
