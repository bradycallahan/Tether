import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import { api } from "./api";
import { h, icon } from "./dom";
import { confirmDialog, hostKeyDialog, pasteConfirm, promptSecret, promptText, showMenu, toast } from "./dialogs";
import { Highlighter } from "./highlight";
import { scheme } from "./schemes";
import { store } from "./state";
import { playSendString } from "./escapes";
import { hostLabel, type CmdError, type Session, type StatusEvent } from "./types";

export type TabState = "idle" | "connecting" | "connected" | "closed";

interface ConnectOpts {
  password?: string;
  passphrase?: string;
  jumpPassword?: string;
  remember?: boolean;
}

export interface TabHost {
  input(tab: Tab, data: string): void;
  activate(tab: Tab): void;
  close(tab: Tab): void;
  changed(tab: Tab): void;
  tabMenu(tab: Tab, x: number, y: number): void;
  isVisible(tab: Tab): boolean;
  editSession(tab: Tab): void;
}

const isMac = navigator.platform.toUpperCase().includes("MAC");

export class Tab {
  readonly connId = crypto.randomUUID();
  state: TabState = "idle";
  statusMessage = "Not connected";
  logPath: string | null = null;
  inBroadcast = true;
  title: string;

  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  readonly highlighter: Highlighter;
  readonly pane: HTMLDivElement;
  readonly tabEl: HTMLDivElement;
  private led: HTMLSpanElement;
  private paneLed: HTMLSpanElement;
  private titleEl: HTMLSpanElement;
  private bcEl: HTMLSpanElement;
  private termEl: HTMLDivElement;
  private findBar: HTMLDivElement | null = null;
  private seq = 0;
  private lastPulse = 0;
  private resizeObs: ResizeObserver;
  private fitQueued = false;

