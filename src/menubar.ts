import { commands, type IconName } from "./commands";
import { h, icon } from "./dom";
import { closeMenus, menuOpen, openMenu, type MenuEntry } from "./menu";

export interface MenuDef {
  label: string;
  /** Built when opened, so labels and check marks are always current. */
  items: () => MenuEntry[];
}

/**
 * The application menu bar (File, Edit, View…). Click or F10 to open; once a
 * menu is open, hovering or Left/Right moves between menus, like a native one.
 */
export class MenuBar {
  readonly el: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private openIndex = -1;

  constructor(private defs: MenuDef[], private onDone: () => void) {
    this.el = h("nav", { class: "menubar", role: "menubar", "aria-label": "Main menu" });
    defs.forEach((d, i) => {
      const b = h("button", { type: "button", role: "menuitem", "aria-haspopup": "menu", tabindex: i === 0 ? "0" : "-1" }, d.label);
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (this.openIndex === i) closeMenus();
        else this.open(i, false);
      });
      b.addEventListener("pointerenter", () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i, false);
      });
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") this.open(i, true);
        else if (e.key === "ArrowRight") this.buttons[(i + 1) % this.buttons.length].focus();
        else if (e.key === "ArrowLeft") this.buttons[(i - 1 + this.buttons.length) % this.buttons.length].focus();
        else if (e.key === "Escape") this.onDone();
        else return;
        e.preventDefault();
      });
      this.buttons.push(b);
      this.el.append(b);
    });
  }

  /** Keyboard entry point (F10). */
  focus() {
    this.buttons[0]?.focus();
  }

  open(i: number, focusFirst: boolean) {
    const b = this.buttons[i];
    if (!b) return;
    this.openIndex = i;
    this.buttons.forEach((x, j) => x.classList.toggle("open", j === i));
    openMenu(this.defs[i].items(), b.getBoundingClientRect(), {
      focusFirst,
      minWidth: 220,
      onNavigate: (dir) => this.open((i + dir + this.buttons.length) % this.buttons.length, true),
      onClose: () => {
        // Another menu may have opened in the meantime.
        if (menuOpen()) return;
        this.openIndex = -1;
        this.buttons.forEach((x) => x.classList.remove("open"));
        if (this.el.contains(document.activeElement) || document.activeElement === document.body) this.onDone();
      },
    });
  }
}

/** A command id, a separator, a spacer, any element, or a command with a short caption. */
export type ToolItem = string | "-" | "grow" | HTMLElement | { id: string; text?: string; icon?: IconName };

/**
 * A toolbar of command buttons. Each button shows the command's icon (and
 * label where there's room), its shortcut in the tooltip, and its pressed or
 * disabled state; call `refresh()` when app state changes.
 */
export class Toolbar {
  readonly el: HTMLElement;
  private buttons: { id: string; el: HTMLButtonElement }[] = [];

  constructor(items: ToolItem[]) {
    this.el = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Toolbar" });
    for (const it of items) {
      if (it === "-") this.el.append(h("span", { class: "sep", role: "separator" }));
      else if (it === "grow") this.el.append(h("span", { class: "grow" }));
      else if (it instanceof HTMLElement) this.el.append(it);
      else {
        const spec = typeof it === "string" ? { id: it } : it;
        const c = commands.get(spec.id);
        const el = h(
          "button",
          { type: "button", class: `tool ${spec.text ? "labeled" : ""}`, "data-cmd": spec.id, onclick: () => commands.run(spec.id) },
          icon(spec.icon ?? c.icon ?? "command"),
          spec.text ? h("span", { class: "text" }, spec.text) : null,
        );
        el.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the terminal
        this.buttons.push({ id: spec.id, el });
        this.el.append(el);
      }
    }
  }

  refresh() {
    for (const b of this.buttons) {
      const c = commands.get(b.id);
      b.el.disabled = !commands.enabled(b.id);
      const checked = c.checked?.();
      if (checked === undefined) b.el.removeAttribute("aria-pressed");
      else b.el.setAttribute("aria-pressed", String(checked));
      b.el.title = commands.tip(b.id);
      b.el.setAttribute("aria-label", commands.label(b.id));
    }
  }
}
