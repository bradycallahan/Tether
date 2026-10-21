import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import { api } from "./api";
import { commands, isMac } from "./commands";
import { h, icon } from "./dom";
import { confirmDialog, hostKeyDialog, pasteConfirm, promptSecret, promptText, toast } from "./dialogs";
import { Highlighter } from "./highlight";
import { fromKeyboard, menuPoint, showMenu, type MenuEntry } from "./menu";
import { scheme } from "./schemes";
import { store } from "./state";
import { describeSend, playSendString } from "./escapes";
import { requestAttention } from "./platform";
import { hostLabel, PROTOCOL_NAMES, type CmdError, type Session, type StatusEvent } from "./types";

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
  /** Where input typed in this tab goes, e.g. "core-sw1" or "6 tabs". */
  targetLabel(tab: Tab): { label: string; many: boolean };
}

/** Waits between automatic reconnect attempts, in seconds. */
const RECONNECT_BACKOFF = [3, 5, 10, 20, 30];

// Credential and host-key prompts are shown one at a time, even when many
// tabs connect at once (restoring a workspace, "Connect to all").
let promptChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = promptChain.then(fn, fn);
  promptChain = run.catch(() => {});
  return run;
}

export class Tab {
  readonly connId = crypto.randomUUID();
  state: TabState = "idle";
  statusMessage = "Not connected";
  private everConnected = false;
  logPath: string | null = null;
  inBroadcast = true;
  title: string;
  /** Set when the user renamed the tab, so session edits don't overwrite it. */
  customTitle = false;
  connectedAt: number | null = null;

  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  readonly highlighter: Highlighter;
  readonly pane: HTMLDivElement;
  readonly tabEl: HTMLDivElement;
  private led: HTMLSpanElement;
  private paneLed: HTMLSpanElement;
  private paneTitle: HTMLSpanElement;
  private titleEl: HTMLSpanElement;
  private bcEl: HTMLSpanElement;
  private termEl: HTMLDivElement;
  private banner: HTMLDivElement;
  private findBar: HTMLDivElement | null = null;
  private seq = 0;
  private lastPulse = 0;
  private resizeObs: ResizeObserver;
  private fitQueued = false;
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  private bannerTimer: number | undefined;
  private idleTimer: number | undefined;
  /** The user asked for this disconnect, so don't auto-reconnect. */
  private userClosed = false;
  private lastError: string | null = null;

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
      theme: scheme(session.terminal.colorScheme ?? s.terminalScheme),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });
    this.highlighter = new Highlighter(this.term);
    this.applyHighlightSet();

    this.termEl = h("div", { class: "term" });
    this.banner = h("div", { class: "banner", hidden: true, role: "status" });
    this.paneLed = h("span", { class: "led" });
    this.paneTitle = h("span", {}, this.title);
    this.pane = h("div", { class: "pane" }, h("div", { class: "pane-label" }, this.paneLed, this.paneTitle), this.banner, h("div", { class: "term-wrap" }, this.termEl));
    this.led = h("span", { class: "led" });
    this.titleEl = h("span", { class: "title" }, this.title);
    this.bcEl = h("span", {
      class: "bc on",
      role: "checkbox",
      "aria-checked": "true",
      title: "Include this tab when broadcasting",
      onclick: (e: Event) => {
        e.stopPropagation();
        this.setBroadcastMember(!this.inBroadcast);
      },
    }, icon("check"));
    this.tabEl = h(
      "div",
      {
        class: "tab",
        role: "tab",
        tabindex: "0",
        draggable: "true",
        onclick: () => host.activate(this),
        onauxclick: (e: MouseEvent) => {
          if (e.button === 1) host.close(this);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          const at = menuPoint(e);
          host.tabMenu(this, at.x, at.y);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") host.activate(this);
        },
      },
      this.led,
      this.bcEl,
      this.titleEl,
      h("button", {
        type: "button",
        class: "x",
        title: "Close tab",
        tabindex: "-1",
        onclick: (e: Event) => {
          e.stopPropagation();
          host.close(this);
        },
      }, icon("close")),
    );
    this.applyTag();
    this.pane.classList.add("bc-member");
    this.pane.addEventListener("pointerdown", () => host.activate(this));

    this.resizeObs = new ResizeObserver(() => this.fitSoon());
  }

  /** Attach the terminal to the DOM. Call after the pane is in the document. */
  mount() {
    const t = this.term;
    t.loadAddon(this.fit);
    t.loadAddon(this.search);
    t.loadAddon(new WebLinksAddon((e, uri) => {
      if (e.ctrlKey || e.metaKey) openUrl(uri).catch(() => {});
    }));
    const uni = new Unicode11Addon();
    t.loadAddon(uni);
    t.unicode.activeVersion = "11";
    t.open(this.termEl);
    if (store.settings.gpuRendering) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        t.loadAddon(gl);
      } catch {
        // Fall back to the DOM renderer.
      }
    }

    t.onData((d) => this.host.input(this, d));
    t.onBinary((d) => {
      if (this.state === "connected") api.writeBytes(this.connId, [...d].map((c) => c.charCodeAt(0) & 0xff));
    });
    t.onResize(({ cols, rows }) => {
      if (this.state === "connected") api.resize(this.connId, cols, rows);
      this.host.changed(this);
    });
    t.onBell(() => {
      if (store.settings.bell === "visual") {
        this.pane.classList.remove("bell");
        void this.pane.offsetWidth;
        this.pane.classList.add("bell");
      }
      if (!this.host.isVisible(this)) this.tabEl.classList.add("unread");
      requestAttention();
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
        this.paste(e.clipboardData?.getData("text/plain") ?? "");
      },
      true,
    );
    this.termEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // The Menu key always opens the menu: a keystroke must never paste.
      if (fromKeyboard(e)) {
        const at = menuPoint(e);
        this.terminalMenu(at.x, at.y);
      } else if (store.settings.rightClickPaste) {
        if (t.hasSelection()) {
          this.copySelection();
          t.clearSelection();
        } else {
          this.pasteFromClipboard();
        }
      } else {
        this.terminalMenu(e.clientX, e.clientY);
      }
    });
    this.resizeObs.observe(this.termEl);
    this.fitSoon();
  }

  private keyFilter(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    // App shortcuts never reach the device.
    if (commands.match(e)) return false;
    // Ctrl+C copies when something is selected (sends ^C otherwise).
    if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && this.term.hasSelection()) {
      this.copySelection();
      this.term.clearSelection();
      return false;
    }
    return true;
  }

  private terminalMenu(x: number, y: number) {
    const entries: MenuEntry[] = [
      { label: "Copy", icon: "copy", shortcut: commands.shortcut("edit.copy"), disabled: !this.term.hasSelection(), action: () => this.copySelection() },
      { label: "Paste", icon: "paste", shortcut: commands.shortcut("edit.paste"), action: () => this.pasteFromClipboard() },
      { label: "Select all", shortcut: commands.shortcut("edit.selectAll"), action: () => this.term.selectAll() },
      "-",
      { label: "Find…", icon: "search", shortcut: commands.shortcut("edit.find"), action: () => this.openFind() },
      { label: "Clear scrollback", icon: "eraser", action: () => this.clearScrollback() },
    ];
    showMenu(x, y, entries);
  }

  copySelection() {
    if (!this.term.hasSelection()) return;
    navigator.clipboard.writeText(this.term.getSelection()).catch(() => toast("Couldn't write to the clipboard."));
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
      if (!(await pasteConfirm(text, this.host.targetLabel(this)))) {
        this.focus();
        return;
      }
    }
    this.focus();
    const data = this.term.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized;
    this.host.input(this, data);
  }

  clearScrollback() {
    this.term.clear();
    this.highlighter.clear();
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
    o.theme = scheme(this.session.terminal.colorScheme ?? s.terminalScheme);
    this.pane.style.setProperty("--term-bg", (o.theme.background as string) ?? "");
    this.applyHighlightSet();
    this.fitSoon();
  }

  applyHighlightSet() {
    const name = this.session.terminal.highlightSet ?? store.settings.defaultHighlightSet;
    const set = store.highlights.find((x) => x.name === name);
    this.highlighter.setRules(set?.rules ?? []);
  }

  /** Pick up edits made to the saved session. */
  updateSession(s: Session) {
    this.session = structuredClone(s);
    this.saved = true;
    if (!this.customTitle) this.setTitle(s.name, false);
    this.applyTag();
    this.applySettings();
    this.scheduleAntiIdle();
  }

  private applyTag() {
    this.tabEl.style.setProperty("--tag", this.session.colorTag ?? "transparent");
    this.tabEl.classList.toggle("tagged", !!this.session.colorTag);
    this.updateTooltip();
  }

  private updateTooltip() {
    this.tabEl.title = `${this.title}\n${PROTOCOL_NAMES[this.session.protocol.kind]} ${hostLabel(this.session.protocol)}\n${this.statusMessage}`;
  }

  setTitle(title: string, custom = true) {
    this.title = title;
    this.customTitle = custom;
    this.titleEl.textContent = title;
    this.paneTitle.textContent = title;
    this.updateTooltip();
    this.host.changed(this);
  }

  setBroadcastMember(on: boolean) {
    this.inBroadcast = on;
    this.bcEl.classList.toggle("on", on);
    this.pane.classList.toggle("bc-member", on);
    this.bcEl.setAttribute("aria-checked", String(on));
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
    const was = this.state;
    this.state = state;
    this.statusMessage = message;
    for (const led of [this.led, this.paneLed]) led.className = `led ${state === "idle" ? "" : state}`;
    if (state === "connected" && was !== "connected") this.connectedAt = Date.now();
    if (state !== "connected") this.connectedAt = null;
    this.updateTooltip();
    this.renderBanner();
    this.host.changed(this);
  }

  // ---------- banner ----------

  private renderBanner() {
    clearTimeout(this.bannerTimer);
    const b = this.banner;
    const show = (kind: string, text: string, ...buttons: HTMLElement[]) => {
      b.className = `banner ${kind}`;
      b.replaceChildren(h("span", { class: "led" }), h("span", { class: "text" }, text), ...buttons);
      if (b.hidden) {
        b.hidden = false;
        this.fitSoon();
      }
    };
    const btn = (label: string, onclick: () => void, primary = false, kbd?: string) =>
      h("button", { type: "button", class: `btn ${primary ? "primary" : "ghost"}`, onclick: (e: Event) => { e.stopPropagation(); onclick(); } }, label, kbd ? h("span", { class: "kbd" }, kbd) : null);

    if (this.state === "connected" || this.state === "idle") {
      if (!b.hidden) {
        b.hidden = true;
        this.fitSoon();
      }
      return;
    }
    if (this.state === "connecting") {
      // Fast connects shouldn't flash a banner.
      const render = () => show("connecting", this.statusMessage, btn("Cancel", () => this.disconnect()));
      if (b.hidden) this.bannerTimer = window.setTimeout(render, 600);
      else render();
      return;
    }
    // closed
    if (this.reconnectTimer !== undefined) {
      const wait = RECONNECT_BACKOFF[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
      show("waiting", `${this.lastError ?? this.statusMessage} Reconnecting in ${wait} s…`,
        btn("Reconnect now", () => this.reconnectNow(), true),
        btn("Stop", () => this.cancelAutoReconnect()));
      return;
    }
    const enter = store.settings.reconnectOnEnter ? "Enter" : undefined;
    if (this.lastError) {
      show("fault", this.lastError,
        btn("Try again", () => this.reconnectNow(), true, enter),
        ...(this.saved || this.session.protocol.kind !== "local" ? [btn(this.saved ? "Edit session…" : "Save as session…", () => this.host.editSession(this))] : []));
    } else {
      show("closed", this.statusMessage, btn("Reconnect", () => this.reconnectNow(), true, enter));
    }
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
    this.scheduleAntiIdle();
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

  /** Keep idle-timeout-happy devices from logging us out. */
  private scheduleAntiIdle() {
    clearTimeout(this.idleTimer);
    const secs = this.session.antiIdleSecs;
    if (!secs || !this.session.antiIdleSend || this.state !== "connected") return;
    this.idleTimer = window.setTimeout(() => {
      if (this.state !== "connected") return;
      playSendString(this.session.antiIdleSend, (s) => this.send(s));
    }, secs * 1000);
  }

  /** Raw keyboard input routed back from the manager when not connected. */
  idleInput(data: string) {
    if (data !== "\r" || !store.settings.reconnectOnEnter) return;
    if (this.state === "closed" || this.state === "idle") this.reconnectNow();
  }

  /** Secrets typed this session, reused for reconnects until the tab closes. */
  private typed: ConnectOpts = {};

  /** A cloned tab reuses the passwords typed into the original. */
  inheritCredentials(from: Tab) {
    this.typed = { ...from.typed };
  }

  async connect(given: ConnectOpts = {}): Promise<void> {
    const opts: ConnectOpts = { ...this.typed, ...given };
    const seq = ++this.seq;
    this.userClosed = false;
    this.lastError = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.state === "connected") api.disconnect(this.connId);
    this.setState("connecting", `Connecting to ${hostLabel(this.session.protocol)}…`);
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
      if (seq !== this.seq) return;
      this.typed = { password: opts.password, passphrase: opts.passphrase, jumpPassword: opts.jumpPassword };
      this.logPath = info.logPath;
      this.reconnectAttempt = 0;
      if (this.state !== "connected") this.setState("connected", `Connected to ${hostLabel(this.session.protocol)}`);
      // Pairs with the "Disconnected" line so the scrollback shows the gap.
      if (this.everConnected) this.info(`— Connected. ${new Date().toLocaleTimeString()}`, "32");
      this.everConnected = true;
      api.resize(this.connId, this.term.cols, this.term.rows);
      this.scheduleAntiIdle();
    } catch (raw) {
      if (seq !== this.seq) return;
      await this.handleError(raw as CmdError, opts);
    }
  }

  private async handleError(e: CmdError, opts: ConnectOpts) {
    const code = e?.code ?? "ERROR";
    const message = e?.message ?? String(e);
    const retry = (extra: ConnectOpts) => this.connect({ ...opts, ...extra });
    // Prompts wait their turn and bring their tab forward, so it's clear
    // which device is asking.
    const ask = <T>(fn: () => Promise<T>) =>
      oneAtATime(async () => {
        this.host.activate(this);
        return fn();
      });
    switch (code) {
      case "NEED_PASSWORD":
      case "AUTH_FAILED": {
        if (code === "AUTH_FAILED") this.typed = {};
        const jump = e.detail?.target === "jump";
        const failed = code === "AUTH_FAILED";
        const r = await ask(() =>
          promptSecret({
            title: jump ? `Jump host password for ${this.title}` : `Password for ${this.title}`,
            label: failed ? `Password for ${hostLabel(this.session.protocol)}` : message,
            error: failed ? (e.detail?.usedSaved ? "The saved password was rejected. Enter the current one." : "That password didn't work.") : undefined,
            allowRemember: this.saved,
          }),
        );
        if (!r) return this.fail(failed ? message : "Connection cancelled.");
        return retry(jump ? { jumpPassword: r.value, remember: r.remember } : { password: r.value, remember: r.remember });
      }
      case "NEED_PASSPHRASE": {
        const r = await ask(() =>
          promptSecret({ title: `Key passphrase for ${this.title}`, label: message, allowRemember: this.saved, error: opts.passphrase ? "That passphrase didn't work." : undefined }),
        );
        if (!r) return this.fail("Connection cancelled.");
        return retry({ passphrase: r.value, remember: r.remember });
      }
      case "NEED_USERNAME": {
        const user = await ask(() => promptText({ title: `Username for ${this.title}`, label: `Log in to ${hostLabel(this.session.protocol)} as`, confirm: "Connect" }));
        if (!user || this.session.protocol.kind !== "ssh") return this.fail("Connection cancelled.");
        this.session = { ...this.session, protocol: { ...this.session.protocol, username: user } };
        this.updateTooltip();
        return retry({});
      }
      case "HOSTKEY_UNKNOWN":
      case "HOSTKEY_CHANGED": {
        const changed = code === "HOSTKEY_CHANGED";
        const ok = await ask(() => hostKeyDialog(e.detail ?? {}, changed));
        if (!ok) return this.fail(changed ? "Stopped: the host key changed." : "Host key not trusted.");
        await api.trustHostKey(String(e.detail!.host), Number(e.detail!.port), String(e.detail!.key), changed);
        return retry({});
      }
      default:
        this.fail(message, true);
    }
  }

  private fail(message: string, canAutoRetry = false) {
    this.lastError = message;
    this.info(`✗ ${message}`, "31");
    if (canAutoRetry && this.session.autoReconnect && !this.userClosed) this.scheduleReconnect();
    this.setState("closed", message);
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
      case "closed": {
        if (this.state === "closed") return;
        clearTimeout(this.idleTimer);
        this.logPath = null;
        this.info(`— ${ev.message} ${new Date().toLocaleTimeString()}`, "33");
        if (this.session.autoReconnect && !this.userClosed) this.scheduleReconnect();
        if (!this.userClosed) requestAttention();
        this.setState("closed", ev.message);
        break;
      }
      case "warning":
        this.info(ev.message, "33");
        break;
      case "error":
        break; // reported by the connect() rejection
    }
  }

  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const wait = RECONNECT_BACKOFF[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectAttempt++;
      this.connect();
    }, wait * 1000);
  }

  private cancelAutoReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempt = 0;
    this.renderBanner();
  }

  /** Connect now, skipping any pending automatic retry. */
  reconnectNow() {
    this.reconnectAttempt = 0;
    this.connect();
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

  disconnect() {
    this.seq++;
    this.userClosed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    this.reconnectTimer = undefined;
    api.disconnect(this.connId);
    if (this.state === "connected" || this.state === "connecting") {
      this.lastError = null;
      this.info(`— Disconnected. ${new Date().toLocaleTimeString()}`, "33");
      this.setState("closed", "Disconnected.");
    } else {
      this.renderBanner();
    }
    this.logPath = null;
  }

  sendBreak() {
    if (this.state !== "connected") return;
    const k = this.session.protocol.kind;
    if (k !== "serial" && k !== "telnet") {
      toast(`Break isn't available over ${PROTOCOL_NAMES[k]}.`);
      return;
    }
    api.sendBreak(this.connId);
    toast("Break sent");
  }

  async toggleLogging() {
    if (this.state !== "connected") {
      toast("Connect first, or turn on logging in the session options.");
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
      if (!input.value) {
        count.textContent = "";
        this.search.clearDecorations();
        return;
      }
      if (back) this.search.findPrevious(input.value, opts());
      else this.search.findNext(input.value, opts());
    };
    const sub = this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = resultCount === 0 ? "No results" : `${resultIndex + 1} of ${resultCount}`;
    });
    const close = () => {
      sub.dispose();
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
    const sel = this.term.getSelection();
    if (sel && !sel.includes("\n")) {
      input.value = sel;
      find();
    }
    input.focus();
    input.select();
  }

  dispose() {
    this.seq++;
    this.userClosed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.bannerTimer);
    api.disconnect(this.connId);
    this.resizeObs.disconnect();
    this.highlighter.dispose();
    this.term.dispose();
    this.pane.remove();
    this.tabEl.remove();
  }
}

