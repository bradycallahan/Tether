import { describe, expect, it } from "vitest";
import { describeSend, parseSendString } from "../src/escapes";
import { parseQuickConnect } from "../src/quickconnect";

describe("send strings", () => {
  it("expands escapes and control characters", () => {
    expect(parseSendString("show run\\r")).toEqual([{ text: "show run\r" }]);
    expect(parseSendString("^C^Z^^x")).toEqual([{ text: "\x03\x1a^x" }]);
    expect(parseSendString("a\\x41\\\\b")).toEqual([{ text: "aA\\b" }]);
  });
  it("splits on pauses", () => {
    expect(parseSendString("wr\\r\\p\\r")).toEqual([{ text: "wr\r" }, { pause: 500 }, { text: "\r" }]);
  });
  it("describes what a button will send", () => {
    expect(describeSend("copy run start\\r\\p\\r")).toBe("copy run start\u23ce\u23f80.5s\u23ce");
    expect(describeSend("^C")).toBe("^C");
    expect(describeSend("\\t")).toBe("^I");
  });
  it("leaves unknown escapes alone", () => {
    expect(parseSendString("c:\\qa\\z")).toEqual([{ text: "c:\\qa\\z" }]);
  });
});

describe("quick connect", () => {
  it("parses ssh forms", () => {
    expect(parseQuickConnect("10.0.0.1")).toMatchObject({ kind: "ssh", host: "10.0.0.1", port: 22, username: "" });
    expect(parseQuickConnect("admin@core-sw1:2222")).toMatchObject({ kind: "ssh", host: "core-sw1", port: 2222, username: "admin" });
    expect(parseQuickConnect("ssh -p 2200 netops@10.9.8.7")).toMatchObject({ host: "10.9.8.7", port: 2200, username: "netops" });
    expect(parseQuickConnect("admin@[2001:db8::1]:830")).toMatchObject({ host: "2001:db8::1", port: 830 });
  });
  it("parses telnet and raw", () => {
    expect(parseQuickConnect("telnet 10.1.1.5 2003")).toMatchObject({ kind: "telnet", host: "10.1.1.5", port: 2003 });
    expect(parseQuickConnect("telnet://ts1:2004")).toMatchObject({ kind: "telnet", host: "ts1", port: 2004 });
    expect(parseQuickConnect("raw 10.1.1.5 7001")).toMatchObject({ kind: "raw", port: 7001 });
  });
  it("parses serial", () => {
    expect(parseQuickConnect("com3")).toMatchObject({ kind: "serial", port: "COM3", baud: 9600 });
    expect(parseQuickConnect("COM4 115200")).toMatchObject({ port: "COM4", baud: 115200 });
    expect(parseQuickConnect("/dev/ttyUSB0@9600")).toMatchObject({ port: "/dev/ttyUSB0", baud: 9600 });
  });
  it("parses local shells and rejects junk", () => {
    expect(parseQuickConnect("pwsh")).toMatchObject({ kind: "local", shell: "pwsh" });
    expect(parseQuickConnect("local")).toMatchObject({ kind: "local", shell: "" });
    expect(parseQuickConnect("host:99999")).toBeNull();
    expect(parseQuickConnect("   ")).toBeNull();
  });
});
