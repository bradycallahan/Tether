import { describe, expect, it } from "vitest";
import { describeSend, parseSendString } from "../src/escapes";
import { findSession, parseLink, parseQuickConnect, savedFor } from "../src/quickconnect";
import { newSession, type Protocol } from "../src/types";

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

describe("links and launch targets", () => {
  it("parses ssh and telnet links", () => {
    expect(parseLink("ssh://admin@10.0.0.1:2222")).toMatchObject({ kind: "ssh", host: "10.0.0.1", port: 2222, username: "admin" });
    expect(parseLink("ssh://core-sw1/")).toMatchObject({ kind: "ssh", host: "core-sw1", port: 22, username: "" });
    expect(parseLink("SSH://net%40ops;fingerprint=ssh-ed25519-abc@[2001:db8::1]:22")).toMatchObject({ host: "2001:db8::1", username: "net@ops" });
    expect(parseLink("telnet://ts1:2003/")).toMatchObject({ kind: "telnet", host: "ts1", port: 2003 });
  });
  it("refuses anything that isn't a network link", () => {
    expect(parseLink("local://bash")).toBeNull();
    expect(parseLink("raw://host:7000")).toBeNull();
    expect(parseLink("ssh://")).toBeNull();
    expect(parseLink("ssh://host:99999")).toBeNull();
    expect(parseLink("ssh://bad%zz@host")).toBeNull();
  });
  it("finds saved sessions by id, path or name", () => {
    const list = [newSession({ name: "core-sw1", folder: "Campus/Core" }), newSession({ name: "edge-fw1" })];
    expect(findSession("campus/core/CORE-SW1", list)).toBe(list[0]);
    expect(findSession("edge-fw1", list)).toBe(list[1]);
    expect(findSession(list[1].id, list)).toBe(list[1]);
    expect(findSession("nope", list)).toBeUndefined();
  });
  it("matches a link to the saved session for that device", () => {
    const ssh = (host: string, username: string, port = 22) => ({ kind: "ssh", host, port, username, auth: { method: "password" }, jumpSession: null, legacyAlgorithms: false, keepaliveSecs: 30 }) as Protocol;
    const list = [newSession({ name: "a", protocol: ssh("core-sw1", "netops") })];
    expect(savedFor(parseLink("ssh://CORE-SW1")!, list)).toBe(list[0]);
    expect(savedFor(parseLink("ssh://netops@core-sw1")!, list)).toBe(list[0]);
    expect(savedFor(parseLink("ssh://admin@core-sw1")!, list)).toBeUndefined();
    expect(savedFor(parseLink("ssh://core-sw1:2222")!, list)).toBeUndefined();
  });
});
