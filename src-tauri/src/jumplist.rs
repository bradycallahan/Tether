//! The taskbar jump list: right-click Tether's taskbar button (or its Start
//! menu entry) for the most recent sessions, each opening with
//! `tether.exe --session <id>` (see `launch.rs`), plus two tasks (Quick
//! connect, Local shell). Windows only; elsewhere a no-op.

use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    /// Shown as the tooltip, e.g. "SSH admin@10.0.0.1".
    pub detail: String,
}

/// Session ids are UUIDs; anything else could smuggle extra arguments.
#[cfg_attr(not(windows), allow(dead_code))]
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The installer's shortcuts carry this AppUserModelID (the bundle identifier
/// in tauri.conf.json). The process and the jump list must use the same one,
/// or Windows files the list under a different taskbar button.
#[cfg(windows)]
pub const APP_ID: &str = "dev.tether.app";

/// Called first thing at startup, before any window exists.
#[cfg(windows)]
pub fn set_app_id() {
    use windows::core::HSTRING;
    // SAFETY: a plain Win32 call with a valid string.
    if let Err(e) =
        unsafe { windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) }
    {
        log::warn!("couldn't set the AppUserModelID: {e}");
    }
}

#[cfg(not(windows))]
pub fn set_app_id() {}

#[cfg(windows)]
pub fn set(entries: Vec<Entry>) {
    // COM wants its own apartment; this runs rarely (when recents change).
    std::thread::spawn(move || {
        if let Err(e) = imp::set(&entries) {
            log::warn!("couldn't update the jump list: {e}");
        }
    });
}

#[cfg(not(windows))]
pub fn set(_entries: Vec<Entry>) {}

#[cfg(windows)]
mod imp {
    use super::{safe_id, Entry, APP_ID};
    use crate::launch::TASKS;
    use std::collections::HashSet;
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    fn args(id: &str) -> String {
        format!("--session {id}")
    }

    unsafe fn link(exe: &HSTRING, args: &str, title: &str, detail: &str) -> windows::core::Result<IShellLinkW> {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(exe)?;
        link.SetArguments(&HSTRING::from(args))?;
        link.SetDescription(&HSTRING::from(detail))?;
        link.SetIconLocation(exe, 0)?;
        let props: IPropertyStore = link.cast()?;
        props.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
        props.Commit()?;
        Ok(link)
    }

    pub fn set(entries: &[Entry]) -> windows::core::Result<()> {
        // SAFETY: plain COM calls on this thread's own apartment, released before CoUninitialize.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            let r = build(entries);
            CoUninitialize();
            r
        }
    }

    unsafe fn build(entries: &[Entry]) -> windows::core::Result<()> {
        let exe = HSTRING::from(std::env::current_exe().map_err(|_| windows::core::Error::empty())?.as_os_str());
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        list.SetAppID(&HSTRING::from(APP_ID))?;
        let mut slots = 0u32;
        // Items the user removed from the list must not be added back (Windows refuses the whole category).
        let removed: IObjectArray = list.BeginList(&mut slots)?;
        let mut gone = HashSet::new();
        for i in 0..removed.GetCount()? {
            if let Ok(link) = removed.GetAt::<IShellLinkW>(i) {
                let mut buf = [0u16; 512];
                if link.GetArguments(&mut buf).is_ok() {
                    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    gone.insert(String::from_utf16_lossy(&buf[..len]));
                }
            }
        }
        let items: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        for e in entries.iter().filter(|e| safe_id(&e.id) && !gone.contains(&args(&e.id))).take(slots.max(1) as usize) {
            items.AddObject(&link(&exe, &args(&e.id), &e.name, &e.detail)?)?;
        }
        let array: IObjectArray = items.cast()?;
        if array.GetCount()? > 0 {
            // Refused (E_ACCESSDENIED) when the user turned off "Show recently
            // opened items in Start, Jump Lists and File Explorer". That's their
            // privacy choice: show the tasks alone.
            if let Err(e) = list.AppendCategory(&HSTRING::from("Recent sessions"), &array) {
                log::info!("recent sessions left out of the jump list: {e}");
            }
        }
        let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        for (flag, id) in TASKS {
            let (title, detail) = match id {
                "connect.quick" => ("Quick connect", "Connect to a host, port or serial line"),
                _ => ("Local shell", "Open your default local shell"),
            };
            tasks.AddObject(&link(&exe, flag, title, detail)?)?;
        }
        list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
        list.CommitList()
    }
}

#[cfg(test)]
mod tests {
    use super::safe_id;

    #[test]
    fn only_plain_ids_become_arguments() {
        assert!(safe_id("6f1c2a9e-3b7d-4c55-9a0e-1f2b3c4d5e6f"));
        assert!(!safe_id(""));
        assert!(!safe_id("x\" --evil"));
        assert!(!safe_id("a b"));
    }
}
