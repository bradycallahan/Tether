import { describe, expect, it } from "vitest";
import { chordMatches, formatChord, parseChord } from "../src/commands";
import { rankSessions } from "../src/quickconnect";
import type { Protocol } from "../src/types";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods,
});

describe("shortcuts", () => {
  it("maps Mod to Ctrl or Cmd", () => {
    expect(parseChord("Mod+Shift+N", false)).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "n" });
    expect(parseChord("Mod+Shift+N", true)).toEqual({ ctrl: false, shift: true, alt: false, meta: true, key: "n" });
    expect(parseChord("Mod++", false).key).toBe("+");
  });
  it("matches exact modifiers only", () => {
    const c = parseChord("Mod+Shift+W", false);
    expect(chordMatches(c, key("W", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(chordMatches(c, key("w", { ctrlKey: true }))).toBe(false);
    expect(chordMatches(c, key("w", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(chordMatches(parseChord("Alt+Enter", false), key("Enter", { altKey: true }))).toBe(true);
  });
  it("formats per platform", () => {
    expect(formatChord("Mod+Shift+N", false)).toBe("Ctrl+Shift+N");
    expect(formatChord("Mod+Shift+N", true)).toBe("⇧⌘N");
    expect(formatChord("Ctrl+PageDown", false)).toBe("Ctrl+PgDn");
    expect(formatChord("Alt+Enter", true)).toBe("⌥↩");
  });
});

describe("session ranking", () => {
  const ssh = (host: string): Protocol => ({ kind: "ssh", host, port: 22, username: "", auth: { method: "password" }, jumpSession: null, legacyAlgorithms: false, keepaliveSecs: 30 });
  const list = [
    { name: "idf1-acc1", folder: "Campus/Access", protocol: ssh("10.10.1.11") },
    { name: "core-sw1", folder: "Campus/Core", protocol: ssh("10.10.0.1") },
    { name: "dc-core", folder: "Data center", protocol: ssh("172.16.0.5") },
    { name: "console", folder: "", protocol: { kind: "serial", port: "COM3", baud: 9600, dataBits: 8, parity: "none", stopBits: 1, flow: "none" } as Protocol },
  ];
  const names = (q: string) => rankSessions(q, list).map((s) => s.name);
  it("puts name prefixes first, then words, then hosts", () => {
    expect(names("core")).toEqual(["core-sw1", "dc-core"]);
    expect(names("10.10.0")).toEqual(["core-sw1"]);
    expect(names("access")).toEqual(["idf1-acc1"]);
    expect(names("com3")).toEqual(["console"]);
  });
  it("falls back to loose letter matches", () => {
    expect(names("csw")).toEqual(["core-sw1"]);
    expect(names("")).toEqual([]);
  });
});

describe("registry", () => {
  it("prefers the enabled command when two share a chord", async () => {
    const { commands } = await import("../src/commands");
    let connected = false;
    const ran: string[] = [];
    commands.add(
      { id: "t.reconnect", label: "Reconnect", keys: ["Ctrl+Shift+Y"], enabled: () => !connected, run: () => ran.push("reconnect") },
      { id: "t.disconnect", label: "Disconnect", keys: ["Ctrl+Shift+Y"], enabled: () => connected, run: () => ran.push("disconnect") },
    );
    const e = key("Y", { ctrlKey: true, shiftKey: true });
    commands.run(commands.match(e)!.id);
    connected = true;
    commands.run(commands.match(e)!.id);
    expect(ran).toEqual(["reconnect", "disconnect"]);
    expect(commands.match(key("y", { ctrlKey: true }))).toBeUndefined();
  });
});
