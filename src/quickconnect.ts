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

/**
 * An ssh:// or telnet:// link from a browser or another app. Only those two
 * schemes: a link must never open a local shell or a serial port. SSH URI
 * extras (";fingerprint=…" in the user part, a path) are ignored.
 */
export function parseLink(url: string): Protocol | null {
  const m = /^(ssh|telnet):\/\/([^/?#]*)/i.exec(url.trim());
  if (!m) return null;
  let authority: string;
  try {
    authority = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const at = authority.lastIndexOf("@");
  const user = at >= 0 ? authority.slice(0, at).split(";")[0].split(":")[0] : "";
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostPart || /\s/.test(hostPart + user)) return null;
  return hostProtocol(m[1].toLowerCase() as "ssh" | "telnet", user ? `${user}@${hostPart}` : hostPart);
}

/** A saved session named on the command line: by id, "Folder/Name", or name. */
export function findSession<T extends Rankable & { id: string }>(query: string, sessions: T[]): T | undefined {
  const q = query.trim().toLowerCase();
  return (
    sessions.find((s) => s.id === query.trim()) ??
    sessions.find((s) => [s.folder, s.name].filter(Boolean).join("/").toLowerCase() === q) ??
    sessions.find((s) => s.name.toLowerCase() === q)
  );
}

/** The saved session a link points at, so its saved settings and credentials are used. */
export function savedFor<T extends Rankable>(p: Protocol, sessions: T[]): T | undefined {
  if (p.kind !== "ssh" && p.kind !== "telnet") return undefined;
  return sessions.find((s) => {
    const q = s.protocol;
    if (q.kind !== p.kind || q.host.toLowerCase() !== p.host.toLowerCase() || q.port !== p.port) return false;
    return p.kind !== "ssh" || !p.username || (q.kind === "ssh" && q.username === p.username);
  });
}

interface Rankable {
  name: string;
  folder: string;
  protocol: Protocol;
  notes?: string;
}

/**
 * Saved sessions matching what's typed, best first: name prefix, then a
 * word in the name, then host, folder or notes, then a loose in-order
 * letter match on the name ("c1" finds "core-sw1").
 */
export function rankSessions<T extends Rankable>(query: string, sessions: T[], limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { s: T; score: number }[] = [];
  for (const s of sessions) {
    const name = s.name.toLowerCase();
    const host = "host" in s.protocol ? s.protocol.host.toLowerCase() : s.protocol.kind === "serial" ? s.protocol.port.toLowerCase() : "";
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.split(/[\s\-_./]+/).some((w) => w.startsWith(q))) score = 60;
    else if (host.startsWith(q)) score = 55;
    else if (name.includes(q)) score = 50;
    else if (host.includes(q)) score = 40;
    else if (s.folder.toLowerCase().includes(q)) score = 25;
    else if (s.notes?.toLowerCase().includes(q)) score = 15;
    else if (q.length > 1 && subsequence(name, q)) score = 10;
    if (score) scored.push({ s, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

function subsequence(hay: string, q: string): boolean {
  let i = 0;
  for (const c of hay) if (c === q[i]) i++;
  return i === q.length;
}
