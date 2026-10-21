import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { clear, h, icon } from "./dom";
import { alertDialog, button, check, confirmDialog, field, modal, toast } from "./dialogs";
import { describeSend } from "./escapes";
import { SCHEMES, scheme } from "./schemes";
import { store } from "./state";
import { compileRules } from "./highlight";
import { securityPanel } from "./vault";
import { platform } from "./platform";
import type { IconName } from "./commands";
import {
  defaultProtocol,
  hostLabel,
  newSession,
  PROTOCOL_NAMES,
  type Button,
  type ButtonBar,
  type HighlightSet,
  type LoginStep,
  type Protocol,
  type ProtocolKind,
  type SecretKind,
  type Session,
  type Settings,
} from "./types";

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
export const TAG_COLORS = ["#e5735f", "#f2b84b", "#7bc47f", "#6cb4e4", "#c49ae6", "#8d99a5"];

function input(value: string | number, attrs: Record<string, unknown> = {}) {
  return h("input", { type: typeof value === "number" ? "number" : "text", value: String(value), spellcheck: "false", ...attrs });
}

function select<T extends string | number>(value: T, options: [T, string][], onchange?: (v: string) => void) {
  const el = h("select", {}, options.map(([v, label]) => h("option", { value: String(v), selected: v === value }, label)));
  if (onchange) el.addEventListener("change", () => onchange(el.value));
  return el;
}

function section(title: string, ...children: (Node | null)[]) {
  return h("section", { class: "form-section" }, h("h3", {}, title), ...children);
}

function panel(...children: (Node | null)[]) {
  return h("div", { class: "panel" }, ...children);
}

/**
 * A category list on the left and one panel at a time on the right, like
 * SecureCRT's options dialogs but flat: no nested trees.
 */
function categories(items: { name: string; icon: IconName; el: HTMLElement }[]) {
  const nav = h("nav", { class: "catnav", role: "tablist", "aria-orientation": "vertical" });
  const buttons = items.map((it, i) => {
    const b = h("button", { type: "button", role: "tab", onclick: () => show(i) }, icon(it.icon), it.name);
    nav.append(b);
    return b;
  });
  const show = (i: number) => {
    items.forEach((it, j) => (it.el.hidden = i !== j));
    buttons.forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
  };
  nav.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : -1;
    if (next < 0 || next >= buttons.length) return;
    e.preventDefault();
    show(next);
    buttons[next].focus();
  });
  show(0);
  const el = h("div", { class: "catdlg" }, nav, h("div", { class: "catpanels" }, items.map((i) => i.el)));
  return { el, show, nav };
}

// ---------------------------------------------------------------------------
// Protocol form, shared by the session editor and the quick connect dialog

interface ProtocolForm {
  el: HTMLElement;
  /** Validate and return the protocol, or an error message. */
  collect(): Protocol | string;
  kind(): ProtocolKind;
  onKindChange(fn: (k: ProtocolKind) => void): void;
  focus(): void;
}

function protocolForm(initial: Protocol, selfId: string | null): ProtocolForm {
  let p: Protocol = structuredClone(initial);
  const listeners: ((k: ProtocolKind) => void)[] = [];
  const box = h("div", { class: "stack-12" });
  const kindSeg = h("div", { class: "seg-control", role: "radiogroup", "aria-label": "Protocol" });
  const kinds: ProtocolKind[] = ["ssh", "telnet", "serial", "raw", "local"];
  let collect: () => Protocol | string = () => p;
  let first: HTMLElement | null = null;

  const renderKinds = () => {
    clear(kindSeg);
    for (const k of kinds) {
      kindSeg.append(
        h("button", {
          type: "button",
          role: "radio",
          "aria-checked": String(p.kind === k),
          "aria-pressed": String(p.kind === k),
          onclick: () => {
            if (p.kind === k) return;
            const old = collect();
            const next = defaultProtocol(k);
            const oldHost = typeof old === "object" && "host" in old ? old.host : "host" in p ? p.host : "";
            if ("host" in next) next.host = oldHost;
            p = next;
            renderKinds();
            render();
            listeners.forEach((fn) => fn(k));
          },
        }, PROTOCOL_NAMES[k]),
      );
    }
  };

  const portCheck = (v: string) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };

  const render = () => {
    clear(box);
    if (p.kind === "ssh") {
      const sp = p;
      const host = input(sp.host, { placeholder: "Host name or IP address" });
      const port = input(sp.port, { min: 1, max: 65535 });
      const user = input(sp.username, { placeholder: "Ask me" });
      const authKind = select(sp.auth.method, [["password", "Password or keyboard-interactive"], ["publicKey", "Public key"]], () => renderAuth());
      const keyPath = input(sp.auth.method === "publicKey" ? sp.auth.keyPath : "", { placeholder: "~/.ssh/id_ed25519" });
      const browse = button("Browse…", {
        onclick: async () => {
          const f = await openDialog({ multiple: false, directory: false, title: "Choose a private key" });
          if (typeof f === "string") keyPath.value = f;
        },
      });
      const keyRow = field("Private key", h("div", { class: "inline" }, keyPath, browse), "OpenSSH or PEM format. You'll be asked for the passphrase when connecting.");
      const renderAuth = () => (keyRow.hidden = authKind.value !== "publicKey");
      renderAuth();
      const jumpOptions: [string, string][] = [["", "None: connect directly"], ...store.sessions.filter((x) => x.protocol.kind === "ssh" && x.id !== selfId).map((x) => [x.id, `${x.folder ? x.folder + "/" : ""}${x.name}`] as [string, string])];
      const jump = select(sp.jumpSession ?? "", jumpOptions);
      const legacy = h("input", { type: "checkbox", checked: sp.legacyAlgorithms });
      box.append(
        h("div", { class: "grid3" }, field("Host", host), field("Port", port), field("Username", user)),
        field("Authentication", authKind),
        keyRow,
        field("Jump host", jump, "Connect through another saved SSH session, for devices you can only reach from a bastion."),
        check("Allow legacy algorithms", legacy, "SHA-1 key exchange and CBC ciphers, for old IOS, ASA and ProCurve boxes"),
      );
      first = host;
      collect = () => {
        const portN = portCheck(port.value);
        if (!host.value.trim()) return "Enter a host name or IP address.";
        if (portN === null) return "Port must be a number from 1 to 65535.";
        if (authKind.value === "publicKey" && !keyPath.value.trim()) return "Choose a private key file, or switch to password authentication.";
        return {
          ...sp,
          host: host.value.trim(),
          port: portN,
          username: user.value.trim(),
          auth: authKind.value === "publicKey" ? { method: "publicKey", keyPath: keyPath.value.trim() } : { method: "password" },
          jumpSession: jump.value || null,
          legacyAlgorithms: legacy.checked,
        };
      };
    } else if (p.kind === "telnet" || p.kind === "raw") {
      const kind = p.kind;
      const host = input(p.host, { placeholder: "Host name or IP address" });
      const port = input(p.port, { min: 1, max: 65535 });
      box.append(
        h("div", { class: "grid2" }, field("Host", host), field("Port", port, kind === "telnet" ? "Console server lines usually start at 2001." : "Raw TCP sends bytes as-is, with no Telnet negotiation.")),
      );
      first = host;
      collect = () => {
        const portN = portCheck(port.value);
        if (!host.value.trim()) return "Enter a host name or IP address.";
        if (portN === null) return "Port must be a number from 1 to 65535.";
        return { kind, host: host.value.trim(), port: portN };
      };
    } else if (p.kind === "serial") {
      const sp = p;
      const port = input(sp.port, { placeholder: "COM3 or /dev/ttyUSB0", list: "tether-ports" });
      const portList = h("datalist", { id: "tether-ports" });
      const found = h("span", { class: "hint" }, "Looking for serial ports…");
      const refresh = async () => {
        const ports = await api.listSerialPorts().catch(() => []);
        clear(portList);
        ports.forEach((x) => portList.append(h("option", { value: x.name }, x.description)));
        found.textContent = ports.length
          ? `Found: ${ports.map((x) => (x.description ? `${x.name} (${x.description})` : x.name)).join(", ")}`
          : "No serial ports found. Plug in the adapter, then click Refresh.";
        if (!port.value && ports.length) port.value = ports[0].name;
      };
      refresh();
      const baud = select(sp.baud, BAUDS.map((b) => [b, String(b)] as [number, string]));
      const bits = select(sp.dataBits, [[8, "8"], [7, "7"], [6, "6"], [5, "5"]]);
      const parity = select(sp.parity, [["none", "None"], ["even", "Even"], ["odd", "Odd"]]);
      const stop = select(sp.stopBits, [[1, "1"], [2, "2"]]);
      const flow = select(sp.flow, [["none", "None"], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]]);
      box.append(
        h("div", { class: "field" }, h("span", {}, "Port"), h("div", { class: "inline" }, port, button("Refresh", { onclick: refresh })), found, portList),
        h("div", { class: "grid2" }, field("Baud rate", baud, "Cisco, Aruba and Juniper consoles default to 9600 8N1."), field("Flow control", flow)),
        h("div", { class: "grid3" }, field("Data bits", bits), field("Parity", parity), field("Stop bits", stop)),
      );
      first = port;
      collect = () => {
        if (!port.value.trim()) return "Choose a serial port.";
        return {
          kind: "serial",
          port: port.value.trim(),
          baud: Number(baud.value),
          dataBits: Number(bits.value),
          parity: parity.value as "none",
          stopBits: Number(stop.value),
          flow: flow.value as "none",
        };
      };
    } else {
      // A picker of the shells found on this machine, plus "Other" for a
      // command line of your own (arguments and quoted paths work).
      const custom = input(p.shell, { placeholder: 'wsl.exe -d Ubuntu or "C:\\Tools\\my shell.exe" -l' });
      const OTHER = "\u0000other";
      // Until the probe answers, the saved command stands in as its own option.
      const pick = h("select", {}, h("option", { value: "" }, "Default shell"), p.shell ? h("option", { value: p.shell, selected: true }, p.shell) : null);
      const customField = field("Command", custom, "Quote a path that has spaces in it.");
      customField.hidden = true;
      const sync = () => {
        customField.hidden = pick.value !== OTHER;
      };
      pick.addEventListener("change", () => {
        sync();
        if (!customField.hidden) custom.focus();
      });
      store.shells().then((list) => {
        const current = pick.value;
        clear(pick);
        pick.append(
          h("option", { value: "" }, list[0] ? `Default shell (${list[0].name})` : "Default shell"),
          ...list.map((sh) => h("option", { value: sh.command }, sh.name)),
          h("option", { value: OTHER }, "Other…"),
        );
        const known = current === "" || list.some((sh) => sh.command === current);
        if (!known) custom.value = current;
        pick.value = known ? current : OTHER;
        sync();
      });
      box.append(field("Shell", pick), customField);
      first = pick;
      collect = () => {
        if (pick.value !== OTHER) return { kind: "local", shell: pick.value };
        if (!custom.value.trim()) return "Enter the command that starts the shell, or pick one from the list.";
        return { kind: "local", shell: custom.value.trim() };
      };
    }
  };
  renderKinds();
  render();
  return {
    el: h("div", { class: "stack-12" }, field("Protocol", kindSeg), box),
    collect: () => collect(),
    kind: () => p.kind,
    onKindChange: (fn) => listeners.push(fn),
    focus: () => first?.focus(),
  };
}

