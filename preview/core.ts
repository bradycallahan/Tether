// In-memory stand-in for Tether's Rust backend, used only by the browser
// preview (preview/vite.config.ts). Command names and payloads mirror
// src-tauri/src/lib.rs; connections talk to a fake Cisco-ish device.

/* eslint-disable @typescript-eslint/no-explicit-any */

export class Channel<T> {
  onmessage: (m: T) => void = () => {};
}

type Args = Record<string, any>;

const term = () => ({
  termType: "xterm-256color",
  logEnabled: false,
  logTemplate: "{session}_{date}_{time}.log",
  logTimestamps: true,
  logStripAnsi: true,
  highlightSet: null,
  backspaceSendsDelete: true,
  encoding: "utf-8",
  colorScheme: null,
});
const ssh = (host: string, username = "netops", extra: Args = {}) => ({
  kind: "ssh", host, port: 22, username, auth: { method: "password" }, jumpSession: null, legacyAlgorithms: false, keepaliveSecs: 30, ...extra,
});
// Stable ids so a restored workspace finds its sessions after a reload.
const sess = (name: string, folder: string, protocol: Args, extra: Args = {}) => ({
  id: `preview-${name.replace(/\W+/g, "-")}`, name, folder, protocol, terminal: term(), notes: "", buttonBar: null, loginScript: "", colorTag: null,
  loginSteps: [], loginTimeoutSecs: 15, autoReconnect: false, antiIdleSecs: 0, antiIdleSend: "", loginUsername: "", ...extra,
});

const empty = new URLSearchParams(location.search).has("empty");

const db = {
  sessions: empty
    ? []
    : [
        sess("core-sw1", "Campus/Core", ssh("10.10.0.1"), { colorTag: "#e5735f", notes: "Catalyst 9500 — MDF rack 2, U14" }),
        sess("core-sw2", "Campus/Core", ssh("10.10.0.2"), { colorTag: "#e5735f" }),
        ...Array.from({ length: 6 }, (_, i) => sess(`idf${i + 1}-acc1`, "Campus/Access", ssh(`10.10.${i + 1}.11`))),
        sess("dc-leaf-101", "Data center", ssh("172.16.1.101", "admin")),
        sess("dc-leaf-102", "Data center", ssh("172.16.1.102", "admin")),
        sess("edge-fw1", "Data center", ssh("172.16.0.1", "admin", { legacyAlgorithms: true })),
        sess("opengear-mdf", "Console servers", { kind: "telnet", host: "10.10.99.5", port: 2003 }),
        sess("USB console", "", { kind: "serial", port: "/dev/ttyUSB0", baud: 9600, dataBits: 8, parity: "none", stopBits: 1, flow: "none" }),
        sess("lab-router (new key)", "Lab", ssh("10.0.0.99")),
        sess("lab-unreachable", "Lab", ssh("10.0.0.250")),
      ],
  settings: {
    uiTheme: new URLSearchParams(location.search).get("theme") ?? "dark",
    terminalScheme: "Patch Bay",
    fontFamily: '"Cascadia Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 14,
    lineHeight: 1.15,
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 20000,
    copyOnSelect: true,
    rightClickPaste: true,
    confirmMultilinePaste: true,
    bell: "visual",
    defaultHighlightSet: "Network gear",
    defaultButtonBar: "Cisco basics",
    logDirectory: "",
    reconnectOnEnter: true,
    showCommandBar: false,
    showButtonBar: true,
    sidebarWidth: 260,
    gpuRendering: false,
    restoreWorkspace: true,
    showToolbar: true,
    showSidebar: true,
    showStatusBar: true,
  } as Args,
  bars: [
    {
      name: "Cisco basics",
      buttons: [
        ["term len 0", "terminal length 0\\r"], ["sh run", "show running-config\\r"], ["int brief", "show ip interface brief\\r"],
        ["int status", "show interfaces status\\r"], ["vlan brief", "show vlan brief\\r"], ["cdp nei", "show cdp neighbors\\r"],
        ["lldp nei", "show lldp neighbors\\r"], ["mac table", "show mac address-table\\r"], ["log", "show logging | last 50\\r"],
        ["wr mem", "copy running-config startup-config\\r\\p\\r"],
      ].map(([label, send]) => ({ label, send, color: null })),
    },
    { name: "Linux", buttons: [["ip a", "ip -br addr\\r"], ["disk", "df -h\\r"]].map(([label, send]) => ({ label, send, color: null })) },
  ],
  highlights: [
    {
      name: "Network gear",
      rules: [
        ["\\b(err-?disabled|down|notconnect|failed|failure|error|denied|invalid|%\\s?[A-Z_]+-[0-3]-\\w+)\\b", "#ef7d6b"],
        ["\\b(up|connected|established|full|forwarding|success(ful)?)\\b", "#8fd18a"],
        ["\\b(warning|blocking|listening|learning|disabled|shutdown|administratively)\\b", "#f2c25c"],
        ["\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b", "#8cc4ec"],
        ["\\b(?:Gi|Te|Fa|Fo|Hu|Twe|Eth?|Po|Vl|Lo|Tu)\\d+(?:/\\d+)*(?:\\.\\d+)?\\b", "#7fd3cf"],
      ].map(([pattern, fg]) => ({ pattern, regex: true, caseSensitive: false, foreground: fg, background: null })),
    },
  ],
  folders: [] as string[],
  // Kept across reloads so "restore workspace" can be tried in the preview.
  workspace: JSON.parse(localStorage.getItem("preview.workspace") ?? "null") ?? { tabs: [], active: 0, tiled: false, recent: [] },
  trusted: new Set<string>(),
  secrets: new Map<string, Set<string>>(),
};

