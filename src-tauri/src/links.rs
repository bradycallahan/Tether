//! Making Tether the handler for `ssh://` and `telnet://` links on Windows.
//!
//! The deep-link plugin's `unregister` deletes the whole
//! `HKCU\Software\Classes\<scheme>` key, including one another app made, so on
//! Windows Tether edits the key itself: it remembers what was there before,
//! and unticking the setting puts that back instead of deleting it.

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use windows_registry::{Key, CURRENT_USER};

    /// Values Tether adds next to the handler so it can undo itself.
    const CREATED: &str = "TetherCreated";
    const PREV_COMMAND: &str = "TetherPreviousCommand";
    const PREV_ICON: &str = "TetherPreviousIcon";

    fn base(scheme: &str) -> String {
        format!("Software\\Classes\\{scheme}")
    }

    fn exe() -> std::io::Result<String> {
        let exe = std::env::current_exe()?;
        // `\\?\` paths confuse the shell; strip the prefix like the plugin does.
        let s = exe.display().to_string();
        Ok(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
    }

    fn command(exe: &str) -> String {
        format!("\"{exe}\" \"%1\"")
    }

    fn default_of(key: &Key, path: &str) -> Option<String> {
        key.open(path).ok()?.get_string("").ok()
    }

    pub fn is_registered(scheme: &str) -> Result<bool> {
        let exe = exe()?;
        Ok(default_of(CURRENT_USER, &format!("{}\\shell\\open\\command", base(scheme))).as_deref()
            == Some(command(&exe).as_str()))
    }

    pub fn register(scheme: &str) -> Result<()> {
        if is_registered(scheme)? {
            return Ok(());
        }
        let exe = exe()?;
        let path = base(scheme);
        let existed = CURRENT_USER.open(&path).is_ok();
        let key = CURRENT_USER.create(&path)?;
        if existed {
            // Keep the other app's description; remember its command and icon.
            if let Some(prev) = default_of(&key, "shell\\open\\command") {
                key.set_string(PREV_COMMAND, prev)?;
            }
            if let Some(prev) = default_of(&key, "DefaultIcon") {
                key.set_string(PREV_ICON, prev)?;
            }
        } else {
            key.set_string("", format!("URL:{} Protocol", scheme.to_uppercase()))?;
            key.set_string(CREATED, "1")?;
        }
        if key.get_string("URL Protocol").is_err() {
            key.set_string("URL Protocol", "")?;
        }
        key.create("DefaultIcon")?.set_string("", format!("{exe},0"))?;
        key.create("shell\\open\\command")?.set_string("", command(&exe))?;
        Ok(())
    }

    pub fn unregister(scheme: &str) -> Result<()> {
        if !is_registered(scheme)? {
            return Ok(());
        }
        let path = base(scheme);
        let key = CURRENT_USER.create(&path)?;
        if key.get_string(CREATED).is_ok() {
            return Ok(CURRENT_USER.remove_tree(&path)?);
        }
        restore(&key, &path, PREV_COMMAND, "shell\\open\\command")?;
        restore(&key, &path, PREV_ICON, "DefaultIcon")?;
        // Leave no empty `shell\open` behind if there was no command before.
        for sub in ["shell\\open", "shell"] {
            if let Ok(k) = key.open(sub) {
                if k.keys()?.next().is_none() && k.values()?.next().is_none() {
                    CURRENT_USER.remove_tree(format!("{path}\\{sub}"))?;
                }
            }
        }
        Ok(())
    }

    /// Put back the value saved under `saved`, or remove `sub` if there was none.
    fn restore(key: &Key, path: &str, saved: &str, sub: &str) -> Result<()> {
        match key.get_string(saved) {
            Ok(prev) => {
                key.create(sub)?.set_string("", prev)?;
                Ok(key.remove_value(saved)?)
            }
            // Deleted through HKCU itself: `key` lacks the DELETE right.
            Err(_) if key.open(sub).is_ok() => Ok(CURRENT_USER.remove_tree(format!("{path}\\{sub}"))?),
            Err(_) => Ok(()),
        }
    }
}

#[cfg(windows)]
pub use imp::{is_registered, register, unregister};
