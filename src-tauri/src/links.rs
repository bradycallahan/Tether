//! Offering Tether for `ssh://` and `telnet://` links on Windows.
//!
//! Windows 10 and 11 ignore an app that just writes `Classes\<scheme>`: the
//! "Select an app" picker and Settings > Default apps only list apps that
//! register capabilities. So Tether registers per user, the documented way:
//!
//! - a ProgID per scheme (`Tether.ssh`) with the open command,
//! - `Software\Tether\Capabilities\URLAssociations` naming those ProgIDs,
//! - a `RegisteredApplications` value pointing at the capabilities.
//!
//! It never touches `Classes\ssh` itself, so another app's handler is left
//! alone, and only the user picks the default (Windows protects that choice).
//! The uninstaller removes the same keys (`windows/hooks.nsh`).

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use windows_registry::CURRENT_USER;

    const APP: &str = "Tether";
    const CAPABILITIES: &str = "Software\\Tether\\Capabilities";
    const REGISTERED: &str = "Software\\RegisteredApplications";

    fn prog_id(scheme: &str) -> String {
        format!("Tether.{scheme}")
    }

    fn exe() -> std::io::Result<String> {
        let s = std::env::current_exe()?.display().to_string();
        // `\\?\` paths confuse the shell.
        Ok(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
    }

    /// Registered, and pointing at this copy of Tether.
    pub fn is_registered(schemes: &[&str]) -> Result<bool> {
        let exe = exe()?;
        let listed = CURRENT_USER.open(REGISTERED).and_then(|k| k.get_string(APP)).is_ok();
        Ok(listed
            && schemes.iter().all(|s| {
                CURRENT_USER
                    .open(format!("Software\\Classes\\{}\\shell\\open\\command", prog_id(s)))
                    .and_then(|k| k.get_string(""))
                    .is_ok_and(|cmd| cmd == format!("\"{exe}\" \"%1\""))
            }))
    }

    pub fn register(schemes: &[&str]) -> Result<()> {
        let exe = exe()?;
        let caps = CURRENT_USER.create(CAPABILITIES)?;
        caps.set_string("ApplicationName", APP)?;
        caps.set_string("ApplicationDescription", "Terminal for network and systems administrators")?;
        caps.set_string("ApplicationIcon", format!("{exe},0"))?;
        let urls = caps.create("URLAssociations")?;
        for scheme in schemes {
            let id = prog_id(scheme);
            let key = CURRENT_USER.create(format!("Software\\Classes\\{id}"))?;
            key.set_string("", format!("{} link", scheme.to_uppercase()))?;
            key.set_string("URL Protocol", "")?;
            key.create("DefaultIcon")?.set_string("", format!("{exe},0"))?;
            key.create("shell\\open\\command")?.set_string("", format!("\"{exe}\" \"%1\""))?;
            urls.set_string(scheme, &id)?;
        }
        CURRENT_USER.create(REGISTERED)?.set_string(APP, CAPABILITIES)?;
        Ok(())
    }

    pub fn unregister(schemes: &[&str]) -> Result<()> {
        let registered = CURRENT_USER.create(REGISTERED)?;
        if registered.get_string(APP).is_ok() {
            registered.remove_value(APP)?;
        }
        for scheme in schemes {
            let path = format!("Software\\Classes\\{}", prog_id(scheme));
            if CURRENT_USER.open(&path).is_ok() {
                CURRENT_USER.remove_tree(&path)?;
            }
        }
        if CURRENT_USER.open(CAPABILITIES).is_ok() {
            CURRENT_USER.remove_tree(CAPABILITIES)?;
        }
        // `Software\Tether` holds nothing else; drop it once it's empty.
        if let Ok(k) = CURRENT_USER.open("Software\\Tether") {
            if k.keys()?.next().is_none() && k.values()?.next().is_none() {
                drop(k);
                CURRENT_USER.remove_tree("Software\\Tether")?;
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::{is_registered, register, unregister};

/// Settings > Default apps, opened at Tether's page where Windows supports it.
#[cfg(windows)]
pub const DEFAULT_APPS: &str = "ms-settings:defaultapps?registeredAppUser=Tether";