// ---------------------------------------------------------------------------

export interface TabManagerHooks {
  changed(): void;
  editSession(tab: Tab): void;
  tabMenu(tab: Tab, x: number, y: number): void;
}

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
    private hooks: TabManagerHooks,
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
    tabsEl.addEventListener("drop", (e) => {
      if (this.dragTab) e.preventDefault();
    });
    this.render();
  }

  open(session: Session, saved: boolean, opts: { connect?: boolean; activate?: boolean } = {}): Tab {
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
      this.hooks.changed();
    });
    if (opts.activate !== false || !this.active) this.activate(tab);
    tab.mount();
    tab.applySettings();
    // A second tab to the same device reads "core-sw1 (2)", so the strip tells them apart.
    const taken = new Set(this.tabs.filter((t) => t !== tab).map((t) => t.title));
    if (taken.has(tab.title)) {
      let n = 2;
      while (taken.has(`${tab.title} (${n})`)) n++;
      tab.setTitle(`${tab.title} (${n})`, false);
    }
    if (opts.connect !== false) {
      // Wait a frame so the terminal has measured itself before we report a size.
      requestAnimationFrame(() => requestAnimationFrame(() => tab.connect()));
    }
    this.render();
    return tab;
  }

  activate(tab: Tab) {
    if (this.active === tab) {
      if (!document.querySelector("dialog[open]")) tab.focus();
      return;
    }
    this.active?.setActive(false);
    this.active = tab;
    tab.setActive(true);
    tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    setTimeout(() => {
      if (!document.querySelector("dialog[open]")) tab.focus();
    });
    this.render();
  }

  async close(tab: Tab, ask = true) {
    if (ask && tab.state === "connected") {
      const ok = await confirmDialog({ title: `Disconnect ${tab.title}?`, message: "The connection will be closed.", confirm: "Disconnect and close" });
      if (!ok) return;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.dispose();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
    }
    this.render();
  }

  /** Close several tabs, asking once if any are connected. */
  async closeMany(list: Tab[]) {
    const live = list.filter((t) => t.state === "connected").length;
    if (live) {
      const ok = await confirmDialog({
        title: `Close ${list.length} tab${list.length === 1 ? "" : "s"}?`,
        message: `${live} ${live === 1 ? "is" : "are"} still connected and will be disconnected.`,
        confirm: `Close ${list.length} tab${list.length === 1 ? "" : "s"}`,
      });
      if (!ok) return;
    }
    for (const t of list) await this.close(t, false);
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

  /** Tabs that typing, buttons and the command window go to right now. */
  targets(): Tab[] {
    if (!this.active) return [];
    if (this.broadcast && this.active.inBroadcast) return this.tabs.filter((t) => t.inBroadcast && t.state === "connected");
    return this.active.state === "connected" ? [this.active] : [];
  }

  /** Send to the usual targets, or with `everywhere` to every connected tab (after a confirmation when that's more than one). */
  async sendString(str: string, everywhere = false) {
    const targets = everywhere ? this.tabs.filter((t) => t.state === "connected") : this.targets();
    if (everywhere && targets.length > 1) {
      const ok = await confirmDialog({
        title: `Send to all ${targets.length} connected tabs?`,
        message: h("span", {}, "Sends ", h("code", {}, describeSend(str)), " to every connected tab, not only this one."),
        confirm: `Send to ${targets.length} tabs`,
        warn: true,
      });
      if (!ok) return;
    }
    if (!targets.length) {
      toast(this.active ? "This tab isn't connected. Press Enter in it to reconnect." : "Open a session first.");
      return;
    }
    await Promise.all(targets.map((t) => playSendString(str, (s) => t.send(s))));
    this.active?.focus();
  }

  setBroadcast(on: boolean) {
    this.broadcast = on;
    this.stripEl.classList.toggle("broadcasting", on);
    this.panesEl.classList.toggle("broadcasting", on);
    if (on) toast("Broadcast on: typing goes to every checked tab.");
    this.render();
  }

  setTiled(on: boolean) {
    this.tiled = on;
    this.panesEl.classList.toggle("tiled", on);
    this.render();
    for (const t of this.tabs) t.fitSoon();
  }

  changed(_tab: Tab) {
    this.hooks.changed();
  }

  isVisible(tab: Tab) {
    return document.hasFocus() && (this.tiled || this.active === tab);
  }

  editSession(tab: Tab) {
    this.hooks.editSession(tab);
  }

  tabMenu(tab: Tab, x: number, y: number) {
    this.hooks.tabMenu(tab, x, y);
  }

  targetLabel(tab: Tab) {
    if (this.broadcast && tab.inBroadcast) {
      const n = this.tabs.filter((t) => t.inBroadcast && t.state === "connected").length;
      return { label: `${n} tab${n === 1 ? "" : "s"}`, many: n > 1 };
    }
    return { label: tab.title, many: false };
  }

  render() {
    const n = this.tabs.length;
    this.emptyEl.hidden = n > 0;
    this.stripEl.classList.toggle("empty", n === 0);
    this.panesEl.style.setProperty("--cols", String(Math.max(1, Math.ceil(Math.sqrt(n)))));
    this.hooks.changed();
  }
}
