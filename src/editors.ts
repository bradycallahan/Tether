import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { clear, h, icon } from "./dom";
import { button, check, field, modal, toast } from "./dialogs";
import { SCHEMES } from "./schemes";
import { store } from "./state";
import { compileRules } from "./highlight";
import {
  defaultProtocol,
  hostLabel,
  PROTOCOL_NAMES,
  type ButtonBar,
  type HighlightSet,
  type Protocol,
  type ProtocolKind,
  type Session,
  type Settings,
} from "./types";

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const TAG_COLORS = ["", "#e5735f", "#f2b84b", "#7bc47f", "#6cb4e4", "#c49ae6", "#8d99a5"];

function input(value: string | number, attrs: Record<string, unknown> = {}) {
  return h("input", { type: typeof value === "number" ? "number" : "text", value: String(value), spellcheck: "false", ...attrs });
}

function select<T extends string | number>(value: T, options: [T, string][], onchange?: (v: string) => void) {
  const el = h("select", {}, options.map(([v, label]) => h("option", { value: String(v), selected: v === value }, label)));
  if (onchange) el.addEventListener("change", () => onchange(el.value));
  return el;
}

function innerTabs(names: string[], panels: HTMLElement[]) {
  const bar = h("div", { class: "tabs-inner", role: "tablist" });
  const pick = (i: number) => {
    panels.forEach((p, j) => (p.hidden = i !== j));
    [...bar.children].forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
  };
  names.forEach((n, i) => bar.append(h("button", { type: "button", role: "tab", onclick: () => pick(i) }, n)));
  pick(0);
  return bar;
}

// ---------------------------------------------------------------------------
// Session editor

