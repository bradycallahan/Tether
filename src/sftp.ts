// The Files pane: a remote file browser docked beside an SSH tab's terminal.
// It talks SFTP over the tab's own connection (sftp.rs), so opening it never
// asks for a password again. Transfers run in Rust; files dropped from the
// desktop arrive here as File objects and are streamed to Rust in chunks.

import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { h, icon } from "./dom";
import { button, check, confirmDialog, modal, promptText, toast } from "./dialogs";
import { fromKeyboard, menuPoint, showMenu, type MenuEntry } from "./menu";
import { store } from "./state";
import type { CmdError, RemoteEntry, TransferProgress } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers (tested in tests/sftp.test.ts)

/** Remote paths always use "/". */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : trimmed.slice(0, i);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** A local path inside `dir`, using the separator the OS picker gave us. */
export function localJoin(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/**
 * A remote name made safe to create on this computer, or null when it could
 * escape the destination folder. Mirrors `sftp::local_name` in Rust.
 */
export function safeLocalName(name: string): string | null {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) return null;
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  if (!safe) return null;
  const stem = safe.split(".")[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/.test(stem)) safe = `_${safe}`;
  return safe;
}

/** A name the user typed for a new folder or a rename. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (name.includes("/")) return "Names can't contain /.";
  if (name === "." || name === "..") return "That name is reserved.";
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export type SortKey = "name" | "size" | "modified";

/** Folders first, then by the chosen column; names compare like a file manager (2 before 10). */
export function sortEntries(list: RemoteEntry[], key: SortKey, dir: 1 | -1): RemoteEntry[] {
  const byName = (a: RemoteEntry, b: RemoteEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...list].sort((a, b) => {
    const da = a.kind === "dir" ? 0 : 1;
    const db = b.kind === "dir" ? 0 : 1;
    if (da !== db) return da - db;
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "modified") c = (a.modified ?? 0) - (b.modified ?? 0);
    return (c || byName(a, b)) * dir;
  });
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const oldDateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

function formatModified(secs: number | null): string {
  if (secs === null) return "";
  const d = new Date(secs * 1000);
  return d.getFullYear() === new Date().getFullYear() ? dateFmt.format(d) : oldDateFmt.format(d);
}

const errText = (e: unknown) => (e as CmdError)?.message ?? String(e);
const errCode = (e: unknown) => (e as CmdError)?.code ?? "ERROR";

// ---------------------------------------------------------------------------
// Replace prompts

type Answer = "replace" | "skip" | "cancel";

/** Asks once per clash; "do the same for the rest" sticks for the batch. */
class Clashes {
  private sticky: Answer | null = null;
  constructor(private remaining: () => number) {}

