//! Saved passwords and key passphrases. By default they live in the operating
//! system's credential store (Windows Credential Manager, macOS Keychain, or
//! the Secret Service on Linux). With a master passphrase set they live in
//! `vault.toml` instead, encrypted (see `vault.rs`). Either way, never in
//! Tether's session files.

use crate::store::atomic_write;
use crate::vault::{Vault, VaultKey};
use anyhow::{anyhow, bail, Result};
use keyring::Entry;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};

const SERVICE: &str = "dev.tether.app";
const VAULT_FILE: &str = "vault.toml";

pub const PASSWORD: &str = "password";
pub const PASSPHRASE: &str = "passphrase";
/// Secondary password for login actions, e.g. a Cisco enable secret.
pub const ENABLE: &str = "enable";
pub const KINDS: [&str; 3] = [PASSWORD, PASSPHRASE, ENABLE];

struct Open {
    vault: Vault,
    /// None until the user unlocks it this run.
    key: Option<VaultKey>,
}

struct State {
    dir: PathBuf,
    vault: Option<Open>,
}

static STATE: Mutex<Option<State>> = parking_lot::const_mutex(None);

/// Read the vault file, if there is one. Called once at startup.
pub fn init(dir: &Path) -> Result<()> {
    let path = dir.join(VAULT_FILE);
    let vault = if path.exists() {
        let vault: Vault = toml::from_str(&std::fs::read_to_string(&path)?)?;
        Some(Open { vault, key: None })
    } else {
        None
    };
    *STATE.lock() = Some(State { dir: dir.to_path_buf(), vault });
    Ok(())
}

fn name(session_id: &str, kind: &str) -> String {
    format!("{kind}:{session_id}")
}

fn os_entry(name: &str) -> Result<Entry> {
    Ok(Entry::new(SERVICE, name)?)
}