export async function editSession(original: Session, opts: { isNew: boolean }): Promise<{ session: Session; connect: boolean } | undefined> {
  const s: Session = structuredClone(original);
  const name = input(s.name, { placeholder: "e.g. core-sw1" });
  const folder = input(s.folder, { placeholder: "e.g. BSU/Core switches", list: "tether-folders" });
  const folderList = h("datalist", { id: "tether-folders" }, store.folders().map((f) => h("option", { value: f })));
  const protoBox = h("div", { class: "dlg-section", style: { display: "grid", gap: "12px" } });
  const errors = h("div", { class: "field" });

  const kindSeg = h("div", { class: "seg-control", role: "radiogroup", "aria-label": "Protocol" });
  const kinds: ProtocolKind[] = ["ssh", "telnet", "serial", "raw", "local"];
  const renderKinds = () => {
    clear(kindSeg);
    for (const k of kinds) {
      kindSeg.append(
        h("button", {
          type: "button",
          "aria-pressed": String(s.protocol.kind === k),
          onclick: () => {
            if (s.protocol.kind === k) return;
            const old = s.protocol;
            s.protocol = defaultProtocol(k);
            if ("host" in old && "host" in s.protocol) s.protocol.host = old.host;
            renderKinds();
            renderProto();
          },
        }, PROTOCOL_NAMES[k]),
      );
    }
  };

  // Protocol-specific controls are rebuilt on each kind change; `collect`
  // reads them back into `s.protocol`.
  let collect: () => string | null = () => null;

  const renderProto = () => {
    clear(protoBox);
    const p = s.protocol;
    secretBox.hidden = p.kind !== "ssh";
    if (p.kind === "ssh") {
      const host = input(p.host, { placeholder: "hostname or IP" });
      const port = input(p.port, { min: 1, max: 65535 });
      const user = input(p.username, { placeholder: "username" });
      const authKind = select(p.auth.method, [["password", "Password / keyboard-interactive"], ["publicKey", "Public key"]], () => renderAuth());
      const keyPath = input(p.auth.method === "publicKey" ? p.auth.keyPath : "", { placeholder: "~/.ssh/id_ed25519" });
      const browse = button("Browse…", {
        onclick: async () => {
          const f = await openDialog({ multiple: false, directory: false, title: "Choose a private key" });
          if (typeof f === "string") keyPath.value = f;
        },
      });
      const keyRow = field("Private key file", h("div", { class: "inline" }, keyPath, browse), "OpenSSH, PEM or PuTTY-converted OpenSSH keys. Passphrases are asked for on connect.");
      const renderAuth = () => (keyRow.hidden = authKind.value !== "publicKey");
      renderAuth();
      const jumpOptions: [string, string][] = [["", "None"], ...store.sessions.filter((x) => x.protocol.kind === "ssh" && x.id !== s.id).map((x) => [x.id, `${x.folder ? x.folder + "/" : ""}${x.name}`] as [string, string])];
      const jump = select(p.jumpSession ?? "", jumpOptions);
      const legacy = h("input", { type: "checkbox", checked: p.legacyAlgorithms });
      const keepalive = input(p.keepaliveSecs, { min: 0, max: 3600 });
      protoBox.append(
        h("div", { class: "grid3" }, field("Host", host), field("Port", port), field("Username", user)),
        field("Authentication", authKind),
        keyRow,
        h("div", { class: "grid2" }, field("Jump host", jump, "Tunnel through another saved SSH session."), field("Keepalive (seconds)", keepalive, "0 turns it off.")),
        check("Allow legacy algorithms", legacy, "SHA-1 key exchange, CBC ciphers — for old IOS and ASA boxes"),
      );
      collect = () => {
        const portN = Number(port.value);
        if (!host.value.trim()) return "Enter a host name or IP address.";
        if (!Number.isInteger(portN) || portN < 1 || portN > 65535) return "Port must be between 1 and 65535.";
        if (authKind.value === "publicKey" && !keyPath.value.trim()) return "Choose a private key file.";
        s.protocol = {
          kind: "ssh",
          host: host.value.trim(),
          port: portN,
          username: user.value.trim(),
          auth: authKind.value === "publicKey" ? { method: "publicKey", keyPath: keyPath.value.trim() } : { method: "password" },
          jumpSession: jump.value || null,
          legacyAlgorithms: legacy.checked,
          keepaliveSecs: Math.max(0, Number(keepalive.value) || 0),
        };
        return null;
      };
    } else if (p.kind === "telnet" || p.kind === "raw") {
      const host = input(p.host, { placeholder: "hostname or IP" });
      const port = input(p.port, { min: 1, max: 65535 });
      protoBox.append(
        h("div", { class: "grid2" }, field("Host", host), field("Port", port, p.kind === "telnet" ? "Console servers usually use 2001 and up." : undefined)),
      );
      collect = () => {
        const portN = Number(port.value);
        if (!host.value.trim()) return "Enter a host name or IP address.";
        if (!Number.isInteger(portN) || portN < 1 || portN > 65535) return "Port must be between 1 and 65535.";
        s.protocol = { kind: p.kind, host: host.value.trim(), port: portN } as Protocol;
        return null;
      };
    } else if (p.kind === "serial") {
      const port = input(p.port, { placeholder: "COM3 or /dev/ttyUSB0", list: "tether-ports" });
      const portList = h("datalist", { id: "tether-ports" });
      const found = h("span", { class: "hint" }, "Looking for serial ports…");
      const refresh = async () => {
        const ports = await api.listSerialPorts().catch(() => []);
        clear(portList);
        ports.forEach((x) => portList.append(h("option", { value: x.name }, x.description)));
        found.textContent = ports.length ? `Found: ${ports.map((x) => (x.description ? `${x.name} (${x.description})` : x.name)).join(", ")}` : "No serial ports found. Plug in the adapter and refresh.";
        if (!port.value && ports.length) port.value = ports[0].name;
      };
      refresh();
      const baud = select(p.baud, BAUDS.map((b) => [b, String(b)] as [number, string]));
      const bits = select(p.dataBits, [[8, "8"], [7, "7"], [6, "6"], [5, "5"]]);
      const parity = select(p.parity, [["none", "None"], ["even", "Even"], ["odd", "Odd"]]);
      const stop = select(p.stopBits, [[1, "1"], [2, "2"]]);
      const flow = select(p.flow, [["none", "None"], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]]);
      protoBox.append(
        h("div", { class: "field" }, h("span", {}, "Port"), h("div", { class: "inline" }, port, button("Refresh", { onclick: refresh })), found, portList),
        h("div", { class: "grid2" }, field("Baud rate", baud, "Cisco consoles default to 9600 8N1."), field("Flow control", flow)),
        h("div", { class: "grid3" }, field("Data bits", bits), field("Parity", parity), field("Stop bits", stop)),
      );
      collect = () => {
        if (!port.value.trim()) return "Choose a serial port.";
        s.protocol = {
          kind: "serial",
          port: port.value.trim(),
          baud: Number(baud.value),
          dataBits: Number(bits.value),
          parity: parity.value as "none",
          stopBits: Number(stop.value),
          flow: flow.value as "none",
        };
        return null;
      };
    } else {
      const shell = input(p.shell, { placeholder: "Default shell" });
      api.defaultShell().then((d) => (shell.placeholder = `Default: ${d}`)).catch(() => {});
      protoBox.append(field("Shell", shell, "Leave blank for your default shell. Arguments are allowed, e.g. wsl -d Ubuntu."));
      collect = () => {
        s.protocol = { kind: "local", shell: shell.value.trim() };
        return null;
      };
    }
  };
  const secretBox = h("div", { class: "callout" }, "Checking saved credentials…");
  renderKinds();
  renderProto();

  // Terminal tab
  const t = s.terminal;
  const highlightSel = select(t.highlightSet ?? "", [["", `Default (${store.settings.defaultHighlightSet ?? "none"})`], ...store.highlights.map((x) => [x.name, x.name] as [string, string])]);
  const barSel = select(s.buttonBar ?? "", [["", "Keep current bar"], ...store.bars.map((b) => [b.name, b.name] as [string, string])]);
  const termType = input(t.termType);
  const bsDel = h("input", { type: "checkbox", checked: t.backspaceSendsDelete });
  const logOn = h("input", { type: "checkbox", checked: t.logEnabled });
  const logTpl = input(t.logTemplate, { class: "mono" });
  const logTs = h("input", { type: "checkbox", checked: t.logTimestamps });
  const logStrip = h("input", { type: "checkbox", checked: t.logStripAnsi });
  const tagSel = h("div", { class: "inline" });
  let tag = s.colorTag ?? "";
  const renderTags = () => {
    clear(tagSel);
    for (const c of TAG_COLORS) {
      tagSel.append(
        h("button", {
          type: "button",
          class: "btn icon-only",
          title: c ? c : "No color",
          "aria-pressed": String(tag === c),
          style: { background: c || "var(--panel-2)" },
          onclick: () => { tag = c; renderTags(); },
        }, c ? "" : "∅"),
      );
    }
  };
  renderTags();

  const loginScript = h("textarea", { rows: "5", spellcheck: "false", placeholder: "terminal length 0\nshow clock" }, s.loginScript);
  const notes = h("textarea", { rows: "6", style: { fontFamily: "var(--font-ui)", fontSize: "13px" } }, s.notes);

  if (!opts.isNew) {
    api.secretStatus(s.id).then((st) => {
      clear(secretBox);
      const parts = [st.password && "a password", st.passphrase && "a key passphrase"].filter(Boolean);
      if (!parts.length) {
        secretBox.textContent = "Nothing saved in the keychain for this session. You'll be asked when connecting.";
        return;
      }
      secretBox.append(
        h("span", {}, `The system keychain holds ${parts.join(" and ")} for this session. `),
        button("Forget", {
          kind: "danger",
          onclick: async () => {
            await api.forgetSecrets(s.id);
            secretBox.textContent = "Forgotten. You'll be asked next time you connect.";
          },
        }),
      );
    });
  } else {
    secretBox.textContent = "Passwords are asked for on first connect and can be saved to your system keychain — never to Tether's files.";
  }

  const pConn = h("div", { style: { display: "grid", gap: "12px" } },
    h("div", { class: "grid2" }, field("Name", name), h("label", { class: "field" }, h("span", {}, "Folder"), folder, folderList)),
    field("Protocol", kindSeg),
    protoBox,
    secretBox,
  );
  const pTerm = h("div", { style: { display: "grid", gap: "12px" } },
    h("div", { class: "grid2" }, field("Keyword highlighting", highlightSel), field("Button bar", barSel)),
    h("div", { class: "grid2" }, field("Terminal type", termType), field("Color tag", tagSel)),
    check("Backspace sends Delete (^?)", bsDel, "Turn off for gear that expects ^H"),
    h("hr", { style: { border: 0, borderTop: "1px solid var(--rule)", margin: "2px 0" } }),
    check("Log this session automatically", logOn),
    field("Log file name", logTpl, "Tokens: {session} {host} {date} {time}. Saved in the log folder from Settings."),
    h("div", { class: "grid2" }, check("Timestamp each line", logTs), check("Plain text (strip colors)", logStrip)),
  );
  const pAuto = h("div", { style: { display: "grid", gap: "12px" } },
    field("Send after login", loginScript, "One command per line, sent after the prompt appears. Escapes like \\r, \\p (pause) and ^C work here."),
  );
  const pNotes = h("div", { style: { display: "grid", gap: "12px" } }, field("Notes", notes, "Searchable from the session filter. Rack location, serial number, change ticket…"));
  const tabs = innerTabs(["Connection", "Terminal", "Automation", "Notes"], [pConn, pTerm, pAuto, pNotes]);

  return modal((done) => {
    const finish = (connect: boolean) => {
      const err = collect();
      errors.textContent = "";
      if (err) {
        errors.append(h("span", { class: "err" }, err));
        [...tabs.children][0]?.dispatchEvent(new MouseEvent("click"));
        return;
      }
      s.name = name.value.trim() || hostLabel(s.protocol);
      s.folder = folder.value.split("/").map((x) => x.trim()).filter(Boolean).join("/");
      s.terminal = {
        ...t,
        termType: termType.value.trim() || "xterm-256color",
        backspaceSendsDelete: bsDel.checked,
        highlightSet: highlightSel.value || null,
        logEnabled: logOn.checked,
        logTemplate: logTpl.value.trim() || "{session}_{date}_{time}.log",
        logTimestamps: logTs.checked,
        logStripAnsi: logStrip.checked,
      };
      s.buttonBar = barSel.value || null;
      s.colorTag = tag || null;
      s.loginScript = loginScript.value;
      s.notes = notes.value;
      done({ session: s, connect });
    };
    return {
      title: opts.isNew ? "New session" : `Edit ${original.name}`,
      wide: true,
      body: [tabs, pConn, pTerm, pAuto, pNotes, errors],
      focus: name,
      footLeft: [],
      foot: [button("Cancel", { onclick: () => done(undefined) }), button("Save", { onclick: () => finish(false) }), button("Save and connect", { kind: "primary", submit: true })],
      onSubmit: () => finish(true),
    };
  });
}

