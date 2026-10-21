// The built-in TFTP server's face: a status-strip segment while it runs, a
// panel with the addresses to give the device and the transfer log, and the
// Start/Stop command. The server itself lives in Rust (tftp.rs) and keeps
// running whichever tab is in front, like SecureCRT's.

import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { clear, h, icon } from "./dom";
import { button, toast } from "./dialogs";
import { platform } from "./platform";
import { store } from "./state";
import type { Settings, TftpStatus, TftpTransfer } from "./types";

const KEEP = 50;

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Whole percent, or null when the size isn't known. Never 100 before the end. */
export function percent(t: Pick<TftpTransfer, "bytes" | "total" | "state">): number | null {
  if (t.state === "done") return 100;
  if (!t.total) return null;
  return Math.min(99, Math.floor((t.bytes / t.total) * 100));
}

/** One line for the log: what happened, to whom. */
export function describe(t: TftpTransfer): string {
  const send = t.direction === "send";
  switch (t.state) {
    case "active":
      return `${send ? "Sending" : "Receiving"} ${t.file} ${send ? "to" : "from"} ${t.peer}`;
    case "done":
      return `${send ? "Sent" : "Received"} ${t.file} ${send ? "to" : "from"} ${t.peer}`;
    case "refused":
      return `Refused ${t.peer} ${send ? "reading" : "writing"} ${t.file}`;
    case "failed":
      return `${send ? "Sending" : "Receiving"} ${t.file} ${send ? "to" : "from"} ${t.peer} failed`;
  }
}

/** The address a device should use: the one it's bound to, else the first found. */
export function serverAddress(s: Pick<TftpStatus, "address" | "addresses" | "port">): string | null {
  const ip = s.address || s.addresses[0]?.address;
  if (!ip) return null;
  return s.port === 69 ? ip : `${ip}:${s.port}`;
}

const TFTP_KEYS: (keyof Settings)[] = ["tftpFolder", "tftpAddress", "tftpPort", "tftpAllowOverwrite", "tftpOpenTabsOnly"];

export class Tftp {
  /** The status-strip segment; hidden while the server is off. */
  readonly el = h("button", { type: "button", class: "seg tftp", hidden: true, "aria-haspopup": "dialog" });
  status: TftpStatus | null = null;
  transfers: TftpTransfer[] = [];
  private panel: HTMLElement | null = null;
  private applied: Partial<Settings> = {};
  /** Set while stopping, when cancelled transfers needn't each say so. */
  private stopping = false;

  constructor(private openSettings: () => void) {
    this.el.addEventListener("click", () => (this.panel ? this.closePanel() : this.openPanel()));
  }

  get running() {
    return !!this.status?.running;
  }

  async init() {
    this.remember();
    listen<TftpStatus>("tftp-status", (e) => this.setStatus(e.payload)).catch(() => {});
    listen<TftpTransfer>("tftp-transfer", (e) => this.onTransfer(e.payload)).catch(() => {});
    store.on("settings", () => void this.settingsChanged());
    this.setStatus(await api.tftpStatus().catch(() => null));
    if (store.settings.tftpStartWithApp && !this.running) await this.start(true);
  }