// ---------------------------------------------------------------------------
// Login actions (expect/send)

const STEP_TEMPLATES: { name: string; ssh: boolean; steps: LoginStep[] }[] = [
  {
    name: "Cisco: enter enable mode",
    ssh: true,
    steps: [
      { expect: ">", send: "enable\\r", regex: false },
      { expect: "Password:", send: "{enable}\\r", regex: false },
      { expect: "#", send: "terminal length 0\\r", regex: false },
    ],
  },
  {
    name: "Cisco: log in, then enable (Telnet or console)",
    ssh: false,
    steps: [
      { expect: "Username:", send: "{username}\\r", regex: false },
      { expect: "Password:", send: "{password}\\r", regex: false },
      { expect: ">", send: "enable\\r", regex: false },
      { expect: "Password:", send: "{enable}\\r", regex: false },
      { expect: "#", send: "terminal length 0\\r", regex: false },
    ],
  },
  { name: "Console server: wake the line", ssh: false, steps: [{ expect: "", send: "\\r", regex: false }] },
  { name: "Cisco: turn off paging", ssh: true, steps: [{ expect: "#", send: "terminal length 0\\r", regex: false }] },
  { name: "Juniper: turn off paging", ssh: true, steps: [{ expect: ">", send: "set cli screen-length 0\\r", regex: false }] },
  { name: "Aruba / ProCurve: skip the banner", ssh: true, steps: [{ expect: "Press any key", send: " ", regex: false }, { expect: "#", send: "no page\\r", regex: false }] },
];

