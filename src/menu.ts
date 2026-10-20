// Drop-down and context menus, with submenus, check marks, disabled items
// and full keyboard control. Used by the menu bar, toolbar drop-downs and
// right-click menus.

import { commands, type IconName } from "./commands";
import { h, icon } from "./dom";

export interface MenuItem {
  label: string;
  action?: () => void;
  icon?: IconName;
  shortcut?: string;
  /** Dim text on the right, e.g. a host name. */
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  submenu?: MenuItem[];
}

/** "-" draws a separator. */
export type MenuEntry = MenuItem | "-";

/** A menu item that runs a registered command, with its label, shortcut and state. */
export function cmd(id: string, overrides: Partial<MenuItem> = {}): MenuItem {
  const c = commands.get(id);
  return {
    label: commands.label(id),
    action: () => commands.run(id),
    icon: c.icon,
    shortcut: commands.shortcut(id),
    checked: c.checked?.(),
    disabled: !commands.enabled(id),
    ...overrides,
  };
}

interface OpenOpts {
  /** Called when the whole menu stack closes. */
  onClose?: () => void;
  /** Left/Right at the top level, for moving between menu bar menus. */
  onNavigate?: (dir: -1 | 1) => void;
  /** Focus the first item (keyboard-opened menus). */
  focusFirst?: boolean;
  minWidth?: number;
}

let stack: HTMLElement[] = [];
let rootOpts: OpenOpts = {};

/** Open a menu at a point, or below an anchor rectangle. */
export function openMenu(entries: MenuEntry[], at: { x: number; y: number } | DOMRect, opts: OpenOpts = {}) {
  closeMenus();
  rootOpts = opts;
  const el = buildLevel(entries, 0);
  if (opts.minWidth) el.style.minWidth = `${opts.minWidth}px`;
  place(el, "width" in at ? { x: at.left, y: at.bottom + 2 } : at, "width" in at ? at : null);
  setTimeout(() => {
    addEventListener("pointerdown", outside, { capture: true });
    addEventListener("blur", closeMenus, { once: true });
  });
  if (opts.focusFirst) focusItem(el, 0, 1);
  else el.focus();
}

/** Right-click menu at the pointer. */
export function showMenu(x: number, y: number, entries: MenuEntry[]) {
  openMenu(entries, { x, y }, { focusFirst: false });
}

export function menuOpen(): boolean {
  return stack.length > 0;
}

export function closeMenus() {
  if (!stack.length) return;
  for (const m of stack) m.remove();
  stack = [];
  removeEventListener("pointerdown", outside, { capture: true });
  const cb = rootOpts.onClose;
  rootOpts = {};
  cb?.();
}

function outside(e: Event) {
  const t = e.target as Node;
  if (stack.some((m) => m.contains(t))) return;
  // Let the menu bar handle clicks on its own buttons.
  if ((t as Element).closest?.(".menubar")) return;
  closeMenus();
}

function place(el: HTMLElement, p: { x: number; y: number }, anchor: DOMRect | null) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  let x = Math.min(p.x, innerWidth - r.width - 6);
  let y = p.y;
  if (y + r.height > innerHeight - 6) y = anchor ? Math.max(6, anchor.top - r.height - 2) : Math.max(6, innerHeight - r.height - 6);
  x = Math.max(6, x);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function items(level: HTMLElement): HTMLButtonElement[] {
  return [...level.querySelectorAll<HTMLButtonElement>(":scope > button")];
}

function focusItem(level: HTMLElement, from: number, dir: 1 | -1) {
  const list = items(level);
  if (!list.length) return;
  for (let n = 0; n < list.length; n++) {
    const i = (((from + n * dir) % list.length) + list.length) % list.length;
    if (!list[i].disabled) {
      list[i].focus();
      return;
    }
  }
}

