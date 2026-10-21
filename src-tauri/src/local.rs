//! Local shell tabs (PowerShell / cmd on Windows, your login shell elsewhere).

use crate::conn::{CmdError, CmdResult, Ctl, Output};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use tokio::sync::mpsc;

/// A shell found on this machine, for the shell picker.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub name: String,
    /// What goes in a session's `shell` field: a program plus arguments,
    /// quoted where a path has spaces.
    pub command: String,
}

pub fn default_shell() -> String {
    if cfg!(windows) {
        if which("pwsh.exe") {
            "pwsh.exe".into()
        } else {
            "powershell.exe".into()
        }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

fn which(exe: &str) -> bool {
    std::env::var_os("PATH").map(|paths| std::env::split_paths(&paths).any(|p| p.join(exe).is_file())).unwrap_or(false)
}

/// The shells worth offering, default first.
pub fn list_shells() -> Vec<ShellInfo> {
    let shell = |name: &str, command: String| ShellInfo { name: name.into(), command };
    let mut out = Vec::new();
    if cfg!(windows) {
        let pwsh7 = Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe");
        if which("pwsh.exe") {
            out.push(shell("PowerShell 7", "pwsh.exe".into()));
        } else if pwsh7.is_file() {
            out.push(shell("PowerShell 7", quote(&pwsh7.to_string_lossy())));
        }
        out.push(shell("Windows PowerShell", "powershell.exe".into()));
        out.push(shell("Command Prompt", "cmd.exe".into()));
        for distro in wsl_distros() {
            out.push(ShellInfo { command: format!("wsl.exe -d {}", quote(&distro)), name: distro });
        }
        for git in [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"] {
            if Path::new(git).is_file() {
                out.push(shell("Git Bash", format!("{} --login -i", quote(git))));
                break;
            }
        }
    } else {
        let default = default_shell();
        let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        let mut seen = Vec::new();
        for path in std::iter::once(default.as_str()).chain(listed.lines().map(str::trim)) {
            if path.is_empty() || path.starts_with('#') || !Path::new(path).is_file() {
                continue;
            }
            let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // /bin/bash and /usr/bin/bash are usually the same shell.
            if ["nologin", "false", "git-shell"].contains(&name.as_str()) || seen.contains(&name) {
                continue;
            }
            seen.push(name.clone());
            out.push(ShellInfo { name, command: path.into() });
        }
    }
    out
}

/// Installed WSL distributions. `wsl --list` prints UTF-16; the probe runs
/// without a console window so nothing flashes on screen.
#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = std::process::Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_wsl_list(&out.stdout)
}

#[cfg(not(windows))]
fn wsl_distros() -> Vec<String> {
    Vec::new()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let utf16 = bytes.starts_with(&[0xff, 0xfe]) || (bytes.len() >= 2 && bytes[1] == 0);
    let text = if utf16 {
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0').to_string())
        // docker-desktop's distros are plumbing, not shells
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

fn quote(s: &str) -> String {
    if s.contains(char::is_whitespace) {
        format!("\"{s}\"")
    } else {
        s.into()
    }
}

/// Splits a shell command into program and arguments. Double quotes group
/// words (`"C:\Program Files\Git\bin\bash.exe" --login`), and a whole
/// unquoted line that names an existing file is taken as one path, so
/// `C:\Program Files\PowerShell\7\pwsh.exe` pasted bare still works.
pub fn split_command(line: &str, exists: impl Fn(&str) -> bool) -> Vec<String> {
    let line = line.trim();
    if !line.contains('"') && line.contains(' ') && exists(line) {
        return vec![line.into()];
    }
    let mut words = Vec::new();
    let mut cur = String::new();
    let (mut quoted, mut started) = (false, false);
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    words.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(cur);
    }
    words
}

pub async fn start(
    shell: String,
    cols: u16,
    rows: u16,
    out: Output,
    mut rx: mpsc::UnboundedReceiver<Ctl>,
) -> CmdResult<()> {
    let shell = if shell.trim().is_empty() { default_shell() } else { shell };
    let err = |e: anyhow::Error| CmdError::new("LOCAL", format!("Could not start {shell}: {e}"));
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(err)?;
    let mut parts = split_command(&shell, |p| Path::new(p).is_file()).into_iter();
    let mut cmd = CommandBuilder::new(parts.next().unwrap_or_else(|| "sh".into()));
    cmd.args(parts);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let mut writer = pair.master.take_writer().map_err(err)?;
    let master = pair.master;

    let reader_out = out.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => reader_out.data(&buf[..n]),
            }
        }
        reader_out.status("closed", "Shell exited.");
    });

    tokio::spawn(async move {
        while let Some(ctl) = rx.recv().await {
            match ctl {
                Ctl::Write(b) => {
                    if writer.write_all(&b).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
                Ctl::Resize(c, r) => {
                    let _ = master.resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                }
                Ctl::Break => {}
                Ctl::Close => break,
            }
        }
        let _ = child.kill();
    });

    out.status("connected", format!("Started {shell}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_and_bare_paths() {
        let none = |_: &str| false;
        assert_eq!(split_command("wsl.exe -d Ubuntu", none), ["wsl.exe", "-d", "Ubuntu"]);
        assert_eq!(
            split_command(r#""C:\Program Files\Git\bin\bash.exe" --login -i"#, none),
            [r"C:\Program Files\Git\bin\bash.exe", "--login", "-i"]
        );
        assert_eq!(split_command(r#"wsl.exe -d "Ubuntu 24.04""#, none), ["wsl.exe", "-d", "Ubuntu 24.04"]);
        let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
        assert_eq!(split_command(pwsh, |p| p == pwsh), [pwsh]);
        assert_eq!(split_command("  bash  ", none), ["bash"]);
        assert_eq!(split_command(r#"cmd.exe /k echo """#, none), ["cmd.exe", "/k", "echo", ""]);
    }

    #[test]
    fn reads_the_wsl_list_in_utf16() {
        let text = "\u{feff}Ubuntu-24.04\r\ndocker-desktop\r\nkali-linux\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu-24.04", "kali-linux"]);
        assert_eq!(parse_wsl_list(b"Debian\n"), ["Debian"]);
    }
}
