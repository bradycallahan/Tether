import { api } from "./api";
import { commands } from "./commands";
import { clear, h, icon } from "./dom";
import { store } from "./state";
import { defaultProtocol, hostLabel, type PortInfo, type Protocol, type Session } from "./types";

export interface WelcomeActions {
  connect(s: Session): void;
  connectSerial(p: Protocol): void;
  run(commandId: string): void;
}

/**
 * What the workspace shows with no tabs open: recent sessions, serial ports
 * that are plugged in right now, and the ways to start something new.
 */
export class Welcome {
  readonly el: HTMLElement;
  private ports: PortInfo[] = [];
  private portsLoaded = false;

  constructor(private actions: WelcomeActions) {
    this.el = h("div", { class: "welcome" });
    store.on("sessions", () => this.render());
    store.on("recent", () => this.render());
  }

  /** Re-check serial ports; call when the welcome screen comes into view. */
  async refreshPorts() {
    this.ports = await api.listSerialPorts().catch(() => []);
    this.portsLoaded = true;
    this.render();
  }

  render() {
    clear(this.el);
    const firstRun = store.sessions.length === 0;
    const recent = store.recentSessions().slice(0, 6);
    const action = (id: string, text: string, ic: Parameters<typeof icon>[0], primary = false) =>
      h("button", { type: "button", class: `action ${primary ? "primary" : ""}`, onclick: () => this.actions.run(id) },
        icon(ic), h("span", { class: "text" }, text), commands.shortcut(id) ? h("span", { class: "kbd" }, commands.shortcut(id)!) : null);

    const head = firstRun
      ? h("div", { class: "welcome-head" },
          h("h1", {}, "Welcome to Tether"),
          h("p", {}, "Bring your sessions over from SecureCRT, add your first device, or just type an address in the box above and press Enter."))
      : h("div", { class: "welcome-head" },
          h("h1", {}, "Connect to a device"),
          h("p", {}, "Pick up where you left off, double-click a session on the left, or type an address in the box above."));

    const start = h("section", { class: "card" },
      h("h2", {}, "Start"),
      firstRun ? action("import.securecrt", "Import from SecureCRT…", "import", true) : null,
      action("session.new", "New session…", "plus", !firstRun),
      action("connect.quick", "Quick connect…", "bolt"),
      action("connect.local", "Local shell", "terminal"),
    );

    const recentCard = h("section", { class: "card" }, h("h2", {}, "Recent sessions"));
    if (recent.length) {
      for (const s of recent) {
        recentCard.append(
          h("button", { type: "button", class: "recent", onclick: () => this.actions.connect(s), title: `Connect to ${s.name}` },
            h("span", { class: "tag", style: { background: s.colorTag ?? "transparent" } }),
            h("span", { class: "name" }, s.name),
            h("span", { class: "sub" }, s.folder ? `${s.folder} · ${hostLabel(s.protocol)}` : hostLabel(s.protocol)),
          ),
        );
      }
    } else {
      recentCard.append(h("p", { class: "muted" }, firstRun ? "Sessions you connect to will show up here." : "Nothing yet. Sessions you connect to will show up here."));
    }

    const serialCard = h("section", { class: "card" }, h("h2", {}, "Serial ports"));
    if (!this.portsLoaded) {
      serialCard.append(h("p", { class: "muted" }, "Looking for serial ports…"));
    } else if (!this.ports.length) {
      serialCard.append(
        h("p", { class: "muted" }, "No console cable detected."),
        h("button", { type: "button", class: "link", onclick: () => this.refreshPorts() }, "Check again"),
      );
    } else {
      for (const p of this.ports) {
        const baud = h("select", { "aria-label": `Baud rate for ${p.name}` },
          [9600, 19200, 38400, 57600, 115200].map((b) => h("option", { value: String(b) }, String(b))));
        serialCard.append(
          h("div", { class: "port" },
            icon("serial"),
            h("div", { class: "port-name" }, h("span", { class: "name" }, p.name), p.description ? h("span", { class: "sub" }, p.description) : null),
            baud,
            h("button", {
              type: "button",
              class: "btn",
              onclick: () => this.actions.connectSerial({ ...defaultProtocol("serial"), port: p.name, baud: Number(baud.value) } as Protocol),
            }, "Connect"),
          ),
        );
      }
    }

    this.el.append(
      h("div", { class: "welcome-inner" },
        head,
        h("div", { class: "cards" }, h("div", { class: "col" }, recentCard, serialCard), h("div", { class: "col" }, start)),
        h("p", { class: "welcome-foot" },
          h("span", { class: "kbd" }, commands.shortcut("tools.palette") ?? ""), " finds any command or session.  ",
          h("span", { class: "kbd" }, commands.shortcut("help.shortcuts") ?? ""), " lists every shortcut."),
      ),
    );
  }
}