function buildLevel(entries: MenuEntry[], depth: number): HTMLElement {
  const level = h("div", { class: "menu", role: "menu", tabindex: "-1" });
  const hasChecks = entries.some((e) => e !== "-" && e.checked !== undefined);
  const hasIcons = entries.some((e) => e !== "-" && e.icon);
  let pendingSep = false;
  for (const e of entries) {
    if (e === "-") {
      pendingSep = level.childElementCount > 0;
      continue;
    }
    if (pendingSep) level.append(h("hr"));
    pendingSep = false;
    const btn = h(
      "button",
      {
        type: "button",
        class: `${e.danger ? "danger" : ""} ${e.submenu ? "has-sub" : ""}`,
        role: e.checked !== undefined ? "menuitemcheckbox" : "menuitem",
        "aria-checked": e.checked === undefined ? undefined : String(e.checked),
        "aria-haspopup": e.submenu ? "menu" : undefined,
        disabled: e.disabled,
      },
      hasChecks ? h("span", { class: "check" }, e.checked ? "✓" : "") : null,
      e.icon ? icon(e.icon) : hasIcons ? h("span", { class: "icon-gap" }) : null,
      h("span", { class: "label" }, e.label),
      e.hint ? h("span", { class: "hint" }, e.hint) : null,
      e.shortcut ? h("span", { class: "kbd" }, e.shortcut) : null,
      e.submenu ? h("span", { class: "sub" }, icon("chevron")) : null,
    );
    const openSub = (focus: boolean) => {
      truncate(depth + 1);
      if (!e.submenu?.length) return;
      const sub = buildLevel(e.submenu, depth + 1);
      const r = btn.getBoundingClientRect();
      place(sub, { x: r.right - 2, y: r.top - 5 }, null);
      const sr = sub.getBoundingClientRect();
      if (sr.right > innerWidth - 4) sub.style.left = `${Math.max(6, r.left - sr.width + 2)}px`;
      if (focus) focusItem(sub, 0, 1);
    };
    btn.addEventListener("pointerenter", () => {
      if (!btn.disabled) btn.focus({ preventScroll: true });
      if (e.submenu) openSub(false);
      else truncate(depth + 1);
    });
    btn.addEventListener("click", () => {
      if (e.submenu) return openSub(true);
      closeMenus();
      e.action?.();
    });
    btn.addEventListener("keydown", (k) => {
      if (k.key === "ArrowRight" && e.submenu) {
        openSub(true);
        k.preventDefault();
        k.stopPropagation();
      }
    });
    level.append(btn);
  }
  level.addEventListener("keydown", (k) => {
    if (k.key === "Enter" || k.key === " ") return; // the focused button clicks itself
    const list = items(level);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    switch (k.key) {
      case "ArrowDown": focusItem(level, i + 1, 1); break;
      case "ArrowUp": focusItem(level, i < 0 ? list.length - 1 : i - 1, -1); break;
      case "Home": focusItem(level, 0, 1); break;
      case "End": focusItem(level, list.length - 1, -1); break;
      case "ArrowLeft":
        if (depth > 0) {
          truncate(depth);
          (stack[depth - 1]?.querySelector("button.has-sub:focus, button.has-sub") as HTMLElement | null)?.focus();
        } else rootOpts.onNavigate?.(-1);
        break;
      case "ArrowRight":
        if (depth === 0) rootOpts.onNavigate?.(1);
        break;
      case "Escape":
        if (depth > 0) truncate(depth);
        else closeMenus();
        break;
      case "Tab": closeMenus(); break;
      default: {
        // Type-ahead: jump to the next item starting with that letter.
        if (k.key.length !== 1 || k.ctrlKey || k.metaKey || k.altKey) return;
        const ch = k.key.toLowerCase();
        const start = i + 1;
        for (let n = 0; n < list.length; n++) {
          const b = list[(start + n) % list.length];
          if (!b.disabled && b.querySelector(".label")?.textContent?.toLowerCase().startsWith(ch)) {
            b.focus();
            break;
          }
        }
      }
    }
    k.preventDefault();
    k.stopPropagation();
  });
  stack[depth] = level;
  return level;
}

function truncate(depth: number) {
  while (stack.length > depth) stack.pop()?.remove();
}
