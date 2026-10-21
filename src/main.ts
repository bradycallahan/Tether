import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { findSession, parseLink, savedFor } from "./quickconnect";
import { api } from "./api";
import { commands, isMac, type Command } from "./commands";
import { clear, h, icon } from "./dom";
import { confirmDialog, promptText, toast } from "./dialogs";
import { dialogRequest, followDialogChanges, inWindow, runDialogWindow } from "./dialogwin";
import { importSecureCrt, runDialog, type DialogRequest, type SessionEditResult, type SettingsPage } from "./editors";
import { aboutDialog, referenceDialog, shortcutsDialog } from "./help";
import { closeMenus, cmd, menuOpen, menuPoint, showMenu, type MenuEntry, type MenuItem } from "./menu";
import { MenuBar, Toolbar, type MenuDef } from "./menubar";
import { Omnibox } from "./omnibox";
import { draggedSessionIds, isSessionDrag, quickSession, Sidebar } from "./sidebar";
import { folderName, isUnder, joinFolder, store } from "./state";
import { TabManager, type Tab, type TabState } from "./tabs";
import { hostLabel, newSession, PROTOCOL_NAMES, type LaunchTarget, type ButtonBar, type HighlightSet, type Protocol, type Session, type Settings, type ShellInfo } from "./types";
import { Welcome } from "./welcome";
import { guardWebview, setWindowTheme } from "./platform";
import { offerAtFirstRun, unlockAtStartup } from "./vault";

const MANY_TABS = 8;

class App {
  root = document.getElementById("app")!;
  sidebar!: Sidebar;
  tabs!: TabManager;
  menubar!: MenuBar;
  toolbar!: Toolbar;
  omnibox!: Omnibox;
  welcome!: Welcome;
  barSelect!: HTMLSelectElement;
  barButtons!: HTMLElement;
  buttonBarEl!: HTMLElement;
  cmdBar!: HTMLElement;
  cmdInput!: HTMLTextAreaElement;
  cmdTarget!: HTMLButtonElement;
  statusEl!: HTMLElement;
  uptimeEl: HTMLElement | null = null;
  currentBar: string | null = null;
  history: string[] = [];
  /** Always on top lasts until Tether closes, like SecureCRT's. */
  private onTop = false;
  /** Shells found on this machine, default first; filled in shortly after startup. */
  shells: ShellInfo[] = [];
  historyPos = -1;
  private uptimeTimer: number | undefined;
  private windowTitle = "";
  private lastActive: Tab | null = null;
  /** True until the last workspace has been read back, so startup doesn't overwrite it. */
  private restoring = true;
  private savedWorkspace = "";

