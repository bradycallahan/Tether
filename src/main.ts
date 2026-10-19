import "./styles.css";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { clear, h, icon } from "./dom";
import { alertDialog, confirmDialog, modal, promptText, showMenu, toast } from "./dialogs";
import { editButtonBars, editHighlights, editSession, editSettings } from "./editors";
import { Sidebar } from "./sidebar";
import { store } from "./state";
import { TabManager, type Tab } from "./tabs";
import { hostLabel, newSession, PROTOCOL_NAMES, type Session } from "./types";

const isMac = navigator.platform.toUpperCase().includes("MAC");
const MOD = isMac ? "⌘" : "Ctrl";

class App {
  root = document.getElementById("app")!;
  sidebar!: Sidebar;
  tabs!: TabManager;
  barSelect!: HTMLSelectElement;
  barButtons!: HTMLElement;
  buttonBarEl!: HTMLElement;
  cmdBar!: HTMLElement;
  cmdInput!: HTMLInputElement;
  cmdTarget!: HTMLElement;
  statusEl!: HTMLElement;
  bcBtn!: HTMLButtonElement;
  tileBtn!: HTMLButtonElement;
  currentBar: string | null = null;
  history: string[] = [];
  historyPos = -1;

  async start() {
    await store.load();
    this.applyTheme();
    this.build();
    store.on("settings", () => {
      this.applyTheme();
      for (const t of this.tabs.tabs) t.applySettings();
      this.renderBars();
    });
    store.on("highlights", () => this.tabs.tabs.forEach((t) => t.applyHighlightSet()));
    store.on("bars", () => this.renderBars());
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => this.applyTheme());
    addEventListener("keydown", (e) => this.shortcut(e), true);
    addEventListener("focus", () => this.tabs.active?.tabEl.classList.remove("unread"));
  }

  applyTheme() {
    const pref = store.settings.uiTheme;
    const light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
    this.root.style.setProperty("--sidebar-w", `${store.settings.sidebarWidth}px`);
  }

  build() {
    this.sidebar = new Sidebar({
      connect: (s, saved) => this.tabs.open(s, saved),
      connectMany: (list) => this.connectMany(list),
      edit: (s) => this.edit(s),
      create: (folder) => this.create(folder),
      duplicate: (s) => this.duplicate(s),
      remove: (s) => this.remove(s),
      renameFolder: (f) => this.renameFolder(f),
      importSecureCrt: () => this.importSecureCrt(),
      settings: () => this.openSettings(),
    });

    const splitter = h("div", { class: "splitter", role: "separator", "aria-orientation": "vertical", title: "Drag to resize, double-click to hide" });
    this.setupSplitter(splitter);

    // Tab strip
    const tabsEl = h("div", { class: "tabs", role: "tablist" });
    this.bcBtn = h("button", { type: "button", class: "btn ghost icon-only", title: `Broadcast typing to checked tabs (${MOD}+Shift+B)`, "aria-pressed": "false", onclick: () => this.toggleBroadcast() }, icon("broadcast"));
    this.tileBtn = h("button", { type: "button", class: "btn ghost icon-only", title: `Tile all tabs (${MOD}+Shift+G)`, "aria-pressed": "false", onclick: () => this.toggleTile() }, icon("tile"));
    const strip = h(
      "div",
      { class: "tabstrip" },
      tabsEl,
      h("div", { class: "strip-tools" },
        h("button", { type: "button", class: "btn ghost icon-only", title: `Local shell (${MOD}+Shift+E)`, onclick: () => this.openLocal() }, icon("terminal")),
        this.tileBtn,
        this.bcBtn,
        h("button", { type: "button", class: "btn ghost icon-only", title: `Command bar (${MOD}+Shift+O)`, onclick: () => this.toggleCmdBar() }, icon("command")),
      ),
    );

    const empty = h(
      "div",
      { class: "empty-state" },
      h("div", {},
        h("h2", {}, "Nothing connected"),
        h("p", {}, "Double-click a saved session, or type an address, serial port or console-server line into the box at the top left."),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn primary", onclick: () => this.sidebar.quickInput.focus() }, "Quick connect"),
          h("button", { type: "button", class: "btn", onclick: () => this.create("") }, "New session"),
          h("button", { type: "button", class: "btn", onclick: () => this.openLocal() }, "Local shell"),
        ),
        h("p", { style: { marginTop: "22px", fontSize: "12px" } }, h("span", { class: "kbd" }, `${MOD}+Shift+P`), " opens every command and session"),
      ),
    );
    const panes = h("div", { class: "panes" }, empty);

    // Command bar
    this.cmdInput = h("input", { type: "text", placeholder: "Type a command and press Enter — escapes like \\r and ^C work", spellcheck: "false", "aria-label": "Command bar" });
    this.cmdTarget = h("span", { class: "target" });
    this.cmdInput.addEventListener("keydown", (e) => this.cmdKey(e));
    this.cmdBar = h("div", { class: "cmdbar", hidden: !store.settings.showCommandBar }, icon("command"), this.cmdInput, this.cmdTarget);

    // Button bar
    this.barSelect = h("select", { "aria-label": "Button bar", title: "Choose a button bar" });
    this.barSelect.addEventListener("change", () => {
      if (this.barSelect.value === "__edit") {
        this.barSelect.value = this.currentBar ?? "";
        this.editBars();
        return;
      }
      this.currentBar = this.barSelect.value;
      this.renderBarButtons();
    });
    this.barButtons = h("div", { style: { display: "contents" } });
    this.buttonBarEl = h("div", { class: "buttonbar", hidden: !store.settings.showButtonBar }, this.barSelect, h("span", { class: "sep" }), this.barButtons);
    this.currentBar = store.settings.defaultButtonBar;

    this.tabs = new TabManager(tabsEl, strip, panes, empty, () => this.refresh(), (tab) => this.editFromTab(tab));

    const workspace = h("main", { class: "workspace" }, strip, panes, this.cmdBar, this.buttonBarEl);
    this.statusEl = h("footer", { class: "status" });
    clear(this.root);
    this.root.append(this.sidebar.el, splitter, workspace, this.statusEl);
    this.renderBars();
    this.refresh();
    setTimeout(() => this.sidebar.quickInput.focus(), 50);
  }

  setupSplitter(el: HTMLElement) {
    el.addEventListener("dblclick", () => this.root.classList.toggle("sidebar-hidden"));
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag");
      const move = (ev: PointerEvent) => {
        const w = Math.max(180, Math.min(520, ev.clientX));
        this.root.style.setProperty("--sidebar-w", `${w}px`);
      };
      const up = (ev: PointerEvent) => {
        el.classList.remove("drag");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        const w = Math.max(180, Math.min(520, ev.clientX));
        if (w !== store.settings.sidebarWidth) store.saveSettings({ ...store.settings, sidebarWidth: w });
        this.tabs.tabs.forEach((t) => t.fitSoon());
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }

  // ---------- bars ----------

  renderBars() {
    clear(this.barSelect);
    for (const b of store.bars) this.barSelect.append(h("option", { value: b.name, selected: b.name === this.currentBar }, b.name));
    this.barSelect.append(h("option", { value: "__edit" }, "Edit bars…"));
    if (!store.bars.some((b) => b.name === this.currentBar)) this.currentBar = store.bars[0]?.name ?? null;
    this.barSelect.value = this.currentBar ?? "";
    this.buttonBarEl.hidden = !store.settings.showButtonBar;
    this.renderBarButtons();
  }

  renderBarButtons() {
    clear(this.barButtons);
    const bar = store.bars.find((b) => b.name === this.currentBar);
    if (!bar || bar.buttons.length === 0) {
      this.barButtons.append(h("button", { type: "button", class: "btn ghost", onclick: () => this.editBars() }, icon("plus"), "Add buttons"));
      return;
    }
    for (const b of bar.buttons) {
      const btn = h("button", {
        type: "button",
        class: "sbtn",
        title: b.send,
        onclick: () => this.tabs.sendString(b.send),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [{ label: "Edit button bars…", action: () => this.editBars(), icon: "edit" }]);
        },
      }, b.label || b.send);
      if (b.color) btn.style.setProperty("--btn-color", b.color);
      this.barButtons.append(btn);
    }
  }

  async editBars() {
    const bars = await editButtonBars(this.currentBar ?? undefined);
    if (bars) await store.saveBars(bars);
    this.tabs.active?.focus();
  }

  async editHl() {
    const sets = await editHighlights();
    if (sets) await store.saveHighlights(sets);
  }

  // ---------- command bar ----------

  toggleCmdBar(force?: boolean) {
    const show = force ?? this.cmdBar.hidden;
    this.cmdBar.hidden = !show;
    store.saveSettings({ ...store.settings, showCommandBar: show });
    if (show) this.cmdInput.focus();
    else this.tabs.active?.focus();
    this.tabs.tabs.forEach((t) => t.fitSoon());
  }

  cmdKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      const v = this.cmdInput.value;
      if (v.trim() && this.history[0] !== v) this.history.unshift(v);
      this.history.length = Math.min(this.history.length, 200);
      this.historyPos = -1;
      const hasEnter = /\\r|\\n$/.test(v);
      this.tabs.sendString(hasEnter ? v : v + "\\r").then(() => this.cmdInput.focus());
      this.cmdInput.value = "";
    } else if (e.key === "ArrowUp") {
      if (this.historyPos < this.history.length - 1) this.cmdInput.value = this.history[++this.historyPos];
    } else if (e.key === "ArrowDown") {
      this.historyPos = Math.max(-1, this.historyPos - 1);
      this.cmdInput.value = this.historyPos >= 0 ? this.history[this.historyPos] : "";
    } else if (e.key === "Escape") {
      this.tabs.active?.focus();
    } else return;
    e.preventDefault();
  }

  // ---------- status ----------

  refresh() {
    if (!this.statusEl) return;
    const t = this.tabs.active;
    clear(this.statusEl);
    const targets = this.tabs.targets();
    if (this.tabs.broadcast) {
      const n = this.tabs.tabs.filter((x) => x.inBroadcast && x.state === "connected").length;
      this.cmdTarget.textContent = `To ${n} tab${n === 1 ? "" : "s"}`;
      this.cmdTarget.className = "target all";
    } else {
      this.cmdTarget.textContent = t ? `To ${t.title}` : "";
      this.cmdTarget.className = "target";
    }
    this.bcBtn.setAttribute("aria-pressed", String(this.tabs.broadcast));
    this.tileBtn.setAttribute("aria-pressed", String(this.tabs.tiled));
    if (!t) {
      this.statusEl.append(h("span", { class: "seg" }, `${store.sessions.length} saved session${store.sessions.length === 1 ? "" : "s"}`));
      getCurrentWindow().setTitle("Tether").catch(() => {});
      return;
    }
    const stateClass = t.state === "connected" ? "on" : t.state === "connecting" ? "warn" : "";
    this.statusEl.append(
      h("span", { class: `seg ${stateClass}` }, h("span", { class: `led ${t.state === "idle" ? "" : t.state}` }), t.statusMessage),
      h("span", { class: "seg" }, t.session.protocol.kind === "local" ? hostLabel(t.session.protocol) : `${PROTOCOL_NAMES[t.session.protocol.kind]} ${hostLabel(t.session.protocol)}`),
      h("span", { class: "grow" }),
      ...(this.tabs.broadcast ? [h("span", { class: "seg warn" }, icon("broadcast"), `Broadcasting to ${targets.length}`)] : []),
      h("button", { type: "button", class: `seg ${t.logPath ? "on" : ""}`, title: t.logPath ?? `Start logging (${MOD}+Shift+L)`, onclick: () => t.toggleLogging() }, icon("log"), t.logPath ? "Logging" : "Not logging"),
      h("span", { class: "seg" }, `${t.term.cols}×${t.term.rows}`),
    );
    getCurrentWindow().setTitle(`${t.title} — Tether`).catch(() => {});
  }

  // ---------- session actions ----------

  async create(folder: string) {
    const r = await editSession(newSession({ folder }), { isNew: true });
    if (!r) return;
    await store.saveSession(r.session);
    if (r.connect) this.tabs.open(r.session, true);
  }

  async edit(s: Session) {
    const r = await editSession(s, { isNew: false });
    if (!r) return;
    await store.saveSession(r.session);
    if (r.connect) this.tabs.open(r.session, true);
  }

  async editFromTab(tab: Tab) {
    const existing = tab.saved ? store.session(tab.session.id) : undefined;
    const r = await editSession(existing ?? tab.session, { isNew: !existing });
    if (!r) return;
    await store.saveSession(r.session);
    tab.session = structuredClone(r.session);
    tab.saved = true;
    tab.setTitle(r.session.name);
    tab.applyHighlightSet();
    if (r.connect && tab.state !== "connected") tab.connect();
  }

  async duplicate(s: Session) {
    const copy = { ...structuredClone(s), id: crypto.randomUUID(), name: `${s.name} copy` };
    await store.saveSession(copy);
    this.edit(copy);
  }

  async remove(s: Session) {
    const ok = await confirmDialog({ title: `Delete ${s.name}?`, message: "The session file and any password saved for it are removed. Open tabs stay connected.", confirm: "Delete session", danger: true });
    if (ok) await store.deleteSession(s.id);
  }

  async renameFolder(path: string) {
    const name = await promptText({ title: "Rename folder", label: "Folder path", value: path, confirm: "Rename" });
    if (name === undefined) return;
    const next = name.split("/").map((x) => x.trim()).filter(Boolean).join("/");
    if (next === path) return;
    const changed = store.sessions
      .filter((s) => s.folder === path || s.folder.startsWith(path + "/"))
      .map((s) => ({ ...s, folder: next + s.folder.slice(path.length) }));
    await store.saveSessions(changed);
  }

  async connectMany(list: Session[]) {
    if (list.length > 8) {
      const ok = await confirmDialog({ title: `Open ${list.length} tabs?`, message: "Each session opens in its own tab.", confirm: `Open ${list.length} tabs` });
      if (!ok) return;
    }
    for (const s of list) this.tabs.open(s, true);
  }

  async openLocal() {
    const s = newSession({ name: "Local shell", protocol: { kind: "local", shell: "" } });
    this.tabs.open(s, false);
  }

  async openSettings() {
    const s = await editSettings({
      importSecureCrt: () => this.importSecureCrt(),
      editBars: () => this.editBars(),
      editHighlights: () => this.editHl(),
    });
    if (s) await store.saveSettings(s);
    this.tabs.active?.focus();
  }

  async importSecureCrt() {
    const proceed = await confirmDialog({
      title: "Import SecureCRT sessions",
      message: h("span", {},
        "Choose SecureCRT's Sessions folder. On Windows it's usually ",
        h("span", { class: "mono" }, "%APPDATA%\\VanDyke\\Config\\Sessions"),
        ", and on macOS ",
        h("span", { class: "mono" }, "~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions"),
        ". Hosts, ports, usernames, serial settings and folders come across; saved passwords don't."),
      confirm: "Choose folder…",
    });
    if (!proceed) return;
    const dir = await openDialog({ directory: true, multiple: false, title: "SecureCRT Sessions folder" });
    if (typeof dir !== "string") return;
    try {
      const report = await api.importSecureCrt(dir);
      if (!report.sessions.length) {
        await alertDialog("Nothing to import", report.skipped.length ? `Skipped ${report.skipped.length} file(s) with unsupported protocols.` : "No session files were found in that folder.");
        return;
      }
      const existing = new Set(store.sessions.map((s) => `${s.folder}/${s.name}`.toLowerCase()));
      const fresh = report.sessions.filter((s) => !existing.has(`${s.folder}/${s.name}`.toLowerCase()));
      const dupes = report.sessions.length - fresh.length;
      const ok = await modal<boolean>((done) => ({
        title: `Import ${fresh.length} session${fresh.length === 1 ? "" : "s"}?`,
        body: h("div", { class: "callout" },
          h("div", {}, `${report.sessions.length} found.`),
          dupes ? h("div", {}, `${dupes} already exist with the same name and folder and will be left alone.`) : null,
          report.skipped.length ? h("div", {}, `${report.skipped.length} skipped (unsupported protocols such as TAPI or RLogin).`) : null,
        ),
        foot: [h("button", { type: "button", class: "btn", onclick: () => done(false) }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, "Import")],
        onSubmit: () => done(true),
      }));
      if (ok && fresh.length) {
        await store.saveSessions(fresh);
        toast(`Imported ${fresh.length} sessions`);
      }
    } catch (e) {
      await alertDialog("Import failed", (e as { message?: string }).message ?? String(e));
    }
  }

  toggleBroadcast() {
    this.tabs.setBroadcast(!this.tabs.broadcast);
    this.tabs.active?.focus();
  }

  toggleTile() {
    this.tabs.setTiled(!this.tabs.tiled);
    this.tabs.active?.focus();
  }

  zoom(delta: number) {
    const size = delta === 0 ? 14 : Math.min(40, Math.max(8, store.settings.fontSize + delta));
    store.saveSettings({ ...store.settings, fontSize: size });
  }

  // ---------- palette ----------

  async palette() {
    type Item = { label: string; sub?: string; kbd?: string; run: () => void };
    const actions: Item[] = [
      { label: "New session", kbd: `${MOD}+Shift+N`, run: () => this.create("") },
      { label: "Quick connect", kbd: `${MOD}+Shift+T`, run: () => this.sidebar.quickInput.focus() },
      { label: "Open local shell", kbd: `${MOD}+Shift+E`, run: () => this.openLocal() },
      { label: this.tabs.broadcast ? "Stop broadcasting" : "Broadcast to all tabs", kbd: `${MOD}+Shift+B`, run: () => this.toggleBroadcast() },
      { label: this.tabs.tiled ? "Show one tab" : "Tile all tabs", kbd: `${MOD}+Shift+G`, run: () => this.toggleTile() },
      { label: "Toggle command bar", kbd: `${MOD}+Shift+O`, run: () => this.toggleCmdBar() },
      { label: "Toggle button bar", run: () => store.saveSettings({ ...store.settings, showButtonBar: !store.settings.showButtonBar }) },
      { label: "Edit button bars", run: () => this.editBars() },
      { label: "Edit keyword highlighting", run: () => this.editHl() },
      { label: "Settings", kbd: `${MOD}+,`, run: () => this.openSettings() },
      { label: "Import SecureCRT sessions", run: () => this.importSecureCrt() },
      { label: "Open log folder", run: () => api.openFolder("logs") },
      { label: "Toggle sidebar", run: () => this.root.classList.toggle("sidebar-hidden") },
    ];
    const t = this.tabs.active;
    if (t) {
      actions.push(
        { label: t.state === "connected" ? "Disconnect tab" : "Reconnect tab", kbd: `${MOD}+Shift+R`, run: () => (t.state === "connected" ? t.disconnect() : t.connect()) },
        { label: "Find in scrollback", kbd: `${MOD}+Shift+F`, run: () => t.openFind() },
        { label: t.logPath ? "Stop logging" : "Start logging", kbd: `${MOD}+Shift+L`, run: () => t.toggleLogging() },
        { label: "Send break", kbd: `${MOD}+Shift+K`, run: () => t.sendBreak() },
        { label: "Clear scrollback", run: () => t.term.clear() },
      );
    }
    const sessions: Item[] = store.sessions.map((s) => ({ label: s.name, sub: `${s.folder ? s.folder + " — " : ""}${hostLabel(s.protocol)}`, run: () => this.tabs.open(s, true) }));
    const tabItems: Item[] = this.tabs.tabs.map((x) => ({ label: `Go to tab: ${x.title}`, sub: x.statusMessage, run: () => this.tabs.activate(x) }));
    const all = [...sessions, ...tabItems, ...actions];

    const input = h("input", { type: "text", placeholder: "Connect to a session or run a command", spellcheck: "false" });
    const list = h("ul", { role: "listbox" });
    let sel = 0;
    let shown: Item[] = [];
    let close: (v: Item | undefined) => void = () => {};
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = (q ? all.filter((i) => fuzzy(`${i.label} ${i.sub ?? ""}`.toLowerCase(), q)) : all).slice(0, 60);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      clear(list);
      shown.forEach((i, idx) =>
        list.append(
          h("li", { class: idx === sel ? "sel" : "", role: "option", onclick: () => close(i), onmousemove: () => { if (sel !== idx) { sel = idx; render(); } } },
            h("span", {}, i.label), i.sub ? h("span", { class: "sub" }, i.sub) : null, i.kbd ? h("span", { class: "kbd" }, i.kbd) : null),
        ),
      );
      list.children[sel]?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => { sel = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") sel = Math.min(shown.length - 1, sel + 1);
      else if (e.key === "ArrowUp") sel = Math.max(0, sel - 1);
      else if (e.key === "Enter") { if (shown[sel]) close(shown[sel]); }
      else return;
      e.preventDefault();
      render();
    });
    render();
    const picked = await new Promise<Item | undefined>((resolve) => {
      const dlg = h("dialog", { class: "palette" }, input, list);
      close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(undefined); });
      dlg.addEventListener("click", (e) => { if (e.target === dlg) close(undefined); });
      document.body.append(dlg);
      dlg.showModal();
      input.focus();
    });
    if (picked) picked.run();
    else this.tabs.active?.focus();
  }

  // ---------- keyboard ----------

  shortcut(e: KeyboardEvent) {
    if (document.querySelector("dialog[open]")) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const t = this.tabs.active;
    let handled = true;
    if (mod && e.shiftKey) {
      switch (key) {
        case "p": this.palette(); break;
        case "t": this.sidebar.quickInput.focus(); break;
        case "n": this.create(""); break;
        case "e": this.openLocal(); break;
        case "w": if (t) this.tabs.close(t); break;
        case "r": if (t) t.state === "connected" ? t.disconnect() : t.connect(); break;
        case "f": t?.openFind(); break;
        case "l": t?.toggleLogging(); break;
        case "k": t?.sendBreak(); break;
        case "b": this.toggleBroadcast(); break;
        case "g": this.toggleTile(); break;
        case "o": this.toggleCmdBar(); break;
        case "c": if (t?.term.hasSelection()) navigator.clipboard.writeText(t.term.getSelection()); break;
        case "v": t?.pasteFromClipboard(); break;
        case "s": this.sidebar.filterInput.focus(); break;
        default: handled = false;
      }
    } else if (e.ctrlKey && (key === "Tab" || key === "PageDown" || key === "PageUp")) {
      this.tabs.cycle(key === "PageUp" || (key === "Tab" && e.shiftKey) ? -1 : 1);
    } else if (!isMac && e.altKey && /^[1-9]$/.test(key)) {
      const target = key === "9" ? this.tabs.tabs.at(-1) : this.tabs.tabs[Number(key) - 1];
      if (target) this.tabs.activate(target);
    } else if (mod && (key === "=" || key === "+")) {
      this.zoom(1);
    } else if (mod && key === "-") {
      this.zoom(-1);
    } else if (mod && key === "0") {
      this.zoom(0);
    } else if (mod && key === ",") {
      this.openSettings();
    } else if (isMac && e.metaKey && !e.shiftKey && key === "t") {
      this.sidebar.quickInput.focus();
    } else if (isMac && e.metaKey && !e.shiftKey && key === "w") {
      if (t) this.tabs.close(t);
    } else if (isMac && e.metaKey && !e.shiftKey && key === "f") {
      t?.openFind();
    } else if (isMac && e.metaKey && !e.shiftKey && key === "k") {
      t?.term.clear();
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

function fuzzy(hay: string, q: string): boolean {
  return q.split(/\s+/).every((word) => {
    if (hay.includes(word)) return true;
    let i = 0;
    for (const c of hay) if (c === word[i]) i++;
    return i === word.length && word.length > 2;
  });
}

new App().start().catch((e) => {
  document.body.textContent = `Tether couldn't start: ${e?.message ?? e}`;
  console.error(e);
});