  async ask(name: string, where: string): Promise<Answer> {
    if (this.sticky) return this.sticky;
    const rest = this.remaining();
    const all = h("input", { type: "checkbox" });
    const r = await modal<Answer>((done) => ({
      title: `Replace ${name}?`,
      intro: `${name} already exists in ${where}.`,
      body: rest > 0 ? check(`Do the same for the other ${rest} item${rest === 1 ? "" : "s"}`, all) : undefined,
      foot: [
        button("Cancel", { onclick: () => done("cancel") }),
        button("Skip", { onclick: () => done("skip") }),
        button("Replace", { kind: "primary", submit: true }),
      ],
      onSubmit: () => done("replace"),
    }));
    const answer = r ?? "cancel";
    if (all.checked && answer !== "cancel") this.sticky = answer;
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Transfers

class Transfer {
  readonly id = crypto.randomUUID();
  readonly el: HTMLDivElement;
  private bar: HTMLDivElement;
  private detail: HTMLSpanElement;
  private nameEl: HTMLSpanElement;
  private action: HTMLButtonElement;
  private started = performance.now();
  cancelled = false;
  finished = false;

  constructor(readonly up: boolean, label: string, private onCancel: (t: Transfer) => void, private onDismiss: (t: Transfer) => void) {
    this.bar = h("div", { class: "fill" });
    this.detail = h("span", { class: "detail" }, up ? "Starting upload…" : "Starting download…");
    this.nameEl = h("span", { class: "name", title: label }, label);
    this.action = h("button", { type: "button", class: "btn ghost icon-only", title: "Cancel", onclick: () => this.click() }, icon("close"));
    this.el = h("div", { class: "transfer", role: "listitem" },
      icon(up ? "upload" : "download"),
      h("div", { class: "info" }, h("div", { class: "line" }, this.nameEl, this.detail), h("div", { class: "bar" }, this.bar)),
      this.action,
    );
  }

  private click() {
    if (this.finished) this.onDismiss(this);
    else {
      this.cancelled = true;
      this.onCancel(this);
    }
  }

  progress(p: TransferProgress) {
    const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
    this.bar.style.width = `${pct}%`;
    const secs = (performance.now() - this.started) / 1000;
    const rate = secs > 0.5 ? ` · ${formatSize(p.done / secs)}/s` : "";
    this.detail.textContent = `${formatSize(p.done)} of ${formatSize(p.total)}${rate}`;
    if (p.current && p.current !== this.nameEl.dataset.current) {
      this.nameEl.dataset.current = p.current;
      this.el.title = p.current;
    }
  }

  finish(ok: boolean, message: string) {
    this.finished = true;
    this.el.classList.add(ok ? "ok" : "failed");
    if (ok) this.bar.style.width = "100%";
    this.detail.textContent = message;
    this.detail.title = message;
    this.action.title = "Dismiss";
  }
}

// ---------------------------------------------------------------------------
// The pane

export interface FilePaneHost {
  readonly connId: string;
  /** The tab's title, for messages ("core-sw1"). */
  label(): string;
  connected(): boolean;
  connecting(): boolean;
  close(): void;
  focusTerminal(): void;
  /** The pane opened, closed or changed folder (for the saved workspace). */
  changed(): void;
}

type View = { kind: "list" } | { kind: "message"; text: string; actions?: HTMLElement[]; fault?: boolean };

const CHUNK = 1024 * 1024;

export class FilePane {
  readonly el: HTMLDivElement;
  /** The folder on screen ("" until SFTP has opened). */
  path = "";
  private home = "";
  private entries: RemoteEntry[] = [];
  private shown: RemoteEntry[] = [];
  private selected = new Set<string>();
  private cursor: string | null = null;
  private anchor: string | null = null;
  private sortKey: SortKey = "name";
  private sortDir: 1 | -1 = 1;
  private seq = 0;
  private opened = false;
  private view: View = { kind: "message", text: "" };
  private typeahead = "";
  private typeaheadAt = 0;

  private pathInput: HTMLInputElement;
  private listEl: HTMLDivElement;
  private headEl: HTMLDivElement;
  private msgEl: HTMLDivElement;
  private transfersEl: HTMLDivElement;
  private upBtn: HTMLButtonElement;
  private downloadBtn: HTMLButtonElement;
  private changeBtns: HTMLButtonElement[];
  private transfers = new Set<Transfer>();

  constructor(private host: FilePaneHost) {
    const tool = (name: Parameters<typeof icon>[0], title: string, onclick: () => void) =>
      h("button", { type: "button", class: "btn ghost icon-only", title, onclick }, icon(name));
    this.upBtn = tool("arrowUp", "Up one folder (Backspace)", () => this.goUp());
    this.pathInput = h("input", { type: "text", class: "path", spellcheck: "false", "aria-label": "Remote folder", title: "Type a folder and press Enter" });
    this.pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const p = this.pathInput.value.trim();
        if (p) this.navigate(p, { fromInput: true });
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.pathInput.value = this.path;
        this.listEl.focus();
      }
    });
    this.downloadBtn = h("button", { type: "button", class: "btn ghost", title: "Download the selected items (Enter)", onclick: () => this.download() }, icon("download"), h("span", { class: "text" }, "Download"));

    const uploadBtn = h("button", { type: "button", class: "btn ghost", title: "Upload files from this computer", onclick: () => this.uploadPicked(false) }, icon("upload"), h("span", { class: "text" }, "Upload"));
    const newFolderBtn = h("button", { type: "button", class: "btn ghost icon-only", title: "New folder", onclick: () => this.newFolder() }, icon("folderPlus"));
    this.changeBtns = [uploadBtn, newFolderBtn];

    this.headEl = h("div", { class: "files-cols", role: "row" });
    this.listEl = h("div", { class: "files-list", tabindex: "0", role: "grid", "aria-label": "Remote files", "aria-multiselectable": "true" });
    this.msgEl = h("div", { class: "files-msg", role: "status" });
    this.transfersEl = h("div", { class: "transfers", role: "list", "aria-label": "Transfers", hidden: true });