  async start() {
    await store.load();
    this.applyTheme();
    this.registerCommands();
    this.build();
    store.on("settings", () => {
      this.applyTheme();
      this.applyChrome();
      for (const t of this.tabs.tabs) t.applySettings();
      this.renderBars();
      this.refresh();
    });
    store.on("highlights", () => this.tabs.tabs.forEach((t) => t.applyHighlightSet()));
    store.on("bars", () => this.renderBars());
    store.on("sessions", () => this.refresh());
    // The taskbar jump list follows recent sessions (and their names).
    let jumpTimer: number | undefined;
    const jump = () => {
      clearTimeout(jumpTimer);
      jumpTimer = window.setTimeout(() => this.updateJumpList(), 500);
    };    store.on("recent", jump);
    store.on("sessions", jump);
    jump();
    followDialogChanges();
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => this.applyTheme());
    addEventListener("keydown", (e) => this.shortcut(e), true);
    if (!isMac) this.altTapsMenuBar();
    guardWebview();
    addEventListener("focus", () => this.tabs.active?.tabEl.classList.remove("unread"));
    // Saved passwords must be unlocked before restored tabs connect with them.
    if ((await api.vaultStatus().catch(() => undefined))?.enabled) {
      await api.windowReady().catch(() => {});
      await unlockAtStartup();
    }
    this.restoreWorkspace();
    // A jump-list entry, shortcut or ssh:// link Tether was started with; later
    // ones arrive from a second launch, which hands them over and exits.
    api.takeLaunchTargets().then((t) => this.openTargets(t)).catch(() => {});
    listen<LaunchTarget[]>("open-targets", (e) => this.openTargets(e.payload)).catch(() => {});
    this.guardClose();
    store.shells().then((list) => (this.shells = list));
    // The window starts hidden; show it once this first frame has painted.
    requestAnimationFrame(() => requestAnimationFrame(() => api.windowReady().catch(() => {})));
    setTimeout(() => offerAtFirstRun(), 400);
  }

  applyTheme() {
    const pref = store.settings.uiTheme;
    const light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
    setWindowTheme(pref === "system" ? null : pref);
    this.root.style.setProperty("--sidebar-w", `${store.settings.sidebarWidth}px`);
  }

  /** Show or hide the optional parts of the window. */
  applyChrome() {
    const s = store.settings;
    this.root.classList.toggle("sidebar-hidden", !s.showSidebar);
    this.toolbar.el.hidden = !s.showToolbar;
    this.statusEl.hidden = !s.showStatusBar;
    this.buttonBarEl.hidden = !s.showButtonBar;
    this.cmdBar.hidden = !s.showCommandBar;
    this.tabs?.tabs.forEach((t) => t.fitSoon());
  }

  // ---------------------------------------------------------------------------
  // Commands

  registerCommands() {
    const active = () => this.tabs?.active ?? null;
    const has = () => !!active();
    const connected = () => active()?.state === "connected";
    const toggle = (key: keyof Settings) => () => store.patchSettings({ [key]: !store.settings[key] } as Partial<Settings>);
    const shown = (key: keyof Settings) => () => !!store.settings[key];
    const list: Command[] = [
      // File
      { id: "session.new", label: "New session…", icon: "plus", keys: ["Mod+Shift+N"], run: () => this.create(this.newSessionFolder()) },
      { id: "folder.new", label: "New folder…", icon: "folderPlus", run: () => this.createFolder("") },
      { id: "connect.focus", label: "Connect to address", icon: "bolt", detail: "Type an address or session name", keys: ["Mod+Shift+T"], macKeys: ["Meta+T"], run: () => this.focusOmnibox() },
      { id: "connect.quick", label: "Quick connect…", icon: "bolt", run: () => this.quickConnect() },
      { id: "connect.serial", label: "Serial console…", icon: "serial", run: () => this.quickConnect("serial") },
      { id: "connect.local", label: "Local shell", icon: "terminal", keys: ["Mod+Shift+E"], run: () => this.openLocal() },
      { id: "tab.reconnect", label: "Reconnect", icon: "refresh", detail: "Reconnect this tab", keys: ["Mod+Shift+R"], enabled: () => has() && !connected(), run: () => active()?.reconnectNow() },
      { id: "tab.disconnect", label: "Disconnect", icon: "unplug", detail: "Disconnect this tab", keys: ["Mod+Shift+R"], enabled: () => connected() || active()?.state === "connecting", run: () => active()?.disconnect() },
      { id: "tab.reconnectAll", label: "Reconnect all closed tabs", enabled: () => this.tabs.tabs.some((t) => t.state === "closed" || t.state === "idle"), run: () => this.tabs.tabs.filter((t) => t.state === "closed" || t.state === "idle").forEach((t) => t.reconnectNow()) },
      { id: "tab.disconnectAll", label: "Disconnect all", enabled: () => this.tabs.tabs.some((t) => t.state === "connected"), run: () => this.disconnectAll() },
      { id: "log.toggle", label: "Log session", icon: "log", detail: "Log this tab to a file", keys: ["Mod+Shift+L"], enabled: connected, checked: () => !!active()?.logPath, run: () => active()?.toggleLogging() },
      { id: "log.openFolder", label: "Open log folder", run: () => api.openFolder("logs") },
      { id: "import.securecrt", label: "Import from SecureCRT…", icon: "import", run: () => this.importSecureCrt() },
      { id: "tab.close", label: "Close tab", keys: ["Mod+Shift+W", "Ctrl+F4"], macKeys: ["Meta+W"], enabled: has, run: () => active() && this.tabs.close(active()!) },
      { id: "app.quit", label: isMac ? "Quit Tether" : "Exit", run: () => getCurrentWindow().close() },
      // Edit
      { id: "edit.copy", label: "Copy", icon: "copy", keys: ["Mod+Shift+C", "Ctrl+Insert"], macKeys: ["Meta+C"], enabled: () => !!active()?.term.hasSelection(), run: () => active()?.copySelection() },
      { id: "edit.paste", label: "Paste", icon: "paste", keys: ["Mod+Shift+V", "Shift+Insert"], macKeys: ["Meta+V"], enabled: has, run: () => active()?.pasteFromClipboard() },
      { id: "edit.selectAll", label: "Select all", keys: ["Mod+Shift+A"], macKeys: ["Meta+A"], enabled: has, run: () => active()?.term.selectAll() },
      { id: "edit.find", label: "Find…", icon: "search", detail: "Find in scrollback", keys: ["Mod+Shift+F"], macKeys: ["Meta+F"], enabled: has, run: () => active()?.openFind() },
      { id: "edit.clear", label: "Clear scrollback", icon: "eraser", macKeys: ["Meta+K"], enabled: has, run: () => active()?.clearScrollback() },
      { id: "edit.reset", label: "Reset terminal", detail: "Fix a terminal garbled by binary output", enabled: has, run: () => active()?.term.reset() },
      // View
      { id: "view.sidebar", label: "Session manager", icon: "sidebar", keys: ["Mod+Shift+M"], checked: shown("showSidebar"), run: toggle("showSidebar") },
      { id: "view.findSession", label: "Find a saved session", icon: "search", keys: ["Mod+Shift+S"], run: () => this.findSession() },
      { id: "view.toolbar", label: "Toolbar", checked: shown("showToolbar"), run: toggle("showToolbar") },
      { id: "view.buttonBar", label: "Button bar", checked: shown("showButtonBar"), run: toggle("showButtonBar") },
      { id: "view.cmdBar", label: "Command window", icon: "command", detail: "Compose a command before sending it", keys: ["Mod+Shift+O"], checked: shown("showCommandBar"), run: () => this.toggleCmdBar() },
      { id: "view.statusBar", label: "Status bar", checked: shown("showStatusBar"), run: toggle("showStatusBar") },
      { id: "view.tile", label: "Tile tabs", icon: "tile", detail: "Show every tab at once", keys: ["Mod+Shift+G"], enabled: () => this.tabs.tabs.length > 1 || this.tabs.tiled, checked: () => this.tabs.tiled, run: () => this.toggleTile() },
      { id: "view.onTop", label: "Always on top", detail: "Keep Tether above other windows", checked: () => this.onTop, run: () => this.toggleOnTop() },
      { id: "view.fullscreen", label: "Full screen", icon: "fullscreen", keys: ["F11"], macKeys: ["Ctrl+Meta+F"], run: () => this.toggleFullscreen() },
      { id: "view.zoomIn", label: "Bigger text", keys: ["Mod+=", "Mod++"], run: () => this.zoom(1) },
      { id: "view.zoomOut", label: "Smaller text", keys: ["Mod+-"], run: () => this.zoom(-1) },
      { id: "view.zoomReset", label: "Actual size", keys: ["Mod+0"], run: () => this.zoom(0) },
      { id: "view.theme.system", label: "Match system", checked: () => store.settings.uiTheme === "system", run: () => store.patchSettings({ uiTheme: "system" }) },
      { id: "view.theme.dark", label: "Dark", checked: () => store.settings.uiTheme === "dark", run: () => store.patchSettings({ uiTheme: "dark" }) },
      { id: "view.theme.light", label: "Light", checked: () => store.settings.uiTheme === "light", run: () => store.patchSettings({ uiTheme: "light" }) },
      // Session
      { id: "session.options", label: "Session options…", icon: "sliders", detail: "Edit this session's settings", keys: ["Alt+Enter"], enabled: () => has() || this.sidebar?.selectedSessions().length === 1, run: () => this.sessionOptions() },
      { id: "session.loginActions", label: "Login actions…", icon: "play", enabled: has, run: () => active() && this.editFromTab(active()!, "login") },
      { id: "tab.rename", label: "Rename tab…", enabled: has, run: () => active() && this.renameTab(active()!) },
      { id: "tab.clone", label: "Clone tab", icon: "clone", detail: "Open another tab to the same device", keys: ["Mod+Shift+D"], enabled: has, run: () => active() && this.cloneTab(active()!) },
      { id: "tab.save", label: "Save as session…", enabled: () => !!active() && !active()!.saved, run: () => active() && this.editFromTab(active()!) },
      { id: "tab.reveal", label: "Show in session manager", enabled: () => !!active()?.saved, run: () => this.revealActive() },
      { id: "tab.break", label: "Send break", keys: ["Mod+Shift+K"], enabled: () => connected() && ["serial", "telnet"].includes(active()!.session.protocol.kind), run: () => active()?.sendBreak() },
      { id: "broadcast.toggle", label: "Broadcast to checked tabs", icon: "broadcast", detail: "Type into every checked tab at once", keys: ["Mod+Shift+B"], checked: () => this.tabs.broadcast, run: () => this.toggleBroadcast() },
      { id: "broadcast.member", label: "Include this tab in broadcast", enabled: has, checked: () => !!active()?.inBroadcast, run: () => active()?.setBroadcastMember(!active()!.inBroadcast) },
      { id: "broadcast.checkAll", label: "Check all tabs", enabled: () => this.tabs.tabs.length > 0, run: () => this.tabs.tabs.forEach((t) => t.setBroadcastMember(true)) },
      { id: "broadcast.uncheckAll", label: "Uncheck all tabs", enabled: () => this.tabs.tabs.length > 0, run: () => this.tabs.tabs.forEach((t) => t.setBroadcastMember(false)) },
      // Tools
      { id: "tools.palette", label: "Command palette…", icon: "command", keys: ["Mod+Shift+P"], run: () => this.palette() },
      { id: "tools.buttonBars", label: "Button bars…", icon: "buttons", run: () => this.editBars() },
      { id: "tools.highlights", label: "Keyword highlighting…", icon: "highlight", run: () => this.editHl() },
      { id: "tools.dataFolder", label: "Open data folder", run: () => api.openFolder("data") },
      { id: "tools.settings", label: "Settings…", icon: "gear", keys: ["Mod+,"], run: () => this.openSettings() },
      // Window
      { id: "tab.next", label: "Next tab", keys: ["Ctrl+Tab", "Ctrl+PageDown"], macKeys: ["Ctrl+Tab", "Meta+Shift+]"], enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.cycle(1) },
      { id: "tab.prev", label: "Previous tab", keys: ["Ctrl+Shift+Tab", "Ctrl+PageUp"], macKeys: ["Ctrl+Shift+Tab", "Meta+Shift+["], enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.cycle(-1) },
      { id: "tab.closeOthers", label: "Close other tabs", enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.closeMany(this.tabs.tabs.filter((t) => t !== active())) },
      { id: "tab.closeAll", label: "Close all tabs", enabled: () => this.tabs.tabs.length > 0, run: () => this.tabs.closeMany([...this.tabs.tabs]) },
      // Help
      { id: "help.shortcuts", label: "Keyboard shortcuts", icon: "keyboard", keys: ["F1"], run: () => shortcutsDialog(this.shortcutGroups()) },
      { id: "help.reference", label: "Quick reference", icon: "help", detail: "Address formats, send-string escapes and login tokens", run: () => referenceDialog() },
      { id: "help.about", label: "About Tether", icon: "info", run: () => aboutDialog() },
    ];
    for (let n = 1; n <= 9; n++) {
      list.push({
        id: `tab.goto${n}`,
        label: n === 9 ? "Go to last tab" : `Go to tab ${n}`,
        keys: [`Alt+${n}`],
        macKeys: [`Meta+${n}`],
        hideInPalette: true,
        run: () => {
          const t = n === 9 ? this.tabs.tabs.at(-1) : this.tabs.tabs[n - 1];
          if (t) this.tabs.activate(t);
        },
      });
    }
    commands.add(...list);
  }

  menus(): MenuDef[] {
    return [
      {
        label: "File",
        items: () => [
          cmd("session.new"), cmd("folder.new"), "-",
          cmd("connect.focus"), cmd("connect.quick"), cmd("connect.serial"), cmd("connect.local"),
          ...this.shellMenu(),
          { label: "Recent sessions", icon: "clock", submenu: this.recentMenu() }, "-",
          cmd("tab.reconnect"), cmd("tab.disconnect"), cmd("tab.reconnectAll"), cmd("tab.disconnectAll"), "-",
          cmd("log.toggle"), cmd("log.openFolder"), "-",
          cmd("import.securecrt"), "-",
          cmd("tab.close"), cmd("app.quit"),
        ],
      },
      {
        label: "Edit",
        items: () => [cmd("edit.copy"), cmd("edit.paste"), cmd("edit.selectAll"), "-", cmd("edit.find"), "-", cmd("edit.clear"), cmd("edit.reset")],
      },
      {
        label: "View",
        items: () => [
          cmd("view.sidebar"), cmd("view.toolbar"), cmd("view.buttonBar"), cmd("view.cmdBar"), cmd("view.statusBar"), "-",
          cmd("view.tile"), cmd("view.onTop"), cmd("view.fullscreen"), "-",
          cmd("view.zoomIn"), cmd("view.zoomOut"), cmd("view.zoomReset"), "-",
          { label: "Theme", submenu: [cmd("view.theme.system"), cmd("view.theme.dark"), cmd("view.theme.light")] },
        ],
      },
      {
        label: "Session",
        items: () => [
          cmd("session.options"), cmd("session.loginActions"), cmd("tab.rename"), cmd("tab.clone"), cmd("tab.save"), cmd("tab.reveal"), "-",
          cmd("tab.break"), "-",
          cmd("broadcast.toggle"), cmd("broadcast.member"), cmd("broadcast.checkAll"), cmd("broadcast.uncheckAll"),
        ],
      },
      {
        label: "Tools",
        items: () => [cmd("tools.palette"), "-", cmd("tools.buttonBars"), cmd("tools.highlights"), "-", cmd("tools.dataFolder"), cmd("tools.settings")],
      },
      {
        label: "Window",
        items: () => [
          cmd("tab.next"), cmd("tab.prev"), "-", cmd("tab.closeOthers"), cmd("tab.closeAll"),
          ...(this.tabs.tabs.length ? (["-"] as MenuEntry[]) : []),
          ...this.tabs.tabs.map((t, i): MenuItem => ({
            label: t.title,
            checked: t === this.tabs.active,
            hint: stateWord(t.state),
            shortcut: i < 8 ? commands.shortcut(`tab.goto${i + 1}`) : undefined,
            action: () => this.tabs.activate(t),
          })),
        ],
      },
      { label: "Help", items: () => [cmd("help.shortcuts"), cmd("help.reference"), "-", cmd("help.about")] },
    ];
  }

  shortcutGroups() {
    const ids = commands.all().map((c) => c.id);
    const group = (title: string, prefixes: string[]) => ({ title, ids: ids.filter((id) => prefixes.some((p) => id.startsWith(p))) });
    return [
      group("Connecting", ["session.new", "connect.", "tab.reconnect", "tab.disconnect"]),
      group("Tabs", ["tab.close", "tab.clone", "tab.next", "tab.prev"]),
      group("Terminal", ["edit.", "log.", "tab.break", "view.zoom", "view.fullscreen"]),
      group("Working with many devices", ["broadcast.", "view.tile", "view.cmdBar"]),
      group("Finding things", ["tools.palette", "view.findSession", "view.sidebar"]),
      group("Settings and help", ["session.options", "tools.settings", "help."]),
    ];
  }

  /** "Other shells ▸" with every shell found here, once there's more than one. */
  shellMenu(): MenuItem[] {
    if (this.shells.length < 2) return [];
    return [{ label: "Other shells", icon: "terminal", submenu: this.shells.map((sh): MenuItem => ({ label: sh.name, action: () => this.openLocal(sh) })) }];
  }

  recentMenu(): MenuItem[] {
    const recent = store.recentSessions().slice(0, 10);
    if (!recent.length) return [{ label: "Nothing yet", disabled: true }];
    return recent.map((s) => ({ label: s.name, hint: hostLabel(s.protocol), action: () => this.openSessions([s]) }));
  }

  // ---------------------------------------------------------------------------
  // Layout

  build() {
    this.sidebar = new Sidebar({
      connect: (list, o) => this.openSessions(list, o),
      edit: (s) => this.edit(s),
      create: (folder) => this.create(folder),
      createFolder: (parent) => this.createFolder(parent),
      duplicate: (s) => this.duplicate(s),
      remove: (list) => this.removeSessions(list),
      removeFolder: (path) => this.removeFolder(path),
      importSecureCrt: () => this.importSecureCrt(),
    });

    const splitter = h("div", { class: "splitter", role: "separator", "aria-orientation": "vertical", title: "Drag to resize. Double-click to hide." });
    this.setupSplitter(splitter);

    this.menubar = new MenuBar(this.menus(), () => this.focusTerminal());
    this.omnibox = new Omnibox({
      connectSession: (s) => this.openSessions([s]),
      connectTarget: (p, typed) => this.tabs.open(quickSession(p, typed), false),
      saveTarget: (p) => this.create("", quickSession(p)),
      done: () => this.focusTerminal(),
    });
    this.toolbar = new Toolbar([
      "view.sidebar",
      this.omnibox.el,
      "-",
      "session.new",
      { id: "tab.reconnect", text: "Reconnect" },
      { id: "tab.disconnect", text: "Disconnect" },
      "tab.clone",
      "-",
      "edit.copy",
      "edit.paste",
      "edit.find",
      "-",
      { id: "log.toggle", text: "Log" },
      { id: "broadcast.toggle", text: "Broadcast" },
      { id: "view.tile", text: "Tile" },
      "view.cmdBar",
      "grow",
      "session.options",
      "tools.settings",
    ]);

    // Tab strip
    const tabsEl = h("div", { class: "tabs", role: "tablist", "aria-label": "Open tabs" });
    const newTab = h("button", {
      type: "button",
      class: "newtab",
      title: "New tab",
      onclick: (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.newTabMenu(r.left, r.bottom + 2);
      },
    }, icon("plus"));
    const strip = h("div", { class: "tabstrip" }, tabsEl, newTab, h("span", { class: "strip-fill", ondblclick: () => this.focusOmnibox() }));

    this.welcome = new Welcome({
      connect: (s) => this.openSessions([s]),
      connectSerial: (p) => this.tabs.open(quickSession(p, p.kind === "serial" ? p.port : hostLabel(p)), false),
      run: (id) => commands.run(id),
    });
    const panes = h("div", { class: "panes" }, this.welcome.el);
    this.setupSessionDrop(panes);
    this.setupSessionDrop(strip);

    // Command window
    this.cmdInput = h("textarea", { rows: 1, placeholder: "Type a command, then Enter. Ctrl+Enter adds a line, Up recalls history, escapes like \\r and ^C work.", spellcheck: "false", "aria-label": "Command window" });
    this.cmdInput.addEventListener("input", () => this.fitCmdInput());
    this.cmdTarget = h("button", { type: "button", class: "target", title: "Click to switch between this tab and broadcasting to checked tabs", onclick: () => this.toggleBroadcast(false) });
    this.cmdInput.addEventListener("keydown", (e) => this.cmdKey(e));
    this.cmdBar = h("div", { class: "cmdbar" },
      h("span", { class: "label-text" }, "Send to"),
      this.cmdTarget,
      this.cmdInput,
      h("button", { type: "button", class: "btn", onclick: () => this.sendCmd() }, "Send"),
      h("button", { type: "button", class: "btn ghost icon-only", title: "Close the command window", onclick: () => this.toggleCmdBar(false) }, icon("close")),
    );

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
    this.barButtons = h("div", { class: "bar-buttons" });
    this.buttonBarEl = h("div", { class: "buttonbar", role: "toolbar", "aria-label": "Button bar" }, this.barSelect, h("span", { class: "sep" }), this.barButtons);
    this.buttonBarEl.addEventListener("contextmenu", (e) => {
      if ((e.target as Element).closest(".sbtn")) return;
      e.preventDefault();
      this.barMenu(e.clientX, e.clientY, null);
    });
    this.currentBar = store.settings.defaultButtonBar;

    this.statusEl = h("footer", { class: "status" });
    this.tabs = new TabManager(tabsEl, strip, panes, this.welcome.el, {
      changed: () => this.refresh(),
      editSession: (tab) => this.editFromTab(tab),
      tabMenu: (tab, x, y) => this.tabMenu(tab, x, y),
    });

    const workspace = h("main", { class: "workspace" }, strip, panes, this.cmdBar, this.buttonBarEl);
    clear(this.root);
    this.root.append(this.menubar.el, this.toolbar.el, this.sidebar.el, splitter, workspace, this.statusEl);
    this.applyChrome();
    this.renderBars();
    this.welcome.render();
    this.welcome.refreshPorts();
    this.refresh();
  }

  setupSplitter(el: HTMLElement) {
    el.addEventListener("dblclick", () => store.patchSettings({ showSidebar: false }));
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
        if (w !== store.settings.sidebarWidth) store.patchSettings({ sidebarWidth: w });
        this.tabs.tabs.forEach((t) => t.fitSoon());
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }

  /** Dropping sessions from the tree onto the tab area opens them. */
  setupSessionDrop(el: HTMLElement) {
    el.addEventListener("dragover", (e) => {
      if (!isSessionDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      el.classList.add("drop-open");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop-open");
    });
    el.addEventListener("drop", (e) => {
      el.classList.remove("drop-open");
      const ids = draggedSessionIds(e);
      if (!ids) return;
      e.preventDefault();
      this.openSessions(ids.map((id) => store.session(id)).filter((s): s is Session => !!s));
    });
  }

  focusTerminal() {
    this.tabs.active?.focus();
  }

  focusOmnibox() {
    if (!store.settings.showToolbar) store.patchSettings({ showToolbar: true });
    this.omnibox.focus();
  }

  findSession() {
    if (!store.settings.showSidebar) store.patchSettings({ showSidebar: true });
    this.sidebar.focusFilter();
  }

  // ---------------------------------------------------------------------------
  // Bars

  renderBars() {
    clear(this.barSelect);
    for (const b of store.bars) this.barSelect.append(h("option", { value: b.name, selected: b.name === this.currentBar }, b.name));
    this.barSelect.append(h("option", { value: "__edit" }, "Edit bars…"));
    if (!store.bars.some((b) => b.name === this.currentBar)) this.currentBar = store.bars[0]?.name ?? null;
    this.barSelect.value = this.currentBar ?? "";
    this.renderBarButtons();
  }

  renderBarButtons() {
    clear(this.barButtons);
    const bar = store.bars.find((b) => b.name === this.currentBar);
    bar?.buttons.forEach((b, i) => {
      const btn = h("button", {
        type: "button",
        class: "sbtn",
        title: `Sends ${b.send}\nShift+click sends it to every connected tab`,
        onclick: (e: MouseEvent) => this.tabs.sendString(b.send, e.shiftKey),
        onpointerdown: (e: Event) => e.preventDefault(),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          const at = menuPoint(e);
          this.barMenu(at.x, at.y, i);
        },
      }, b.label || b.send);
      if (b.color) btn.style.setProperty("--btn-color", b.color);
      this.barButtons.append(btn);
    });
    this.barButtons.append(
      h("button", {
        type: "button",
        class: `btn ghost add ${bar?.buttons.length ? "icon-only" : ""}`,
        title: "Add a button",
        onclick: () => this.editOneButton(null),
      }, icon("plus"), bar?.buttons.length ? null : "Add a button"),
    );
  }

  barMenu(x: number, y: number, index: number | null) {
    const bar = store.bars.find((b) => b.name === this.currentBar);
    const entries: MenuEntry[] = [];
    if (index !== null && bar) {
      const n = bar.buttons.length;
      const move = (d: number) => {
        const bars = structuredClone(store.bars);
        const b = bars.find((x) => x.name === bar.name)!;
        [b.buttons[index], b.buttons[index + d]] = [b.buttons[index + d], b.buttons[index]];
        store.saveBars(bars);
      };
      entries.push(
        { label: "Edit button…", icon: "edit", action: () => this.editOneButton(index) },
        { label: "Move left", disabled: index === 0, action: () => move(-1) },
        { label: "Move right", disabled: index === n - 1, action: () => move(1) },
        {
          label: "Delete button",
          icon: "trash",
          danger: true,
          action: () => {
            const bars = structuredClone(store.bars);
            const removed = bars.find((x) => x.name === bar.name)!.buttons.splice(index, 1)[0];
            const before = structuredClone(store.bars);
            store.saveBars(bars);
            toast(`Deleted “${removed.label}”`, { action: { label: "Undo", run: () => store.saveBars(before) } });
          },
        },
        "-",
      );
    }
    entries.push(
      { label: "New button…", icon: "plus", action: () => this.editOneButton(null) },
      { label: "Edit button bars…", icon: "edit", action: () => this.editBars() },
      "-",
      cmd("view.buttonBar", { label: "Show button bar" }),
    );
    showMenu(x, y, entries);
  }

  async editOneButton(index: number | null) {
    const bars = await dialog<ButtonBar[]>({ kind: "button", bar: this.currentBar ?? store.bars[0]?.name ?? "My buttons", index });
    if (bars) {
      await store.saveBars(bars);
      if (!this.currentBar) this.currentBar = bars[0]?.name ?? null;
      this.renderBars();
    }
    this.focusTerminal();
  }

  async editBars() {
    const bars = await dialog<ButtonBar[]>({ kind: "bars", bar: this.currentBar ?? undefined });
    if (bars) await store.saveBars(bars);
    this.focusTerminal();
  }

  async editHl() {
    const sets = await dialog<HighlightSet[]>({ kind: "highlights" });
    if (sets) await store.saveHighlights(sets);
  }

  // ---------------------------------------------------------------------------
  // Command window

  toggleCmdBar(force?: boolean) {
    const show = force ?? !store.settings.showCommandBar;
    store.patchSettings({ showCommandBar: show });
    if (show) setTimeout(() => this.cmdInput.focus());
    else this.focusTerminal();
  }

  sendCmd() {
    const v = this.cmdInput.value;
    if (v.trim() && this.history[0] !== v) this.history.unshift(v);
    this.history.length = Math.min(this.history.length, 200);
    this.historyPos = -1;
    // Each line of a multi-line command is sent with its own Enter.
    const text = v.replace(/\r?\n/g, "\\r");
    const hasEnter = /\\[rn]$/.test(text);
    this.tabs.sendString(hasEnter ? text : text + "\\r").then(() => this.cmdInput.focus());
    this.setCmdInput("");
  }

  private setCmdInput(v: string) {
    this.cmdInput.value = v;
    this.fitCmdInput();
  }

  /** Grow with the text, up to six lines. */
  private fitCmdInput() {
    const lines = Math.min(6, this.cmdInput.value.split("\n").length);
    this.cmdInput.rows = lines;
  }

  cmdKey(e: KeyboardEvent) {
    const el = this.cmdInput;
    const multiline = el.value.includes("\n");
    if (e.key === "Enter" && (e.ctrlKey || e.shiftKey)) {
      el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
      this.fitCmdInput();
    } else if (e.key === "Enter" && !e.altKey && !e.metaKey) {
      this.sendCmd();
    } else if (e.key === "ArrowUp" && (!multiline || el.selectionStart === 0)) {
      if (this.historyPos < this.history.length - 1) this.setCmdInput(this.history[++this.historyPos]);
    } else if (e.key === "ArrowDown" && (!multiline || el.selectionStart === el.value.length)) {
      this.historyPos = Math.max(-1, this.historyPos - 1);
      this.setCmdInput(this.historyPos >= 0 ? this.history[this.historyPos] : "");
    } else if (e.key === "Escape") {
      this.focusTerminal();
    } else return;
    e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Status and refresh

  refresh() {
    if (!this.statusEl || !this.tabs) return;
    const t = this.tabs.active;
    this.toolbar.refresh();

    // Live LEDs in the session tree.
    const live = new Map<string, TabState>();
    const rank: Record<TabState, number> = { connected: 3, connecting: 2, closed: 1, idle: 0 };
    for (const x of this.tabs.tabs) {
      if (!x.saved) continue;
      const cur = live.get(x.session.id);
      if (!cur || rank[x.state] > rank[cur]) live.set(x.session.id, x.state);
    }
    this.sidebar.setLive(live);

    // Command window target.
    const targets = this.tabs.targets();
    const all = this.tabs.broadcast && !!t?.inBroadcast;
    this.cmdTarget.textContent = all ? `${targets.length} checked tab${targets.length === 1 ? "" : "s"}` : t ? t.title : "No tab";
    this.cmdTarget.classList.toggle("all", all);

    // Follow the active session's button bar.
    if (t !== this.lastActive) {
      this.lastActive = t;
      const want = t?.session.buttonBar;
      if (want && want !== this.currentBar && store.bars.some((b) => b.name === want)) {
        this.currentBar = want;
        this.renderBars();
      }
      if (!t) this.welcome.refreshPorts();
    }

    this.renderStatus(t, targets.length);
    this.tickUptime();
    this.persistWorkspace();
  }

  renderStatus(t: Tab | null, targets: number) {
    clear(this.statusEl);
    this.uptimeEl = null;
    const live = this.tabs.tabs.filter((x) => x.state === "connected").length;
    if (!t) {
      this.statusEl.append(h("span", { class: "seg" }, `${store.sessions.length} saved session${store.sessions.length === 1 ? "" : "s"}`));
      this.setWindowTitle("Tether");
      return;
    }
    const stateClass = t.state === "connected" ? "on" : t.state === "connecting" ? "warn" : t.state === "closed" ? "bad" : "";
    this.uptimeEl = h("span", { class: "seg dim" });
    const segs = [
      h("span", { class: `seg ${stateClass}` }, h("span", { class: `led ${t.state === "idle" ? "" : t.state}` }), t.statusMessage),
      h("span", { class: "seg" }, t.session.protocol.kind === "local" ? hostLabel(t.session.protocol) : `${PROTOCOL_NAMES[t.session.protocol.kind]} ${hostLabel(t.session.protocol)}`),
      this.uptimeEl,
      h("span", { class: "grow" }),
      this.tabs.broadcast
        ? h("button", { type: "button", class: "seg warn", title: "Stop broadcasting", onclick: () => this.toggleBroadcast() }, icon("broadcast"), `Broadcasting to ${targets} tab${targets === 1 ? "" : "s"}`)
        : null,
      this.tabs.tabs.length > 1 ? h("span", { class: "seg dim" }, `${live} of ${this.tabs.tabs.length} tabs connected`) : null,
      h("button", { type: "button", class: `seg ${t.logPath ? "on" : ""}`, title: t.logPath ?? commands.tip("log.toggle"), disabled: t.state !== "connected", onclick: () => t.toggleLogging() }, icon("log"), t.logPath ? "Logging" : "Not logging"),
      h("span", { class: "seg dim", title: "Columns × rows" }, `${t.term.cols}×${t.term.rows}`),
    ];
    this.statusEl.append(...segs.filter((x): x is HTMLElement => !!x));
    // Like SecureCRT, the title says when the tab in front isn't connected,
    // so it shows on the taskbar and in Alt+Tab too.
    const state = t.state === "connected" ? "" : t.state === "connecting" ? " (Connecting)" : " (Not connected)";
    this.setWindowTitle(`${t.title}${state} - Tether`);
  }

  setWindowTitle(title: string) {
    if (title === this.windowTitle) return;
    this.windowTitle = title;
    getCurrentWindow().setTitle(title).catch(() => {});
  }

  /** The connected-for clock runs only while a connected tab is in front. */
  tickUptime() {
    const t = this.tabs.active;
    const run = !!t?.connectedAt && !this.statusEl.hidden;
    const paint = () => {
      const at = this.tabs.active?.connectedAt;
      if (this.uptimeEl) this.uptimeEl.textContent = at ? `Up ${formatDuration(Date.now() - at)}` : "";
    };
    paint();
    if (run && this.uptimeTimer === undefined) this.uptimeTimer = window.setInterval(paint, 1000);
    if (!run && this.uptimeTimer !== undefined) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace

  persistWorkspace() {
    if (this.restoring) return;
    const w = store.workspace;
    w.tabs = this.tabs.tabs.map((t) => ({ session: t.session, saved: t.saved, title: t.customTitle ? t.title : "", inBroadcast: t.inBroadcast }));
    w.active = this.tabs.active ? this.tabs.tabs.indexOf(this.tabs.active) : 0;
    w.tiled = this.tabs.tiled;
    const json = JSON.stringify(w);
    if (json === this.savedWorkspace) return;
    this.savedWorkspace = json;
    store.saveWorkspaceSoon();
  }

  restoreWorkspace() {
    const w = store.workspace;
    this.savedWorkspace = JSON.stringify(w);
    if (!store.settings.restoreWorkspace || !w.tabs.length) {
      this.restoring = false;
      setTimeout(() => this.omnibox.input.focus(), 50);
      return;
    }
    try {
      for (const wt of w.tabs) {
        const fresh = wt.saved ? store.session(wt.session.id) : undefined;
        const tab = this.tabs.open(fresh ?? wt.session, !!fresh, { activate: false });
        if (wt.title) tab.setTitle(wt.title);
        tab.setBroadcastMember(wt.inBroadcast);
      }
      const active = this.tabs.tabs[Math.min(w.active, this.tabs.tabs.length - 1)];
      if (active) this.tabs.activate(active);
      if (w.tiled && this.tabs.tabs.length > 1) this.tabs.setTiled(true);
    } finally {
      this.restoring = false;
    }
    this.persistWorkspace();
  }

  /** Ask before closing the window on live connections, and save the workspace. */
  guardClose() {
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        const live = this.tabs.tabs.filter((t) => t.state === "connected").length;
        if (live) {
          e.preventDefault();
          const verb = isMac ? "Quit" : "Exit";
          const they = live === 1 ? "It'll" : "They'll";
          const ok = await confirmDialog({
            title: `${verb} with ${live} connected tab${live === 1 ? "" : "s"}?`,
            message: store.settings.restoreWorkspace ? `${they} be disconnected now and reopened next time Tether starts.` : `${they} be disconnected.`,
            confirm: verb,
          });
          if (!ok) return;
          await store.saveWorkspaceNow();
          await getCurrentWindow().destroy();
          return;
        }
        await store.saveWorkspaceNow();
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Sessions

  updateJumpList() {
    const recent = store.recentSessions().slice(0, 10);
    api.setJumpList(recent.map((s) => ({ id: s.id, name: s.name, detail: `${PROTOCOL_NAMES[s.protocol.kind]} ${hostLabel(s.protocol)}` }))).catch(() => {});
  }

  openTargets(list: LaunchTarget[]) {
    for (const t of list) {
      if (t.kind === "command") {
        commands.run(t.value);
        continue;
      }
      if (t.kind === "session") {
        const s = findSession(t.value, store.sessions);
        if (s) this.openSessions([s]);
        else toast(`There's no saved session called ${t.value}.`);
        continue;
      }
      const p = parseLink(t.value);
      if (!p) {
        toast(`Tether can't open ${t.value.slice(0, 80)}: it isn't a valid ssh:// or telnet:// address.`);
        continue;
      }
      const saved = savedFor(p, store.sessions);
      if (saved) this.openSessions([saved]);
      else this.tabs.open(quickSession(p), false);
    }
  }

  async openSessions(list: Session[], opts: { tile?: boolean } = {}) {
    if (!list.length) return;
    if (list.length > MANY_TABS) {
      const ok = await confirmDialog({ title: `Open ${list.length} tabs?`, message: "Each session opens in its own tab and connects right away.", confirm: `Open ${list.length} tabs` });
      if (!ok) return;
    }
    list.forEach((s, i) => {
      this.tabs.open(s, true, { activate: i === 0 });
      store.touchRecent(s.id);
    });
    if (opts.tile && this.tabs.tabs.length > 1) this.tabs.setTiled(true);
  }

  newSessionFolder(): string {
    return this.sidebar.selectedSessions()[0]?.folder ?? "";
  }

  async saveEdited(r: SessionEditResult) {
    await store.saveSession(r.session);
    for (const [kind, value] of Object.entries(r.secrets)) {
      await api.setSecret(r.session.id, kind as keyof SessionEditResult["secrets"], value).catch((e) => toast(e?.message ?? "Couldn't save the password."));
    }
    for (const t of this.tabs.tabs) if (t.saved && t.session.id === r.session.id) t.updateSession(r.session);
  }

  async create(folder: string, base?: Session) {
    const r = await dialog<SessionEditResult>({ kind: "session", session: base ? { ...base, folder } : newSession({ folder }), isNew: true });
    if (!r) return this.focusTerminal();
    await this.saveEdited(r);
    this.sidebar.reveal(r.session.id);
    if (r.connect) this.openSessions([r.session]);
  }

  async edit(s: Session) {
    const r = await dialog<SessionEditResult>({ kind: "session", session: s, isNew: false });
    if (!r) return;
    await this.saveEdited(r);
    if (r.connect) this.openSessions([r.session]);
  }

  async editFromTab(tab: Tab, page?: "login") {
    const existing = tab.saved ? store.session(tab.session.id) : undefined;
    const r = await dialog<SessionEditResult>({ kind: "session", session: existing ?? tab.session, isNew: !existing, page });
    if (!r) return this.focusTerminal();
    await this.saveEdited(r);
    tab.updateSession(r.session);
    store.touchRecent(r.session.id);
    if (r.connect && tab.state !== "connected") tab.reconnectNow();
    this.focusTerminal();
  }

  sessionOptions() {
    const picked = this.sidebar.hasFocus() ? this.sidebar.selectedSessions() : [];
    if (picked.length === 1) return this.edit(picked[0]);
    const t = this.tabs.active;
    if (t) this.editFromTab(t);
  }

  async duplicate(s: Session) {
    const copy = { ...structuredClone(s), id: crypto.randomUUID(), name: `${s.name} copy` };
    const r = await dialog<SessionEditResult>({ kind: "session", session: copy, isNew: true });
    if (!r) return;
    await this.saveEdited(r);
    this.sidebar.reveal(r.session.id);
  }

  async removeSessions(list: Session[]) {
    if (!list.length) return;
    const one = list.length === 1;
    const ok = await confirmDialog({
      title: one ? `Delete ${list[0].name}?` : `Delete ${list.length} sessions?`,
      message: `${one ? "The session file" : "Their files"} and any passwords saved for ${one ? "it" : "them"} are removed. Open tabs stay connected.`,
      confirm: one ? "Delete session" : `Delete ${list.length} sessions`,
      danger: true,
    });
    if (ok) await store.deleteSessions(list.map((s) => s.id));
  }

  async createFolder(parent: string) {
    const name = await promptText({
      title: "New folder",
      intro: parent ? `Inside ${parent}.` : undefined,
      label: "Folder name",
      placeholder: "e.g. Branch offices",
      confirm: "Create folder",
    });
    const clean = name?.trim().replace(/\//g, "-");
    if (!clean) return;
    const path = joinFolder(parent, clean);
    if (store.folders().includes(path)) {
      toast(`${path} already exists.`);
    } else {
      await store.addFolder(path);
    }
    this.sidebar.revealFolder(path);
  }

  async removeFolder(path: string) {
    const inside = store.sessions.filter((s) => isUnder(s.folder, path));
    if (inside.length) {
      const ok = await confirmDialog({
        title: `Delete ${folderName(path)} and its ${inside.length} session${inside.length === 1 ? "" : "s"}?`,
        message: "The folder, everything in it, and any passwords saved for those sessions are removed. Open tabs stay connected.",
        confirm: "Delete folder",
        danger: true,
      });
      if (!ok) return;
    }
    await store.deleteFolder(path);
  }

  openLocal(shell?: ShellInfo) {
    const name = shell?.name ?? this.shells[0]?.name ?? "Local shell";
    this.tabs.open(newSession({ name, protocol: { kind: "local", shell: shell?.command ?? "" } }), false);
  }

  async quickConnect(kind?: Protocol["kind"]) {
    const r = await dialog<{ session: Session; save: boolean }>({ kind: "quick", protocol: kind });
    if (!r) return this.focusTerminal();
    if (r.save) {
      await store.saveSession(r.session);
      this.sidebar.reveal(r.session.id);
      this.openSessions([r.session]);
    } else {
      this.tabs.open(r.session, false);
    }
  }

  async openSettings(page?: SettingsPage) {
    const s = await dialog<Settings>({ kind: "settings", page });
    if (s) await store.saveSettings(s);
    this.focusTerminal();
  }

  importSecureCrt() {
    return importSecureCrt();
  }

  // ---------------------------------------------------------------------------
  // Tabs

  newTabMenu(x: number, y: number) {
    const recent = store.recentSessions().slice(0, 8);
    showMenu(x, y, [
      cmd("connect.focus"),
      cmd("connect.quick"),
      cmd("connect.serial"),
      cmd("connect.local"),
      ...this.shellMenu(),
      ...(recent.length ? (["-"] as MenuEntry[]) : []),
      ...recent.map((s): MenuItem => ({ label: s.name, hint: hostLabel(s.protocol), action: () => this.openSessions([s]) })),
    ]);
  }

  tabMenu(tab: Tab, x: number, y: number) {
    this.tabs.activate(tab);
    const i = this.tabs.tabs.indexOf(tab);
    const right = this.tabs.tabs.slice(i + 1);
    showMenu(x, y, [
      tab.state === "connected" || tab.state === "connecting" ? cmd("tab.disconnect") : cmd("tab.reconnect"),
      cmd("tab.clone"),
      cmd("tab.rename"),
      tab.saved ? cmd("session.options") : cmd("tab.save"),
      cmd("tab.reveal"),
      "-",
      cmd("broadcast.member"),
      cmd("log.toggle", { label: tab.logPath ? "Stop logging" : "Start logging" }),
      cmd("edit.find"),
      cmd("edit.clear"),
      cmd("tab.break"),
      "-",
      cmd("tab.close"),
      cmd("tab.closeOthers"),
      { label: "Close tabs to the right", disabled: !right.length, action: () => this.tabs.closeMany(right) },
    ]);
  }

  async renameTab(tab: Tab) {
    const t = await promptText({ title: "Rename tab", label: "Tab name", value: tab.title, confirm: "Rename" });
    if (t?.trim()) tab.setTitle(t.trim());
    tab.focus();
  }

  cloneTab(tab: Tab) {
    const copy = this.tabs.open(tab.session, tab.saved);
    copy.inheritCredentials(tab);
  }

  revealActive() {
    const t = this.tabs.active;
    if (!t?.saved) return;
    if (!store.settings.showSidebar) store.patchSettings({ showSidebar: true });
    this.sidebar.reveal(t.session.id);
  }

  async disconnectAll() {
    const live = this.tabs.tabs.filter((t) => t.state === "connected" || t.state === "connecting");
    const ok = await confirmDialog({ title: `Disconnect ${live.length} tab${live.length === 1 ? "" : "s"}?`, message: "The tabs stay open so you can reconnect them.", confirm: "Disconnect all" });
    if (ok) live.forEach((t) => t.disconnect());
  }

  toggleBroadcast(refocus = true) {
    this.tabs.setBroadcast(!this.tabs.broadcast);
    if (refocus) this.focusTerminal();
  }

  toggleTile() {
    this.tabs.setTiled(!this.tabs.tiled);
    this.focusTerminal();
  }

  toggleOnTop() {
    this.onTop = !this.onTop;
    getCurrentWindow().setAlwaysOnTop(this.onTop).catch(() => toast("Couldn't keep the window on top."));
    this.refresh();
  }

  async toggleFullscreen() {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen())).catch(() => {});
  }

  zoom(delta: number) {
    const size = delta === 0 ? 14 : Math.min(40, Math.max(8, store.settings.fontSize + delta));
    store.patchSettings({ fontSize: size });
  }

  // ---------------------------------------------------------------------------
  // Palette

  async palette() {
    type Item = { label: string; sub?: string; kbd?: string; kind: string; run: () => void };
    const sessions: Item[] = store.sessions.map((s) => ({ kind: "Session", label: s.name, sub: `${s.folder ? s.folder + " · " : ""}${hostLabel(s.protocol)}`, run: () => this.openSessions([s]) }));
    const tabItems: Item[] = this.tabs.tabs.map((x) => ({ kind: "Tab", label: x.title, sub: x.statusMessage, run: () => this.tabs.activate(x) }));
    const actions: Item[] = commands
      .all()
      .filter((c) => !c.hideInPalette && (c.enabled?.() ?? true) && c.id !== "connect.focus")
      .map((c) => ({ kind: "Command", label: commands.label(c.id).replace(/…$/, ""), sub: c.detail, kbd: commands.shortcut(c.id), run: () => commands.run(c.id) }));
    const all = [...tabItems, ...sessions, ...actions];

    const input = h("input", { type: "text", placeholder: "Search sessions, tabs and commands", spellcheck: "false", "aria-label": "Search" });
    const list = h("ul", { role: "listbox" });
    let sel = 0;
    let shown: Item[] = [];
    let close: (v: Item | undefined) => void = () => {};
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = (q ? rankItems(all, q) : all).slice(0, 80);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      clear(list);
      shown.forEach((i, idx) =>
        list.append(
          h("li", { class: idx === sel ? "sel" : "", role: "option", onclick: () => close(i), onmousemove: () => { if (sel !== idx) { sel = idx; render(); } } },
            h("span", { class: "kind" }, i.kind),
            h("span", { class: "label" }, i.label),
            i.sub ? h("span", { class: "sub" }, i.sub) : null,
            i.kbd ? h("span", { class: "kbd" }, i.kbd) : null),
        ),
      );
      if (!shown.length) list.append(h("li", { class: "none" }, "Nothing matches. Press Enter to quick connect to it instead."));
      list.children[sel]?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => { sel = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") sel = Math.min(shown.length - 1, sel + 1);
      else if (e.key === "ArrowUp") sel = Math.max(0, sel - 1);
      else if (e.key === "Enter") {
        if (shown[sel]) close(shown[sel]);
        else if (input.value.trim()) {
          const typed = input.value.trim();
          close({ kind: "", label: "", run: () => { this.omnibox.input.value = typed; this.focusOmnibox(); this.omnibox.input.dispatchEvent(new Event("input")); } });
        }
      } else return;
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
    else this.focusTerminal();
  }

  // ---------------------------------------------------------------------------
  // Keyboard

  /**
   * Pressing and releasing Alt on its own moves to the menu bar (and back),
   * as in any Windows app. Alt used with another key or a click is Meta for
   * the device, so it doesn't count.
   */
  altTapsMenuBar() {
    let alone = false;
    addEventListener("keydown", (e) => {
      alone = e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey && (alone || !e.repeat);
    }, true);
    addEventListener("pointerdown", () => (alone = false), true);
    addEventListener("blur", () => (alone = false));
    addEventListener("keyup", (e) => {
      if (e.key !== "Alt" || !alone) return;
      alone = false;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      if (menuOpen()) closeMenus();
      if (this.menubar.hasFocus()) this.focusTerminal();
      else this.menubar.focus();
    }, true);
  }

  shortcut(e: KeyboardEvent) {
    if (document.querySelector("dialog[open]") || menuOpen()) return;
    if (e.key === "F10" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      this.menubar.focus();
      return;
    }
    const c = commands.match(e);
    if (!c) return;
    // In text fields, copy/paste/select-all belong to the field.
    const editable = (e.target as HTMLElement).closest?.("input, textarea, select");
    if (editable && c.id.startsWith("edit.")) return;
    e.preventDefault();
    e.stopPropagation();
    commands.run(c.id);
  }
}

function stateWord(s: TabState): string {
  return s === "connected" ? "Connected" : s === "connecting" ? "Connecting" : s === "closed" ? "Closed" : "";
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}

/**
 * Palette ranking: every word must appear in the label or detail. Loose
 * in-order letter matches ("rcn" for Reconnect) only count when nothing
 * matches properly, so they don't bury real hits.
 */
function rankItems<T extends { label: string; sub?: string }>(items: T[], q: string): T[] {
  const words = q.split(/\s+/);
  const scored = items.map((item) => {
    const label = item.label.toLowerCase();
    const hay = `${label} ${(item.sub ?? "").toLowerCase()}`;
    let score = 0;
    if (words.every((w) => label.includes(w))) score = label.startsWith(words[0]) ? 4 : 3;
    else if (words.every((w) => hay.includes(w))) score = 2;
    else if (words.every((w) => w.length > 2 && subsequence(label, w))) score = 1;
    return { item, score };
  });
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored
    .filter((x) => x.score > 0 && (best === 1 || x.score > 1))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

function subsequence(hay: string, w: string): boolean {
  let i = 0;
  for (const c of hay) if (c === w[i]) i++;
  return i === w.length;
}

/** Show an options dialog in its own window and wait for its result. */
function dialog<T>(req: DialogRequest): Promise<T | undefined> {
  return inWindow(req, () => runDialog(req) as Promise<T | undefined>);
}

const request = dialogRequest<DialogRequest>();
(request ? runDialogWindow(request, runDialog) : new App().start()).catch((e) => {
  document.body.textContent = `Tether couldn't start: ${e?.message ?? e}`;
  console.error(e);
});
