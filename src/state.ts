import { api } from "./api";
import type { ButtonBar, HighlightSet, Session, Settings } from "./types";

type Topic = "sessions" | "bars" | "highlights" | "settings";

/** Library state loaded from disk, with a tiny change-notification bus. */
class Store {
  sessions: Session[] = [];
  bars: ButtonBar[] = [];
  highlights: HighlightSet[] = [];
  settings!: Settings;
  private listeners = new Map<Topic, Set<() => void>>();

  async load() {
    [this.sessions, this.bars, this.highlights, this.settings] = await Promise.all([
      api.listSessions(),
      api.getButtonBars(),
      api.getHighlights(),
      api.getSettings(),
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

  folders(): string[] {
    const set = new Set<string>();
    for (const s of this.sessions) {
      const parts = s.folder.split("/").filter(Boolean);
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
    await api.saveSessions(list);
    for (const s of list) {
      const i = this.sessions.findIndex((x) => x.id === s.id);
      if (i >= 0) this.sessions[i] = s;
      else this.sessions.push(s);
    }
    this.sortSessions();
    this.emit("sessions");
  }

  async deleteSession(id: string) {
    await api.deleteSession(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
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

  private sortSessions() {
    this.sessions.sort((a, b) => (a.folder.toLowerCase() + "\u0000" + a.name.toLowerCase()).localeCompare(b.folder.toLowerCase() + "\u0000" + b.name.toLowerCase()));
  }
}

export const store = new Store();