fn os_get(name: &str) -> Result<Option<String>> {
    match os_entry(name)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn os_delete(name: &str) -> Result<()> {
    match os_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn save(state: &State, vault: &Vault) -> Result<()> {
    atomic_write(&state.dir.join(VAULT_FILE), &toml::to_string_pretty(vault)?)
}

pub fn set(session_id: &str, kind: &str, secret: &str) -> Result<()> {
    let n = name(session_id, kind);
    let mut guard = STATE.lock();
    match guard.as_mut() {
        Some(State { vault: Some(open), .. }) => {
            let Some(key) = open.key.as_ref() else {
                bail!("Unlock saved passwords with your master passphrase first.")
            };
            open.vault.set(key, &n, secret)?;
            let vault = open.vault.clone();
            save(guard.as_ref().ok_or_else(|| anyhow!("secrets not initialized"))?, &vault)
        }
        _ => Ok(os_entry(&n)?.set_password(secret)?),
    }
}

/// A saved secret, or None if there isn't one (or the vault is still locked,
/// in which case the user is asked as if nothing were saved).
pub fn get(session_id: &str, kind: &str) -> Result<Option<String>> {
    let n = name(session_id, kind);
    let guard = STATE.lock();
    match guard.as_ref() {
        Some(State { vault: Some(open), .. }) => match open.key.as_ref() {
            Some(key) => Ok(open.vault.get(key, &n)?.map(|s| s.to_string())),
            None => Ok(None),
        },
        _ => os_get(&n),
    }
}

/// Whether a secret is saved, even while the vault is locked (entry names
/// aren't secret; only their values are encrypted).
pub fn exists(session_id: &str, kind: &str) -> bool {
    let n = name(session_id, kind);
    match STATE.lock().as_ref() {
        Some(State { vault: Some(open), .. }) => open.vault.entries.contains_key(&n),
        _ => os_get(&n).ok().flatten().is_some(),
    }
}

pub fn delete(session_id: &str, kind: &str) -> Result<()> {
    let n = name(session_id, kind);
    let mut guard = STATE.lock();
    match guard.as_mut() {
        Some(State { vault: Some(open), .. }) => {
            if open.vault.entries.contains_key(&n) {
                open.vault.remove(&n);
                let vault = open.vault.clone();
                save(guard.as_ref().ok_or_else(|| anyhow!("secrets not initialized"))?, &vault)?;
            }
            Ok(())
        }
        _ => os_delete(&n),
    }
}

/// (passphrase set, unlocked)
pub fn vault_status() -> (bool, bool) {
    match STATE.lock().as_ref().and_then(|s| s.vault.as_ref()) {
        Some(open) => (true, open.key.is_some()),
        None => (false, false),
    }
}

/// Unlock the vault for this run. Ok(false) means a wrong passphrase.
pub fn unlock(passphrase: &str) -> Result<bool> {
    let mut guard = STATE.lock();
    let open = guard.as_mut().and_then(|s| s.vault.as_mut()).ok_or_else(|| anyhow!("No master passphrase is set."))?;
    match open.vault.unlock(passphrase)? {
        Some(key) => {
            open.key = Some(key);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Set a master passphrase: move the secrets saved for `session_ids` out of
/// the OS store into a new vault.
pub fn enable(passphrase: &str, session_ids: &[String]) -> Result<()> {
    let mut guard = STATE.lock();
    let state = guard.as_mut().ok_or_else(|| anyhow!("secrets not initialized"))?;
    if state.vault.is_some() {
        bail!("A master passphrase is already set.");
    }
    let (mut vault, key) = Vault::create(passphrase)?;
    let mut moved = Vec::new();
    for id in session_ids {
        for kind in KINDS {
            let n = name(id, kind);
            if let Some(secret) = os_get(&n)? {
                vault.set(&key, &n, &secret)?;
                moved.push(n);
            }
        }
    }
    // The vault is on disk before anything leaves the OS store, so a crash
    // here leaves a copy rather than nothing.
    save(state, &vault)?;
    for n in &moved {
        let _ = os_delete(n);
    }
    state.vault = Some(Open { vault, key: Some(key) });
    Ok(())
}

/// Remove the master passphrase: move every secret back to the OS store.
pub fn disable() -> Result<()> {
    let mut guard = STATE.lock();
    let state = guard.as_mut().ok_or_else(|| anyhow!("secrets not initialized"))?;
    let Some(open) = state.vault.as_ref() else { return Ok(()) };
    let Some(key) = open.key.as_ref() else { bail!("Unlock saved passwords with your master passphrase first.") };
    for (n, secret) in open.vault.all(key)? {
        os_entry(&n)?.set_password(&secret)?;
    }
    std::fs::remove_file(state.dir.join(VAULT_FILE))?;
    state.vault = None;
    Ok(())
}

/// Re-encrypt every secret under a new passphrase.
pub fn change(passphrase: &str) -> Result<()> {
    let mut guard = STATE.lock();
    let state = guard.as_mut().ok_or_else(|| anyhow!("secrets not initialized"))?;
    let Some(open) = state.vault.as_ref() else { bail!("No master passphrase is set.") };
    let Some(key) = open.key.as_ref() else { bail!("Unlock saved passwords with your master passphrase first.") };
    let (mut vault, new_key) = Vault::create(passphrase)?;
    for (n, secret) in open.vault.all(key)? {
        vault.set(&new_key, &n, &secret)?;
    }
    save(state, &vault)?;
    state.vault = Some(Open { vault, key: Some(new_key) });
    Ok(())
}

/// Forget a vault whose passphrase is lost. Its secrets are gone; sessions stay.
pub fn reset() -> Result<()> {
    let mut guard = STATE.lock();
    let state = guard.as_mut().ok_or_else(|| anyhow!("secrets not initialized"))?;
    let path = state.dir.join(VAULT_FILE);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    state.vault = None;
    Ok(())
}