// ---------------------------------------------------------------------------
// Settings

export async function editSettings(actions: { importSecureCrt: () => void; editBars: () => void; editHighlights: () => void }): Promise<Settings | undefined> {
  const s: Settings = structuredClone(store.settings);
  const theme = h("div", { class: "seg-control" });
  const renderTheme = () => {
    clear(theme);
    (["system", "dark", "light"] as const).forEach((v) =>
      theme.append(h("button", { type: "button", "aria-pressed": String(s.uiTheme === v), onclick: () => { s.uiTheme = v; renderTheme(); } }, v[0].toUpperCase() + v.slice(1))),
    );
  };
  renderTheme();
  const schemeSel = select(s.terminalScheme, Object.keys(SCHEMES).map((k) => [k, k] as [string, string]));
  const swatches = h("div", { class: "scheme-swatches" });
  const renderSwatches = () => {
    clear(swatches);
    const sc = SCHEMES[schemeSel.value];
    for (const c of [sc.background, sc.foreground, sc.red, sc.green, sc.yellow, sc.blue, sc.magenta, sc.cyan]) {
      swatches.append(h("i", { style: { background: c ?? "transparent", outline: "1px solid var(--rule)" } }));
    }
  };
  schemeSel.addEventListener("change", renderSwatches);
  renderSwatches();
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
  const bell = select(s.bell, [["visual", "Flash the tab"], ["none", "Off"]]);
  const hlDefault = select(s.defaultHighlightSet ?? "", [["", "None"], ...store.highlights.map((x) => [x.name, x.name] as [string, string])]);
  const barDefault = select(s.defaultButtonBar ?? "", [["", "None"], ...store.bars.map((x) => [x.name, x.name] as [string, string])]);
  const logDir = input(s.logDirectory, { placeholder: "Inside Tether's data folder" });
  const browse = button("Browse…", {
    onclick: async () => {
      const d = await openDialog({ directory: true, multiple: false, title: "Log folder" });
      if (typeof d === "string") logDir.value = d;
    },
  });
  const dataDir = h("span", { class: "mono" }, "…");
  api.dataDir().then((d) => (dataDir.textContent = d)).catch(() => {});

  const pLook = h("div", { style: { display: "grid", gap: "12px" } },
    field("Interface", theme),
    h("label", { class: "field" }, h("span", {}, "Terminal colors"), schemeSel, swatches),
    field("Font", font, "A comma-separated list. The first installed font wins."),
    h("div", { class: "grid3" }, field("Size", size), field("Line height", lh), field("Cursor", cursor)),
    check("Blinking cursor", blink),
    check("GPU-accelerated rendering", gpu, "Turn off if text stops redrawing on your graphics driver. Applies to new tabs."),
  );
  const pBehave = h("div", { style: { display: "grid", gap: "12px" } },
    check("Copy on select", copySel),
    check("Right-click pastes", rcPaste, "PuTTY style. Off shows a menu instead."),
    check("Confirm before pasting more than one line", confirmPaste, "Stops a stray config dump hitting the wrong switch"),
    check("Press Enter to reconnect a closed tab", reconnect),
    h("div", { class: "grid2" }, field("Scrollback lines", scrollback), field("Bell", bell)),
    h("div", { class: "grid2" },
      h("div", { class: "field" }, h("span", {}, "Default highlighting"), hlDefault, h("button", { type: "button", class: "btn ghost", onclick: actions.editHighlights, style: { justifySelf: "start" } }, "Edit highlight rules…")),
      h("div", { class: "field" }, h("span", {}, "Default button bar"), barDefault, h("button", { type: "button", class: "btn ghost", onclick: actions.editBars, style: { justifySelf: "start" } }, "Edit button bars…")),
    ),
  );
  const pFiles = h("div", { style: { display: "grid", gap: "12px" } },
    field("Log folder", h("div", { class: "inline" }, logDir, browse)),
    h("div", { class: "field" }, h("span", {}, "Data folder"), dataDir, h("span", { class: "hint" }, "Sessions are plain TOML files here, one per session — safe to keep in Git. Put a file named tether.portable next to the app to keep everything beside it instead.")),
    h("div", { class: "inline" },
      button("Open data folder", { onclick: () => api.openFolder("data") }),
      button("Open log folder", { onclick: () => api.openFolder("logs") }),
      button(h("span", { class: "inline" }, icon("import"), "Import SecureCRT sessions…"), { onclick: actions.importSecureCrt }),
    ),
  );
  const tabs = innerTabs(["Appearance", "Behavior", "Files"], [pLook, pBehave, pFiles]);

  return modal((done) => ({
    title: "Settings",
    wide: true,
    body: [tabs, pLook, pBehave, pFiles],
    foot: [button("Cancel", { onclick: () => done(undefined) }), button("Save", { kind: "primary", submit: true })],
    focus: tabs.querySelector("button") as HTMLElement,
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
      s.bell = bell.value as Settings["bell"];
      s.defaultHighlightSet = hlDefault.value || null;
      s.defaultButtonBar = barDefault.value || null;
      s.logDirectory = logDir.value.trim();
      done(s);
    },
  }));
}

