// What makes the webview behave like an app on each OS: a platform tag for
// platform-specific styling, no browser keys or browser context menu, and the
// taskbar/dock nudge when something needs attention.

import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { KeyLike } from "./commands";

export type Platform = "windows" | "mac" | "linux";

export const platform: Platform =
  typeof navigator === "undefined" ? "linux" : /windows/i.test(navigator.userAgent) ? "windows" : /mac/i.test(navigator.platform) ? "mac" : "linux";

/**
 * Keys a browser engine acts on by itself: reload (which would drop every
 * connection), print, its own find bar, caret browsing, history navigation.
 * WebView2 and WebKitGTK both have some of these. The terminal never needs
 * guarding: xterm.js turns these keys into bytes for the device and consumes them.
 */
export function isBrowserKey(e: KeyLike, mac = platform === "mac"): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (["BrowserBack", "BrowserForward", "BrowserRefresh", "BrowserSearch", "BrowserHome"].includes(key)) return true;
  if (mac) return e.metaKey && !e.ctrlKey && ["r", "p", "["].includes(key);
  if (e.metaKey) return false;
  if (e.altKey && !e.ctrlKey && (key === "ArrowLeft" || key === "ArrowRight" || key === "Home")) return true;
  if (!e.ctrlKey && !e.altKey && ["F3", "F5", "F7", "F12"].includes(key)) return true;
  if (e.ctrlKey && !e.altKey && ["r", "p", "f", "g", "h", "j", "u", "s", "o", "n", "F5"].includes(key)) return true;
  return e.ctrlKey && e.shiftKey && !e.altKey && ["i", "j", "delete"].includes(key.toLowerCase());
}

function editable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

/** Call once at startup, after the app's own key handler is installed. */
export function guardWebview() {
  document.documentElement.dataset.platform = platform;
  addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented || (e.target instanceof Element && e.target.closest(".xterm"))) return;
      if (isBrowserKey(e)) e.preventDefault();
    },
    true,
  );
  // Every place that has a menu of its own calls preventDefault; anywhere
  // else, the engine's Back/Reload/Print menu is the giveaway that this is a
  // web page. Text fields keep the system's Cut/Copy/Paste menu.
  addEventListener("contextmenu", (e) => {
    if (!e.defaultPrevented && !editable(e.target)) e.preventDefault();
  });
  // Dropping a file anywhere that doesn't take it would navigate to the file.
  addEventListener("dragover", (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  });
  addEventListener("drop", (e) => {
    if (!e.defaultPrevented && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

/** Flash the taskbar button (or bounce the dock) when Tether is in the background. */
export function requestAttention() {
  if (document.hasFocus()) return;
  getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
}

/** Keep the native title bar in step with Tether's own theme. */
export function setWindowTheme(theme: "light" | "dark" | null) {
  getCurrentWindow().setTheme(theme).catch(() => {});
}