function loginStepsEditor(s: Session) {
  // Older sessions kept one command per line; show them as steps.
  let steps: LoginStep[] = s.loginSteps.length
    ? structuredClone(s.loginSteps)
    : s.loginScript.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ expect: "", send: /\\[rn]$/.test(l) ? l : `${l}\\r`, regex: false }));
  const rows = h("div", { class: "steps" });
  const timeout = input(s.loginTimeoutSecs || 15, { min: 1, max: 600, style: { width: "80px" } });

  const render = () => {
    clear(rows);
    if (!steps.length) {
      rows.append(h("div", { class: "steps-empty" }, "No login actions. Add a step, or start from a template."));
    } else {
      rows.append(h("div", { class: "step head" }, h("span", {}, ""), h("span", {}, "Wait for"), h("span", {}, "Then send"), h("span", {})));
    }
    steps.forEach((st, i) => {
      const expect = input(st.expect, { class: "mono", placeholder: "Output settles", "aria-label": `Step ${i + 1}: wait for` });
      const re = h("button", { type: "button", class: "re", title: "Treat as a regular expression", "aria-pressed": String(st.regex) }, ".*");
      const send = input(st.send, { class: "mono", placeholder: "show clock\\r", "aria-label": `Step ${i + 1}: send` });
      const validate = () => {
        let ok = true;
        if (st.regex && st.expect) {
          try {
            new RegExp(st.expect);
          } catch {
            ok = false;
          }
        }
        expect.classList.toggle("invalid", !ok);
        expect.title = ok ? "" : "Not a valid regular expression";
      };
      expect.addEventListener("input", () => {
        st.expect = expect.value;
        validate();
      });
      send.addEventListener("input", () => (st.send = send.value));
      re.addEventListener("click", () => {
        st.regex = !st.regex;
        re.setAttribute("aria-pressed", String(st.regex));
        validate();
      });
      validate();
      const move = (d: number) => {
        const j = i + d;
        if (j < 0 || j >= steps.length) return;
        [steps[i], steps[j]] = [steps[j], steps[i]];
        render();
      };
      rows.append(
        h("div", { class: "step" },
          h("span", { class: "num" }, String(i + 1)),
          h("div", { class: "expect" }, expect, re),
          send,
          h("div", { class: "mini" },
            h("button", { type: "button", class: "btn ghost", title: "Move up", disabled: i === 0, onclick: () => move(-1) }, icon("up")),
            h("button", { type: "button", class: "btn ghost", title: "Move down", disabled: i === steps.length - 1, onclick: () => move(1) }, icon("down")),
            h("button", { type: "button", class: "btn ghost danger", title: "Remove step", onclick: () => { steps.splice(i, 1); render(); } }, icon("trash")),
          ),
        ),
      );
    });
  };
  render();

  const templates = select("", [["", "Add from a template…"], ...STEP_TEMPLATES.map((t, i) => [String(i), t.name] as [string, string])]);
  templates.addEventListener("change", () => {
    const t = STEP_TEMPLATES[Number(templates.value)];
    templates.value = "";
    if (!t) return;
    steps.push(...structuredClone(t.steps));
    render();
  });
  const addBtn = button(h("span", { class: "inline" }, icon("plus"), "Add step"), {
    onclick: () => {
      steps.push({ expect: "", send: "", regex: false });
      render();
      (rows.querySelectorAll<HTMLInputElement>(".step:last-child input"))[0]?.focus();
    },
  });

  const help = h("div", { class: "hint-block" },
    h("p", {}, "Each step waits until the device shows the text (case doesn't matter), then sends the reply. Leave “Wait for” empty to send as soon as output settles."),
    h("p", {}, h("code", {}, "\\r"), " presses Enter, ", h("code", {}, "\\p"), " pauses half a second, ", h("code", {}, "^C"), " sends Ctrl+C. ",
      h("code", {}, "{username}"), ", ", h("code", {}, "{password}"), " and ", h("code", {}, "{enable}"), " are filled in from the session and its saved passwords, so passwords never appear here."),
  );
  const el = h("div", { class: "stack-12" },
    rows,
    h("div", { class: "inline wrap" }, addBtn, templates),
    h("div", { class: "inline" }, h("span", { class: "label-text" }, "Give up on a step after"), timeout, h("span", { class: "label-text" }, "seconds")),
    help,
  );
  return {
    el,
    collect(): { steps: LoginStep[]; timeout: number } | string {
      const bad = steps.findIndex((st) => {
        if (!st.regex || !st.expect) return false;
        try {
          new RegExp(st.expect);
          return false;
        } catch {
          return true;
        }
      });
      if (bad >= 0) return `Login step ${bad + 1}: “${steps[bad].expect}” isn't a valid regular expression.`;
      return {
        steps: steps.filter((st) => st.expect || st.send),
        timeout: clamp(Number(timeout.value), 1, 600, 15),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Session editor

export interface SessionEditResult {
  session: Session;
  connect: boolean;
  /** Secrets typed into the editor, to save once the session is saved. */
  secrets: Partial<Record<SecretKind, string>>;
}

export async function editSession(original: Session, opts: { isNew: boolean; page?: "login" }): Promise<SessionEditResult | undefined> {
  const s: Session = structuredClone(original);
  const name = input(s.name, { placeholder: "e.g. core-sw1" });
  const folder = input(s.folder, { placeholder: "Top level", list: "tether-folders" });
  const folderList = h("datalist", { id: "tether-folders" }, store.folders().map((f) => h("option", { value: f })));
  const errors = h("div", { class: "form-error", role: "alert" });
  const proto = protocolForm(s.protocol, opts.isNew ? null : s.id);

  // Credentials
  const loginUser = input(s.loginUsername, { placeholder: "For {username} in login actions" });
  const loginUserField = field("Username", loginUser);
  const password = h("input", { type: "password", autocomplete: "off" });
  const enable = h("input", { type: "password", autocomplete: "off" });
  const credNote = h("span", { class: "hint" });
  const saved = { password: false, enable: false, locked: false };
  const forget = button("Forget saved passwords", {
    kind: "danger",
    onclick: async () => {
      await api.forgetSecrets(s.id);
      saved.password = saved.enable = false;
      forget.hidden = true;
      renderCredNote();
      toast("Saved passwords removed.");
    },
  });
  forget.hidden = true;
  const credBox = section("Credentials",
    loginUserField,
    h("div", { class: "grid2" },
      field("Password", password),
      field("Enable password", enable),
    ),
    credNote,
    forget,
  );
  const renderCredNote = () => {
    const k = proto.kind();
    const kept = "Saved \u2014 type to replace";
    credBox.hidden = k === "local";
    loginUserField.hidden = k === "ssh";
    // A locked vault can't take new values, and a blank field mustn't look like nothing is saved.
    const locked = "Saved, locked until you enter your master passphrase";
    password.placeholder = saved.password ? (saved.locked ? locked : kept) : k === "ssh" ? "Asked when connecting" : "Not saved";
    enable.placeholder = saved.enable ? (saved.locked ? locked : kept) : "Not saved";
    password.disabled = enable.disabled = saved.locked;
    credNote.textContent = saved.locked
      ? "Saved passwords are locked. Unlock them under Settings > Security to change them; connecting still asks for anything it needs."
      : k === "ssh"
      ? "Saved encrypted, never in Tether's session files. Leave the password blank to be asked each time. The enable password is used by login actions."
      : "Saved encrypted. Login actions send them with {username}, {password} and {enable}.";
  };
  if (!opts.isNew) {
    api.secretStatus(s.id).then((st) => {
      saved.password = st.password;
      saved.enable = st.enable;
      saved.locked = st.locked;
      forget.hidden = !(st.password || st.passphrase || st.enable);
      renderCredNote();
    }).catch(() => {});
  }
  renderCredNote();
  proto.onKindChange(renderCredNote);

  // Login actions
  const login = loginStepsEditor(s);

  // Terminal
  const t = s.terminal;
  const highlightSel = select(t.highlightSet ?? "", [["", `Default (${store.settings.defaultHighlightSet ?? "none"})`], ...store.highlights.map((x) => [x.name, x.name] as [string, string])]);
  const barSel = select(s.buttonBar ?? "", [["", "Keep the current bar"], ...store.bars.map((b) => [b.name, b.name] as [string, string])]);
  const termType = input(t.termType);
  const bsDel = h("input", { type: "checkbox", checked: t.backspaceSendsDelete });

  // Appearance
  const schemeSel = select(t.colorScheme ?? "", [["", `Default (${store.settings.terminalScheme})`], ...Object.keys(SCHEMES).map((k) => [k, k] as [string, string])]);
  const preview = h("div", { class: "scheme-preview" });
  const renderPreview = () => schemePreview(preview, schemeSel.value || store.settings.terminalScheme);
  schemeSel.addEventListener("change", renderPreview);
  renderPreview();
  let tag = s.colorTag ?? "";
  const tagSel = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Color tag" });
  const renderTags = () => {
    clear(tagSel);
    for (const c of ["", ...TAG_COLORS]) {
      tagSel.append(
        h("button", {
          type: "button",
          class: `swatch ${c ? "" : "none"}`,
          title: c ? c : "No color",
          role: "radio",
          "aria-checked": String(tag === c),
          style: { background: c || "" },
          onclick: () => {
            tag = c;
            renderTags();
          },
        }, c ? "" : icon("close")),
      );
    }
  };
  renderTags();

  // Logging
  const logOn = h("input", { type: "checkbox", checked: t.logEnabled });
  const logTpl = input(t.logTemplate, { class: "mono" });
  const logTs = h("input", { type: "checkbox", checked: t.logTimestamps });
  const logStrip = h("input", { type: "checkbox", checked: t.logStripAnsi });

  // Advanced
  const autoRe = h("input", { type: "checkbox", checked: s.autoReconnect });
  const idleSecs = input(s.antiIdleSecs || 0, { min: 0, max: 86400, style: { width: "90px" } });
  const idleSend = input(s.antiIdleSend, { class: "mono", placeholder: "\\r", style: { width: "120px" } });
  const keepalive = input(s.protocol.kind === "ssh" ? s.protocol.keepaliveSecs : 30, { min: 0, max: 3600, style: { width: "90px" } });
  const keepaliveRow = h("div", { class: "inline" }, h("span", { class: "label-text" }, "Send SSH keepalives every"), keepalive, h("span", { class: "label-text" }, "seconds (0 turns them off)"));
  const renderAdvanced = () => (keepaliveRow.hidden = proto.kind() !== "ssh");
  renderAdvanced();
  proto.onKindChange(renderAdvanced);

  const notes = h("textarea", { rows: "12", class: "prose", placeholder: "Rack location, serial number, circuit ID, change ticket…" }, s.notes);

  const cats = categories([
    {
      name: "Connection",
      icon: "plug",
      el: panel(
        h("div", { class: "grid2" }, field("Name", name), h("label", { class: "field" }, h("span", {}, "Folder"), folder, folderList)),
        proto.el,
        credBox,
      ),
    },
    {
      name: "Login actions",
      icon: "play",
      el: panel(h("p", { class: "panel-intro" }, "Answer prompts automatically after connecting: log in on a console server, enter enable mode, turn off paging."), login.el),
    },
    {
      name: "Terminal",
      icon: "terminal",
      el: panel(
        h("div", { class: "grid2" }, field("Keyword highlighting", highlightSel), field("Button bar", barSel, "Switches to this bar when the tab is in front.")),
        field("Terminal type", termType, "What the device is told the terminal is. xterm-256color suits almost everything; try vt100 for very old gear."),
        check("Backspace sends Delete (^?)", bsDel, "Turn off for gear that expects ^H"),
      ),
    },
    {
      name: "Appearance",
      icon: "palette",
      el: panel(field("Color scheme", schemeSel), preview, h("div", { class: "field" }, h("span", {}, "Color tag"), tagSel, h("span", { class: "hint" }, "Shown on the tab and in the session manager. Red for production is a common habit."))),
    },
    {
      name: "Logging",
      icon: "log",
      el: panel(
        check("Log this session every time it connects", logOn),
        field("Log file name", logTpl, "Tokens: {session} {host} {date} {time}. Files go in the log folder set in Settings."),
        check("Timestamp each line", logTs),
        check("Plain text (strip colors and escape codes)", logStrip),
      ),
    },
    {
      name: "Advanced",
      icon: "sliders",
      el: panel(
        section("When the connection drops",
          check("Reconnect automatically", autoRe, "Retries after 3, 5, 10 and 20 seconds, then every 30 seconds, until you stop it or it connects."),
        ),
        section("Idle timeouts",
          h("div", { class: "inline wrap" }, h("span", { class: "label-text" }, "Send"), idleSend, h("span", { class: "label-text" }, "after"), idleSecs, h("span", { class: "label-text" }, "seconds without typing")),
          h("span", { class: "hint" }, "Keeps devices with an exec-timeout from logging you out. 0 turns it off. \\r sends Enter; ^@ sends a null byte most devices ignore."),
          keepaliveRow,
        ),
      ),
    },
    { name: "Notes", icon: "edit", el: panel(field("Notes", notes, "Searchable from the session filter.")) },
  ]);
  if (opts.page === "login") cats.show(1);

  return modal((done) => {
    const finish = (connect: boolean) => {
      errors.textContent = "";
      const p = proto.collect();
      if (typeof p === "string") {
        errors.textContent = p;
        cats.show(0);
        return;
      }
      const l = login.collect();
      if (typeof l === "string") {
        errors.textContent = l;
        cats.show(1);
        return;
      }
      if (p.kind === "ssh") p.keepaliveSecs = clamp(Number(keepalive.value), 0, 3600, 30);
      s.protocol = p;
      s.name = name.value.trim() || hostLabel(p);
      s.folder = folder.value.split("/").map((x) => x.trim()).filter(Boolean).join("/");
      s.terminal = {
        ...t,
        termType: termType.value.trim() || "xterm-256color",
        backspaceSendsDelete: bsDel.checked,
        highlightSet: highlightSel.value || null,
        colorScheme: schemeSel.value || null,
        logEnabled: logOn.checked,
        logTemplate: logTpl.value.trim() || "{session}_{date}_{time}.log",
        logTimestamps: logTs.checked,
        logStripAnsi: logStrip.checked,
      };
      s.buttonBar = barSel.value || null;
      s.colorTag = tag || null;
      s.loginSteps = l.steps;
      s.loginTimeoutSecs = l.timeout;
      s.loginScript = "";
      s.autoReconnect = autoRe.checked;
      s.antiIdleSecs = clamp(Number(idleSecs.value), 0, 86400, 0);
      s.antiIdleSend = idleSend.value || (s.antiIdleSecs ? "\\r" : "");
      s.loginUsername = p.kind === "ssh" ? "" : loginUser.value.trim();
      s.notes = notes.value;
      const secrets: SessionEditResult["secrets"] = {};
      if (password.value) secrets.password = password.value;
      if (enable.value) secrets.enable = enable.value;
      done({ session: s, connect, secrets });
    };
    return {
      title: opts.isNew ? "New session" : `Session options: ${original.name}`,
      className: "catdialog",
      body: cats.el,
      focus: name,
      footLeft: [errors],
      foot: [button("Cancel", { onclick: () => done(undefined) }), button("Save", { onclick: () => finish(false) }), button("Save and connect", { kind: "primary", submit: true })],
      onSubmit: () => finish(true),
    };
  });
}

function schemePreview(el: HTMLElement, name: string) {
  const sc = scheme(name);
  clear(el);
  el.style.background = sc.background ?? "";
  el.style.color = sc.foreground ?? "";
  const c = (color: string | undefined, text: string) => h("span", { style: { color: color ?? "" } }, text);
  el.append(
    h("div", {}, "core-sw1#", c(sc.foreground, "show ip interface brief")),
    h("div", {}, "Vlan10   ", c(sc.blue, "10.10.0.1"), "   YES NVRAM  ", c(sc.green, "up"), "        ", c(sc.green, "up")),
    h("div", {}, "Gi1/0/2  unassigned  YES unset  ", c(sc.red, "down"), "      ", c(sc.red, "down")),
    h("div", {}, c(sc.yellow, "%PM-4-ERR_DISABLE"), ": bpduguard error on ", c(sc.cyan, "Gi1/0/4")),
    h("div", {}, "core-sw1#", h("span", { class: "cursor", style: { background: sc.cursor ?? sc.foreground ?? "" } }, " ")),
  );
}

// ---------------------------------------------------------------------------
// Quick connect dialog

export async function quickConnectDialog(kind: ProtocolKind = "ssh"): Promise<{ session: Session; save: boolean } | undefined> {
  const proto = protocolForm(defaultProtocol(kind), null);
  const save = h("input", { type: "checkbox" });
  const name = input("", { placeholder: "Defaults to the address" });
  const folder = input("", { placeholder: "Top level", list: "tether-qc-folders" });
  const saveBox = h("div", { class: "grid2", hidden: true },
    field("Name", name),
    h("label", { class: "field" }, h("span", {}, "Folder"), folder, h("datalist", { id: "tether-qc-folders" }, store.folders().map((f) => h("option", { value: f })))),
  );
  save.addEventListener("change", () => (saveBox.hidden = !save.checked));
  const errors = h("div", { class: "form-error", role: "alert" });
  if (kind === "serial") setTimeout(() => proto.focus(), 0);
  return modal((done) => ({
    title: "Quick connect",
    intro: "Connect once without saving, or tick the box to keep it in the session manager.",
    body: [proto.el, check("Save this session", save), saveBox],
    footLeft: [errors],
    foot: [button("Cancel", { onclick: () => done(undefined) }), button("Connect", { kind: "primary", submit: true })],
    onSubmit: () => {
      const p = proto.collect();
      if (typeof p === "string") {
        errors.textContent = p;
        return;
      }
      const session = newSession({
        name: name.value.trim() || hostLabel(p),
        folder: folder.value.split("/").map((x) => x.trim()).filter(Boolean).join("/"),
        protocol: p,
      });
      done({ session, save: save.checked });
    },
  }));
}

// ---------------------------------------------------------------------------
// Settings

export type SettingsPage = "appearance" | "terminal" | "highlighting" | "buttons" | "files" | "tftp" | "security";

export async function editSettings(
  actions: { importSecureCrt: () => void; editBars: () => void; editHighlights: () => void },
  page?: SettingsPage,
): Promise<Settings | undefined> {
  const s: Settings = structuredClone(store.settings);
  const theme = h("div", { class: "seg-control", role: "radiogroup", "aria-label": "Interface theme" });
  const renderTheme = () => {
    clear(theme);
    ([["system", "Match system"], ["dark", "Dark"], ["light", "Light"]] as const).forEach(([v, label]) =>
      theme.append(h("button", { type: "button", role: "radio", "aria-checked": String(s.uiTheme === v), "aria-pressed": String(s.uiTheme === v), onclick: () => { s.uiTheme = v; renderTheme(); } }, label)),
    );
  };
  renderTheme();
  const schemeSel = select(s.terminalScheme, Object.keys(SCHEMES).map((k) => [k, k] as [string, string]));
  const preview = h("div", { class: "scheme-preview" });
  schemeSel.addEventListener("change", () => schemePreview(preview, schemeSel.value));
  schemePreview(preview, s.terminalScheme);
  const font = input(s.fontFamily, { class: "mono" });
  const size = input(s.fontSize, { min: 8, max: 40 });
  const lh = input(s.lineHeight, { min: 1, max: 2, step: 0.05 });
  const cursor = select(s.cursorStyle, [["block", "Block"], ["bar", "Bar"], ["underline", "Underline"]]);
  const blink = h("input", { type: "checkbox", checked: s.cursorBlink });
  const gpu = h("input", { type: "checkbox", checked: s.gpuRendering });
  const scrollback = input(s.scrollback, { min: 1000, max: 1000000, step: 1000 });
  const copySel = h("input", { type: "checkbox", checked: s.copyOnSelect });
  const rcPaste = h("input", { type: "checkbox", checked: s.rightClickPaste });
  const confirmPaste = h("input", { type: "checkbox", checked: s.confirmMultilinePaste });
  const reconnect = h("input", { type: "checkbox", checked: s.reconnectOnEnter });
  const restore = h("input", { type: "checkbox", checked: s.restoreWorkspace });
  const bell = select(s.bell, [["visual", "Flash the terminal"], ["none", "Off"]]);
  const hlDefault = select(s.defaultHighlightSet ?? "", [["", "None"], ...store.highlights.map((x) => [x.name, x.name] as [string, string])]);
  const barDefault = select(s.defaultButtonBar ?? "", [["", "None"], ...store.bars.map((x) => [x.name, x.name] as [string, string])]);
  const logDir = input(s.logDirectory, { placeholder: "Inside Tether's data folder" });
  const browse = button("Browse…", {
    onclick: async () => {
      const d = await openDialog({ directory: true, multiple: false, title: "Log folder" });
      if (typeof d === "string") logDir.value = d;
    },
  });
  const dataDir = h("span", { class: "mono path" }, "…");
  api.dataDir().then((d) => (dataDir.textContent = d)).catch(() => {});
  // Applies at once (it's a system setting, not part of Tether's own settings file).
  // Windows doesn't let an app make itself the default: Tether offers itself,
  // and the user picks it in Default apps (or the first time a link opens).
  const win = platform === "windows";
  const links = h("input", { type: "checkbox" });
  const defaultApps = button("Open Default apps", { onclick: () => void api.openDefaultApps().catch((e) => toast(e?.message ?? String(e))) });
  const linksRow = h("div", {},
    check(
      win ? "Offer Tether for ssh:// and telnet:// links" : "Open ssh:// and telnet:// links with Tether",
      links,
      win
        ? "Links in browsers, tickets and wikis can open a tab here. Windows asks which app to use the first time you open one, or choose Tether in Settings > Default apps. Other apps' link settings aren't changed."
        : "Links in browsers, tickets and wikis open a tab here. Turning this off removes Tether as the handler.",
    ),
    win ? h("div", { class: "inline under-check" }, defaultApps) : null,
  );
  linksRow.hidden = true;
  const syncLinks = () => (defaultApps.disabled = !links.checked);
  api.linkHandlerStatus().then((on) => {
    if (on === null) return;
    links.checked = on;
    syncLinks();
    linksRow.hidden = false;
  }).catch(() => {});
  links.addEventListener("change", () => {
    syncLinks();
    api.setLinkHandler(links.checked).then(
      () => {
        if (!links.checked) toast("Tether no longer offers to open ssh:// and telnet:// links.");
        else if (win) toast("Tether is now offered for ssh:// and telnet:// links.", { action: { label: "Open Default apps", run: () => void api.openDefaultApps().catch(() => {}) } });
        else toast("ssh:// and telnet:// links now open in Tether.");
      },
      (e) => {
        links.checked = !links.checked;
        syncLinks();
        toast(e?.message ?? "Couldn't change the link handler.");
      },
    );
  });

  // TFTP server
  const tftpDir = input(s.tftpFolder, { placeholder: "tftp in Tether's data folder" });
  const tftpBrowse = button("Browse…", {
    onclick: async () => {
      const d = await openDialog({ directory: true, multiple: false, title: "TFTP folder" });
      if (typeof d === "string") tftpDir.value = d;
    },
  });
  // A saved address that's gone (cable unplugged, VPN down) stays selectable rather than silently changing.
  const tftpAddr = select(s.tftpAddress, [["", "All network interfaces"], ...(s.tftpAddress ? [[s.tftpAddress, s.tftpAddress] as [string, string]] : [])]);
  const tftpPort = input(s.tftpPort, { min: 1, max: 65535 });
  const tftpStart = h("input", { type: "checkbox", checked: s.tftpStartWithApp });
  const tftpOverwrite = h("input", { type: "checkbox", checked: s.tftpAllowOverwrite });
  const tftpTabsOnly = h("input", { type: "checkbox", checked: s.tftpOpenTabsOnly });
  api.tftpStatus().then((st) => {
    if (!s.tftpFolder) tftpDir.placeholder = st.folder;
    for (const a of st.addresses) {
      if (a.address !== s.tftpAddress) tftpAddr.append(h("option", { value: a.address }, a.interface ? `${a.address} (${a.interface})` : a.address));
    }
  }).catch(() => {});

  const cats = categories([
    {
      name: "Appearance",
      icon: "palette",
      el: panel(
        field("Interface", theme),
        field("Terminal colors", schemeSel, "Sessions can override this in their own options."),
        preview,
        field("Font", font, "A comma-separated list. The first one installed is used."),
        h("div", { class: "grid3" }, field("Size", size), field("Line height", lh), field("Cursor", cursor)),
        check("Blinking cursor", blink),
        check("GPU-accelerated rendering", gpu, "Faster with huge outputs. Turn off if text stops redrawing on your graphics driver. Applies to new tabs."),
      ),
    },
    {
      name: "Terminal",
      icon: "terminal",
      el: panel(
        section("Mouse and clipboard",
          check("Copy text as soon as it's selected", copySel),
          check("Right-click pastes", rcPaste, "PuTTY and SecureCRT style. Off shows a menu instead."),
          check("Confirm before pasting more than one line", confirmPaste, "Shows what's about to be sent and where. Stops a stray config dump hitting the wrong switch."),
        ),
        section("Connections",
          check("Press Enter in a closed tab to reconnect", reconnect),
          check("Reopen last time's tabs when Tether starts", restore, "Tabs reconnect on their own. Broadcast always starts off."),
        ),
        h("div", { class: "grid2" }, field("Scrollback lines", scrollback), field("Bell", bell)),
      ),
    },
    {
      name: "Highlighting",
      icon: "highlight",
      el: panel(
        field("Default rule set", hlDefault, "Used by every session that doesn't pick its own."),
        h("div", {}, button(h("span", { class: "inline" }, icon("edit"), "Edit highlight rules…"), { onclick: actions.editHighlights })),
      ),
    },
    {
      name: "Button bars",
      icon: "buttons",
      el: panel(
        field("Bar shown at startup", barDefault),
        h("div", {}, button(h("span", { class: "inline" }, icon("edit"), "Edit button bars…"), { onclick: actions.editBars })),
      ),
    },
    {
      name: "Files",
      icon: "folder",
      el: panel(
        field("Log folder", h("div", { class: "inline" }, logDir, browse)),
        h("div", { class: "field" }, h("span", {}, "Data folder"), dataDir,
          h("span", { class: "hint" }, "Sessions are plain TOML files here, one per session, safe to keep in Git. Put a file named tether.portable next to the app to keep everything beside it instead.")),
        h("div", { class: "inline wrap" },
          button("Open data folder", { onclick: () => api.openFolder("data") }),
          button("Open log folder", { onclick: () => api.openFolder("logs") }),
          button(h("span", { class: "inline" }, icon("import"), "Import SecureCRT sessions…"), { onclick: actions.importSecureCrt }),
        ),
        linksRow,
      ),
    },
    {
      name: "TFTP server",
      icon: "transfer",
      el: panel(
        field("Folder", h("div", { class: "inline" }, tftpDir, tftpBrowse), "Devices read files from here and write received files here. Sub-folders work too: backups/sw1-confg."),
        h("div", { class: "grid2" }, field("Listen on", tftpAddr), field("UDP port", tftpPort, "Devices expect 69.")),
        check("Start the TFTP server when Tether starts", tftpStart, "Otherwise start it from Tools when you need it."),
        section("Safety",
          check("Let devices replace files already in the folder", tftpOverwrite, "Off: a device can't overwrite a file that's there. Backups of the same switch need a new name each time."),
          check("Only answer devices that have an open tab", tftpTabsOnly, "Matches the device's address against open SSH, Telnet and raw tabs. Leave off when you work over a serial console, since Tether doesn't know that device's address."),
        ),
        h("p", { class: "hint" }, "Every transfer is written to tftp.log in the log folder."),
      ),
    },
    { name: "Security", icon: "lock", el: securityPanel() },
  ]);
  const pages: SettingsPage[] = ["appearance", "terminal", "highlighting", "buttons", "files", "tftp", "security"];
  if (page) cats.show(Math.max(0, pages.indexOf(page)));

  return modal((done) => ({
    title: "Settings",
    className: "catdialog",
    body: cats.el,
    foot: [button("Cancel", { onclick: () => done(undefined) }), button("Save", { kind: "primary", submit: true })],
    focus: cats.nav.querySelector("button[aria-selected=true]") as HTMLElement,
    onSubmit: () => {
      s.terminalScheme = schemeSel.value;
      s.fontFamily = font.value.trim() || store.settings.fontFamily;
      s.fontSize = clamp(Number(size.value), 8, 40, 14);
      s.lineHeight = clamp(Number(lh.value), 1, 2, 1.15);
      s.cursorStyle = cursor.value as Settings["cursorStyle"];
      s.cursorBlink = blink.checked;
      s.gpuRendering = gpu.checked;
      s.scrollback = clamp(Number(scrollback.value), 1000, 1000000, 20000);
      s.copyOnSelect = copySel.checked;
      s.rightClickPaste = rcPaste.checked;
      s.confirmMultilinePaste = confirmPaste.checked;
      s.reconnectOnEnter = reconnect.checked;
      s.restoreWorkspace = restore.checked;
      s.bell = bell.value as Settings["bell"];
      s.defaultHighlightSet = hlDefault.value || null;
      s.defaultButtonBar = barDefault.value || null;
      s.logDirectory = logDir.value.trim();
      s.tftpFolder = tftpDir.value.trim();
      s.tftpAddress = tftpAddr.value;
      s.tftpPort = Math.round(clamp(Number(tftpPort.value), 1, 65535, 69));
      s.tftpStartWithApp = tftpStart.checked;
      s.tftpAllowOverwrite = tftpOverwrite.checked;
      s.tftpOpenTabsOnly = tftpTabsOnly.checked;
      done(s);
    },
  }));
}

function clamp(n: number, lo: number, hi: number, fallback: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---------------------------------------------------------------------------
// Button bars

/** Edit (or create, with `index` null) one button on a bar. */
export async function editButton(barName: string, index: number | null): Promise<ButtonBar[] | undefined> {
  const bars: ButtonBar[] = structuredClone(store.bars);
  let bar = bars.find((b) => b.name === barName);
  if (!bar) {
    bar = { name: barName || "My buttons", buttons: [] };
    bars.push(bar);
  }
  const b: Button = index === null ? { label: "", send: "", color: null } : structuredClone(bar.buttons[index]);
  const label = input(b.label, { placeholder: "e.g. int brief" });
  const send = input(b.send, { class: "mono", placeholder: "show ip interface brief\\r" });
  const enter = h("input", { type: "checkbox", checked: index === null || /\\r$/.test(b.send) });
  const out = h("div", { class: "send-preview" });
  const update = () => {
    out.textContent = send.value ? `Sends: ${describeSend(send.value)}${enter.checked && !/\\r$/.test(send.value) ? "⏎" : ""}` : "";
  };
  send.addEventListener("input", update);
  enter.addEventListener("change", update);
  update();
  let color = b.color ?? "";
  const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Color" });
  const renderSw = () => {
    clear(swatches);
    for (const c of ["", ...TAG_COLORS]) {
      swatches.append(h("button", {
        type: "button",
        class: `swatch ${c ? "" : "none"}`,
        title: c || "No color",
        role: "radio",
        "aria-checked": String(color === c),
        style: { background: c || "" },
        onclick: () => {
          color = c;
          renderSw();
        },
      }, c ? "" : icon("close")));
    }
  };
  renderSw();
  const errors = h("div", { class: "form-error", role: "alert" });
  return modal((done) => ({
    title: index === null ? `New button on “${bar!.name}”` : `Edit button “${b.label || b.send}”`,
    body: [
      field("Label", label),
      field("Send", send, "Escapes: \\r Enter, \\p pause, ^C Ctrl+C, \\xHH any byte."),
      check("Press Enter at the end", enter),
      out,
      h("div", { class: "field" }, h("span", {}, "Color"), swatches),
    ],
    focus: label,
    footLeft: [errors],
    foot: [button("Cancel", { onclick: () => done(undefined) }), button(index === null ? "Add button" : "Save", { kind: "primary", submit: true })],
    onSubmit: () => {
      if (!send.value && !label.value.trim()) {
        errors.textContent = "Give the button something to send.";
        return;
      }
      let text = send.value;
      if (enter.checked && !/\\r$/.test(text)) text += "\\r";
      if (!enter.checked) text = text.replace(/\\r$/, "");
      const next: Button = { label: label.value.trim() || text.replace(/\\r$/, ""), send: text, color: color || null };
      if (index === null) bar!.buttons.push(next);
      else bar!.buttons[index] = next;
      done(bars);
    },
  }));
}

export async function editButtonBars(initialBar?: string): Promise<ButtonBar[] | undefined> {
  const bars: ButtonBar[] = structuredClone(store.bars);
  if (!bars.length) bars.push({ name: "My buttons", buttons: [] });
  let current = Math.max(0, bars.findIndex((b) => b.name === initialBar));
  const barSel = h("select", { "aria-label": "Bar" });
  const rows = h("div", { class: "rows" });
  const barName = input("", { placeholder: "Bar name", "aria-label": "Bar name" });

  const renderSel = () => {
    clear(barSel);
    bars.forEach((b, i) => barSel.append(h("option", { value: String(i), selected: i === current }, b.name || "(unnamed)")));
    barName.value = bars[current]?.name ?? "";
  };
  barSel.addEventListener("change", () => {
    current = Number(barSel.value);
    renderSel();
    renderRows();
  });
  barName.addEventListener("input", () => {
    bars[current].name = barName.value;
    (barSel.options[current] as HTMLOptionElement).textContent = barName.value || "(unnamed)";
  });

  const renderRows = () => {
    clear(rows);
    const bar = bars[current];
    if (!bar.buttons.length) rows.append(h("div", { class: "steps-empty" }, "No buttons yet."));
    else rows.append(h("div", { class: "rowedit buttons rowhead" }, h("span", {}, "Label"), h("span", {}, "Sends"), h("span", {}, "Color"), h("span", {})));
    bar.buttons.forEach((b, i) => {
      const label = input(b.label, { placeholder: "Label" });
      const send = input(b.send, { placeholder: "show version\\r", class: "mono" });
      const color = h("input", { type: "color", value: b.color ?? "#6cb4e4", title: "Color" });
      label.addEventListener("input", () => (b.label = label.value));
      send.addEventListener("input", () => (b.send = send.value));
      color.addEventListener("input", () => (b.color = color.value));
      const move = (d: number) => {
        const j = i + d;
        if (j < 0 || j >= bar.buttons.length) return;
        [bar.buttons[i], bar.buttons[j]] = [bar.buttons[j], bar.buttons[i]];
        renderRows();
      };
      rows.append(
        h("div", { class: "rowedit buttons" }, label, send, color,
          h("div", { class: "mini" },
            h("button", { type: "button", class: "btn ghost", title: "Move up", disabled: i === 0, onclick: () => move(-1) }, icon("up")),
            h("button", { type: "button", class: "btn ghost", title: "Move down", disabled: i === bar.buttons.length - 1, onclick: () => move(1) }, icon("down")),
            h("button", { type: "button", class: "btn ghost danger", title: "Remove", onclick: () => { bar.buttons.splice(i, 1); renderRows(); } }, icon("trash")),
          ),
        ),
      );
    });
    rows.append(
      h("div", { class: "inline" },
        button(h("span", { class: "inline" }, icon("plus"), "Add button"), {
          onclick: () => {
            bar.buttons.push({ label: "", send: "", color: null });
            renderRows();
            (rows.querySelectorAll(".rowedit.buttons:not(.rowhead)")[bar.buttons.length - 1]?.querySelector("input") as HTMLInputElement | null)?.focus();
          },
        }),
      ),
    );
  };
  renderSel();
  renderRows();

  return modal((done) => ({
    title: "Button bars",
    intro: "Buttons send text to the active tab, or to every checked tab while broadcasting. End with \\r to press Enter; \\p pauses half a second; ^C sends Ctrl+C.",
    wide: true,
    body: [
      h("div", { class: "inline" }, barSel, barName,
        button("New bar", { onclick: () => { bars.push({ name: `Bar ${bars.length + 1}`, buttons: [] }); current = bars.length - 1; renderSel(); renderRows(); barName.focus(); barName.select(); } }),
        button("Delete bar", { kind: "danger", onclick: () => { if (bars.length <= 1) return toast("Keep at least one bar."); bars.splice(current, 1); current = 0; renderSel(); renderRows(); } }),
      ),
      rows,
    ],
    foot: [button("Cancel", { onclick: () => done(undefined) }), button("Save", { kind: "primary", submit: true })],
    onSubmit: () => done(bars.map((b) => ({ ...b, name: b.name.trim() || "Untitled", buttons: b.buttons.filter((x) => x.label.trim() || x.send) }))),
  }));
}

// ---------------------------------------------------------------------------
// Highlight rules

export async function editHighlights(): Promise<HighlightSet[] | undefined> {
  const sets: HighlightSet[] = structuredClone(store.highlights);
  if (!sets.length) sets.push({ name: "My highlights", rules: [] });
  let current = 0;
  const setSel = h("select", { "aria-label": "Rule set" });
  const setName = input("", { placeholder: "Set name", "aria-label": "Set name" });
  const rows = h("div", { class: "rows" });
  const sample = h("div", { class: "paste-preview", style: { whiteSpace: "pre-wrap" } });
  const SAMPLE = "Gi1/0/12 is up, line protocol is up\nGi1/0/13 is down, line protocol is down (notconnect)\n%LINK-3-UPDOWN: Interface Te1/1/1, changed state to down\nVlan20  10.20.0.1/24  aabb.cc00.0102";

  const renderSample = () => {
    clear(sample);
    const rules = compileRules(sets[current].rules);
    for (const line of SAMPLE.split("\n")) {
      const marks: { s: number; e: number; fg?: string; bg?: string }[] = [];
      for (const r of rules) {
        r.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = r.re.exec(line))) {
          if (!m[0]) {
            r.re.lastIndex++;
            continue;
          }
          marks.push({ s: m.index, e: m.index + m[0].length, fg: r.fg, bg: r.bg });
        }
      }
      marks.sort((a, b) => a.s - b.s);
      let pos = 0;
      const div = h("div");
      for (const mk of marks) {
        if (mk.s < pos) continue;
        div.append(line.slice(pos, mk.s), h("span", { style: { color: mk.fg ?? "", background: mk.bg ?? "" } }, line.slice(mk.s, mk.e)));
        pos = mk.e;
      }
      div.append(line.slice(pos));
      sample.append(div);
    }
  };

  const renderSel = () => {
    clear(setSel);
    sets.forEach((s, i) => setSel.append(h("option", { value: String(i), selected: i === current }, s.name || "(unnamed)")));
    setName.value = sets[current].name;
  };
  setSel.addEventListener("change", () => { current = Number(setSel.value); renderSel(); renderRows(); });
  setName.addEventListener("input", () => { sets[current].name = setName.value; (setSel.options[current] as HTMLOptionElement).textContent = setName.value || "(unnamed)"; });

  const renderRows = () => {
    clear(rows);
    const set = sets[current];
    rows.append(h("div", { class: "rowedit rules rowhead" }, h("span", {}, "Pattern"), h("span", {}, "Regex"), h("span", {}, "Case"), h("span", {}, "Color"), h("span", {})));
    set.rules.forEach((r, i) => {
      const pat = input(r.pattern, { class: "mono", placeholder: "down|err-disabled" });
      const isRe = h("input", { type: "checkbox", checked: r.regex, title: "Regular expression" });
      const cs = h("input", { type: "checkbox", checked: r.caseSensitive, title: "Match case" });
      const fg = h("input", { type: "color", value: r.foreground ?? "#f2b84b" });
      const validate = () => {
        let ok = true;
        if (isRe.checked && pat.value) {
          try { new RegExp(pat.value); } catch { ok = false; }
        }
        pat.classList.toggle("invalid", !ok);
        pat.title = ok ? "" : "Not a valid regular expression";
      };
      pat.addEventListener("input", () => { r.pattern = pat.value; validate(); renderSample(); });
      isRe.addEventListener("change", () => { r.regex = isRe.checked; validate(); renderSample(); });
      cs.addEventListener("change", () => { r.caseSensitive = cs.checked; renderSample(); });
      fg.addEventListener("input", () => { r.foreground = fg.value; renderSample(); });
      validate();
      rows.append(
        h("div", { class: "rowedit rules" }, pat, isRe, cs, fg,
          h("div", { class: "mini" }, h("button", { type: "button", class: "btn ghost danger", title: "Remove", onclick: () => { set.rules.splice(i, 1); renderRows(); } }, icon("trash"))),
        ),
      );
    });
    rows.append(h("div", { class: "inline" }, button(h("span", { class: "inline" }, icon("plus"), "Add rule"), { onclick: () => { set.rules.push({ pattern: "", regex: false, caseSensitive: false, foreground: "#f2b84b", background: null }); renderRows(); } })));
    renderSample();
  };
  renderSel();
  renderRows();

  return modal((done) => ({
    title: "Keyword highlighting",
    intro: "Matches are colored as output arrives, without changing what's logged or sent.",
    wide: true,
    body: [
      h("div", { class: "inline" }, setSel, setName,
        button("New set", { onclick: () => { sets.push({ name: `Set ${sets.length + 1}`, rules: [] }); current = sets.length - 1; renderSel(); renderRows(); } }),
        button("Delete set", { kind: "danger", onclick: () => { if (sets.length <= 1) return toast("Keep at least one set."); sets.splice(current, 1); current = 0; renderSel(); renderRows(); } }),
      ),
      rows,
      field("Preview", sample),
    ],
    foot: [button("Cancel", { onclick: () => done(undefined) }), button("Save", { kind: "primary", submit: true })],
    onSubmit: () => done(sets.map((s) => ({ ...s, name: s.name.trim() || "Untitled", rules: s.rules.filter((r) => r.pattern) }))),
  }));
}

// ---------------------------------------------------------------------------
// SecureCRT import

/** Pick SecureCRT's Sessions folder and add what's new in it to the library. */
export async function importSecureCrt() {
  const proceed = await confirmDialog({
    title: "Import SecureCRT sessions",
    message: h("span", {},
      "Choose SecureCRT's Sessions folder. On Windows it's usually ",
      h("span", { class: "mono" }, "%APPDATA%\\VanDyke\\Config\\Sessions"),
      ", and on macOS ",
      h("span", { class: "mono" }, "~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions"),
      ". Hosts, ports, usernames, serial settings and folders come across; saved passwords don't."),
    confirm: "Choose folder…",
  });
  if (!proceed) return;
  const dir = await openDialog({ directory: true, multiple: false, title: "SecureCRT Sessions folder" });
  if (typeof dir !== "string") return;
  try {
    const report = await api.importSecureCrt(dir);
    if (!report.sessions.length) {
      await alertDialog("Nothing to import", report.skipped.length ? `Skipped ${report.skipped.length} file(s) with unsupported protocols.` : "No session files were found in that folder. Make sure it's the Sessions folder itself.");
      return;
    }
    const existing = new Set(store.sessions.map((s) => `${s.folder}/${s.name}`.toLowerCase()));
    const fresh = report.sessions.filter((s) => !existing.has(`${s.folder}/${s.name}`.toLowerCase()));
    const dupes = report.sessions.length - fresh.length;
    if (!fresh.length) {
      await alertDialog("Already imported", `All ${report.sessions.length} sessions in that folder are already in your library.`);
      return;
    }
    const ok = await modal<boolean>((done) => ({
      title: `Import ${fresh.length} session${fresh.length === 1 ? "" : "s"}?`,
      body: h("div", { class: "callout" },
        h("div", {}, `${report.sessions.length} found.`),
        dupes ? h("div", {}, `${dupes} already exist with the same name and folder and will be left alone.`) : null,
        report.skipped.length ? h("div", {}, `${report.skipped.length} skipped (unsupported protocols such as TAPI or RLogin).`) : null,
      ),
      foot: [h("button", { type: "button", class: "btn", onclick: () => done(false) }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, `Import ${fresh.length}`)],
      onSubmit: () => done(true),
    }));
    if (ok) {
      await store.saveSessions(fresh);
      toast(`Imported ${fresh.length} session${fresh.length === 1 ? "" : "s"}`);
    }
  } catch (e) {
    await alertDialog("Import failed", (e as { message?: string }).message ?? String(e));
  }
}

// ---------------------------------------------------------------------------
// Dialog windows

/** Each options dialog, as something that can be sent to its own window. */
export type DialogRequest =
  | { kind: "session"; session: Session; isNew: boolean; page?: "login" }
  | { kind: "quick"; protocol?: ProtocolKind }
  | { kind: "settings"; page?: SettingsPage }
  | { kind: "bars"; bar?: string }
  | { kind: "button"; bar: string; index: number | null }
  | { kind: "highlights" };

/** Run a dialog in this page. Editors opened from Settings save their own changes. */
export function runDialog(r: DialogRequest): Promise<unknown> {
  switch (r.kind) {
    case "session":
      return editSession(r.session, { isNew: r.isNew, page: r.page });
    case "quick":
      return quickConnectDialog(r.protocol);
    case "settings":
      return editSettings(
        {
          importSecureCrt,
          editBars: async () => {
            const bars = await editButtonBars();
            if (bars) await store.saveBars(bars);
          },
          editHighlights: async () => {
            const sets = await editHighlights();
            if (sets) await store.saveHighlights(sets);
          },
        },
        r.page,
      );
    case "bars":
      return editButtonBars(r.bar);
    case "button":
      return editButton(r.bar, r.index);
    case "highlights":
      return editHighlights();
  }
}
