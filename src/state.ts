import { api } from "./api";
import type { ButtonBar, HighlightSet, Session, Settings, Workspace } from "./types";

type Topic = "sessions" | "bars" | "highlights" | "settings" | "recent";

const RECENT_MAX = 12;

/** Library state loaded from disk, with a tiny change-notification bus. */
class Store {
  sessions: Session[] = [];
  bars: ButtonBar[] = [];
  highlights: HighlightSet[] = [];
  settings!: Settings;
  /** Folders created explicitly (possibly empty). */
  explicitFolders: string[] = [];
  workspace: Workspace = { tabs: [], active: 0, tiled: false, recent: [] };
  private listeners = new Map<Topic, Set<() => void>>();
  private workspaceTimer: number | undefined;

  async load() {
    [this.sessions, this.bars, this.highlights, this.settings, this.explicitFolders, this.workspace] = await Promise.all([
      api.listSessions(),
      api.getButtonBars(),
      api.getHighlights(),
      api.getSettings(),
      api.getFolders().catch(() => []),
      api.getWorkspace().catch(() => ({ tabs: [], active: 0, tiled: false, recent: [] })),
    ]);
  }

  on(topic: Topic, fn: () => void) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic)!.add(fn);
  }

  emit(topic: Topic) {
    this.listeners.get(topic)?.forEach((fn) => fn());
  }

  session(id: string | null | undefined) {
    return id ? this.sessions.find((s) => s.id === id) : undefined;
  }

  /** Every folder path: explicit ones, ones holding sessions, and their parents. */
  folders(): string[] {
    const set = new Set<string>();
    for (const f of [...this.explicitFolders, ...this.sessions.map((s) => s.folder)]) {
      const parts = f.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async saveSession(s: Session) {
    await api.saveSession(s);
    const i = this.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.sessions[i] = s;
    else this.sessions.push(s);
    this.sortSessions();
    this.emit("sessions");
  }

  async saveSessions(list: Session[]) {
    if (!list.length) return;
    await api.saveSessions(list);
    for (const s of list) {
      const i = this.sessions.findIndex((x) => x.id === s.id);
      if (i >= 0) this.sessions[i] = s;
      else this.sessions.push(s);
    }
    this.sortSessions();
    this.emit("sessions");
  }

  async deleteSessions(ids: string[]) {
    for (const id of ids) await api.deleteSession(id);
    const gone = new Set(ids);
    this.sessions = this.sessions.filter((s) => !gone.has(s.id));
    this.workspace.recent = this.workspace.recent.filter((r) => !gone.has(r));
    this.emit("sessions");
  }

  async addFolder(path: string) {
    if (this.explicitFolders.includes(path)) return;
    await this.setFolders([...this.explicitFolders, path]);
  }

  /** Rename or move a folder (and everything under it) to `next`. */
  async renameFolder(path: string, next: string) {
    if (next === path || isUnder(next, path)) return;
    const moved = (f: string) => (isUnder(f, path) ? next + f.slice(path.length) : f);
    await this.saveSessions(this.sessions.filter((s) => isUnder(s.folder, path)).map((s) => ({ ...s, folder: moved(s.folder) })));
    // Keep the folder visible even if it holds no sessions.
    await this.setFolders([...this.explicitFolders.map(moved), next]);
  }

  /** Delete a folder, its subfolders and every session inside. */
  async deleteFolder(path: string) {
    await this.deleteSessions(this.sessions.filter((s) => isUnder(s.folder, path)).map((s) => s.id));
    await this.setFolders(this.explicitFolders.filter((f) => !isUnder(f, path)));
  }

  async moveSessions(ids: string[], folder: string) {
    const set = new Set(ids);
    await this.saveSessions(this.sessions.filter((s) => set.has(s.id) && s.folder !== folder).map((s) => ({ ...s, folder })));
  }

  private async setFolders(list: string[]) {
    const clean = [...new Set(list.filter(Boolean))];
    await api.saveFolders(clean);
    this.explicitFolders = clean;
    this.emit("sessions");
  }

  async saveBars(bars: ButtonBar[]) {
    await api.saveButtonBars(bars);
    this.bars = bars;
    this.emit("bars");
  }

  async saveHighlights(sets: HighlightSet[]) {
    await api.saveHighlights(sets);
    this.highlights = sets;
    this.emit("highlights");
  }

  async saveSettings(s: Settings) {
    await api.saveSettings(s);
    this.settings = s;
    this.emit("settings");
  }

  /** Change a few settings without rewriting callers' copies. */
  patchSettings(patch: Partial<Settings>) {
    return this.saveSettings({ ...this.settings, ...patch });
  }

  /** Saved sessions used most recently, newest first. */
  recentSessions(): Session[] {
    return this.workspace.recent.map((id) => this.session(id)).filter((s): s is Session => !!s);
  }

  touchRecent(id: string) {
    this.workspace.recent = [id, ...this.workspace.recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
    this.emit("recent");
    this.saveWorkspaceSoon();
  }

  /** Workspace writes are debounced: tab changes come in bursts. */
  saveWorkspaceSoon() {
    clearTimeout(this.workspaceTimer);
    this.workspaceTimer = window.setTimeout(() => this.saveWorkspaceNow(), 400);
  }

  saveWorkspaceNow() {
    clearTimeout(this.workspaceTimer);
    return api.saveWorkspace(this.workspace).catch(() => {});
  }

  private sortSessions() {
    this.sessions.sort((a, b) => (a.folder.toLowerCase() + "\u0000" + a.name.toLowerCase()).localeCompare(b.folder.toLowerCase() + "\u0000" + b.name.toLowerCase()));
  }
}

/** True if `folder` is `parent` or inside it. */
export function isUnder(folder: string, parent: string): boolean {
  return folder === parent || folder.startsWith(parent + "/");
}

export function joinFolder(parent: string, name: string): string {
  return [parent, name].map((x) => x.trim()).filter(Boolean).join("/");
}

export function folderName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function parentFolder(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export const store = new Store();
