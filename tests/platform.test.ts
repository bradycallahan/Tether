import { describe, expect, it } from "vitest";
import { isBrowserKey } from "../src/platform";

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe("browser keys", () => {
  it("catches reload, print and the browser's find bar on Windows and Linux", () => {
    for (const k of [key("F5"), key("r", { ctrl: true }), key("F5", { ctrl: true }), key("p", { ctrl: true }), key("f", { ctrl: true }), key("F7"), key("F12")]) {
      expect(isBrowserKey(k, false), k.key).toBe(true);
    }
    expect(isBrowserKey(key("ArrowLeft", { alt: true }), false)).toBe(true);
    expect(isBrowserKey(key("I", { ctrl: true, shift: true }), false)).toBe(true);
  });

  it("leaves typing, editing keys and app shortcuts alone", () => {
    for (const k of [key("r"), key("F1"), key("F2"), key("F10"), key("F11"), key("c", { ctrl: true }), key("v", { ctrl: true }), key("a", { ctrl: true }), key("z", { ctrl: true }), key("Insert", { shift: true }), key("ArrowLeft"), key("ArrowLeft", { ctrl: true })]) {
      expect(isBrowserKey(k, false), k.key).toBe(false);
    }
  });

  it("uses Command on macOS", () => {
    expect(isBrowserKey(key("r", { meta: true }), true)).toBe(true);
    expect(isBrowserKey(key("r", { ctrl: true }), true)).toBe(false);
  });
});
