import { commands, isMac } from "./commands";
import { clear, h } from "./dom";
import { button, modal } from "./dialogs";

/** Every shortcut, grouped the way the menus are, with a filter. */
export async function shortcutsDialog(groups: { title: string; ids: string[] }[]) {
  const filter = h("input", { type: "text", placeholder: "Filter shortcuts", spellcheck: "false", "aria-label": "Filter shortcuts" });
  const list = h("div", { class: "shortcut-list" });
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    clear(list);
    for (const g of groups) {
      const rows = g.ids
        .filter((id) => commands.shortcut(id))
        .filter((id) => !q || commands.label(id).toLowerCase().includes(q) || g.title.toLowerCase().includes(q));
      if (!rows.length) continue;
      list.append(h("h3", {}, g.title));
      for (const id of rows) list.append(h("div", { class: "shortcut-row" }, h("span", {}, commands.label(id)), h("span", { class: "kbd" }, commands.shortcut(id)!)));
    }
    if (!list.childElementCount) list.append(h("p", { class: "hint" }, "No shortcuts match."));
  };
  filter.addEventListener("input", render);
  render();
  await modal<boolean>((done) => ({
    title: "Keyboard shortcuts",
    intro: isMac
      ? "\u23181 to \u23189 jumps to a tab. Plain Ctrl keys always reach the device."
      : "Shortcuts use Ctrl+Shift so plain Ctrl keys always reach the device. Alt+1 to Alt+9 jumps to a tab.",
    wide: true,
    body: [filter, list],
    focus: filter,
    foot: [button("Close", { kind: "primary", submit: true })],
    onSubmit: () => done(true),
  }));
}

/** Formats for quick connect, send strings and login-action tokens. */
export async function referenceDialog() {
  const table = (rows: [string, string][]) =>
    h("table", { class: "ref" }, h("tbody", {}, rows.map(([a, b]) => h("tr", {}, h("td", {}, h("code", {}, a)), h("td", {}, b)))));
  await modal<boolean>((done) => ({
    title: "Quick reference",
    wide: true,
    body: [
      h("h3", {}, "Quick connect"),
      table([
        ["10.0.0.1", "SSH, asks for the username"],
        ["admin@core-sw1:2222", "SSH as admin on port 2222"],
        ["ssh -p 2222 admin@host", "OpenSSH style"],
        ["telnet ts1 2003", "Telnet to a console server line"],
        ["raw 10.1.1.5 7001", "Raw TCP, no Telnet negotiation"],
        ["COM3 9600  ·  /dev/ttyUSB0@115200", "Serial port at a baud rate"],
        ["local  ·  pwsh  ·  bash", "Local shell"],
      ]),
      h("h3", {}, "Send strings (buttons, command window, login actions)"),
      table([
        ["\\r", "Enter"],
        ["\\n  \\t  \\e  \\b", "Line feed, Tab, Escape, Delete"],
        ["^C  ^Z  ^]", "Control characters (^^ for a literal caret)"],
        ["\\xHH", "Any byte, e.g. \\x1e for Ctrl+Shift+6 on Cisco"],
        ["\\p  \\P", "Pause half a second, or two seconds"],
      ]),
      h("h3", {}, "Login action tokens"),
      table([
        ["{username}", "The session's SSH username"],
        ["{password}", "The password saved in the system keychain"],
        ["{enable}", "The enable password saved in the system keychain"],
      ]),
    ],
    foot: [button("Close", { kind: "primary", submit: true })],
    onSubmit: () => done(true),
  }));
}

export async function aboutDialog() {
  await modal<boolean>((done) => ({
    title: "About Tether",
    body: [
      h("div", { class: "about" },
        h("div", { class: "about-mark" }, h("span", { class: "led connected" }), h("span", { class: "led" }), h("span", { class: "led connecting" })),
        h("div", {},
          h("p", { class: "about-name" }, `Tether ${__APP_VERSION__}`),
          h("p", {}, "An open-source terminal for network and systems administrators: SSH, Telnet, serial consoles and local shells."),
          h("p", { class: "hint" }, "MIT licensed. Built with Rust, Tauri and xterm.js."),
        ),
      ),
    ],
    foot: [button("Close", { kind: "primary", submit: true })],
    onSubmit: () => done(true),
  }));
}
