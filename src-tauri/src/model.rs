//! Data model shared between the backend and the UI. Everything here is
//! serialized to plain TOML on disk so session libraries diff cleanly in Git.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    /// Slash-separated folder path, e.g. "BSU/Core switches". Empty = root.
    #[serde(default)]
    pub folder: String,
    pub protocol: Protocol,
    #[serde(default)]
    pub terminal: TerminalOptions,
    #[serde(default)]
    pub notes: String,
    /// Optional button bar to show when this session is focused.
    #[serde(default)]
    pub button_bar: Option<String>,
    /// Commands sent automatically after login (one per line, escapes allowed).
    #[serde(default)]
    pub login_script: String,
    #[serde(default)]
    pub color_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Protocol {
    #[serde(rename_all = "camelCase")]
    Ssh {
        host: String,
        #[serde(default = "default_ssh_port")]
        port: u16,
        #[serde(default)]
        username: String,
        #[serde(default)]
        auth: SshAuth,
        /// Id of another saved SSH session to tunnel through.
        #[serde(default)]
        jump_session: Option<String>,
        /// Allow SHA-1 kex/MACs and CBC ciphers for old switches and routers.
        #[serde(default)]
        legacy_algorithms: bool,
        #[serde(default = "default_keepalive")]
        keepalive_secs: u32,
    },
    #[serde(rename_all = "camelCase")]
    Telnet {
        host: String,
        #[serde(default = "default_telnet_port")]
        port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Raw { host: String, port: u16 },
    #[serde(rename_all = "camelCase")]
    Serial {
        port: String,
        #[serde(default = "default_baud")]
        baud: u32,
        #[serde(default = "default_data_bits")]
        data_bits: u8,
        #[serde(default)]
        parity: Parity,
        #[serde(default = "default_stop_bits")]
        stop_bits: u8,
        #[serde(default)]
        flow: FlowControl,
    },
    #[serde(rename_all = "camelCase")]
    Local {
        #[serde(default)]
        shell: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum SshAuth {
    /// Password or keyboard-interactive. Password lives in the OS keychain.
    #[default]
    Password,
    #[serde(rename_all = "camelCase")]
    PublicKey { key_path: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Parity {
    #[default]
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalOptions {
    pub term_type: String,
    pub log_enabled: bool,
    /// Log file name template. Tokens: {session} {host} {date} {time}
    pub log_template: String,
    pub log_timestamps: bool,
    pub log_strip_ansi: bool,
    pub highlight_set: Option<String>,
    pub backspace_sends_delete: bool,
    pub encoding: String,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            term_type: "xterm-256color".into(),
            log_enabled: false,
            log_template: "{session}_{date}_{time}.log".into(),
            log_timestamps: true,
            log_strip_ansi: true,
            highlight_set: None,
            backspace_sends_delete: true,
            encoding: "utf-8".into(),
        }
    }
}

fn default_ssh_port() -> u16 { 22 }
fn default_telnet_port() -> u16 { 23 }
fn default_keepalive() -> u32 { 30 }
fn default_baud() -> u32 { 9600 }
fn default_data_bits() -> u8 { 8 }
fn default_stop_bits() -> u8 { 1 }

// ---------------------------------------------------------------------------
// Button bars

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ButtonBar {
    pub name: String,
    #[serde(default)]
    pub buttons: Vec<Button>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Button {
    pub label: String,
    /// Text to send. Escapes: \r \n \t \e \\ and \p (pause 500 ms).
    pub send: String,
    #[serde(default)]
    pub color: Option<String>,
}

// ---------------------------------------------------------------------------
// Keyword highlighting

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlightSet {
    pub name: String,
    #[serde(default)]
    pub rules: Vec<HighlightRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRule {
    /// JavaScript-flavoured regular expression (or plain text if `regex` is false).
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    pub foreground: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
}

// ---------------------------------------------------------------------------
// App settings

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub ui_theme: String,
    pub terminal_scheme: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
    pub confirm_multiline_paste: bool,
    pub bell: String,
    pub default_highlight_set: Option<String>,
    pub default_button_bar: Option<String>,
    pub log_directory: String,
    pub reconnect_on_enter: bool,
    pub show_command_bar: bool,
    pub show_button_bar: bool,
    pub sidebar_width: u32,
    pub gpu_rendering: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ui_theme: "system".into(),
            terminal_scheme: "Patch Bay".into(),
            font_family: "\"Cascadia Mono\", \"JetBrains Mono\", \"SF Mono\", Menlo, Consolas, \"DejaVu Sans Mono\", monospace".into(),
            font_size: 14,
            line_height: 1.15,
            cursor_style: "block".into(),
            cursor_blink: true,
            scrollback: 20000,
            copy_on_select: true,
            right_click_paste: true,
            confirm_multiline_paste: true,
            bell: "visual".into(),
            default_highlight_set: Some("Network gear".into()),
            default_button_bar: Some("Cisco basics".into()),
            log_directory: String::new(),
            reconnect_on_enter: true,
            show_command_bar: false,
            show_button_bar: true,
            sidebar_width: 260,
            // WebKitGTK can stall repaints of background WebGL canvases.
            gpu_rendering: !cfg!(target_os = "linux"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_round_trips_through_toml() {
        let s = Session {
            id: "abc".into(),
            name: "core-sw1".into(),
            folder: "BSU/Core".into(),
            protocol: Protocol::Ssh {
                host: "10.0.0.1".into(),
                port: 22,
                username: "admin".into(),
                auth: SshAuth::PublicKey { key_path: "~/.ssh/id_ed25519".into() },
                jump_session: None,
                legacy_algorithms: true,
                keepalive_secs: 30,
            },
            terminal: TerminalOptions::default(),
            notes: String::new(),
            button_bar: None,
            login_script: String::new(),
            color_tag: None,
        };
        let text = toml::to_string_pretty(&s).unwrap();
        let back: Session = toml::from_str(&text).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn minimal_serial_session_uses_defaults() {
        let text = r#"
            id = "x"
            name = "console"
            [protocol]
            kind = "serial"
            port = "COM3"
        "#;
        let s: Session = toml::from_str(text).unwrap();
        match s.protocol {
            Protocol::Serial { baud, data_bits, stop_bits, .. } => {
                assert_eq!((baud, data_bits, stop_bits), (9600, 8, 1))
            }
            _ => panic!("wrong protocol"),
        }
    }
}
