import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { HighlightRule } from "./types";

interface Compiled {
  re: RegExp;
  fg?: string;
  bg?: string;
}

export function compileRules(rules: HighlightRule[]): Compiled[] {
  const out: Compiled[] = [];
  for (const r of rules) {
    if (!r.pattern) continue;
    const src = r.regex ? r.pattern : r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      out.push({
        re: new RegExp(src, r.caseSensitive ? "g" : "gi"),
        fg: normalizeColor(r.foreground),
        bg: normalizeColor(r.background),
      });
    } catch {
      // Invalid user regex: skip it; the editor shows the error.
    }
  }
  return out;
}

function normalizeColor(c?: string | null): string | undefined {
  if (!c) return undefined;
  return /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
}

/**
 * Keyword highlighting that never touches the byte stream. Instead of
 * rewriting escape sequences (which breaks colored prompts and splits across
 * chunks), we read lines back out of xterm's buffer after they're drawn and
 * lay decorations over the matches.
 */
export class Highlighter implements IDisposable {
  private rules: Compiled[] = [];
  private cursorMarker: IMarker | null = null;
  private pending: IDisposable[] = [];
  private scheduled = false;
  enabled = true;

  constructor(private term: Terminal) {}

  setRules(rules: HighlightRule[]) {
    this.rules = compileRules(rules);
  }

  /** Call after each write completes. Work is batched per animation frame. */
  schedule() {
    if (this.scheduled || !this.enabled || this.rules.length === 0) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.scan();
    });
  }

  private scan() {
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") return; // full-screen apps redraw constantly
    const end = buf.baseY + buf.cursorY;
    let start = this.cursorMarker && !this.cursorMarker.isDisposed && this.cursorMarker.line >= 0 ? this.cursorMarker.line : end;
    if (end - start > 3000) start = end - 3000; // huge paste: only the tail
    for (const d of this.pending) d.dispose();
    this.pending = [];
    for (let y = start; y <= end; y++) {
      const decos = this.decorateLine(y, end);
      if (y === end) this.pending = decos;
    }
    this.cursorMarker?.dispose();
    this.cursorMarker = this.term.registerMarker(0) ?? null;
  }

  private decorateLine(y: number, cursorLine: number): IDecoration[] {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return [];
    const text = line.translateToString(true);
    if (!text.trim()) return [];
    const made: IDecoration[] = [];
    const offset = y - cursorLine;
    for (const rule of this.rules) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = rule.re.exec(text)) && guard++ < 200) {
        if (m[0].length === 0) {
          rule.re.lastIndex++;
          continue;
        }
        const marker = this.term.registerMarker(offset);
        if (!marker) continue;
        const deco = this.term.registerDecoration({
          marker,
          x: m.index,
          width: m[0].length,
          foregroundColor: rule.fg,
          backgroundColor: rule.bg,
          layer: "top",
        });
        if (deco) {
          deco.onDispose(() => marker.dispose());
          made.push(deco);
        } else {
          marker.dispose();
        }
      }
    }
    return made;
  }

  clear() {
    for (const d of this.pending) d.dispose();
    this.pending = [];
    this.cursorMarker?.dispose();
    this.cursorMarker = null;
  }

  dispose() {
    this.clear();
  }
}
