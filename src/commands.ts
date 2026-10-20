// Every user-facing action lives here once, with its label, shortcut and
// enabled/checked state. The menu bar, toolbar, command palette, context
// menus and keyboard handling all read from this registry, so a shortcut
// shown in a menu is always the one that works.

import type { ICONS } from "./dom";

export type IconName = keyof typeof ICONS;

export const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export interface Command {
  id: string;
  label: string | (() => string);
  /** Chords like "Mod+Shift+N". Mod is Ctrl on Windows/Linux and ⌘ on macOS. */
  keys?: string[];
  /** macOS chords, when they differ from `keys`. */
  macKeys?: string[];
  icon?: IconName;
  /** Longer text for tooltips and the palette. */
  detail?: string;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Left out of the command palette (e.g. "Go to tab 3"). */
  hideInPalette?: boolean;
  run: () => void;
}

export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function parseChord(text: string, mac = isMac): Chord {
  const c: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  // Split on "+" but allow "+" itself as the key ("Mod++").
  const parts = text.split(/\+(?!$)/);
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case "mod": if (mac) c.meta = true; else c.ctrl = true; break;
      case "ctrl": c.ctrl = true; break;
      case "shift": c.shift = true; break;
      case "alt": c.alt = true; break;
      case "meta": case "cmd": c.meta = true; break;
      default: c.key = p.length === 1 ? p.toLowerCase() : p;
    }
  }
  return c;
}

export function chordMatches(c: Chord, e: KeyLike): boolean {
  if (c.ctrl !== e.ctrlKey || c.shift !== e.shiftKey || c.alt !== e.altKey || c.meta !== e.metaKey) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return key === c.key;
}

const MAC_KEY_NAMES: Record<string, string> = { Enter: "↩", Tab: "⇥", PageUp: "⇞", PageDown: "⇟", ArrowUp: "↑", ArrowDown: "↓", Escape: "⎋" };
const PC_KEY_NAMES: Record<string, string> = { PageUp: "PgUp", PageDown: "PgDn", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc" };

/** "Mod+Shift+N" → "Ctrl+Shift+N" or "⇧⌘N". */
export function formatChord(text: string, mac = isMac): string {
  const c = parseChord(text, mac);
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (mac) {
    return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${MAC_KEY_NAMES[key] ?? key}`;
  }
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Win", PC_KEY_NAMES[key] ?? key].filter(Boolean).join("+");
}

class Registry {
  private byId = new Map<string, Command>();
  /** Chords indexed by key, so matching a keystroke is one lookup (it runs on every key). */
  private chords = new Map<string, { chord: Chord; cmd: Command }[]>();

  add(...cmds: Command[]) {
    for (const cmd of cmds) {
      this.byId.set(cmd.id, cmd);
      for (const k of (isMac ? cmd.macKeys ?? cmd.keys : cmd.keys) ?? []) {
        const chord = parseChord(k);
        this.chords.set(chord.key, [...(this.chords.get(chord.key) ?? []), { chord, cmd }]);
      }
    }
  }

  get(id: string): Command {
    const c = this.byId.get(id);
    if (!c) throw new Error(`Unknown command ${id}`);
    return c;
  }

  all(): Command[] {
    return [...this.byId.values()];
  }

  label(id: string): string {
    const l = this.get(id).label;
    return typeof l === "function" ? l() : l;
  }

  enabled(id: string): boolean {
    return this.get(id).enabled?.() ?? true;
  }

  /** Display text of the first shortcut, e.g. "Ctrl+Shift+N". */
  shortcut(id: string): string | undefined {
    const c = this.get(id);
    const k = (isMac ? c.macKeys ?? c.keys : c.keys)?.[0];
    return k ? formatChord(k) : undefined;
  }

  /** Tooltip text: label plus shortcut. */
  tip(id: string): string {
    const s = this.shortcut(id);
    const d = this.get(id).detail;
    return `${d ?? this.label(id)}${s ? ` (${s})` : ""}`;
  }

  run(id: string) {
    if (this.enabled(id)) this.get(id).run();
  }

  /**
   * The command bound to this key event, if any. When two commands share a
   * chord (Reconnect / Disconnect), the one that's currently enabled wins.
   */
  match(e: KeyLike): Command | undefined {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const hits = (this.chords.get(key) ?? []).filter((x) => chordMatches(x.chord, e)).map((x) => x.cmd);
    return hits.find((c) => c.enabled?.() ?? true) ?? hits[0];
  }
}

export const commands = new Registry();
