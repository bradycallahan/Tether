// Options dialogs in their own windows, the Windows (and SecureCRT) way: the
// main window opens an owned window that stays above it and ignores input
// until the dialog closes. The dialog window loads the same UI bundle and runs
// the same editor code; only the result travels back, as an event. Small
// prompts (passwords, host keys, paste confirmation) stay in the page, next
// to the tab they belong to.

import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, LogicalPosition, LogicalSize, type ScrollBarStyle } from "@tauri-apps/api/window";
import { api } from "./api";
import { hostNextModal } from "./dialogs";
import { guardWebview, setWindowTheme } from "./platform";
import { store, type Topic } from "./state";

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Request<R> {
  label: string;
  req: R;
  anchor: Anchor;
}

const MAIN = "main";
let seq = 0;

/** The request this window was opened for, if it's a dialog window. */
export function dialogRequest<R>(): Request<R> | undefined {
  const m = /^#dialog=(.*)$/.exec(location.hash);
  if (!m) return undefined;
  try {
    return JSON.parse(decodeURIComponent(m[1])) as Request<R>;
  } catch {
    return undefined;
  }
}

/**
 * Run a dialog in its own window and resolve with its result (undefined if it
 * was cancelled or closed). Where windows can't be made (the browser preview)
 * it runs `inline` instead.
 */
export async function inWindow<R, T>(req: R, inline: () => Promise<T | undefined>): Promise<T | undefined> {
  if (!isTauri()) return inline();
  const main = getCurrentWindow();
  const scale = await main.scaleFactor();
  const pos = (await main.innerPosition()).toLogical(scale);
  const size = (await main.innerSize()).toLogical(scale);
  const label = `dialog-${Date.now().toString(36)}-${++seq}`;
  const request: Request<R> = { label, req, anchor: { x: pos.x, y: pos.y, width: size.width, height: size.height } };

  return new Promise((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      main.setEnabled(true).catch(() => {});
      main.setFocus().catch(() => {});
      resolve(v);
    };
    listen<{ label: string; value: T | null }>("dialog-result", (e) => {
      if (e.payload.label === label) finish(e.payload.value ?? undefined);
    }).then((un) => {
      unlisten = un;
      if (settled) un();
      const css = getComputedStyle(document.documentElement);
      const w = new WebviewWindow(label, {
        url: `index.html#dialog=${encodeURIComponent(JSON.stringify(request))}`,
        parent: main,
        title: "Tether",
        // Sized and placed by the dialog once it knows its content; this is
        // just room enough to measure in.
        width: 1000,
        height: 760,
        visible: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        backgroundColor: css.getPropertyValue("--panel").trim() || undefined,
        dragDropEnabled: false,
        // WebView2 requires these to match the main window's (they share a data directory).
        scrollBarStyle: "fluentOverlay" as ScrollBarStyle,
        generalAutofillEnabled: false,
      });
      w.once("tauri://error", () => finish(undefined));
      w.once("tauri://destroyed", () => finish(undefined));
      main.setEnabled(false).catch(() => {});
      // A dialog whose page failed to start would leave the app locked behind
      // an invisible window; show it so it can at least be closed.
      setTimeout(() => {
        if (!settled) w.show().catch(() => {});
      }, 4000);
    });
  });
}

/** Entry point of a dialog window: run the dialog, send back its result, close. */
export async function runDialogWindow<R>(request: Request<R>, run: (req: R) => Promise<unknown>) {
  const win = getCurrentWindow();
  guardWebview();
  await store.load();
  // Changes saved from inside the dialog (an import, button bars edited from
  // Settings) are reloaded by the main window.
  store.relay = (topic: Topic) => void emitTo(MAIN, "library-changed", topic).catch(() => {});
  applyTheme();
  store.on("settings", applyTheme);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);
  hostNextModal((dlg, title) => void present(dlg, title, request.anchor));
  let value: unknown;
  try {
    value = await run(request.req);
  } finally {
    await emitTo(MAIN, "dialog-result", { label: request.label, value: value ?? null }).catch(() => {});
    await win.destroy();
  }
}

/** Let the main window know about library changes made in a dialog window. */
export function followDialogChanges() {
  if (!isTauri()) return;
  listen<Topic>("library-changed", (e) => void store.reload(e.payload)).catch(() => {});
}

function applyTheme() {
  const pref = store.settings.uiTheme;
  const light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  setWindowTheme(pref === "system" ? null : pref);
}

/** Fit the window to the dialog's natural size, centre it over the main window, show it. */
async function present(dlg: HTMLDialogElement, title: string, anchor: Anchor) {
  const win = getCurrentWindow();
  const box = dlg.getBoundingClientRect();
  // Never bigger than the main window: options dialogs are a fixed size and
  // otherwise overhang a small main window.
  const width = Math.ceil(Math.min(box.width, Math.max(420, anchor.width - 40)));
  const height = Math.ceil(Math.min(box.height, Math.max(260, anchor.height - 60)));
  dlg.classList.add("in-window");
  document.title = title;
  await Promise.all([
    win.setTitle(title),
    win.setSize(new LogicalSize(width, height)),
    win.setMinSize(new LogicalSize(Math.min(width, 420), Math.min(height, 260))),
    win.setPosition(new LogicalPosition(Math.round(anchor.x + (anchor.width - width) / 2), Math.round(anchor.y + Math.max(0, (anchor.height - height) / 3)))),
  ]).catch(() => {});
  // Shows the window once this frame has painted, like the main window.
  requestAnimationFrame(() => requestAnimationFrame(() => api.windowReady().catch(() => win.show())));
}
