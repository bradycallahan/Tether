//! The main window: remembered size and position, a start that never shows a
//! blank frame, and (on Windows) a WebView2 that behaves like an app instead
//! of a browser.

use crate::model::WindowPlacement;
use crate::store::Store;
use parking_lot::Mutex;
use tauri::{LogicalSize, PhysicalPosition, Runtime, WebviewWindow, WindowEvent};

/// A monitor's work area in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Area {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width as i32 && y < self.y + self.height as i32
    }
}

/// Where to put a remembered window now, or None to let it open centered.
/// A window is only put back if a spot near the left of its title bar is on
/// a monitor, so one saved on an unplugged screen can't open out of reach.
/// It's shrunk to fit if the screen it lands on got smaller.
pub fn fit(p: &WindowPlacement, areas: &[Area], scale: f64) -> Option<WindowPlacement> {
    let area = areas.iter().find(|a| a.contains(p.x.saturating_add(80), p.y.saturating_add(12)))?;
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let max_w = (area.width as f64 / scale).floor();
    let max_h = (area.height as f64 / scale).floor();
    Some(WindowPlacement { width: p.width.min(max_w), height: p.height.min(max_h), ..p.clone() })
}

/// The window's last un-maximized bounds, kept up to date as it moves so the
/// saved placement is the one the user arranged, not the maximized one.
#[derive(Default)]
pub struct Placement(Mutex<Option<WindowPlacement>>);

const MIN_W: f64 = 720.0;
const MIN_H: f64 = 420.0;

/// Called from `setup`, while the window is still hidden.
pub fn restore<R: Runtime>(win: &WebviewWindow<R>, store: &Store, placement: &Placement) {
    #[cfg(windows)]
    harden_webview(win);

    let Some(saved) = store.window_placement() else { return };
    if saved.width < MIN_W || saved.height < MIN_H {
        return;
    }
    let monitors: Vec<(Area, f64)> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let w = m.work_area();
            (Area { x: w.position.x, y: w.position.y, width: w.size.width, height: w.size.height }, m.scale_factor())
        })
        .collect();
    let areas: Vec<Area> = monitors.iter().map(|(a, _)| *a).collect();
    let scale = monitors
        .iter()
        .find(|(a, _)| a.contains(saved.x.saturating_add(80), saved.y.saturating_add(12)))
        .map_or(1.0, |(_, s)| *s);
    let Some(p) = fit(&saved, &areas, scale) else { return };
    let _ = win.set_position(PhysicalPosition::new(p.x, p.y));
    let _ = win.set_size(LogicalSize::new(p.width, p.height));
    *placement.0.lock() = Some(p);
}

/// Shows the window once the UI has painted its first frame.
pub fn show<R: Runtime>(win: &WebviewWindow<R>, placement: &Placement) {
    if win.is_visible().unwrap_or(true) {
        return;
    }
    if placement.0.lock().as_ref().is_some_and(|p| p.maximized) {
        let _ = win.maximize();
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// Tracks moves and resizes, and saves the placement when the window closes.
pub fn on_event<R: Runtime>(win: &WebviewWindow<R>, event: &WindowEvent, store: &Store, placement: &Placement) {
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let busy = win.is_maximized().unwrap_or(true)
                || win.is_minimized().unwrap_or(true)
                || win.is_fullscreen().unwrap_or(true)
                || !win.is_visible().unwrap_or(false);
            if busy {
                return;
            }
            let (Ok(pos), Ok(size), Ok(scale)) = (win.outer_position(), win.inner_size(), win.scale_factor()) else {
                return;
            };
            let size = size.to_logical::<f64>(scale);
            *placement.0.lock() =
                Some(WindowPlacement { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false });
        }
        WindowEvent::CloseRequested { .. } => {
            let Some(mut p) = placement.0.lock().clone() else { return };
            p.maximized = win.is_maximized().unwrap_or(false);
            if let Err(e) = store.save_window_placement(&p) {
                log::warn!("couldn't save the window placement: {e:#}");
            }
        }
        _ => {}
    }
}

/// WebView2 ships with browser keys switched on: F5 and Ctrl+R reload the page
/// (dropping every connection), Ctrl+P prints, Ctrl+F opens the browser's find
/// bar. Tether isn't a web page, so release builds turn them off. Editing keys
/// (copy, paste, undo) are unaffected. The UI also guards these keys itself,
/// in case a WebView2 runtime ignores the setting.
#[cfg(windows)]
fn harden_webview<R: Runtime>(win: &WebviewWindow<R>) {
    if cfg!(debug_assertions) {
        return; // keep F12 and reload while developing
    }
    let _ = win.with_webview(|wv| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        // SAFETY: plain COM calls on the live controller, on the thread Tauri runs this closure on.
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placed(x: i32, y: i32, width: f64, height: f64) -> WindowPlacement {
        WindowPlacement { x, y, width, height, maximized: false }
    }

    const LAPTOP: Area = Area { x: 0, y: 0, width: 1920, height: 1040 };
    const LEFT_MONITOR: Area = Area { x: -2560, y: 0, width: 2560, height: 1400 };

    #[test]
    fn restores_a_window_that_is_on_screen() {
        let p = placed(100, 80, 1280.0, 800.0);
        assert_eq!(fit(&p, &[LAPTOP], 1.0), Some(p));
    }

    #[test]
    fn forgets_a_window_on_an_unplugged_monitor() {
        let p = placed(-2000, 100, 1280.0, 800.0);
        assert_eq!(fit(&p, &[LAPTOP], 1.0), None);
        assert!(fit(&p, &[LAPTOP, LEFT_MONITOR], 1.0).is_some());
    }

    #[test]
    fn forgets_a_window_whose_title_bar_is_off_screen() {
        assert_eq!(fit(&placed(100, -400, 1280.0, 800.0), &[LAPTOP], 1.0), None);
        assert_eq!(fit(&placed(1900, 100, 1280.0, 800.0), &[LAPTOP], 1.0), None);
    }

    #[test]
    fn shrinks_to_a_smaller_screen() {
        // Saved on a 4K monitor, reopened on a 1080p laptop at 150 %.
        let p = fit(&placed(10, 10, 2400.0, 1300.0), &[LAPTOP], 1.5).unwrap();
        assert_eq!((p.width, p.height), (1280.0, 693.0));
    }
}
