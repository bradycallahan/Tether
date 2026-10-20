import { commands } from "./commands";
import { clear, h, icon } from "./dom";
import { showMenu, type MenuEntry, type MenuItem } from "./menu";
import { folderName, isUnder, joinFolder, parentFolder, store } from "./state";
import type { TabState } from "./tabs";
import { hostLabel, newSession, PROTOCOL_NAMES, type Protocol, type Session } from "./types";

export interface SidebarActions {
  connect(sessions: Session[], opts?: { tile?: boolean }): void;
  edit(session: Session): void;
  create(folder: string): void;
  createFolder(parent: string): void;
  duplicate(session: Session): void;
  remove(sessions: Session[]): void;
  removeFolder(path: string): void;
  importSecureCrt(): void;
}

const OPEN_KEY = "tether.openFolders";
const DRAG_TYPE = "application/x-tether-sessions";
const KIND_LABEL: Record<Protocol["kind"], string> = { ssh: "SSH", telnet: "TEL", raw: "RAW", serial: "COM", local: "SH" };

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  sessions: Session[];
}

/** Row keys: "s:<session id>" or "f:<folder path>". */
type Key = string;
const sKey = (id: string): Key => `s:${id}`;
const fKey = (path: string): Key => `f:${path}`;

/**
 * The session manager: a folder tree of saved sessions with filtering,
 * multi-select, drag-and-drop between folders, inline rename and a port
 * LED on every session that's open in a tab.
 */
export class Sidebar {
  readonly el: HTMLElement;
  readonly filterInput: HTMLInputElement;
  private tree: HTMLElement;
  private filterClear: HTMLButtonElement;
  private open: Set<string>;
  private selected = new Set<Key>();
  private anchor: Key | null = null;
  private cursor: Key | null = null;
  private rows: { key: Key; el: HTMLElement }[] = [];
  private live = new Map<string, TabState>();
  private dragKeys: Key[] = [];

