import { commands } from "./commands";
import { clear, h, icon } from "./dom";
import { parseQuickConnect, rankSessions } from "./quickconnect";
import { store } from "./state";
import { hostLabel, PROTOCOL_NAMES, type Protocol, type Session } from "./types";

export interface OmniboxActions {
  connectSession(s: Session): void;
  connectTarget(p: Protocol, typed: string): void;
  saveTarget(p: Protocol, typed: string): void;
  done(): void;
}

type Suggestion =
  | { kind: "target"; p: Protocol; typed: string }
  | { kind: "save"; p: Protocol; typed: string }
  | { kind: "session"; s: Session };

/**
 * The "Connect to…" box in the toolbar. Type an address, serial port or
 * part of a session name; it suggests saved sessions as you type and shows
 * recent ones when empty.
 */
export class Omnibox {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private pop: HTMLElement;
  private list: Suggestion[] = [];
  private sel = 0;

  constructor(private actions: OmniboxActions) {
    this.input = h("input", {
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      placeholder: "Connect to host, serial port or saved session",
      "aria-label": "Connect to",
      role: "combobox",
      "aria-expanded": "false",
      "aria-autocomplete": "list",
    });
    this.pop = h("div", { class: "omni-pop", role: "listbox", hidden: true });
    this.el = h("div", { class: "omnibox" }, icon("bolt"), this.input, h("span", { class: "kbd" }, commands.shortcut("connect.focus") ?? ""), this.pop);
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target !== this.input && !this.pop.contains(e.target as Node)) {
        e.preventDefault();
        this.input.focus();
      }
    });
    // The list opens when asked for (shortcut, click, typing), not merely on
    // focus, so it doesn't cover the window at startup.
    this.input.addEventListener("pointerdown", () => this.update());
    this.input.addEventListener("input", () => {
      this.sel = 0;
      this.update();
    });
    this.input.addEventListener("blur", () => setTimeout(() => this.hide(), 120));
    this.input.addEventListener("keydown", (e) => this.key(e));
  }

  focus() {
    this.input.focus();
    this.input.select();
    this.update();
  }

  private key(e: KeyboardEvent) {
    if (this.pop.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      this.update();
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown": this.move(1); break;
      case "ArrowUp": this.move(-1); break;
      case "Enter": {
        const s = this.list[this.sel];
        if (s) this.pick(s);
        else if (this.input.value.trim()) this.update(true);
        break;
      }
      case "Escape":
        if (!this.pop.hidden && !this.input.value) {
          this.hide();
        } else if (this.input.value) {
          this.input.value = "";
          this.update();
        } else {
          this.hide();
          this.actions.done();
        }
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private move(d: number) {
    if (!this.list.length) return;
    this.sel = (this.sel + d + this.list.length) % this.list.length;
    this.paint();
  }

  private pick(s: Suggestion) {
    this.input.value = "";
    this.hide();
    if (s.kind === "session") this.actions.connectSession(s.s);
    else if (s.kind === "target") this.actions.connectTarget(s.p, s.typed);
    else this.actions.saveTarget(s.p, s.typed);
  }

  private suggestions(): Suggestion[] {
    const typed = this.input.value.trim();
    if (!typed) return store.recentSessions().slice(0, 8).map((s) => ({ kind: "session", s }));
    const sessions = rankSessions(typed, store.sessions, 7).map((s): Suggestion => ({ kind: "session", s }));
    const p = parseQuickConnect(typed);
    if (!p) return sessions;
    const target: Suggestion = { kind: "target", p, typed };
    // A saved session whose name starts with what's typed is probably what
    // the user means; otherwise they typed an address.
    const lower = typed.toLowerCase();
    const sessionFirst = sessions.length > 0 && sessions[0].kind === "session" && sessions[0].s.name.toLowerCase().startsWith(lower);
    const out = sessionFirst ? [...sessions, target] : [target, ...sessions];
    out.push({ kind: "save", p, typed });
    return out;
  }

  private update(showError = false) {
    this.list = this.suggestions();
    this.sel = Math.min(this.sel, Math.max(0, this.list.length - 1));
    clear(this.pop);
    const typed = this.input.value.trim();
    if (!typed) {
      this.pop.append(h("div", { class: "omni-head" }, this.list.length ? "Recent sessions" : "Quick connect"));
    }
    this.list.forEach((s, i) => this.pop.append(this.row(s, i)));
    if (!typed) {
      this.pop.append(
        h("div", { class: "omni-hint" },
          "Type an address like ", h("code", {}, "admin@10.0.0.1"), ", ", h("code", {}, "telnet ts1 2003"), " or ", h("code", {}, "COM3 9600"), ", or part of a session name."),
      );
    } else if (!this.list.length) {
      this.pop.append(h("div", { class: `omni-hint ${showError ? "bad" : ""}` }, "No saved session matches, and that isn't an address, port or serial device."));
    }
    this.pop.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.paint();
  }

  private row(s: Suggestion, i: number): HTMLElement {
    let content: (Node | string | null)[];
    if (s.kind === "session") {
      const st = s.s;
      content = [
        icon(st.protocol.kind === "serial" ? "serial" : st.protocol.kind === "local" ? "terminal" : "plug"),
        h("span", { class: "main" }, st.name),
        h("span", { class: "sub" }, `${st.folder ? st.folder + " · " : ""}${hostLabel(st.protocol)}`),
      ];
    } else if (s.kind === "target") {
      content = [icon("bolt"), h("span", { class: "main" }, `${PROTOCOL_NAMES[s.p.kind]} to ${hostLabel(s.p)}`), h("span", { class: "sub" }, "Quick connect")];
    } else {
      content = [icon("plus"), h("span", { class: "main" }, `Save ${hostLabel(s.p)} as a session…`)];
    }
    return h("div", {
      class: `omni-row ${s.kind}`,
      role: "option",
      onpointerdown: (e: Event) => e.preventDefault(),
      onclick: () => this.pick(s),
      onpointermove: () => {
        if (this.sel !== i) {
          this.sel = i;
          this.paint();
        }
      },
    }, ...content, i === this.sel ? h("span", { class: "kbd enter" }, "Enter") : null);
  }

  private paint() {
    [...this.pop.querySelectorAll(".omni-row")].forEach((r, i) => {
      r.classList.toggle("sel", i === this.sel);
      r.setAttribute("aria-selected", String(i === this.sel));
      r.querySelector(".kbd.enter")?.remove();
      if (i === this.sel) r.append(h("span", { class: "kbd enter" }, "Enter"));
    });
    this.pop.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  private hide() {
    this.pop.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
  }
}
