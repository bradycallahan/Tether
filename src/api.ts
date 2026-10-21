import { Channel, invoke } from "@tauri-apps/api/core";
import type { ButtonBar, HighlightSet, ImportReport, LaunchTarget, PortInfo, SecretKind, Session, Settings, ShellInfo, StatusEvent, Workspace } from "./types";

export const api = {
  listSessions: () => invoke<Session[]>("list_sessions"),
  saveSession: (session: Session) => invoke<void>("save_session", { session }),
  saveSessions: (sessions: Session[]) => invoke<void>("save_sessions", { sessions }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  getButtonBars: () => invoke<ButtonBar[]>("get_button_bars"),
  saveButtonBars: (bars: ButtonBar[]) => invoke<void>("save_button_bars", { bars }),
  getHighlights: () => invoke<HighlightSet[]>("get_highlights"),
  saveHighlights: (sets: HighlightSet[]) => invoke<void>("save_highlights", { sets }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  getFolders: () => invoke<string[]>("get_folders"),
  saveFolders: (folders: string[]) => invoke<void>("save_folders", { folders }),
  getWorkspace: () => invoke<Workspace>("get_workspace"),
  saveWorkspace: (workspace: Workspace) => invoke<void>("save_workspace", { workspace }),
  secretStatus: (id: string) => invoke<Record<SecretKind | "locked", boolean>>("secret_status", { id }),
  /** An empty value removes the secret. */
  setSecret: (id: string, kind: SecretKind, value: string) => invoke<void>("set_secret", { id, kind, value }),
  forgetSecrets: (id: string) => invoke<void>("forget_secrets", { id }),
  setJumpList: (entries: { id: string; name: string; detail: string }[]) => invoke<void>("set_jump_list", { entries }),
  takeLaunchTargets: () => invoke<LaunchTarget[]>("take_launch_targets"),
  linkHandlerStatus: () => invoke<boolean | null>("link_handler_status"),
  setLinkHandler: (on: boolean) => invoke<void>("set_link_handler", { on }),
  vaultStatus: () => invoke<{ enabled: boolean; unlocked: boolean }>("vault_status"),
  vaultUnlock: (passphrase: string) => invoke<void>("vault_unlock", { passphrase }),
  vaultEnable: (passphrase: string) => invoke<void>("vault_enable", { passphrase }),
  vaultChange: (passphrase: string) => invoke<void>("vault_change", { passphrase }),
  vaultDisable: () => invoke<void>("vault_disable"),
  vaultReset: () => invoke<void>("vault_reset"),
  importSecureCrt: (path: string) => invoke<ImportReport>("import_securecrt", { path }),
  listSerialPorts: () => invoke<PortInfo[]>("list_serial_ports"),
  defaultShell: () => invoke<string>("default_shell"),
  listShells: () => invoke<ShellInfo[]>("list_shells"),
  openFolder: (which: "logs" | "data") => invoke<void>("open_folder", { which }),
  dataDir: () => invoke<string>("data_dir"),
  windowReady: () => invoke<void>("window_ready"),
  setTitleBarColors: (caption: string, text: string) => invoke<void>("set_title_bar_colors", { caption, text }),
  trustHostKey: (host: string, port: number, key: string, replace: boolean) =>
    invoke<void>("trust_host_key", { host, port, key, replace }),

  connect: (
    args: {
      connId: string;
      session: Session;
      cols: number;
      rows: number;
      password?: string;
      passphrase?: string;
      jumpPassword?: string;
      remember: boolean;
      saved: boolean;
    },
    onData: (bytes: Uint8Array) => void,
    onStatus: (e: StatusEvent) => void,
  ) => {
    const data = new Channel<string>();
    data.onmessage = (m) => onData(fromBase64(m));
    const status = new Channel<StatusEvent>();
    status.onmessage = onStatus;
    return invoke<{ logPath: string | null }>("connect", { args, data, status });
  },
  write: (connId: string, data: string) => invoke<boolean>("write", { connId, data }),
  writeBytes: (connId: string, data: number[]) => invoke<boolean>("write_bytes", { connId, data }),
  resize: (connId: string, cols: number, rows: number) => invoke<boolean>("resize", { connId, cols, rows }),
  sendBreak: (connId: string) => invoke<boolean>("send_break", { connId }),
  disconnect: (connId: string) => invoke<void>("disconnect", { connId }),
  setLogging: (connId: string, enabled: boolean) => invoke<string | null>("set_logging", { connId, enabled }),
};

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