  constructor(public session: Session, public saved: boolean, private host: TabHost) {
    this.title = session.name || hostLabel(session.protocol);
    const s = store.settings;
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      theme: scheme(s.terminalScheme),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });
    this.highlighter = new Highlighter(this.term);
    this.applyHighlightSet();

    this.termEl = h("div", { class: "term" });
    this.paneLed = h("span", { class: "led" });
    this.pane = h("div", { class: "pane" }, h("div", { class: "pane-label" }, this.paneLed, this.title), this.termEl);
    this.led = h("span", { class: "led" });
    this.titleEl = h("span", { class: "title" }, this.title);
    this.bcEl = h("span", { class: "bc on", title: "Include in broadcast", onclick: (e: Event) => { e.stopPropagation(); this.setBroadcastMember(!this.inBroadcast); } }, "✓");
    this.tabEl = h(
      "div",
      {
        class: "tab",
        role: "tab",
        tabindex: "0",
        draggable: "true",
        title: hostLabel(session.protocol),
        onclick: () => host.activate(this),
        onauxclick: (e: MouseEvent) => { if (e.button === 1) host.close(this); },
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); host.tabMenu(this, e.clientX, e.clientY); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") host.activate(this); },
      },
      this.led,
      this.bcEl,
      this.titleEl,
      h("span", { class: "x", title: "Close tab", onclick: (e: Event) => { e.stopPropagation(); host.close(this); } }, icon("close")),
    );
    this.pane.addEventListener("pointerdown", () => host.activate(this));

    this.resizeObs = new ResizeObserver(() => this.fitSoon());
  }

  /** Attach the terminal to the DOM. Call after the pane is in the document. */
  mount() {
    const t = this.term;
    t.loadAddon(this.fit);
    t.loadAddon(this.search);
    t.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) openUrl(uri).catch(() => {}); }));
    const uni = new Unicode11Addon();
    t.loadAddon(uni);
    t.unicode.activeVersion = "11";
    t.open(this.termEl);
    if (store.settings.gpuRendering) try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      t.loadAddon(gl);
    } catch {
      // Fall back to the DOM renderer.
    }

    t.onData((d) => this.host.input(this, d));
    t.onBinary((d) => {
      if (this.state === "connected") api.writeBytes(this.connId, [...d].map((c) => c.charCodeAt(0) & 0xff));
    });
    t.onResize(({ cols, rows }) => {
      if (this.state === "connected") api.resize(this.connId, cols, rows);
    });
    t.onBell(() => {
      const mode = store.settings.bell;
      if (mode === "visual") {
        this.pane.classList.remove("bell");
        void this.pane.offsetWidth;
        this.pane.classList.add("bell");
      }
      if (!this.host.isVisible(this)) this.tabEl.classList.add("unread");
    });
    t.onSelectionChange(() => {
      if (store.settings.copyOnSelect && t.hasSelection()) navigator.clipboard.writeText(t.getSelection()).catch(() => {});
    });
    t.attachCustomKeyEventHandler((e) => this.keyFilter(e));

    // We own pasting so multi-line pastes can be confirmed.
    this.termEl.addEventListener(
      "paste",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        this.paste(text);
      },
      true,
    );
    this.termEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (store.settings.rightClickPaste) {
        if (t.hasSelection()) {
          navigator.clipboard.writeText(t.getSelection()).catch(() => {});
          t.clearSelection();
        } else {
          this.pasteFromClipboard();
        }
      } else {
        this.host.tabMenu(this, e.clientX, e.clientY);
      }
    });
    this.resizeObs.observe(this.termEl);
    this.fitSoon();
  }

  private keyFilter(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    // Shortcuts the app handles: let them bubble out of xterm.
    if (mod && e.shiftKey && /^[A-Z]$/i.test(e.key)) return false;
    if (e.ctrlKey && (e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown")) return false;
    if (e.altKey && /^[1-9]$/.test(e.key) && !isMac) return false;
    if (mod && (e.key === "," || e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) return false;
    if (isMac && e.metaKey && ["t", "w", "f", "k"].includes(e.key.toLowerCase())) return false;
    // Ctrl+C copies when something is selected (sends ^C otherwise).
    if (!isMac && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c" && this.term.hasSelection()) {
      navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
      this.term.clearSelection();
      return false;
    }
    if (e.shiftKey && e.key === "Insert") {
      this.pasteFromClipboard();
      return false;
    }
    return true;
  }

  async pasteFromClipboard() {
    try {
      this.paste(await navigator.clipboard.readText());
    } catch {
      toast("Couldn't read the clipboard.");
    }
  }

  async paste(text: string) {
    if (!text) return;
    const normalized = text.replace(/\r\n|\n/g, "\r");
    const lines = normalized.split("\r").filter((l, i, a) => l.length > 0 || i < a.length - 1).length;
    if (store.settings.confirmMultilinePaste && lines > 1) {
      if (!(await pasteConfirm(text))) {
        this.focus();
        return;
      }
    }
    this.focus();
    const data = this.term.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized;
    this.host.input(this, data);
  }

  fitSoon() {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      if (!this.termEl.isConnected || this.termEl.clientWidth === 0 || this.termEl.clientHeight === 0) return;
      try {
        this.fit.fit();
      } catch {
        /* not rendered yet */
      }
    });
  }

  focus() {
    this.term.focus();
  }

  applySettings() {
    const s = store.settings;
    const o = this.term.options;
    o.fontFamily = s.fontFamily;
    o.fontSize = s.fontSize;
    o.lineHeight = s.lineHeight;
    o.cursorStyle = s.cursorStyle;
    o.cursorBlink = s.cursorBlink;
    o.scrollback = s.scrollback;
    o.theme = scheme(s.terminalScheme);
    this.pane.style.background = (o.theme.background as string) ?? "";
    this.applyHighlightSet();
    this.fitSoon();
  }

  applyHighlightSet() {
    const name = this.session.terminal.highlightSet ?? store.settings.defaultHighlightSet;
    const set = store.highlights.find((x) => x.name === name);
    this.highlighter.setRules(set?.rules ?? []);
  }

  setTitle(title: string) {
    this.title = title;
    this.titleEl.textContent = title;
    const label = this.pane.querySelector(".pane-label");
    if (label) label.lastChild!.textContent = title;
    this.host.changed(this);
  }

  setBroadcastMember(on: boolean) {
    this.inBroadcast = on;
    this.bcEl.classList.toggle("on", on);
    this.host.changed(this);
  }

  setActive(active: boolean) {
    this.tabEl.classList.toggle("active", active);
    this.pane.classList.toggle("active", active);
    this.tabEl.setAttribute("aria-selected", String(active));
    if (active) {
      this.tabEl.classList.remove("unread");
      this.fitSoon();
    }
  }

  private setState(state: TabState, message: string) {
    this.state = state;
    this.statusMessage = message;
    for (const led of [this.led, this.paneLed]) led.className = `led ${state === "idle" ? "" : state}`;
    this.host.changed(this);
  }

  private lastInfo = "";

  private info(text: string, color = "2") {
    if (text === this.lastInfo && color === "2") return;
    this.lastInfo = text;
    const nl = this.term.buffer.active.cursorX > 0 ? "\r\n" : "";
    this.term.write(`${nl}\x1b[${color}m${text}\x1b[0m\r\n`);
  }

  private outbox = "";
  private flushing = false;

  /**
   * Queue keystrokes for this connection. IPC calls can complete out of order,
   * so writes go out one at a time and anything typed meanwhile is coalesced
   * into the next call — order is preserved and fast typing costs fewer calls.
   */
  send(data: string) {
    if (this.state !== "connected") return;
    this.outbox += this.session.terminal.backspaceSendsDelete ? data : data.replace(/\x7f/g, "\b");
    if (!this.flushing) this.flush();
  }

  private async flush() {
    this.flushing = true;
    try {
      while (this.outbox) {
        const chunk = this.outbox;
        this.outbox = "";
        await api.write(this.connId, chunk).catch(() => false);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Raw keyboard input routed back from the manager when not connected. */
  idleInput(data: string) {
    if ((this.state === "closed" || this.state === "idle") && data === "\r" && store.settings.reconnectOnEnter) {
      this.connect();
    }
  }

  /** Secrets typed this session, reused for reconnects until the tab closes. */
  private typed: ConnectOpts = {};

  async connect(given: ConnectOpts = {}): Promise<void> {
    const opts: ConnectOpts = { ...this.typed, ...given };
    const seq = ++this.seq;
    if (this.state === "connected") api.disconnect(this.connId);
    this.setState("connecting", `Connecting to ${hostLabel(this.session.protocol)}…`);
    const fresh = this.seq;
    try {
      const info = await api.connect(
        {
          connId: this.connId,
          session: this.session,
          cols: this.term.cols,
          rows: this.term.rows,
          password: opts.password,
          passphrase: opts.passphrase,
          jumpPassword: opts.jumpPassword,
          remember: opts.remember ?? false,
          saved: this.saved,
        },
        (bytes) => {
          if (seq === this.seq) this.onData(bytes);
        },
        (ev) => {
          if (seq === this.seq) this.onStatus(ev);
        },
      );
      if (fresh !== this.seq) return;
      this.typed = { password: opts.password, passphrase: opts.passphrase, jumpPassword: opts.jumpPassword };
      this.logPath = info.logPath;
      if (this.state !== "connected") this.setState("connected", `Connected to ${hostLabel(this.session.protocol)}`);
      api.resize(this.connId, this.term.cols, this.term.rows);
      this.runLoginScript();
    } catch (raw) {
      if (fresh !== this.seq) return;
      await this.handleError(raw as CmdError, opts);
    }
  }

  private async handleError(e: CmdError, opts: ConnectOpts) {
    const code = e?.code ?? "ERROR";
    const message = e?.message ?? String(e);
    const retry = (extra: ConnectOpts) => this.connect({ ...opts, ...extra });
    switch (code) {
      case "NEED_PASSWORD":
      case "AUTH_FAILED": {
        if (code === "AUTH_FAILED") this.typed = {};
        const jump = e.detail?.target === "jump";
        const failed = code === "AUTH_FAILED";
        const r = await promptSecret({
          title: jump ? "Jump host password" : "Password",
          label: failed ? `Password for ${hostLabel(this.session.protocol)}` : message,
          error: failed ? (e.detail?.usedSaved ? "The saved password was rejected. Enter the current one." : "That password didn't work.") : undefined,
          allowRemember: this.saved,
        });
        if (!r) return this.fail(failed ? message : "Cancelled.");
        return retry(jump ? { jumpPassword: r.value, remember: r.remember } : { password: r.value, remember: r.remember });
      }
      case "NEED_PASSPHRASE": {
        const r = await promptSecret({ title: "Key passphrase", label: message, allowRemember: this.saved, error: opts.passphrase ? "That passphrase didn't work." : undefined });
        if (!r) return this.fail("Cancelled.");
        return retry({ passphrase: r.value, remember: r.remember });
      }
      case "NEED_USERNAME": {
        const user = await promptText({ title: "Username", label: `Log in to ${hostLabel(this.session.protocol)} as`, confirm: "Connect" });
        if (!user || this.session.protocol.kind !== "ssh") return this.fail("Cancelled.");
        this.session = { ...this.session, protocol: { ...this.session.protocol, username: user } };
        this.tabEl.title = hostLabel(this.session.protocol);
        return retry({});
      }
      case "HOSTKEY_UNKNOWN":
      case "HOSTKEY_CHANGED": {
        const changed = code === "HOSTKEY_CHANGED";
        const ok = await hostKeyDialog(e.detail ?? {}, changed);
        if (!ok) return this.fail(changed ? "Stopped: the host key changed." : "Host key not trusted.");
        await api.trustHostKey(String(e.detail!.host), Number(e.detail!.port), String(e.detail!.key), changed);
        return retry({});
      }
      default:
        return this.fail(message);
    }
  }

  private fail(message: string) {
    this.setState("closed", message);
    this.info(`✗ ${message}`, "31");
    if (store.settings.reconnectOnEnter) this.info("Press Enter to try again.");
    this.focus();
  }

  private onStatus(ev: StatusEvent) {
    switch (ev.state) {
      case "connecting":
        this.setState("connecting", ev.message);
        this.info(ev.message);
        break;
      case "connected":
        this.setState("connected", ev.message);
        break;
      case "closed":
        if (this.state === "closed") return;
        this.setState("closed", ev.message);
        this.logPath = null;
        this.info(`— ${ev.message}${store.settings.reconnectOnEnter ? " Press Enter to reconnect." : ""}`, "33");
        break;
      case "warning":
        this.info(ev.message, "33");
        break;
      case "error":
        break; // reported by the connect() rejection
    }
  }

  private onData(bytes: Uint8Array) {
    this.lastInfo = "";
    this.term.write(bytes, () => this.highlighter.schedule());
    const now = performance.now();
    if (now - this.lastPulse > 90) {
      this.lastPulse = now;
      this.led.animate([{ background: "var(--activity)" }, { background: "var(--link)" }], { duration: 140 });
    }
    if (!this.host.isVisible(this)) this.tabEl.classList.add("unread");
  }

  private async runLoginScript() {
    const script = this.session.loginScript.trim();
    if (!script) return;
    await new Promise((r) => setTimeout(r, 600));
    for (const line of script.split(/\r?\n/)) {
      if (this.state !== "connected") return;
      if (!line.trim()) continue;
      await playSendString(line.endsWith("\\r") || line.endsWith("\\n") ? line : line + "\\r", (s) => this.send(s));
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  disconnect() {
    this.seq++;
    api.disconnect(this.connId);
    if (this.state === "connected" || this.state === "connecting") {
      this.setState("closed", "Disconnected.");
      this.info(`— Disconnected.${store.settings.reconnectOnEnter ? " Press Enter to reconnect." : ""}`, "33");
    }
    this.logPath = null;
  }

  sendBreak() {
    if (this.state !== "connected") return;
    api.sendBreak(this.connId);
    const k = this.session.protocol.kind;
    if (k === "serial" || k === "telnet") toast("Break sent");
    else toast("Break isn't available on this connection type.");
  }

  async toggleLogging() {
    if (this.state !== "connected") {
      toast("Connect first, or turn on logging in the session settings.");
      return;
    }
    try {
      this.logPath = await api.setLogging(this.connId, !this.logPath);
      toast(this.logPath ? `Logging to ${this.logPath}` : "Logging stopped");
    } catch (e) {
      toast((e as CmdError).message ?? String(e));
    }
    this.host.changed(this);
  }

  // ---------- find ----------

  openFind() {
    if (this.findBar) {
      (this.findBar.querySelector("input") as HTMLInputElement).select();
      return;
    }
    const input = h("input", { type: "text", placeholder: "Find in scrollback", spellcheck: "false" });
    const count = h("span", { class: "count" });
    const caseBtn = h("button", { type: "button", class: "btn ghost icon-only", title: "Match case", "aria-pressed": "false" }, "Aa");
    const deco = {
      matchBackground: "#3d5a73",
      activeMatchBackground: "#f2b84b",
      matchOverviewRuler: "#6cb4e4",
      activeMatchColorOverviewRuler: "#f2b84b",
    };
    const opts = () => ({ caseSensitive: caseBtn.getAttribute("aria-pressed") === "true", decorations: deco });
    const find = (back = false) => {
      if (!input.value) return;
      if (back) this.search.findPrevious(input.value, opts());
      else this.search.findNext(input.value, opts());
    };
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = resultCount === 0 ? "No results" : `${resultIndex + 1} of ${resultCount}`;
    });
    const close = () => {
      this.search.clearDecorations();
      this.findBar?.remove();
      this.findBar = null;
      this.focus();
    };
    caseBtn.onclick = () => {
      caseBtn.setAttribute("aria-pressed", String(caseBtn.getAttribute("aria-pressed") !== "true"));
      find();
    };
    input.addEventListener("input", () => find());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") find(e.shiftKey);
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
    });
    this.findBar = h(
      "div",
      { class: "findbar" },
      input,
      count,
      caseBtn,
      h("button", { type: "button", class: "btn ghost icon-only", title: "Previous (Shift+Enter)", onclick: () => find(true) }, icon("up")),
      h("button", { type: "button", class: "btn ghost icon-only", title: "Next (Enter)", onclick: () => find() }, icon("down")),
      h("button", { type: "button", class: "btn ghost icon-only", title: "Close (Esc)", onclick: close }, icon("close")),
    );
    this.pane.append(this.findBar);
    input.focus();
  }

  dispose() {
    this.seq++;
    api.disconnect(this.connId);
    this.resizeObs.disconnect();
    this.highlighter.dispose();
    this.term.dispose();
    this.pane.remove();
    this.tabEl.remove();
  }
}

// ---------------------------------------------------------------------------

export class TabManager implements TabHost {
  tabs: Tab[] = [];
  active: Tab | null = null;
  broadcast = false;
  tiled = false;
  private dragTab: Tab | null = null;

  constructor(
    private tabsEl: HTMLElement,
    private stripEl: HTMLElement,
    private panesEl: HTMLElement,
    private emptyEl: HTMLElement,
    private onChange: () => void,
    private onEditSession: (tab: Tab) => void,
  ) {
    tabsEl.addEventListener("dragover", (e) => {
      if (!this.dragTab) return;
      e.preventDefault();
      const over = this.tabs.find((t) => t.tabEl.contains(e.target as Node));
      if (!over || over === this.dragTab) return;
      const r = over.tabEl.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      over.tabEl[after ? "after" : "before"](this.dragTab.tabEl);
    });
    tabsEl.addEventListener("drop", (e) => e.preventDefault());
    this.render();
  }

  open(session: Session, saved: boolean, connect = true): Tab {
    const tab = new Tab(structuredClone(session), saved, this);
    this.tabs.push(tab);
    this.tabsEl.append(tab.tabEl);
    this.panesEl.append(tab.pane);
    tab.tabEl.addEventListener("dragstart", (e) => {
      this.dragTab = tab;
      tab.tabEl.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", tab.title);
    });
    tab.tabEl.addEventListener("dragend", () => {
      tab.tabEl.classList.remove("dragging");
      this.dragTab = null;
      this.tabs = [...this.tabsEl.querySelectorAll(".tab")].map((el) => this.tabs.find((t) => t.tabEl === el)!).filter(Boolean);
    });
    this.activate(tab);
    tab.mount();
    tab.applySettings();
    if (connect) {
      // Wait a frame so the terminal has measured itself before we report a size.
      requestAnimationFrame(() => requestAnimationFrame(() => tab.connect()));
    }
    this.render();
    return tab;
  }

  activate(tab: Tab) {
    if (this.active === tab) {
      tab.focus();
      return;
    }
    this.active?.setActive(false);
    this.active = tab;
    tab.setActive(true);
    tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    setTimeout(() => tab.focus());
    this.render();
  }

  async close(tab: Tab, ask = true) {
    if (ask && tab.state === "connected") {
      const ok = await confirmDialog({ title: `Disconnect ${tab.title}?`, message: "The session will be closed.", confirm: "Disconnect and close" });
      if (!ok) return;
    }
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.dispose();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
    }
    this.render();
  }

  async closeOthers(keep: Tab) {
    for (const t of [...this.tabs]) if (t !== keep) await this.close(t, false);
  }

  cycle(delta: number) {
    if (!this.tabs.length) return;
    const i = this.active ? this.tabs.indexOf(this.active) : 0;
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  input(tab: Tab, data: string) {
    if (tab.state !== "connected") {
      tab.idleInput(data);
      return;
    }
    if (this.broadcast && tab.inBroadcast) {
      for (const t of this.tabs) if (t.inBroadcast && t.state === "connected") t.send(data);
    } else {
      tab.send(data);
    }
  }

  /** Targets for button bar / command bar sends. */
  targets(): Tab[] {
    if (!this.active) return [];
    if (this.broadcast && this.active.inBroadcast) return this.tabs.filter((t) => t.inBroadcast && t.state === "connected");
    return this.active.state === "connected" ? [this.active] : [];
  }

  async sendString(str: string) {
    const targets = this.targets();
    if (!targets.length) {
      toast(this.active ? "This tab isn't connected." : "Open a session first.");
      return;
    }
    await Promise.all(targets.map((t) => playSendString(str, (s) => t.send(s))));
    this.active?.focus();
  }

  setBroadcast(on: boolean) {
    this.broadcast = on;
    this.stripEl.classList.toggle("broadcasting", on);
    if (on) toast("Broadcast on — typing goes to every checked tab.");
    this.render();
  }

  setTiled(on: boolean) {
    this.tiled = on;
    this.panesEl.classList.toggle("tiled", on);
    this.render();
    for (const t of this.tabs) t.fitSoon();
  }

  changed(_tab: Tab) {
    this.onChange();
  }

  isVisible(tab: Tab) {
    return document.hasFocus() && (this.tiled || this.active === tab);
  }

  editSession(tab: Tab) {
    this.onEditSession(tab);
  }

  tabMenu(tab: Tab, x: number, y: number) {
    showMenu(x, y, [
      tab.state === "connected"
        ? { label: "Disconnect", action: () => tab.disconnect(), icon: "plug" }
        : { label: "Reconnect", action: () => tab.connect(), icon: "plug", shortcut: "Ctrl+Shift+R" },
      { label: "Duplicate tab", action: () => this.open(tab.session, tab.saved) },
      { label: "Rename tab…", action: async () => { const t = await promptText({ title: "Rename tab", label: "Tab name", value: tab.title }); if (t) tab.setTitle(t); } },
      { label: tab.saved ? "Edit session…" : "Save as session…", action: () => this.editSession(tab), icon: "edit" },
      { label: tab.logPath ? "Stop logging" : "Start logging", action: () => tab.toggleLogging(), icon: "log", separatorBefore: true },
      { label: "Find…", action: () => tab.openFind(), icon: "search", shortcut: "Ctrl+Shift+F" },
      { label: "Clear scrollback", action: () => { tab.term.clear(); tab.highlighter.clear(); } },
      { label: "Send break", action: () => tab.sendBreak(), shortcut: "Ctrl+Shift+K" },
      { label: "Close tab", action: () => this.close(tab), separatorBefore: true, shortcut: "Ctrl+Shift+W" },
      { label: "Close other tabs", action: () => this.closeOthers(tab), danger: true },
    ]);
  }

  render() {
    const n = this.tabs.length;
    this.emptyEl.hidden = n > 0;
    this.panesEl.style.setProperty("--cols", String(Math.max(1, Math.ceil(Math.sqrt(n)))));
    this.onChange();
  }
}