  constructor(private actions: SidebarActions) {
    try {
      this.open = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
    } catch {
      this.open = new Set();
    }
    this.filterInput = h("input", { type: "text", placeholder: "Filter sessions", spellcheck: "false", "aria-label": "Filter sessions" });
    this.filterClear = h("button", { type: "button", class: "clear", title: "Clear filter (Esc)", hidden: true, onclick: () => this.clearFilter() }, icon("close"));
    this.tree = h("div", { class: "tree", role: "tree", tabindex: "0", "aria-multiselectable": "true", "aria-label": "Saved sessions" });

    this.filterInput.addEventListener("input", () => this.render());
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.visibleSessions()[0];
        if (first) this.actions.connect([first]);
      } else if (e.key === "ArrowDown") {
        this.tree.focus();
        this.moveCursor(this.cursor ? 1 : 0, false);
      } else if (e.key === "Escape") {
        if (this.filterInput.value) this.clearFilter();
        else this.tree.focus();
      } else return;
      e.preventDefault();
    });
    this.tree.addEventListener("keydown", (e) => this.treeKey(e));
    this.tree.addEventListener("focus", () => {
      if (!this.cursor && this.rows.length) this.setCursor(this.rows[0].key, false);
    });
    this.tree.addEventListener("contextmenu", (e) => {
      if ((e.target as Element).closest(".tree-row")) return;
      e.preventDefault();
      this.rootMenu(e.clientX, e.clientY);
    });
    this.tree.addEventListener("pointerdown", (e) => {
      if (!(e.target as Element).closest(".tree-row")) this.selectOnly(null);
    });
    this.setupDrop(this.tree, () => "");

    this.el = h(
      "aside",
      { class: "sidebar", "aria-label": "Session manager" },
      h(
        "div",
        { class: "sidebar-head" },
        h("h2", {}, "Sessions"),
        h("span", { class: "grow" }),
        h("button", { type: "button", class: "btn ghost icon-only", title: commands.tip("session.new"), onclick: () => this.actions.create(this.targetFolder()) }, icon("plus")),
        h("button", { type: "button", class: "btn ghost icon-only", title: "New folder", onclick: () => this.actions.createFolder(this.targetFolder()) }, icon("folderPlus")),
        h("button", {
          type: "button",
          class: "btn ghost icon-only",
          title: "More",
          onclick: (e: MouseEvent) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            this.rootMenu(r.left, r.bottom + 2);
          },
        }, icon("more")),
      ),
      h("div", { class: "filter-box" }, icon("search"), this.filterInput, this.filterClear),
      this.tree,
    );
    store.on("sessions", () => this.render());
    this.render();
  }

  /** Tab states by session id, for the LEDs. */
  setLive(states: Map<string, TabState>) {
    const changed = states.size !== this.live.size || [...states].some(([k, v]) => this.live.get(k) !== v);
    if (!changed) return;
    this.live = states;
    for (const { key, el } of this.rows) {
      if (!key.startsWith("s:")) continue;
      const led = el.querySelector(".led") as HTMLElement | null;
      const st = states.get(key.slice(2));
      if (led) led.className = `led ${st && st !== "idle" ? st : "off"}`;
    }
  }

  /** Selected saved sessions (folders expand to their contents). */
  selectedSessions(): Session[] {
    const out = new Map<string, Session>();
    for (const k of this.selected) {
      if (k.startsWith("s:")) {
        const s = store.session(k.slice(2));
        if (s) out.set(s.id, s);
      } else {
        for (const s of store.sessions) if (isUnder(s.folder, k.slice(2))) out.set(s.id, s);
      }
    }
    return [...out.values()];
  }

  focusTree() {
    this.tree.focus();
  }

  hasFocus(): boolean {
    return this.el.contains(document.activeElement);
  }

  focusFilter() {
    this.filterInput.focus();
    this.filterInput.select();
  }

  /** Select and reveal a session (e.g. the active tab's). */
  reveal(id: string) {
    const s = store.session(id);
    if (!s) return;
    const parts = s.folder.split("/").filter(Boolean);
    let changed = false;
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!this.open.has(p)) {
        this.open.add(p);
        changed = true;
      }
    }
    if (changed) this.saveOpen();
    this.selectOnly(sKey(id));
    this.render();
    this.rowEl(sKey(id))?.scrollIntoView({ block: "nearest" });
  }

  /** Expand down to a folder and select it. */
  revealFolder(path: string) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.open.add(parts.slice(0, i).join("/"));
    this.saveOpen();
    this.selectOnly(fKey(path));
    this.render();
    this.rowEl(fKey(path))?.scrollIntoView({ block: "nearest" });
  }

  setAllOpen(open: boolean) {
    this.open = open ? new Set(store.folders()) : new Set();
    this.saveOpen();
    this.render();
  }

  // ---------- rendering ----------

  private visibleSessions(): Session[] {
    const q = this.filterInput.value.trim().toLowerCase();
    if (!q) return store.sessions;
    const terms = q.split(/\s+/);
    return store.sessions.filter((s) => {
      const hay = `${s.name} ${s.folder} ${hostLabel(s.protocol)} ${PROTOCOL_NAMES[s.protocol.kind]} ${s.notes}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  private buildTree(sessions: Session[], withEmptyFolders: boolean): FolderNode {
    const root: FolderNode = { name: "", path: "", folders: new Map(), sessions: [] };
    const ensure = (folder: string) => {
      let node = root;
      const parts = folder.split("/").filter(Boolean);
      parts.forEach((p, i) => {
        if (!node.folders.has(p)) node.folders.set(p, { name: p, path: parts.slice(0, i + 1).join("/"), folders: new Map(), sessions: [] });
        node = node.folders.get(p)!;
      });
      return node;
    };
    if (withEmptyFolders) for (const f of store.explicitFolders) ensure(f);
    for (const s of sessions) ensure(s.folder).sessions.push(s);
    return root;
  }

  render() {
    const filter = this.filterInput.value.trim();
    this.filterClear.hidden = !filter;
    clear(this.tree);
    this.rows = [];
    if (store.sessions.length === 0 && store.explicitFolders.length === 0) {
      this.tree.append(
        h("div", { class: "tree-empty" },
          h("p", {}, "Save the devices you visit often and they'll be one double-click away."),
          h("div", { class: "stack" },
            h("button", { type: "button", class: "btn primary", onclick: () => this.actions.create("") }, icon("plus"), "New session"),
            h("button", { type: "button", class: "btn", onclick: () => this.actions.importSecureCrt() }, icon("import"), "Import from SecureCRT"),
          ),
        ),
      );
      return;
    }
    const visible = this.visibleSessions();
    if (filter && visible.length === 0) {
      this.tree.append(
        h("div", { class: "tree-empty" },
          h("p", {}, `No sessions match “${filter}”.`),
          h("button", { type: "button", class: "btn", onclick: () => this.clearFilter() }, "Clear filter"),
        ),
      );
      return;
    }
    const walk = (node: FolderNode, depth: number) => {
      for (const f of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isOpen = !!filter || this.open.has(f.path);
        this.addRow(fKey(f.path), this.folderRow(f, depth, isOpen));
        if (isOpen) walk(f, depth + 1);
      }
      for (const s of node.sessions) this.addRow(sKey(s.id), this.sessionRow(s, depth));
    };
    walk(this.buildTree(visible, !filter), 0);
    // Drop selections that disappeared (deleted, filtered out).
    const present = new Set(this.rows.map((r) => r.key));
    for (const k of [...this.selected]) if (!present.has(k)) this.selected.delete(k);
    if (this.cursor && !present.has(this.cursor)) this.cursor = null;
    this.paintSelection();
  }

  private addRow(key: Key, el: HTMLElement) {
    this.rows.push({ key, el });
    this.tree.append(el);
  }

  private folderRow(f: FolderNode, depth: number, isOpen: boolean) {
    const key = fKey(f.path);
    const row = h(
      "div",
      {
        class: `tree-row folder ${isOpen ? "open" : ""}`,
        role: "treeitem",
        "aria-expanded": String(isOpen),
        draggable: "true",
        title: f.path,
        onclick: (e: MouseEvent) => {
          this.clickRow(key, e);
          if (!e.shiftKey && !(e.ctrlKey || e.metaKey) && !(e.target as Element).closest(".rename")) this.toggle(f.path);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (!this.selected.has(key)) this.selectOnly(key);
          this.folderMenu(f, e.clientX, e.clientY);
        },
      },
      h("span", { class: "chev" }, icon("chevron")),
      icon("folder"),
      h("span", { class: "name" }, f.name),
      h("span", { class: "count" }, String(countSessions(f))),
    );
    row.style.setProperty("--depth", String(depth));
    this.setupDrag(row, key);
    this.setupDrop(row, () => f.path);
    return row;
  }

  private sessionRow(s: Session, depth: number) {
    const key = sKey(s.id);
    const st = this.live.get(s.id);
    const row = h(
      "div",
      {
        class: "tree-row session",
        role: "treeitem",
        draggable: "true",
        title: `${s.name}\n${PROTOCOL_NAMES[s.protocol.kind]} ${hostLabel(s.protocol)}${s.notes ? `\n\n${s.notes}` : ""}`,
        onclick: (e: MouseEvent) => this.clickRow(key, e),
        ondblclick: (e: MouseEvent) => {
          if ((e.target as Element).closest(".rename")) return;
          this.actions.connect([s]);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (!this.selected.has(key)) this.selectOnly(key);
          this.sessionMenu(e.clientX, e.clientY);
        },
      },
      h("span", { class: "tag", style: { background: s.colorTag ?? "transparent" } }),
      h("span", { class: `led ${st && st !== "idle" ? st : "off"}` }),
      h("span", { class: "name" }, s.name),
      h("span", { class: "host" }, shortAddress(s.protocol)),
      // SSH is the norm; only the others get a badge so they stand out.
      s.protocol.kind === "ssh" ? null : h("span", { class: "kind", title: PROTOCOL_NAMES[s.protocol.kind] }, KIND_LABEL[s.protocol.kind]),
    );
    row.style.setProperty("--depth", String(depth));
    this.setupDrag(row, key);
    this.setupDrop(row, () => s.folder);
    return row;
  }

  // ---------- selection ----------

  private clickRow(key: Key, e: MouseEvent) {
    if (e.shiftKey && this.anchor) {
      this.selectRange(this.anchor, key, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.anchor = key;
    } else {
      this.selected = new Set([key]);
      this.anchor = key;
    }
    this.cursor = key;
    this.paintSelection();
    this.tree.focus({ preventScroll: true });
  }

  private selectOnly(key: Key | null) {
    this.selected = new Set(key ? [key] : []);
    this.anchor = key;
    this.cursor = key;
    this.paintSelection();
  }

  private selectRange(from: Key, to: Key, add: boolean) {
    const keys = this.rows.map((r) => r.key);
    const a = keys.indexOf(from);
    const b = keys.indexOf(to);
    if (a < 0 || b < 0) return;
    if (!add) this.selected.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(keys[i]);
  }

  private paintSelection() {
    for (const { key, el } of this.rows) {
      el.classList.toggle("selected", this.selected.has(key));
      el.classList.toggle("cursor", key === this.cursor);
      el.setAttribute("aria-selected", String(this.selected.has(key)));
    }
  }

  private setCursor(key: Key, extend: boolean) {
    if (extend && this.anchor) this.selectRange(this.anchor, key, false);
    else {
      this.selected = new Set([key]);
      this.anchor = key;
    }
    this.cursor = key;
    this.paintSelection();
    this.rowEl(key)?.scrollIntoView({ block: "nearest" });
  }

  private moveCursor(delta: number, extend: boolean) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex((r) => r.key === this.cursor);
    const next = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.setCursor(this.rows[next].key, extend);
  }

  private rowEl(key: Key) {
    return this.rows.find((r) => r.key === key)?.el;
  }

  /** Folder that "New session"/"New folder" should go into. */
  private targetFolder(): string {
    const k = this.cursor ?? [...this.selected][0];
    if (!k) return "";
    if (k.startsWith("f:")) return k.slice(2);
    return store.session(k.slice(2))?.folder ?? "";
  }

  private treeKey(e: KeyboardEvent) {
    if ((e.target as Element).closest(".rename")) return;
    const key = this.cursor;
    const folder = key?.startsWith("f:") ? key.slice(2) : null;
    switch (e.key) {
      case "ArrowDown": this.moveCursor(1, e.shiftKey); break;
      case "ArrowUp": this.moveCursor(-1, e.shiftKey); break;
      case "Home": this.moveCursor(-this.rows.length, e.shiftKey); break;
      case "End": this.moveCursor(this.rows.length, e.shiftKey); break;
      case "ArrowRight":
        if (folder !== null && !this.open.has(folder) && !this.filterInput.value) this.toggle(folder);
        else if (folder !== null) this.moveCursor(1, false);
        break;
      case "ArrowLeft":
        if (folder !== null && this.open.has(folder) && !this.filterInput.value) this.toggle(folder);
        else if (key) {
          const parent = folder !== null ? parentFolder(folder) : store.session(key.slice(2))?.folder ?? "";
          if (parent) this.setCursor(fKey(parent), false);
        }
        break;
      case "Enter":
        if (e.altKey) {
          const s = this.selectedSessions()[0];
          if (s && key?.startsWith("s:")) this.actions.edit(s);
        } else if (folder !== null && this.selected.size <= 1) this.toggle(folder);
        else this.connectSelected();
        break;
      case "F2": if (key) this.startRename(key); break;
      case "Delete": this.deleteSelected(); break;
      case "a":
        if (!(e.ctrlKey || e.metaKey)) return this.typeToFilter(e);
        this.selected = new Set(this.rows.map((r) => r.key));
        this.paintSelection();
        break;
      default:
        return this.typeToFilter(e);
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** Typing a letter in the tree starts filtering. */
  private typeToFilter(e: KeyboardEvent) {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.key === " ") return;
    this.filterInput.focus();
  }

  private toggle(path: string) {
    if (this.open.has(path)) this.open.delete(path);
    else this.open.add(path);
    this.saveOpen();
    this.render();
  }

  private saveOpen() {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...this.open]));
    } catch {
      /* private mode: folders just won't stay open across restarts */
    }
  }

  private clearFilter() {
    this.filterInput.value = "";
    this.render();
    this.filterInput.focus();
  }

  // ---------- actions on the selection ----------

  private connectSelected(tile = false) {
    const list = this.selectedSessions();
    if (list.length) this.actions.connect(list, { tile });
  }

  private deleteSelected() {
    const folders = [...this.selected].filter((k) => k.startsWith("f:"));
    if (folders.length === 1 && this.selected.size === 1) return this.actions.removeFolder(folders[0].slice(2));
    const sessions = [...this.selected].filter((k) => k.startsWith("s:")).map((k) => store.session(k.slice(2))).filter((s): s is Session => !!s);
    if (sessions.length) this.actions.remove(sessions);
  }

  private startRename(key: Key) {
    const row = this.rowEl(key);
    const nameEl = row?.querySelector(".name") as HTMLElement | null;
    if (!row || !nameEl) return;
    const isFolder = key.startsWith("f:");
    const session = isFolder ? undefined : store.session(key.slice(2));
    const original = isFolder ? folderName(key.slice(2)) : session?.name ?? "";
    const input = h("input", { type: "text", class: "rename", value: original, spellcheck: "false", "aria-label": "New name" });
    row.draggable = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim().replace(/\//g, "-");
      if (commit && next && next !== original) {
        if (isFolder) {
          const path = key.slice(2);
          await store.renameFolder(path, joinFolder(parentFolder(path), next));
          this.open.delete(path);
          this.open.add(joinFolder(parentFolder(path), next));
          this.saveOpen();
        } else if (session) {
          await store.saveSession({ ...session, name: next });
        }
      }
      this.render();
      this.tree.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  private moveMenu(): MenuItem[] {
    const sessions = this.selectedSessions();
    const here = new Set(sessions.map((s) => s.folder));
    const items: MenuItem[] = [{ label: "Top level", disabled: here.size === 1 && here.has(""), action: () => store.moveSessions(sessions.map((s) => s.id), "") }];
    for (const f of store.folders()) {
      items.push({ label: f, disabled: here.size === 1 && here.has(f), action: () => store.moveSessions(sessions.map((s) => s.id), f) });
    }
    return items;
  }

  private sessionMenu(x: number, y: number) {
    const sessions = this.selectedSessions();
    const n = sessions.length;
    const one = n === 1 ? sessions[0] : null;
    const entries: MenuEntry[] = [
      { label: n > 1 ? `Connect ${n} sessions` : "Connect", icon: "plug", shortcut: "Enter", action: () => this.connectSelected() },
      ...(n > 1 ? [{ label: `Connect ${n} sessions in tiles`, icon: "tile", action: () => this.connectSelected(true) } as MenuItem] : []),
      "-",
      { label: "Session options…", icon: "sliders", shortcut: "Alt+Enter", disabled: !one, action: () => one && this.actions.edit(one) },
      { label: "Rename", shortcut: "F2", disabled: !one, action: () => one && this.startRename(sKey(one.id)) },
      { label: "Duplicate", icon: "clone", disabled: !one, action: () => one && this.actions.duplicate(one) },
      { label: "Copy address", icon: "copy", disabled: !one, action: () => one && navigator.clipboard.writeText(addressOf(one.protocol)).catch(() => {}) },
      { label: "Move to", icon: "folder", submenu: this.moveMenu() },
      "-",
      { label: "New session here…", icon: "plus", action: () => this.actions.create(this.targetFolder()) },
      { label: "New folder here…", icon: "folderPlus", action: () => this.actions.createFolder(this.targetFolder()) },
      "-",
      { label: n > 1 ? `Delete ${n} sessions…` : "Delete…", icon: "trash", shortcut: "Del", danger: true, action: () => this.actions.remove(sessions) },
    ];
    showMenu(x, y, entries);
  }

  private folderMenu(f: FolderNode, x: number, y: number) {
    const all = collectSessions(f);
    showMenu(x, y, [
      { label: `Connect to all ${all.length}`, icon: "plug", disabled: !all.length, action: () => this.actions.connect(all) },
      { label: `Connect to all ${all.length} in tiles`, icon: "tile", disabled: all.length < 2, action: () => this.actions.connect(all, { tile: true }) },
      "-",
      { label: "New session here…", icon: "plus", action: () => this.actions.create(f.path) },
      { label: "New folder here…", icon: "folderPlus", action: () => this.actions.createFolder(f.path) },
      { label: "Rename", icon: "edit", shortcut: "F2", action: () => this.startRename(fKey(f.path)) },
      "-",
      { label: "Delete folder…", icon: "trash", danger: true, action: () => this.actions.removeFolder(f.path) },
    ]);
  }

  private rootMenu(x: number, y: number) {
    showMenu(x, y, [
      { label: "New session…", icon: "plus", action: () => this.actions.create("") },
      { label: "New folder…", icon: "folderPlus", action: () => this.actions.createFolder("") },
      "-",
      { label: "Expand all folders", action: () => this.setAllOpen(true) },
      { label: "Collapse all folders", action: () => this.setAllOpen(false) },
      "-",
      { label: "Import from SecureCRT…", icon: "import", action: () => this.actions.importSecureCrt() },
    ]);
  }

  // ---------- drag and drop ----------

  private setupDrag(row: HTMLElement, key: Key) {
    row.addEventListener("dragstart", (e) => {
      if (!this.selected.has(key)) this.selectOnly(key);
      this.dragKeys = [...this.selected];
      const ids = this.selectedSessions().map((s) => s.id);
      e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer?.setData("text/plain", this.selectedSessions().map((s) => s.name).join("\n"));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      this.dragKeys = [];
      this.tree.querySelectorAll(".drop").forEach((el) => el.classList.remove("drop"));
    });
  }

  private setupDrop(el: HTMLElement, target: () => string) {
    const accepts = (e: DragEvent) => this.dragKeys.length > 0 && !!e.dataTransfer?.types.includes(DRAG_TYPE);
    el.addEventListener("dragover", (e) => {
      if (!accepts(e)) return;
      const dest = target();
      // A folder can't move into itself.
      if (this.dragKeys.some((k) => k.startsWith("f:") && isUnder(dest, k.slice(2)))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.tree.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      (dest ? this.rowEl(fKey(dest)) ?? el : this.tree).classList.add("drop");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop");
    });
    el.addEventListener("drop", async (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const dest = target();
      const keys = this.dragKeys;
      this.dragKeys = [];
      this.tree.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      for (const k of keys.filter((k) => k.startsWith("f:"))) {
        const path = k.slice(2);
        if (parentFolder(path) !== dest && !isUnder(dest, path)) await store.renameFolder(path, joinFolder(dest, folderName(path)));
      }
      const ids = keys.filter((k) => k.startsWith("s:")).map((k) => k.slice(2));
      await store.moveSessions(ids, dest);
      if (dest && !this.open.has(dest)) this.toggle(dest);
    });
  }
}

function countSessions(f: FolderNode): number {
  let n = f.sessions.length;
  for (const c of f.folders.values()) n += countSessions(c);
  return n;
}

function collectSessions(f: FolderNode): Session[] {
  return [...f.sessions, ...[...f.folders.values()].flatMap(collectSessions)];
}

/** Address without the user name, for the narrow tree. */
function shortAddress(p: Protocol): string {
  if (p.kind === "ssh") return p.port === 22 ? p.host : `${p.host}:${p.port}`;
  return hostLabel(p);
}

function addressOf(p: Protocol): string {
  if (p.kind === "serial") return p.port;
  if (p.kind === "local") return p.shell;
  return p.host;
}

/** Session ids being dragged out of the tree, if this drag came from it. */
export function draggedSessionIds(e: DragEvent): string[] | null {
  const raw = e.dataTransfer?.getData(DRAG_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

export function isSessionDrag(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(DRAG_TYPE);
}

export function quickSession(p: Protocol, name = hostLabel(p)): Session {
  return newSession({ name, protocol: p });
}
