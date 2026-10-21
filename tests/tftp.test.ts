import { describe as group, expect, it } from "vitest";
import { describe, formatBytes, percent, serverAddress } from "../src/tftp";
import type { TftpTransfer } from "../src/types";

const t = (over: Partial<TftpTransfer>): TftpTransfer => ({
  id: 1, peer: "10.10.0.1", file: "ios.bin", direction: "send", state: "active", bytes: 0, total: null, elapsedMs: 0, error: null, ...over,
});

group("TFTP status text", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(48_211)).toBe("47 KB");
    expect(formatBytes(1_184_563_200)).toBe("1.1 GB");
  });

  it("never shows 100% before the transfer is done", () => {
    expect(percent(t({ bytes: 50, total: 200 }))).toBe(25);
    expect(percent(t({ bytes: 199_999, total: 200_000 }))).toBe(99);
    expect(percent(t({ bytes: 300, total: 200 }))).toBe(99);
    expect(percent(t({ bytes: 200, total: 200, state: "done" }))).toBe(100);
    expect(percent(t({ bytes: 50, total: null }))).toBeNull();
    expect(percent(t({ bytes: 50, total: 0 }))).toBeNull();
  });

  it("describes transfers from the PC's side", () => {
    expect(describe(t({}))).toBe("Sending ios.bin to 10.10.0.1");
    expect(describe(t({ state: "done", direction: "receive", file: "sw1-confg" }))).toBe("Received sw1-confg from 10.10.0.1");
    expect(describe(t({ state: "refused", direction: "receive" }))).toBe("Refused 10.10.0.1 writing ios.bin");
    expect(describe(t({ state: "failed" }))).toBe("Sending ios.bin to 10.10.0.1 failed");
  });

  it("picks the address to give the device", () => {
    const addresses = [{ address: "192.168.1.20", interface: "Wi-Fi" }, { address: "10.0.0.5", interface: "Ethernet" }];
    expect(serverAddress({ address: "", addresses, port: 69 })).toBe("192.168.1.20");
    expect(serverAddress({ address: "10.0.0.5", addresses, port: 69 })).toBe("10.0.0.5");
    expect(serverAddress({ address: "", addresses, port: 6969 })).toBe("192.168.1.20:6969");
    expect(serverAddress({ address: "", addresses: [], port: 69 })).toBeNull();
  });
});
