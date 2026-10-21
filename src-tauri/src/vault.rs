//! The optional master passphrase: saved secrets encrypted in `vault.toml`
//! with a key derived from a passphrase only the user knows (Argon2id, then
//! AES-256-GCM per entry). Without it, secrets live in the OS credential store
//! (`secrets.rs`). The passphrase and the derived key never touch the disk.
//!
//! This module is pure: it seals and opens values and (de)serializes the file.
//! `secrets.rs` decides when the vault is used and holds the unlocked key.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const NONCE_LEN: usize = 12;
/// Sealed under the name "check" so a wrong passphrase is caught on unlock,
/// not on the first connection.
const CHECK: &[u8] = b"tether vault";

/// The derived key; wiped from memory when dropped.
pub type VaultKey = Zeroizing<[u8; 32]>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Kdf {
    /// Memory in KiB, passes, lanes.
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub salt: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub version: u32,
    pub kdf: Kdf,
    pub check: String,
    /// "kind:session-id" (the same names the OS credential store uses) to sealed value.
    #[serde(default)]
    pub entries: BTreeMap<String, String>,
}

impl Vault {
    /// A new, empty vault for `passphrase`, and its key.
    pub fn create(passphrase: &str) -> Result<(Vault, VaultKey)> {
        Self::create_with(passphrase, Params::DEFAULT_M_COST.max(64 * 1024), 3, 1)
    }

    fn create_with(passphrase: &str, m_cost: u32, t_cost: u32, p_cost: u32) -> Result<(Vault, VaultKey)> {
        if passphrase.is_empty() {
            bail!("The passphrase can't be empty.");
        }
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).map_err(|e| anyhow!("no system randomness: {e}"))?;
        let kdf = Kdf { m_cost, t_cost, p_cost, salt: B64.encode(salt) };
        let key = derive(passphrase, &kdf)?;
        let check = seal(&key, "check", CHECK)?;
        Ok((Vault { version: 1, kdf, check, entries: BTreeMap::new() }, key))
    }

    /// The key for `passphrase`, or None if it's the wrong passphrase.
    pub fn unlock(&self, passphrase: &str) -> Result<Option<VaultKey>> {
        if self.version != 1 {
            bail!("This vault was made by a newer version of Tether.");
        }
        let key = derive(passphrase, &self.kdf)?;
        Ok(open(&key, "check", &self.check).ok().filter(|v| v.as_slice() == CHECK).map(|_| key))
    }

    pub fn get(&self, key: &VaultKey, name: &str) -> Result<Option<Zeroizing<String>>> {
        let Some(sealed) = self.entries.get(name) else { return Ok(None) };
        let bytes = open(key, name, sealed)?;
        Ok(Some(Zeroizing::new(String::from_utf8(bytes.to_vec()).map_err(|_| anyhow!("a saved secret is damaged"))?)))
    }

    pub fn set(&mut self, key: &VaultKey, name: &str, secret: &str) -> Result<()> {
        self.entries.insert(name.to_string(), seal(key, name, secret.as_bytes())?);
        Ok(())
    }

    pub fn remove(&mut self, name: &str) {
        self.entries.remove(name);
    }

    /// Every secret, decrypted, to move them elsewhere (another passphrase, or back to the OS store).
    pub fn all(&self, key: &VaultKey) -> Result<Vec<(String, Zeroizing<String>)>> {
        self.entries.keys().map(|name| Ok((name.clone(), self.get(key, name)?.unwrap_or_default()))).collect()
    }
}

fn derive(passphrase: &str, kdf: &Kdf) -> Result<VaultKey> {
    let salt = B64.decode(&kdf.salt).map_err(|_| anyhow!("the vault file is damaged (salt)"))?;
    let params =
        Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(32)).map_err(|e| anyhow!("bad vault parameters: {e}"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), &salt, key.as_mut())
        .map_err(|e| anyhow!("couldn't derive the vault key: {e}"))?;
    Ok(key)
}

/// nonce ‖ ciphertext, base64. The entry's name is authenticated too, so a
/// sealed value can't be swapped onto another session.
fn seal(key: &VaultKey, name: &str, plain: &[u8]) -> Result<String> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|e| anyhow!("no system randomness: {e}"))?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(**key));
    let ct = cipher
        .encrypt(&Nonce::from(nonce), Payload { msg: plain, aad: name.as_bytes() })
        .map_err(|_| anyhow!("couldn't encrypt a secret"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

fn open(key: &VaultKey, name: &str, sealed: &str) -> Result<Zeroizing<Vec<u8>>> {
    let raw = B64.decode(sealed).map_err(|_| anyhow!("a saved secret is damaged"))?;
    if raw.len() < NONCE_LEN {
        bail!("a saved secret is damaged");
    }
    let (nonce, ct) = raw.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| anyhow!("a saved secret is damaged"))?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(**key));
    cipher
        .decrypt(&Nonce::from(nonce), Payload { msg: ct, aad: name.as_bytes() })
        .map(Zeroizing::new)
        .map_err(|_| anyhow!("a saved secret couldn't be decrypted"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Small parameters keep the tests fast; real vaults use 64 MiB.
    fn quick(pass: &str) -> (Vault, VaultKey) {
        Vault::create_with(pass, 256, 1, 1).unwrap()
    }

    #[test]
    fn round_trips_secrets() {
        let (mut v, key) = quick("correct horse");
        v.set(&key, "password:abc", "s3cret!").unwrap();
        assert_eq!(v.get(&key, "password:abc").unwrap().as_deref().map(String::as_str), Some("s3cret!"));
        assert!(v.get(&key, "enable:abc").unwrap().is_none());
        assert!(!v.entries["password:abc"].contains("s3cret"));
    }

    #[test]
    fn wrong_passphrase_does_not_unlock() {
        let (v, _) = quick("correct horse");
        assert!(v.unlock("correct horse").unwrap().is_some());
        assert!(v.unlock("Correct horse").unwrap().is_none());
        assert!(v.unlock("").unwrap().is_none());
    }

    #[test]
    fn survives_a_trip_through_the_file() {
        let (mut v, key) = quick("pw");
        v.set(&key, "passphrase:x", "key pass").unwrap();
        let text = toml::to_string_pretty(&v).unwrap();
        let back: Vault = toml::from_str(&text).unwrap();
        let key2 = back.unlock("pw").unwrap().unwrap();
        assert_eq!(back.get(&key2, "passphrase:x").unwrap().as_deref().map(String::as_str), Some("key pass"));
    }

    #[test]
    fn a_value_moved_to_another_name_is_rejected() {
        let (mut v, key) = quick("pw");
        v.set(&key, "password:a", "for a").unwrap();
        let moved = v.entries["password:a"].clone();
        v.entries.insert("password:b".into(), moved);
        assert!(v.get(&key, "password:b").is_err());
    }

    #[test]
    fn same_secret_seals_differently_each_time() {
        let (mut v, key) = quick("pw");
        v.set(&key, "password:a", "same").unwrap();
        let first = v.entries["password:a"].clone();
        v.set(&key, "password:a", "same").unwrap();
        assert_ne!(first, v.entries["password:a"]);
    }

    #[test]
    fn empty_passphrase_is_refused() {
        assert!(Vault::create("").is_err());
    }
}