    this.el = h("div", { class: "files", role: "region", "aria-label": "Files" },
      h("div", { class: "files-head" },
        icon("folder"),
        h("h2", {}, "Files"),
        h("span", { class: "grow" }),
        h("button", { type: "button", class: "btn ghost icon-only", title: "Close files", onclick: () => host.close() }, icon("close")),
      ),
      h("div", { class: "files-bar" }, this.upBtn, tool("home", "Home folder", () => this.home && this.navigate(this.home)), this.pathInput, tool("refresh", "Refresh (F5)", () => this.refresh())),
      h("div", { class: "files-bar actions" },
        uploadBtn,
        this.downloadBtn,
        newFolderBtn,
        h("span", { class: "grow" }),
        h("button", {
          type: "button",
          class: "btn ghost icon-only",
          title: "More",
          onclick: (e: MouseEvent) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(r.left, r.bottom + 2, this.menu(false));
          },
        }, icon("more")),
      ),
      h("div", { class: "files-table" }, this.headEl, this.listEl, this.msgEl),
      this.transfersEl,
    );

    this.listEl.addEventListener("keydown", (e) => this.onKey(e));
    this.listEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = (e.target as Element).closest<HTMLElement>(".file-row");
      if (row && !fromKeyboard(e)) {
        const name = row.dataset.name!;
        if (!this.selected.has(name)) this.select(name, false, false);
      }
      const at = fromKeyboard(e) ? this.cursorPoint() ?? menuPoint(e) : { x: e.clientX, y: e.clientY };
      showMenu(at.x, at.y, this.menu(!!row || (fromKeyboard(e) && this.selected.size > 0)));
    });
    this.listEl.addEventListener("pointerdown", (e) => {
      if (e.target === this.listEl && e.button === 0) {
        this.selected.clear();
        this.renderSelection();
      }
    });
    this.msgEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.opened) showMenu(e.clientX, e.clientY, this.menu(false));
    });
    this.setupDrop();
    this.renderHead();
    this.render();
  }

  // ---------- lifecycle ----------

  /** The tab connected (or the pane was opened on a connected tab). */
  async start(path?: string) {
    const seq = ++this.seq;
    this.opened = false;
    const slow = window.setTimeout(() => {
      if (seq === this.seq) this.show({ kind: "message", text: `Starting SFTP on ${this.host.label()}…` });
    }, 300);
    try {
      this.home = await api.sftpOpen(this.host.connId);
      if (seq !== this.seq) return;
      this.opened = true;
      clearTimeout(slow);
      await this.navigate(path || this.path || this.home, { fallback: true });
    } catch (e) {
      clearTimeout(slow);
      if (seq !== this.seq) return;
      this.show({ kind: "message", text: errText(e), fault: true, actions: [button("Try again", { onclick: () => this.start(path) })] });
    }
  }

  /** The tab isn't connected (yet, or any more). Keep the folder for the next connect. */
  stop() {
    this.seq++;
    this.opened = false;
    const name = this.host.label();
    const text = this.host.connecting() ? `Waiting for ${name} to connect…` : `${name} isn't connected. Its files come back when it reconnects.`;
    this.show({ kind: "message", text });
  }

  /** Transfers still running, so closing the tab can say so. */
  busy(): number {
    return [...this.transfers].filter((t) => !t.finished).length;
  }

  focus() {
    this.listEl.focus();
  }

  dispose() {
    this.seq++;
    for (const t of this.transfers) if (!t.finished) this.cancel(t);
  }

  // ---------- browsing ----------

  async navigate(path: string, o: { fromInput?: boolean; fallback?: boolean; select?: string } = {}): Promise<void> {
    if (!this.opened) return;
    const seq = ++this.seq;
    const slow = window.setTimeout(() => {
      if (seq === this.seq) this.listEl.setAttribute("aria-busy", "true");
    }, 250);
    try {
      const list = await api.sftpList(this.host.connId, path);
      if (seq !== this.seq) return;
      const changed = path !== this.path;
      this.path = path;
      this.pathInput.classList.remove("invalid");
      this.entries = list;
      if (changed) {
        this.selected.clear();
        this.cursor = this.anchor = null;
        this.listEl.scrollTop = 0;
      } else {
        const names = new Set(list.map((e) => e.name));
        for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
        if (this.cursor && !names.has(this.cursor)) this.cursor = null;
      }
      if (o.select) {
        this.selected = new Set([o.select]);
        this.cursor = this.anchor = o.select;
      }
      this.show({ kind: "list" });
      if (o.select) this.scrollToCursor();
      if (changed) this.host.changed();
    } catch (e) {
      if (seq !== this.seq) return;
      if (o.fromInput) {
        this.pathInput.classList.add("invalid");
        toast(errText(e));
        this.pathInput.addEventListener("input", () => this.pathInput.classList.remove("invalid"), { once: true });
        return;
      }
      if (o.fallback && path !== this.home) {
        // The folder from last time is gone; start from home instead.
        return this.navigate(this.home);
      }
      this.path = path;
      this.show({
        kind: "message",
        text: errText(e),
        fault: true,
        actions: [button("Try again", { onclick: () => this.navigate(path) }), ...(path !== this.home ? [button("Home folder", { onclick: () => this.navigate(this.home) })] : [])],
      });
    } finally {
      clearTimeout(slow);
      if (seq === this.seq) this.listEl.removeAttribute("aria-busy");
    }
  }

  refresh() {
    if (this.opened) this.navigate(this.path || this.home);
    else if (this.host.connected()) this.start();
  }

  private goUp() {
    if (!this.opened || this.path === "/" || !this.path) return;
    const from = baseName(this.path);
    this.navigate(parentPath(this.path) || "/", { select: from });
  }

  private openEntry(e: RemoteEntry) {
    if (e.kind === "dir") this.navigate(joinPath(this.path, e.name));
    else this.download([e]);
  }

  // ---------- rendering ----------

  private show(view: View) {
    this.view = view;
    this.render();
  }

  private render() {
    const v = this.view;
    this.pathInput.value = this.path;
    this.pathInput.disabled = !this.opened;
    this.upBtn.disabled = !this.opened || this.path === "/";
    this.el.classList.toggle("ready", this.opened);
    if (v.kind === "message") {
      this.listEl.replaceChildren();
      this.headEl.hidden = true;
      this.msgEl.hidden = !v.text;
      this.msgEl.className = `files-msg${v.fault ? " fault" : ""}`;
      this.msgEl.replaceChildren(h("p", {}, v.text), ...(v.actions?.length ? [h("div", { class: "actions" }, v.actions)] : []));
      this.updateButtons();
      return;
    }
    const hidden = store.settings.filesShowHidden;
    this.shown = sortEntries(this.entries.filter((e) => hidden || !e.name.startsWith(".")), this.sortKey, this.sortDir);
    this.headEl.hidden = false;
    const rows = this.shown.map((e) => this.row(e));
    this.listEl.replaceChildren(...rows);
    if (!this.shown.length) {
      const onlyHidden = this.entries.length > 0;
      this.msgEl.hidden = false;
      this.msgEl.className = "files-msg";
      this.msgEl.replaceChildren(h("p", {}, onlyHidden ? "Only hidden files here." : "This folder is empty. Drop files here to upload them."));
      if (onlyHidden) this.msgEl.append(h("div", { class: "actions" }, button("Show hidden files", { onclick: () => this.toggleHidden() })));
    } else {
      this.msgEl.hidden = true;
    }
    this.renderSelection();
  }

  private row(e: RemoteEntry): HTMLElement {
    const dir = e.kind === "dir";
    const tip = [e.link ? "Link" : "", e.permissions, dir ? "" : `${e.size.toLocaleString()} bytes`].filter(Boolean).join(" · ");
    const el = h("div", {
      class: `file-row ${dir ? "dir" : ""} ${e.link ? "link" : ""}`,
      role: "row",
      "data-name": e.name,
      title: tip,
      draggable: "false",
      onpointerdown: (ev: PointerEvent) => {
        if (ev.button !== 0 || (ev.target as Element).closest(".rename")) return;
        this.select(e.name, ev.shiftKey, ev.ctrlKey || ev.metaKey);
      },
      ondblclick: (ev: MouseEvent) => {
        if (!(ev.target as Element).closest(".rename")) this.openEntry(e);
      },
    },
      h("span", { class: "name", role: "gridcell" }, icon(dir ? "folder" : "file"), h("span", { class: "label" }, e.name)),
      h("span", { class: "size", role: "gridcell" }, dir ? "" : formatSize(e.size)),
      h("span", { class: "modified", role: "gridcell" }, formatModified(e.modified)),
    );
    return el;
  }

  private renderHead() {
    const col = (key: SortKey, label: string) => {
      const active = this.sortKey === key;
      return h("button", {
        type: "button",
        class: `col ${key} ${active ? "sorted" : ""}`,
        role: "columnheader",
        "aria-sort": active ? (this.sortDir === 1 ? "ascending" : "descending") : "none",
        onclick: () => {
          if (this.sortKey === key) this.sortDir = this.sortDir === 1 ? -1 : 1;
          else {
            this.sortKey = key;
            this.sortDir = key === "name" ? 1 : -1;
          }
          this.renderHead();
          this.render();
        },
      }, label, active ? icon(this.sortDir === 1 ? "up" : "down") : null);
    };
    this.headEl.replaceChildren(col("name", "Name"), col("size", "Size"), col("modified", "Modified"));
  }

  private renderSelection() {
    for (const row of this.listEl.children as HTMLCollectionOf<HTMLElement>) {
      const name = row.dataset.name!;
      const sel = this.selected.has(name);
      row.classList.toggle("selected", sel);
      row.classList.toggle("cursor", name === this.cursor);
      row.setAttribute("aria-selected", String(sel));
    }
    this.updateButtons();
  }

  private updateButtons() {
    this.downloadBtn.disabled = !this.opened || this.selected.size === 0;
    for (const b of this.changeBtns) b.disabled = !this.opened;
  }

  private rowEl(name: string): HTMLElement | null {
    return [...(this.listEl.children as HTMLCollectionOf<HTMLElement>)].find((r) => r.dataset.name === name) ?? null;
  }

  private scrollToCursor() {
    if (this.cursor) this.rowEl(this.cursor)?.scrollIntoView({ block: "nearest" });
  }

  private cursorPoint() {
    const r = (this.cursor && this.rowEl(this.cursor)?.getBoundingClientRect()) || null;
    return r ? { x: r.left + 24, y: r.bottom } : null;
  }

  // ---------- selection and keys ----------

  private select(name: string, extend: boolean, toggle: boolean) {
    if (extend && this.anchor) {
      const names = this.shown.map((e) => e.name);
      const a = names.indexOf(this.anchor);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        if (!toggle) this.selected.clear();
        for (const n of names.slice(from, to + 1)) this.selected.add(n);
      }
    } else if (toggle) {
      if (this.selected.has(name)) this.selected.delete(name);
      else this.selected.add(name);
      this.anchor = name;
    } else {
      this.selected = new Set([name]);
      this.anchor = name;
    }
    this.cursor = name;
    this.renderSelection();
  }

  private selection(): RemoteEntry[] {
    return this.shown.filter((e) => this.selected.has(e.name));
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as Element).closest(".rename")) return;
    const names = this.shown.map((x) => x.name);
    const at = this.cursor ? names.indexOf(this.cursor) : -1;
    const move = (i: number) => {
      if (!names.length) return;
      const n = names[Math.max(0, Math.min(names.length - 1, i))];
      this.select(n, e.shiftKey, false);
      this.scrollToCursor();
    };
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor(this.listEl.clientHeight / 24) - 1);
    switch (e.key) {
      case "ArrowDown": move(at + 1); break;
      case "ArrowUp":
        if (e.altKey) this.goUp();
        else move(at < 0 ? 0 : at - 1);
        break;
      case "PageDown": move(at + page); break;
      case "PageUp": move(at - page); break;
      case "Home": move(0); break;
      case "End": move(names.length - 1); break;
      case "Enter": {
        const sel = this.selection();
        if (sel.length === 1) this.openEntry(sel[0]);
        else if (sel.length > 1) this.download(sel);
        break;
      }
      case "Backspace": this.goUp(); break;
      case "F2": this.rename(); break;
      case "F5": this.refresh(); break;
      case "Delete": this.remove(); break;
      case "Escape":
        if (this.selected.size) {
          this.selected.clear();
          this.renderSelection();
        } else this.host.focusTerminal();
        break;
      default:
        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
          this.selected = new Set(names);
          this.renderSelection();
          break;
        }
        // Type a name's first letters to jump to it.
        if (e.key.length === 1 && !mod && !e.altKey && e.key !== " ") {
          const now = performance.now();
          this.typeahead = now - this.typeaheadAt < 800 ? this.typeahead + e.key.toLowerCase() : e.key.toLowerCase();
          this.typeaheadAt = now;
          const hit = names.find((n) => n.toLowerCase().startsWith(this.typeahead));
          if (hit) {
            this.select(hit, false, false);
            this.scrollToCursor();
          }
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private menu(onItems: boolean): MenuEntry[] {
    const sel = this.selection();
    const ready = this.opened;
    const one = sel.length === 1 ? sel[0] : null;
    const items: MenuEntry[] = [];
    if (onItems && sel.length) {
      if (one?.kind === "dir") items.push({ label: "Open", action: () => this.openEntry(one) });
      items.push(
        { label: sel.length > 1 ? `Download ${sel.length} items…` : "Download…", icon: "download", action: () => this.download(sel) },
        { label: "Rename", icon: "edit", shortcut: "F2", disabled: !one, action: () => this.rename() },
        { label: sel.length > 1 ? `Delete ${sel.length} items…` : "Delete…", icon: "trash", shortcut: "Del", danger: true, action: () => this.remove() },
        "-",
        { label: sel.length > 1 ? "Copy paths" : "Copy path", icon: "copy", action: () => this.copyPaths(sel) },
        "-",
      );
    }
    items.push(
      { label: "Upload files…", icon: "upload", disabled: !ready, action: () => this.uploadPicked(false) },
      { label: "Upload a folder…", disabled: !ready, action: () => this.uploadPicked(true) },
      { label: "New folder…", icon: "folderPlus", disabled: !ready, action: () => this.newFolder() },
      "-",
      { label: "Copy folder path", disabled: !ready, action: () => this.copyText(this.path) },
      { label: "Show hidden files", checked: store.settings.filesShowHidden, action: () => this.toggleHidden() },
      { label: "Refresh", icon: "refresh", shortcut: "F5", disabled: !this.host.connected(), action: () => this.refresh() },
    );
    return items;
  }

  private toggleHidden() {
    store.patchSettings({ filesShowHidden: !store.settings.filesShowHidden });
  }

  /** Settings changed (hidden files). */
  applySettings() {
    if (this.view.kind === "list") this.render();
  }

  private copyPaths(list: RemoteEntry[]) {
    this.copyText(list.map((e) => joinPath(this.path, e.name)).join("\n"));
  }

  private copyText(text: string) {
    navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Couldn't write to the clipboard."));
  }

  // ---------- changes ----------

  private async newFolder() {
    if (!this.opened) return;
    const where = this.path;
    let name = await promptText({ title: "New folder", label: `Name of the new folder in ${where}`, confirm: "Create" });
    while (name !== undefined) {
      const problem = nameProblem(name);
      if (!problem) break;
      toast(problem);
      name = await promptText({ title: "New folder", label: `Name of the new folder in ${where}`, value: name, confirm: "Create" });
    }
    if (name === undefined) return this.listEl.focus();
    name = name.trim();
    try {
      await api.sftpMkdir(this.host.connId, joinPath(where, name));
      if (this.path === where) await this.navigate(where, { select: name });
    } catch (e) {
      toast(errText(e));
    }
    this.listEl.focus();
  }

  private rename() {
    const sel = this.selection();
    if (sel.length !== 1) return;
    const entry = sel[0];
    const row = this.rowEl(entry.name);
    const label = row?.querySelector(".label");
    if (!row || !label) return;
    const input = h("input", { type: "text", class: "rename", value: entry.name, spellcheck: "false", "aria-label": "New name" });
    label.replaceWith(input);
    input.focus();
    // Select the name without its extension, as Explorer does.
    const dot = entry.kind === "dir" ? -1 : entry.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      const problem = nameProblem(next);
      if (commit && next !== entry.name && problem) toast(problem);
      if (commit && next !== entry.name && !problem) {
        try {
          await api.sftpRename(this.host.connId, joinPath(this.path, entry.name), joinPath(this.path, next));
          await this.navigate(this.path, { select: next });
          this.listEl.focus();
          return;
        } catch (e) {
          toast(errText(e));
        }
      }
      this.render();
      this.listEl.focus();
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

  private async remove() {
    const sel = this.selection();
    if (!sel.length) return;
    const where = this.path;
    const hasDir = sel.some((e) => e.kind === "dir");
    const what = sel.length === 1 ? sel[0].name : `${sel.length} items`;
    const ok = await confirmDialog({
      title: `Delete ${what}?`,
      message: `${hasDir ? (sel.length === 1 ? "The folder and everything in it are" : "These, including everything in the folders, are") : sel.length === 1 ? "It's" : "They're"} deleted from ${this.host.label()}. This can't be undone.`,
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return this.listEl.focus();
    for (const e of sel) {
      try {
        await api.sftpRemove(this.host.connId, joinPath(where, e.name));
      } catch (err) {
        toast(errText(err));
        break;
      }
    }
    if (this.path === where) await this.navigate(where);
    this.listEl.focus();
  }

  // ---------- transfers ----------

  private track(up: boolean, label: string): Transfer {
    const t = new Transfer(up, label, (x) => this.cancel(x), (x) => this.dismiss(x));
    this.transfers.add(t);
    this.transfersEl.prepend(t.el);
    this.transfersEl.hidden = false;
    return t;
  }

  private cancel(t: Transfer) {
    t.cancelled = true;
    api.sftpCancel(t.id).catch(() => {});
  }

  private dismiss(t: Transfer) {
    t.el.remove();
    this.transfers.delete(t);
    this.transfersEl.hidden = this.transfers.size === 0;
  }

  private done(t: Transfer, ok: boolean, message: string) {
    t.finish(ok, message);
    // Successes clear themselves; failures wait to be read.
    if (ok) window.setTimeout(() => this.dismiss(t), 5000);
  }

  private async download(list = this.selection()) {
    if (!this.opened || !list.length) return;
    const from = this.path;
    let targets: { entry: RemoteEntry; local: string; overwrite: boolean }[];
    if (list.length === 1 && list[0].kind !== "dir") {
      const name = safeLocalName(list[0].name) ?? "download";
      const local = await save({ title: `Download ${list[0].name}`, defaultPath: name });
      if (!local) return;
      // The save dialog already asked about replacing.
      targets = [{ entry: list[0], local, overwrite: true }];
    } else {
      const dir = await open({ directory: true, title: list.length === 1 ? `Download ${list[0].name} to` : `Download ${list.length} items to` });
      if (typeof dir !== "string") return;
      targets = [];
      for (const entry of list) {
        const name = safeLocalName(entry.name);
        if (name) targets.push({ entry, local: localJoin(dir, name), overwrite: false });
        else toast(`Skipped ${entry.name}: that name can't be used on this computer.`);
      }
    }
    const clashes = new Clashes(() => targets.length - 1);
    while (targets.length) {
      const { entry, local, overwrite } = targets[0];
      const t = this.track(false, entry.name);
      const args = { connId: this.host.connId, id: t.id, remote: joinPath(from, entry.name), local, overwrite };
      try {
        const sum = await api.sftpDownload(args, (p) => t.progress(p));
        this.done(t, true, summary("Downloaded", sum.files, sum.skipped.length, entry.kind === "dir"));
      } catch (e) {
        if (errCode(e) === "EXISTS") {
          this.dismiss(t);
          const answer = await clashes.ask(baseName(local), "that folder");
          if (answer === "cancel") return;
          if (answer === "replace") {
            targets[0] = { ...targets[0], overwrite: true };
            continue;
          }
        } else {
          this.done(t, false, errCode(e) === "CANCELLED" ? "Cancelled" : errText(e));
        }
      }
      targets.shift();
    }
  }

  /** Upload files or a folder chosen in the OS picker. */
  private async uploadPicked(folder: boolean) {
    if (!this.opened) return;
    const picked = await open({ directory: folder, multiple: !folder, title: `Upload to ${this.path}` });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const into = this.path;
    const queue = paths.map((p) => ({ local: p, overwrite: false }));
    const clashes = new Clashes(() => queue.length - 1);
    while (queue.length) {
      const { local, overwrite } = queue[0];
      const name = local.split(/[\\/]/).filter(Boolean).pop() ?? local;
      const t = this.track(true, name);
      try {
        const sum = await api.sftpUpload({ connId: this.host.connId, id: t.id, remote: into, local, overwrite }, (p) => t.progress(p));
        this.done(t, true, summary("Uploaded", sum.files, sum.skipped.length, folder));
        if (this.path === into) this.navigate(into);
      } catch (e) {
        if (errCode(e) === "EXISTS") {
          this.dismiss(t);
          const answer = await clashes.ask(name, into);
          if (answer === "cancel") return;
          if (answer === "replace") {
            queue[0] = { ...queue[0], overwrite: true };
            continue;
          }
        } else {
          this.done(t, false, errCode(e) === "CANCELLED" ? "Cancelled" : errText(e));
        }
      }
      queue.shift();
    }
  }

  // ---------- drag and drop from the desktop ----------

  private setupDrop() {
    let target: HTMLElement | null = null;
    const mark = (el: HTMLElement | null) => {
      if (target === el) return;
      target?.classList.remove("drop");
      target = el;
      el?.classList.add("drop");
    };
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    this.el.addEventListener("dragover", (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.opened) {
        e.dataTransfer!.dropEffect = "none";
        return;
      }
      e.dataTransfer!.dropEffect = "copy";
      const row = (e.target as Element).closest<HTMLElement>(".file-row.dir");
      mark(row ?? this.el);
    });
    this.el.addEventListener("dragleave", (e) => {
      if (!this.el.contains(e.relatedTarget as Node)) mark(null);
    });
    this.el.addEventListener("drop", (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const row = target && target !== this.el ? target.dataset.name : undefined;
      mark(null);
      if (!this.opened || !e.dataTransfer) return;
      const into = row ? joinPath(this.path, row) : this.path;
      // Entries must be read before the event returns; the walk itself can be async.
      const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
      this.uploadDropped(entries, into);
    });
  }

  private async uploadDropped(entries: FileSystemEntry[], into: string) {
    for (const entry of entries) {
      const files: { file: File; rel: string }[] = [];
      const dirs: string[] = [];
      try {
        await walk(entry, "", files, dirs);
      } catch {
        toast(`Couldn't read ${entry.name}.`);
        continue;
      }
      const t = this.track(true, entry.name);
      const total = files.reduce((n, f) => n + f.file.size, 0);
      let index = 0;
      const clashes = new Clashes(() => files.length - index - 1);
      let done = 0;
      let sent = 0;
      let skipped = 0;
      let failed: string | null = null;
      try {
        for (const d of dirs) await api.sftpMkdir(this.host.connId, joinPath(into, d)).catch(() => {});
        for (; index < files.length && !t.cancelled; index++) {
          const { file, rel } = files[index];
          const path = joinPath(into, rel);
          const id = `${t.id}:${index}`;
          let overwrite = false;
          let skip = false;
          for (;;) {
            try {
              await api.sftpUploadBegin(this.host.connId, id, path, overwrite);
              break;
            } catch (e) {
              if (errCode(e) !== "EXISTS") throw e;
              const answer = await clashes.ask(baseName(path), parentPath(path));
              if (answer === "replace") {
                overwrite = true;
                continue;
              }
              if (answer === "cancel") t.cancelled = true;
              skip = true;
              break;
            }
          }
          if (t.cancelled) break;
          if (skip) {
            skipped++;
            done += file.size;
            continue;
          }
          for (let off = 0; off < file.size && !t.cancelled; off += CHUNK) {
            const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
            await api.sftpUploadChunk(id, bytes);
            done += bytes.length;
            t.progress({ done, total, current: rel });
          }
          await api.sftpUploadEnd(id, !t.cancelled);
          if (!t.cancelled) sent++;
        }
      } catch (e) {
        failed = errText(e);
      }
      if (t.cancelled) this.done(t, false, "Cancelled");
      else if (failed) this.done(t, false, failed);
      else this.done(t, true, summary("Uploaded", sent, skipped, entry.isDirectory));
      if (this.path === into || parentPath(into) === this.path) this.navigate(this.path);
      if (failed || t.cancelled) break;
    }
  }
}

function summary(verb: string, files: number, skipped: number, folder: boolean): string {
  const main = folder ? `${verb} ${files} file${files === 1 ? "" : "s"}` : verb;
  return skipped ? `${main}, skipped ${skipped}` : main;
}

/** Collect a dropped file or folder: files with their paths relative to the drop, and folders to create. */
async function walk(entry: FileSystemEntry, prefix: string, files: { file: File; rel: string }[], dirs: string[]) {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    files.push({ file, rel });
    return;
  }
  if (!entry.isDirectory) return;
  dirs.push(rel);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns a batch at a time until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walk(child, rel, files, dirs);
  }
}