  async start(quiet = false) {
    try {
      this.setStatus(await api.tftpStart());
      this.remember();
      if (!quiet) {
        const at = this.status && serverAddress(this.status);
        toast(at ? `TFTP server ready at ${at}.` : "TFTP server ready.", { action: { label: "Details", run: () => this.openPanel() } });
      }
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e);
      toast(msg, { ms: 9000, action: { label: "TFTP settings", run: this.openSettings } });
    }
  }

  async stop() {
    const busy = this.transfers.filter((t) => t.state === "active").length;
    this.stopping = true;
    this.setStatus(await api.tftpStop().catch(() => this.status));
    this.stopping = false;
    if (busy) toast(`TFTP server stopped. ${busy === 1 ? "A transfer was" : `${busy} transfers were`} cancelled.`);
  }

  toggle() {
    void (this.running ? this.stop() : this.start());
  }

  private remember() {
    this.applied = Object.fromEntries(TFTP_KEYS.map((k) => [k, store.settings[k]]));
  }

  /** New folder, address or rules take effect at once, unless that would cut a transfer short. */
  private async settingsChanged() {
    if (!this.running) {
      this.setStatus(await api.tftpStatus().catch(() => this.status));
      return;
    }
    if (TFTP_KEYS.every((k) => store.settings[k] === this.applied[k])) return;
    if (this.transfers.some((t) => t.state === "active")) {
      toast("The new TFTP settings apply after the transfer in progress. Stop and start the server then.", { ms: 6000 });
      return;
    }
    await api.tftpStop().catch(() => {});
    this.status = null;
    await this.start(true);
  }

  private setStatus(s: TftpStatus | null) {
    if (!s) return;
    this.status = s;
    // Stopping cancels every transfer; don't leave one looking busy if its last event went missing.
    if (!s.running) {
      for (const t of this.transfers) {
        if (t.state === "active") Object.assign(t, { state: "failed", error: "The TFTP server was stopped" });
      }
    }
    this.render();
  }

  private onTransfer(t: TftpTransfer) {
    const i = this.transfers.findIndex((x) => x.id === t.id);
    const was = i >= 0 ? this.transfers[i] : undefined;
    if (i >= 0) this.transfers[i] = t;
    else this.transfers.unshift(t);
    if (this.transfers.length > KEEP) this.transfers.length = KEEP;
    // Finished transfers get a word unless the panel already shows them.
    if (t.state !== "active" && was?.state !== t.state && !this.panel && !this.stopping && this.running) {
      const size = t.state === "done" ? ` (${formatBytes(t.bytes)})` : "";
      const why = t.error ? `: ${t.error}` : "";
      toast(`${describe(t)}${size}${why}`, t.state === "done" && t.direction === "receive" ? { action: { label: "Open folder", run: () => void api.openFolder("tftp") } } : {});
    }
    this.render();
  }

  private render() {
    const s = this.status;
    const active = this.transfers.filter((t) => t.state === "active");
    this.el.hidden = !s?.running && !active.length;
    clear(this.el);
    if (active.length) {
      const t = active[0];
      const pct = percent(t);
      const more = active.length > 1 ? ` +${active.length - 1}` : "";
      this.el.className = "seg tftp warn";
      // Progress first, so it survives when a narrow window cuts the file name short.
      this.el.append(h("span", { class: "led busy" }), `TFTP ${pct === null ? formatBytes(t.bytes) : `${pct}%`}${more} ${t.direction === "send" ? "sending" : "receiving"} ${t.file}`);
    } else if (s?.running) {
      this.el.className = "seg tftp on";
      this.el.append(h("span", { class: "led connected" }), `TFTP ${serverAddress(s) ?? "ready"}`);
    }
    this.el.title = s?.running ? "TFTP server: addresses, folder and transfers" : "";
    if (this.panel) this.fillPanel();
  }

  // ---------------------------------------------------------------------------
  // Panel

  openPanel() {
    if (this.panel) return;
    this.panel = h("div", { class: "tftp-panel", role: "dialog", "aria-label": "TFTP server", tabindex: "-1" });
    document.body.append(this.panel);
    this.el.setAttribute("aria-expanded", "true");
    this.fillPanel();
    this.place();
    addEventListener("pointerdown", this.outside, true);
    addEventListener("keydown", this.onKey, true);
    addEventListener("resize", this.closePanel);
    (this.panel.querySelector(".btn") as HTMLElement | null)?.focus();
    // Refresh addresses: a cable or VPN may have come up since it started.
    api.tftpStatus().then((s) => this.setStatus(s)).catch(() => {});
  }

  closePanel = () => {
    if (!this.panel) return;
    this.panel.remove();
    this.panel = null;
    this.el.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", this.outside, true);
    removeEventListener("keydown", this.onKey, true);
    removeEventListener("resize", this.closePanel);
  };

  private outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!this.panel?.contains(t) && !this.el.contains(t)) this.closePanel();
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.closePanel();
    if (!this.el.hidden) this.el.focus();
  };

  /** Above the status strip, right-aligned with the segment, kept on screen. */
  private place() {
    if (!this.panel) return;
    const r = this.el.hidden ? { right: innerWidth - 12, top: innerHeight - 24 } : this.el.getBoundingClientRect();
    const w = this.panel.offsetWidth;
    this.panel.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    this.panel.style.bottom = `${innerHeight - r.top + 6}px`;
  }

  private fillPanel() {
    const p = this.panel;
    const s = this.status;
    if (!p || !s) return;
    clear(p);
    const on = s.running;
    const portNote = s.port === 69 ? "" : ` (port ${s.port})`;
    const addresses = s.address ? s.addresses.filter((a) => a.address === s.address) : s.addresses;
    const shown = addresses.length ? addresses : s.address ? [{ address: s.address, interface: "" }] : [];
    const first = s.address || shown[0]?.address || "<this PC>";
    const target = s.port === 69 ? first : `${first}:${s.port}`;

    p.append(
      h("div", { class: "tftp-head" },
        h("span", { class: `led ${on ? "connected" : ""}` }),
        h("strong", {}, "TFTP server"),
        h("span", { class: "dim" }, on ? `Ready${portNote}` : "Off"),
      ),
    );
    if (on) {
      p.append(
        h("div", { class: "tftp-section" },
          h("div", { class: "rowhead" }, "Devices can reach it at"),
          shown.length
            ? h("ul", { class: "tftp-addrs" }, shown.map((a) =>
                h("li", {},
                  h("span", { class: "mono" }, a.address),
                  h("span", { class: "dim" }, a.interface),
                  h("button", { type: "button", class: "btn ghost small", title: `Copy ${a.address}`, onclick: () => this.copy(a.address) }, icon("copy"), "Copy"),
                )))
            : h("p", { class: "dim" }, "No network address found. Connect a cable or Wi-Fi."),
          h("p", { class: "hint" }, "On a Cisco device: ", h("span", { class: "mono" }, `copy tftp://${target}/<file> flash:`)),
        ),
      );
    } else {
      p.append(h("p", { class: "tftp-section dim" }, "Start the server to let devices copy files to and from the folder below."));
    }
    p.append(
      h("div", { class: "tftp-section" },
        h("div", { class: "rowhead" }, "Folder"),
        h("div", { class: "tftp-folder" }, h("span", { class: "mono path", title: s.folder }, s.folder), button("Open", { kind: "ghost", onclick: () => void api.openFolder("tftp").catch((e) => toast(e?.message ?? String(e))) })),
      ),
    );

    const list = h("ul", { class: "tftp-log" });
    for (const t of this.transfers.slice(0, 12)) {
      const pct = percent(t);
      const state = t.state === "done" ? "connected" : t.state === "active" ? "busy" : "error";
      const meta = t.state === "active"
        ? `${formatBytes(t.bytes)}${pct === null ? "" : ` · ${pct}%`}`
        : t.state === "done"
          ? `${formatBytes(t.bytes)} · ${rate(t)}`
          : t.error ?? "";
      list.append(
        h("li", { class: t.state },
          h("span", { class: `led ${state}` }),
          h("div", {},
            h("div", { class: "what" }, describe(t)),
            h("div", { class: "meta" }, meta),
            t.state === "active" && pct !== null ? h("div", { class: "bar" }, h("span", { style: { width: `${pct}%` } })) : null,
          ),
        ),
      );
    }
    p.append(
      h("div", { class: "tftp-section" },
        h("div", { class: "rowhead" }, "Transfers"),
        this.transfers.length
          ? list
          : h("p", { class: "dim" }, on
            ? platform === "windows"
              ? "None yet. If a device times out, check that Windows Firewall allows Tether on this network."
              : "None yet."
            : "None this session."),
      ),
      h("div", { class: "tftp-foot" },
        button("Settings…", { kind: "ghost", onclick: () => { this.closePanel(); this.openSettings(); } }),
        h("span", { class: "grow" }),
        on ? button("Stop server", { onclick: () => void this.stop() }) : button("Start server", { kind: "primary", onclick: () => void this.start(true) }),
      ),
    );
    this.place();
  }

  private copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}.`), () => toast("Couldn't copy to the clipboard."));
  }
}

function rate(t: TftpTransfer): string {
  const secs = t.elapsedMs / 1000;
  if (secs < 0.5) return "under a second";
  return `${formatBytes(t.bytes / secs)}/s`;
}