// ---------------------------------------------------------------------------
// Fake device

const SHOW_IP_INT = `Interface              IP-Address      OK? Method Status                Protocol
Vlan1                  unassigned      YES NVRAM  administratively down down
Vlan10                 10.10.0.1       YES NVRAM  up                    up
Vlan20                 10.20.0.1       YES NVRAM  up                    up
GigabitEthernet1/0/1   unassigned      YES unset  up                    up
GigabitEthernet1/0/2   unassigned      YES unset  down                  down
Te1/1/1                unassigned      YES unset  up                    up`;

const SHOW_INT_STATUS = `Port      Name               Status       Vlan       Duplex  Speed Type
Gi1/0/1   uplink-core        connected    trunk        full   1000 10/100/1000BaseTX
Gi1/0/2   AP-2F-east         connected    20           full   1000 10/100/1000BaseTX
Gi1/0/3                      notconnect   20           auto   auto 10/100/1000BaseTX
Gi1/0/4   printer-2F         err-disabled 30           auto   auto 10/100/1000BaseTX
Gi1/0/5                      disabled     1            auto   auto 10/100/1000BaseTX`;

class Device {
  line = "";
  awake: boolean;
  constructor(private name: string, private kind: string, private out: (s: string) => void, private hangUp: () => void) {
    this.awake = kind !== "serial";
  }
  get prompt() {
    return `${this.name.replace(/[^\w-]/g, "")}#`;
  }
  start() {
    if (this.kind === "serial") return;
    this.out(`\r\n*** Authorized access only. Activity is logged. ***\r\n\r\n${this.prompt}`);
  }
  input(s: string) {
    for (const ch of s) {
      if (ch === "\r") {
        const cmd = this.line.trim();
        this.line = "";
        if (!this.awake) {
          this.awake = true;
          this.out(`\r\n\r\nSwitch>`);
          continue;
        }
        if (cmd === "exit" || cmd === "logout") {
          this.out("\r\n");
          this.hangUp();
          return;
        }
        this.out("\r\n" + this.respond(cmd) + this.prompt);
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.out("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.out("^C\r\n" + this.prompt);
      } else if (ch >= " ") {
        this.line += ch;
        this.out(ch);
      }
    }
  }
  respond(cmd: string): string {
    const c = cmd.toLowerCase();
    const nl = (t: string) => t.replace(/\n/g, "\r\n") + "\r\n";
    if (!c) return "";
    if (c.startsWith("terminal length")) return "";
    if (c === "show ip interface brief" || c === "sh ip int br") return nl(SHOW_IP_INT);
    if (c.startsWith("show interfaces status") || c === "sh int status") return nl(SHOW_INT_STATUS);
    if (c.startsWith("show version")) return nl(`Cisco IOS XE Software, Version 17.09.04a\n${this.name} uptime is 41 weeks, 2 days, 3 hours, 12 minutes`);
    if (c.startsWith("show logging"))
      return nl(`*Oct 20 01:12:44: %LINK-3-UPDOWN: Interface GigabitEthernet1/0/2, changed state to down\n*Oct 20 01:12:45: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/2, changed state to down\n*Oct 20 01:40:02: %PM-4-ERR_DISABLE: bpduguard error detected on Gi1/0/4, putting Gi1/0/4 in err-disable state`);
    if (c.startsWith("copy run")) return nl("Destination filename [startup-config]? \nBuilding configuration...\n[OK]");
    return nl(`                ^\n% Invalid input detected at '^' marker.`);
  }
}

const conns = new Map<string, { device: Device; status: Channel<unknown> }>();
const enc = new TextEncoder();
const b64 = (s: string) => {
  let bin = "";
  for (const b of enc.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (code: string, message: string, detail?: Args) => ({ code, message, detail });

async function connect(a: Args) {
  const { args, data, status } = a as { args: Args; data: Channel<string>; status: Channel<unknown> };
  const s = args.session;
  const p = s.protocol;
  const label = p.host ?? p.port ?? "local shell";
  status.onmessage({ state: "connecting", message: `Connecting to ${label}…` });
  await wait(350);
  if (p.host === "10.0.0.250") throw err("CONNECT", `Couldn't reach ${p.host}:${p.port}: connection timed out after 10 s. Check the address and that the device is up.`);
  if (p.host === "10.0.0.99" && !db.trusted.has(p.host))
    throw err("HOSTKEY_UNKNOWN", "Unknown host key", { host: p.host, port: p.port, algorithm: "ssh-ed25519", fingerprint: "SHA256:q3x2Vb7dXvZ6s0kM1YB5o8lO0Wj4wTq2vXf0b7mYkqE", key: "ssh-ed25519 AAAA…" });
  if (s.name === "edge-fw1" && !args.password && !db.secrets.get(s.id)?.has("password"))
    throw err("NEED_PASSWORD", `Password for ${p.username}@${p.host}`);
  if (args.remember && args.password) {
    if (!db.secrets.has(s.id)) db.secrets.set(s.id, new Set());
    db.secrets.get(s.id)!.add("password");
  }
  const device = new Device(s.name, p.kind, (t) => data.onmessage(b64(t)), () => {
    conns.delete(args.connId);
    status.onmessage({ state: "closed", message: "Connection closed by remote host." });
  });
  conns.set(args.connId, { device, status });
  status.onmessage({ state: "connected", message: `Connected to ${label}` });
  setTimeout(() => device.start(), 60);
  return { logPath: s.terminal.logEnabled ? `/home/admin/.config/Tether/logs/${s.name}.log` : null };
}

const handlers: Record<string, (a: Args) => unknown> = {
  list_sessions: () => structuredClone(db.sessions),
  save_session: ({ session }) => {
    const i = db.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) db.sessions[i] = session;
    else db.sessions.push(session);
  },
  save_sessions: ({ sessions }) => sessions.forEach((s: Args) => handlers.save_session({ session: s })),
  delete_session: ({ id }) => {
    db.sessions = db.sessions.filter((s) => s.id !== id);
  },
  get_button_bars: () => structuredClone(db.bars),
  save_button_bars: ({ bars }) => void (db.bars = bars),
  get_highlights: () => structuredClone(db.highlights),
  save_highlights: ({ sets }) => void (db.highlights = sets),
  get_settings: () => structuredClone(db.settings),
  save_settings: ({ settings }) => void (db.settings = settings),
  get_folders: () => [...db.folders],
  save_folders: ({ folders }) => void (db.folders = folders),
  get_workspace: () => db.workspace,
  save_workspace: ({ workspace }) => {
    db.workspace = workspace;
    localStorage.setItem("preview.workspace", JSON.stringify(workspace));
  },
  secret_status: ({ id }) => ({ password: !!db.secrets.get(id)?.has("password"), passphrase: false, enable: !!db.secrets.get(id)?.has("enable") }),
  set_secret: ({ id, kind }) => {
    if (!db.secrets.has(id)) db.secrets.set(id, new Set());
    db.secrets.get(id)!.add(kind);
  },
  forget_secrets: ({ id }) => void db.secrets.delete(id),
  import_securecrt: () => ({ sessions: [sess("imported-sw1", "Imported/Branch", ssh("192.168.50.2"))], skipped: [] }),
  list_serial_ports: () => [{ name: "/dev/ttyUSB0", description: "FTDI FT232R USB UART" }],
  default_shell: () => "/bin/bash",
  open_folder: () => undefined,
  data_dir: () => "/home/admin/.config/Tether",
  window_ready: () => undefined,
  trust_host_key: ({ host }) => void db.trusted.add(host),
  connect,
  write: ({ connId, data }) => {
    conns.get(connId)?.device.input(data);
    return true;
  },
  write_bytes: () => true,
  resize: () => true,
  send_break: () => true,
  disconnect: ({ connId }) => void conns.delete(connId),
  set_logging: ({ enabled }) => (enabled ? "/home/admin/.config/Tether/logs/session.log" : null),
};

export async function invoke<T>(cmd: string, args: Args = {}): Promise<T> {
  const h = handlers[cmd];
  if (!h) throw err("PREVIEW", `The browser preview doesn't fake "${cmd}" yet.`);
  return (await h(args)) as T;
}
