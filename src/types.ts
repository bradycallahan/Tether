// Mirrors src-tauri/src/model.rs. Keep the two in sync.

export type Parity = "none" | "odd" | "even";
export type FlowControl = "none" | "software" | "hardware";

export type SshAuth = { method: "password" } | { method: "publicKey"; keyPath: string };

export type Protocol =
  | {
      kind: "ssh";
      host: string;
      port: number;
      username: string;
      auth: SshAuth;
      jumpSession?: string | null;
      legacyAlgorithms: boolean;
      keepaliveSecs: number;
    }
  | { kind: "telnet"; host: string; port: number }
  | { kind: "raw"; host: string; port: number }
  | {
      kind: "serial";
      port: string;
      baud: number;
      dataBits: number;
      parity: Parity;
      stopBits: number;
      flow: FlowControl;
    }
  | { kind: "local"; shell: string };

export type ProtocolKind = Protocol["kind"];

export interface TerminalOptions {
  termType: string;
  logEnabled: boolean;
  logTemplate: string;
  logTimestamps: boolean;
  logStripAnsi: boolean;
  highlightSet: string | null;
  backspaceSendsDelete: boolean;
  encoding: string;
  /** Terminal color scheme for this session; null follows Settings. */
  colorScheme: string | null;
}

/** Wait for `expect` (plain text, or a regex when `regex`), then send `send`. */
export interface LoginStep {
  expect: string;
  send: string;
  regex: boolean;
}

export interface Session {
  id: string;
  name: string;
  folder: string;
  protocol: Protocol;
  terminal: TerminalOptions;
  notes: string;
  buttonBar: string | null;
  /** Legacy one-command-per-line script; superseded by loginSteps. */
  loginScript: string;
  colorTag: string | null;
  loginSteps: LoginStep[];
  loginTimeoutSecs: number;
  autoReconnect: boolean;
  antiIdleSecs: number;
  antiIdleSend: string;
  /** Login-action user name for non-SSH sessions ({username}). */
  loginUsername: string;
}

export interface Button {
  label: string;
  send: string;
  color?: string | null;
}

export interface ButtonBar {
  name: string;
  buttons: Button[];
}

export interface HighlightRule {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  foreground: string | null;
  background?: string | null;
}

export interface HighlightSet {
  name: string;
  rules: HighlightRule[];
}

export interface Settings {
  uiTheme: "system" | "dark" | "light";
  terminalScheme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  confirmMultilinePaste: boolean;
  bell: "none" | "visual" | "sound";
  defaultHighlightSet: string | null;
  defaultButtonBar: string | null;
  logDirectory: string;
  reconnectOnEnter: boolean;
  showCommandBar: boolean;
  showButtonBar: boolean;
  sidebarWidth: number;
  gpuRendering: boolean;
  restoreWorkspace: boolean;
  showToolbar: boolean;
  showSidebar: boolean;
  showStatusBar: boolean;
  /** The master passphrase has been offered once (first run). */
  vaultOffered: boolean;
  /** Mark a background tab whose busy output stopped this many seconds ago; 0 = off. */
  quietTabSecs: number;
}

export interface WorkspaceTab {
  session: Session;
  saved: boolean;
  title: string;
  inBroadcast: boolean;
}

export interface Workspace {
  tabs: WorkspaceTab[];
  active: number;
  tiled: boolean;
  recent: string[];
}

export type SecretKind = "password" | "passphrase" | "enable";

export interface StatusEvent {
  state: "connecting" | "connected" | "closed" | "error" | "warning";
  message: string;
}

/** Something the command line or a link asked Tether to open (launch.rs). */
export type LaunchTarget = { kind: "session" | "url" | "command"; value: string };

export interface CmdError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface PortInfo {
  name: string;
  description: string;
}

/** A shell found on this machine. `command` goes in a session's `shell`. */
export interface ShellInfo {
  name: string;
  command: string;
}

export interface ImportReport {
  sessions: Session[];
  skipped: string[];
}

export function defaultTerminal(): TerminalOptions {
  return {
    termType: "xterm-256color",
    logEnabled: false,
    logTemplate: "{session}_{date}_{time}.log",
    logTimestamps: true,
    logStripAnsi: true,
    highlightSet: null,
    backspaceSendsDelete: true,
    encoding: "utf-8",
    colorScheme: null,
  };
}

export function defaultProtocol(kind: ProtocolKind): Protocol {
  switch (kind) {
    case "ssh":
      return { kind, host: "", port: 22, username: "", auth: { method: "password" }, jumpSession: null, legacyAlgorithms: false, keepaliveSecs: 30 };
    case "telnet":
      return { kind, host: "", port: 23 };
    case "raw":
      return { kind, host: "", port: 2001 };
    case "serial":
      return { kind, port: "", baud: 9600, dataBits: 8, parity: "none", stopBits: 1, flow: "none" };
    case "local":
      return { kind, shell: "" };
  }
}

export function newSession(partial: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    name: "",
    folder: "",
    protocol: defaultProtocol("ssh"),
    terminal: defaultTerminal(),
    notes: "",
    buttonBar: null,
    loginScript: "",
    colorTag: null,
    loginSteps: [],
    loginTimeoutSecs: 15,
    autoReconnect: false,
    antiIdleSecs: 0,
    antiIdleSend: "",
    loginUsername: "",
    ...partial,
  };
}

export function hostLabel(p: Protocol): string {
  switch (p.kind) {
    case "ssh": {
      const user = p.username ? `${p.username}@` : "";
      return p.port === 22 ? `${user}${p.host}` : `${user}${p.host}:${p.port}`;
    }
    case "telnet":
    case "raw":
      return `${p.host}:${p.port}`;
    case "serial":
      return `${p.port} @ ${p.baud}`;
    case "local":
      return p.shell || "local shell";
  }
}

export const PROTOCOL_NAMES: Record<ProtocolKind, string> = {
  ssh: "SSH",
  telnet: "Telnet",
  raw: "Raw TCP",
  serial: "Serial",
  local: "Local shell",
};