function clamp(n: number, lo: number, hi: number, fallback: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---------------------------------------------------------------------------
// Button bars

export async function editButtonBars(initialBar?: string): Promise<ButtonBar[] | undefined> {
  const bars: ButtonBar[] = structuredClone(store.bars);
  if (!bars.length) bars.push({ name: "My buttons", buttons: [] });
  let current = Math.max(0, bars.findIndex((b) => b.name === initialBar));
  const barSel = h("select");
  const rows = h("div", { class: "rows" });
  const barName = input("", { placeholder: "Bar name" });

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
    rows.append(h("div", { class: "rowedit buttons rowhead" }, h("span", {}, "Label"), h("span", {}, "Sends"), h("span", {}, "Color"), h("span", {})));
    bar.buttons.forEach((b, i) => {
      const label = input(b.label, { placeholder: "Label" });
      const send = input(b.send, { placeholder: "show version\\r", class: "mono" });
      const color = h("input", { type: "color", value: b.color ?? "#6cb4e4" });
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
            h("button", { type: "button", class: "btn ghost", title: "Move up", onclick: () => move(-1) }, icon("up")),
            h("button", { type: "button", class: "btn ghost", title: "Move down", onclick: () => move(1) }, icon("down")),
            h("button", { type: "button", class: "btn ghost danger", title: "Remove", onclick: () => { bar.buttons.splice(i, 1); renderRows(); } }, icon("trash")),
          ),
        ),
      );
    });
    rows.append(
      h("div", { class: "inline" },
        button(h("span", { class: "inline" }, icon("plus"), "Add button"), { onclick: () => { bar.buttons.push({ label: "", send: "", color: null }); renderRows(); (rows.querySelectorAll(".rowedit.buttons input")[(bar.buttons.length - 1) * 3] as HTMLInputElement | undefined)?.focus(); } }),
      ),
    );
  };
  renderSel();
  renderRows();

  return modal((done) => ({
    title: "Button bars",
    intro: "Buttons send text to the active tab — or every checked tab while broadcasting. End a command with \\r to press Enter. \\p pauses half a second, ^C sends Ctrl+C.",
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
  const setSel = h("select");
  const setName = input("", { placeholder: "Set name" });
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
          if (!m[0]) { r.re.lastIndex++; continue; }
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
        pat.style.borderColor = ok ? "" : "var(--fault)";
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
