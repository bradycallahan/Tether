//! Local shell tabs (PowerShell / cmd on Windows, your login shell elsewhere).

use crate::conn::{CmdError, CmdResult, Ctl, Output};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use tokio::sync::mpsc;

pub fn default_shell() -> String {
    if cfg!(windows) {
        if which("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|p| p.join(exe).is_file()))
        .unwrap_or(false)
}

pub async fn start(shell: String, cols: u16, rows: u16, out: Output, mut rx: mpsc::UnboundedReceiver<Ctl>) -> CmdResult<()> {
    let shell = if shell.trim().is_empty() { default_shell() } else { shell };
    let err = |e: anyhow::Error| CmdError::new("LOCAL", format!("Could not start {shell}: {e}"));
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;
    let mut parts = shell.split_whitespace();
    let mut cmd = CommandBuilder::new(parts.next().unwrap_or("sh"));
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
