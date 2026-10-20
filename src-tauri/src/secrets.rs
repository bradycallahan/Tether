//! Saved passwords and key passphrases live in the operating system's
//! credential store (Windows Credential Manager, macOS Keychain, or the
//! Secret Service on Linux) — never in Tether's own files.

use anyhow::Result;
use keyring::Entry;

const SERVICE: &str = "dev.tether.app";

fn entry(session_id: &str, kind: &str) -> Result<Entry> {
    Ok(Entry::new(SERVICE, &format!("{kind}:{session_id}"))?)
}

pub fn set(session_id: &str, kind: &str, secret: &str) -> Result<()> {
    entry(session_id, kind)?.set_password(secret)?;
    Ok(())
}

pub fn get(session_id: &str, kind: &str) -> Result<Option<String>> {
    match entry(session_id, kind)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(session_id: &str, kind: &str) -> Result<()> {
    match entry(session_id, kind)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub const PASSWORD: &str = "password";
pub const PASSPHRASE: &str = "passphrase";
/// Secondary password for login actions, e.g. a Cisco enable secret.
pub const ENABLE: &str = "enable";
