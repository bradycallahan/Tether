import { defaultProtocol, type Protocol } from "./types";

/**
 * Turn whatever a network admin types into a connection:
 *   10.0.0.1                     ssh, current user name left blank
 *   admin@core-sw1               ssh
 *   admin@10.0.0.1:2222          ssh on a custom port
 *   ssh -p 2222 admin@host       ssh, OpenSSH style
 *   admin@[2001:db8::1]:22       ssh to IPv6
 *   telnet 10.1.1.5 2003         telnet (console server line)
 *   telnet://10.1.1.5:2003       telnet
 *   raw 10.1.1.5 7001            raw TCP
 *   COM3  /  COM3 115200  /  COM3:115200  /  /dev/ttyUSB0@9600   serial
 *   local  /  shell  /  pwsh     local shell
 */
export function parseQuickConnect(raw: string): Protocol | null {
  const input = raw.trim();
  if (!input) return null;
  const words = input.split(/\s+/);
  const first = words[0].toLowerCase();

  if (["local", "shell", "pwsh", "powershell", "cmd", "bash", "zsh"].includes(first)) {
    const shell = first === "local" || first === "shell" ? words.slice(1).join(" ") : input;
    return { ...defaultProtocol("local"), shell } as Protocol;
  }

  const serial = /^((?:com\d+)|(?:\/dev\/[\w.\-/]+))(?:[\s:@]+(\d{3,7}))?$/i.exec(input);
  if (serial) {
    return { ...defaultProtocol("serial"), port: serial[1].toUpperCase().startsWith("COM") ? serial[1].toUpperCase() : serial[1], baud: serial[2] ? Number(serial[2]) : 9600 } as Protocol;
  }

  const url = /^(ssh|telnet|raw):\/\/(.+)$/i.exec(input);
  if (url) return hostProtocol(url[1].toLowerCase() as "ssh" | "telnet" | "raw", url[2]);

  if (first === "telnet" || first === "raw" || first === "ssh") {
    return hostProtocol(first, words.slice(1).join(" "));
  }
  return hostProtocol("ssh", input);
}

function hostProtocol(kind: "ssh" | "telnet" | "raw", rest: string): Protocol | null {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  let port: number | undefined;
  let user = "";
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-p" && words[i + 1]) {
      port = Number(words[++i]);
    } else if (w === "-l" && words[i + 1]) {
      user = words[++i];
    } else {
      positional.push(w);
    }
  }
  if (positional.length === 0) return null;
  let target = positional[0];
  if (positional[1] && /^\d+$/.test(positional[1])) port = Number(positional[1]);

  const at = target.lastIndexOf("@");
  if (at > 0) {
    user = target.slice(0, at);
    target = target.slice(at + 1);
  }
  let host = target;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(target);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const colon = target.split(":");
    if (colon.length === 2 && /^\d+$/.test(colon[1])) {
      host = colon[0];
      port = Number(colon[1]);
    }
  }
  if (!host || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) return null;
  const base = defaultProtocol(kind) as Extract<Protocol, { host: string }>;
  const p = { ...base, host, port: port ?? base.port } as Protocol;
  if (p.kind === "ssh") p.username = user;
  return p;
}
