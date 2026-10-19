import { clear, h, icon } from "./dom";
import { showMenu, type MenuItem } from "./dialogs";
import { parseQuickConnect } from "./quickconnect";
import { store } from "./state";
import { hostLabel, PROTOCOL_NAMES, type Protocol, type Session } from "./types";

export interface SidebarActions {
  connect(session: Session, saved: boolean): void;
  connectMany(sessions: Session[]): void;
  edit(session: Session): void;
  create(folder: string): void;
  duplicate(session: Session): void;
  remove(session: Session): void;
  renameFolder(folder: string): void;
  importSecureCrt(): void;
  settings(): void;
}

const OPEN_KEY = "tether.openFolders";
const KIND_LABEL: Record<Protocol["kind"], string> = { ssh: "SSH", telnet: "TEL", raw: "RAW", serial: "COM", local: "SH" };

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  sessions: Session[];
}

export class Sidebar {
  readonly el: HTMLElement;
  readonly quickInput: HTMLInputElement;
  readonly filterInput: HTMLInputElement;
  private hint: HTMLElement;
  private tree: HTMLElement;
  private open: Set<string>;
  private selectedId: string | null = null;

  constructor(private actions: SidebarActions) {
    try {
      this.open = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
    } catch {
      this.open = new Set();
    }
    this.quickInput = h("input", {
      type: "text",
      placeholder: "Connect to…",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Quick connect",
    });
    this.hint = h("div", { class: "quick-hint" });
    this.filterInput = h("input", { type: "text", class: "filter", placeholder: "Filter sessions", spellcheck: "false", "aria-label": "Filter sessions" });
    this.tree = h("div", { class: "tree", role: "tree", tabindex: "0" });

    this.quickInput.addEventListener("input", () => this.updateHint());
    this.quickInput.addEventListener("focus", () => this.updateHint());
    this.quickInput.addEventListener("blur", () => { if (!this.quickInput.value) this.hint.textContent = ""; });
    this.quickInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const p = parseQuickConnect(this.quickInput.value);
        if (!p) return;
        const name = this.quickInput.value.trim();
        this.actions.connect({ ...quickSession(p), name }, false);
        this.quickInput.value = "";
        this.hint.textContent = "";
      } else if (e.key === "Escape") {
        this.quickInput.value = "";
        this.quickInput.blur();
      }
    });
    this.filterInput.addEventListener("input", () => this.render());
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.visibleSessions()[0];
        if (first) this.actions.connect(first, true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSelection(1);
        this.tree.focus();
      } else if (e.key === "Escape") {
        this.filterInput.value = "";
        this.render();
      }
    });
    this.tree.addEventListener("keydown", (e) => this.treeKey(e));

    this.el = h(
      "aside",
      { class: "sidebar" },
      h("div", { class: "sidebar-head" }, h("label", { class: "quick" }, icon("bolt"), this.quickInput), this.hint, this.filterInput),
      this.tree,
      h(
        "div",
        { class: "sidebar-foot" },
        h("button", { type: "button", class: "btn", onclick: () => this.actions.create(""), title: "New session (Ctrl+Shift+N)" }, icon("plus"), "New session"),
        h("span", { class: "grow" }),
        h("button", { type: "button", class: "btn ghost icon-only", onclick: () => this.actions.importSecureCrt(), title: "Import SecureCRT sessions" }, icon("import")),
        h("button", { type: "button", class: "btn ghost icon-only", onclick: () => this.actions.settings(), title: "Settings (Ctrl+,)" }, icon("gear")),
      ),
    );
    store.on("sessions", () => this.render());
    this.render();
  }

  private updateHint() {
    const v = this.quickInput.value.trim();
    if (!v) {
      this.hint.className = "quick-hint";
      this.hint.textContent = "For example admin@10.0.0.1, COM3 9600, or telnet ts1 2003";
      return;
    }
    const p = parseQuickConnect(v);
    this.hint.className = `quick-hint ${p ? "" : "bad"}`;
    this.hint.textContent = p ? `${PROTOCOL_NAMES[p.kind]} to ${hostLabel(p)} — press Enter` : "Not a host, port or serial device";
  }

  private visibleSessions(): Session[] {
    const q = this.filterInput.value.trim().toLowerCase();
    if (!q) return store.sessions;
    const terms = q.split(/\s+/);
    return store.sessions.filter((s) => {
      const hay = `${s.name} ${s.folder} ${hostLabel(s.protocol)} ${s.notes}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  private buildTree(sessions: Session[]): FolderNode {
    const root: FolderNode = { name: "", path: "", folders: new Map(), sessions: [] };
    for (const s of sessions) {
      let node = root;
      const parts = s.folder.split("/").filter(Boolean);
      parts.forEach((p, i) => {
        if (!node.folders.has(p)) node.folders.set(p, { name: p, path: parts.slice(0, i + 1).join("/"), folders: new Map(), sessions: [] });
        node = node.folders.get(p)!;
      });
      node.sessions.push(s);
    }
    return root;
  }

  render() {
    clear(this.tree);
    if (store.sessions.length === 0) {
      this.tree.append(
        h(
          "div",
          { class: "tree-empty" },
          h("p", {}, "No saved sessions yet. Type an address in the box above to connect right away, or save devices you visit often."),
          h("div", { class: "inline" },
            h("button", { type: "button", class: "btn primary", onclick: () => this.actions.create("") }, "New session"),
            h("button", { type: "button", class: "btn", onclick: () => this.actions.importSecureCrt() }, "Import from SecureCRT"),
          ),
        ),
      );
      return;
    }
    const filtering = this.filterInput.value.trim().length > 0;
    const visible = this.visibleSessions();
    if (visible.length === 0) {
      this.tree.append(h("div", { class: "tree-empty" }, h("p", {}, "No sessions match.")));
      return;
    }
    const walk = (node: FolderNode, depth: number) => {
      for (const f of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isOpen = filtering || this.open.has(f.path);
        const count = countSessions(f);
        const row = h(
          "div",
          {
            class: `tree-row folder ${isOpen ? "open" : ""}`,
            role: "treeitem",
            "aria-expanded": String(isOpen),
            "data-folder": f.path,
            onclick: () => this.toggle(f.path),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              this.folderMenu(f, e.clientX, e.clientY);
            },
          },
          h("span", { class: "chev" }, icon("chevron")),
          icon("folder"),
          h("span", { class: "name" }, f.name),
          h("span", { class: "host" }, String(count)),
        );
        row.style.setProperty("--depth", String(depth));
        this.tree.append(row);
        if (isOpen) walk(f, depth + 1);
      }
      for (const s of node.sessions) this.tree.append(this.sessionRow(s, depth));
    };
    walk(this.buildTree(visible), 0);
  }

  private sessionRow(s: Session, depth: number) {
    const row = h(
      "div",
      {
        class: `tree-row session ${this.selectedId === s.id ? "selected" : ""}`,
        role: "treeitem",
        "data-id": s.id,
        title: `${PROTOCOL_NAMES[s.protocol.kind]} — ${hostLabel(s.protocol)}${s.notes ? `\n${s.notes}` : ""}`,
        onclick: () => this.select(s.id),
        ondblclick: () => this.actions.connect(s, true),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          this.select(s.id);
          this.sessionMenu(s, e.clientX, e.clientY);
        },
      },
      h("span", { class: "tag", style: { background: s.colorTag ?? "transparent" } }),
      h("span", { class: "kind" }, KIND_LABEL[s.protocol.kind]),
      h("span", { class: "name" }, s.name),
      h("span", { class: "host" }, hostLabel(s.protocol)),
    );
    row.style.setProperty("--depth", String(depth));
    return row;
  }

  private select(id: string) {
    this.selectedId = id;
    this.tree.querySelectorAll(".tree-row.session").forEach((r) => r.classList.toggle("selected", (r as HTMLElement).dataset.id === id));
  }

  private toggle(path: string) {
    if (this.open.has(path)) this.open.delete(path);
    else this.open.add(path);
    localStorage.setItem(OPEN_KEY, JSON.stringify([...this.open]));
    this.render();
  }

  private moveSelection(delta: number) {
    const rows = [...this.tree.querySelectorAll<HTMLElement>(".tree-row.session")];
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.dataset.id === this.selectedId);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))];
    this.select(next.dataset.id!);
    next.scrollIntoView({ block: "nearest" });
  }

  private treeKey(e: KeyboardEvent) {
    const s = store.session(this.selectedId);
    switch (e.key) {
      case "ArrowDown": this.moveSelection(1); break;
      case "ArrowUp": this.moveSelection(-1); break;
      case "Enter": if (s) this.actions.connect(s, true); break;
      case "F2": if (s) this.actions.edit(s); break;
      case "Delete": if (s) this.actions.remove(s); break;
      default: return;
    }
    e.preventDefault();
  }

  private sessionMenu(s: Session, x: number, y: number) {
    const items: MenuItem[] = [
      { label: "Connect", action: () => this.actions.connect(s, true), icon: "plug", shortcut: "Enter" },
      { label: "Edit…", action: () => this.actions.edit(s), icon: "edit", shortcut: "F2" },
      { label: "Duplicate", action: () => this.actions.duplicate(s) },
      { label: "New session in this folder…", action: () => this.actions.create(s.folder), icon: "plus" },
      { label: "Delete", action: () => this.actions.remove(s), danger: true, separatorBefore: true, shortcut: "Del" },
    ];
    showMenu(x, y, items);
  }

  private folderMenu(f: FolderNode, x: number, y: number) {
    const all = collectSessions(f);
    showMenu(x, y, [
      { label: `Connect to all ${all.length}`, action: () => this.actions.connectMany(all), icon: "plug" },
      { label: "New session here…", action: () => this.actions.create(f.path), icon: "plus" },
      { label: "Rename folder…", action: () => this.actions.renameFolder(f.path), icon: "edit" },
    ]);
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

export function quickSession(p: Protocol): Session {
  return {
    id: crypto.randomUUID(),
    name: hostLabel(p),
    folder: "",
    protocol: p,
    terminal: {
      termType: "xterm-256color",
      logEnabled: false,
      logTemplate: "{session}_{date}_{time}.log",
      logTimestamps: true,
      logStripAnsi: true,
      highlightSet: null,
      backspaceSendsDelete: true,
      encoding: "utf-8",
    },
    notes: "",
    buttonBar: null,
    loginScript: "",
    colorTag: null,
  };
}
