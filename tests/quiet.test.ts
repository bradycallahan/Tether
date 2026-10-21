import { describe, expect, it } from "vitest";
import { BUSY_MS, QuietWatch } from "../src/quiet";

const QUIET = 10_000;

describe("quiet tabs", () => {
  it("marks a busy burst once it stops", () => {
    const w = new QuietWatch();
    for (let t = 0; t <= 3000; t += 700) w.output(t);
    expect(w.remaining(2800 + QUIET - 1, QUIET)).toBeGreaterThan(0);
    expect(w.remaining(2800 + QUIET, QUIET)).toBeLessThanOrEqual(0);
    expect(w.settle()).toBe(true);
  });
  it("ignores a lone line", () => {
    const w = new QuietWatch();
    expect(w.output(0)).toBe(false);
    expect(w.output(40)).toBe(false);
    expect(w.settle()).toBe(false);
  });
  it("reports when a burst becomes busy", () => {
    const w = new QuietWatch();
    expect(w.output(100)).toBe(false);
    expect(w.output(100 + BUSY_MS)).toBe(true);
  });
  it("starts a new burst after settling or being seen", () => {
    const w = new QuietWatch();
    w.output(0);
    w.output(5000);
    w.settle();
    w.output(20_000);
    expect(w.settle()).toBe(false);
    w.output(0);
    w.output(5000);
    w.reset();
    expect(w.settle()).toBe(false);
  });
});
