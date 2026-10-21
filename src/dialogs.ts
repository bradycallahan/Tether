import { h } from "./dom";

export interface DialogParts {
  title: string;
  intro?: string | Node;
  body?: Node | Node[];
  foot: Node[];
  footLeft?: Node[];
  wide?: boolean;
  className?: string;
  /** Element to focus once open (defaults to first input). */
  focus?: HTMLElement;
  onSubmit?: () => void;
}

/** Set by a dialog window (dialogwin.ts): the next modal fills that window
 * instead of floating over the page, and is handed over to be sized and shown. */
let windowHost: ((dlg: HTMLDialogElement, title: string) => void) | undefined;

export function hostNextModal(host: (dlg: HTMLDialogElement, title: string) => void) {
  windowHost = host;
}

/**
 * Show a modal. `build` receives `done(value)`; pressing Escape resolves
 * with `undefined`. Returns whatever was passed to `done`.
 */
export function modal<T>(build: (done: (v: T | undefined) => void) => DialogParts): Promise<T | undefined> {
  return new Promise((resolve) => {
    const dlg = h("dialog");
    let settled = false;
    const done = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const parts = build(done);
    if (parts.wide) dlg.classList.add("wide");
    if (parts.className) dlg.classList.add(parts.className);
    const form = h(
      "form",
      {
        method: "dialog",
        onsubmit: (e: Event) => {
          e.preventDefault();
          parts.onSubmit?.();
        },
      },
      h("div", { class: "dlg-head" }, h("h1", {}, parts.title), parts.intro ? (typeof parts.intro === "string" ? h("p", {}, parts.intro) : parts.intro) : null),
      parts.body ? h("div", { class: "dlg-body" }, parts.body) : null,
      h("div", { class: "dlg-foot" }, parts.footLeft ? h("div", { class: "left" }, parts.footLeft) : null, parts.foot),
    );
    dlg.append(form);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(undefined);
    });
    const host = windowHost;
    windowHost = undefined;
    document.body.append(dlg);
    dlg.showModal();
    host?.(dlg, parts.title);
    const target = parts.focus ?? (dlg.querySelector("input:not([type=checkbox]), textarea, select") as HTMLElement | null) ?? (dlg.querySelector(".btn.primary") as HTMLElement | null);
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
  });
}

/** Labeled form row. Only wraps in <label> for a single form control — a
 * <label> around buttons would forward every click to the first button. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const simple = control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement;
  return h(simple ? "label" : "div", { class: "field" }, h("span", {}, label), control, hint ? h("span", { class: "hint" }, hint) : null);
}

export function check(label: string, input: HTMLInputElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "check" }, input, h("span", {}, label), hint ? h("span", { class: "hint" }, hint) : null);
}

export function button(label: string | Node, opts: { kind?: "primary" | "danger" | "ghost" | "danger solid" | "warn"; submit?: boolean; onclick?: () => void; title?: string } = {}) {
  return h(
    "button",
    { type: opts.submit ? "submit" : "button", class: `btn ${opts.kind ?? ""}`, onclick: opts.onclick, title: opts.title },
    label,
  );
}

export async function confirmDialog(o: { title: string; message: string | Node; confirm: string; danger?: boolean; warn?: boolean; cancel?: string }): Promise<boolean> {
  const r = await modal<boolean>((done) => ({
    title: o.title,
    intro: o.message,
    foot: [button(o.cancel ?? "Cancel", { onclick: () => done(false) }), button(o.confirm, { kind: o.danger ? "danger solid" : o.warn ? "warn" : "primary", submit: true })],
    onSubmit: () => done(true),
  }));
  return r === true;
}

export async function alertDialog(title: string, message: string | Node): Promise<void> {
  await modal<boolean>((done) => ({
    title,
    intro: message,
    foot: [button("OK", { kind: "primary", submit: true })],
    onSubmit: () => done(true),
  }));
}

export async function promptText(o: { title: string; label: string; value?: string; placeholder?: string; confirm?: string; intro?: string }): Promise<string | undefined> {
  const input = h("input", { type: "text", value: o.value ?? "", placeholder: o.placeholder ?? "", spellcheck: "false" });
  return modal<string>((done) => ({
    title: o.title,
    intro: o.intro,
    body: field(o.label, input),
    foot: [button("Cancel", { onclick: () => done(undefined) }), button(o.confirm ?? "OK", { kind: "primary", submit: true })],
    onSubmit: () => done(input.value),
  }));
}

export async function promptSecret(o: {
  title: string;
  label: string;
  intro?: string;
  error?: string;
  allowRemember: boolean;
}): Promise<{ value: string; remember: boolean } | undefined> {
  const input = h("input", { type: "password", autocomplete: "off" });
  const remember = h("input", { type: "checkbox", checked: true });
  return modal((done) => ({
    title: o.title,
    intro: o.intro,
    body: [
      h("label", { class: `field ${o.error ? "error" : ""}` }, h("span", {}, o.label), input, o.error ? h("span", { class: "err" }, o.error) : null),
      o.allowRemember ? check("Save in the system keychain", remember) : null,
    ].filter(Boolean) as Node[],
    foot: [button("Cancel", { onclick: () => done(undefined) }), button("Connect", { kind: "primary", submit: true })],
    onSubmit: () => done({ value: input.value, remember: o.allowRemember && remember.checked }),
  }));
}

export async function hostKeyDialog(detail: Record<string, unknown>, changed: boolean): Promise<boolean> {
  const host = String(detail.host);
  const port = Number(detail.port);
  const where = port === 22 ? host : `${host}:${port}`;
  const fp = h("div", { class: "fingerprint" }, String(detail.fingerprint));
  if (!changed) {
    return (await modal<boolean>((done) => ({
      title: `Trust ${where}?`,
      intro: "This is the first time Tether has connected to this host. Compare the fingerprint with the device (show ip ssh / show crypto key mypubkey) before trusting it.",
      body: [
        h("div", { class: "callout" }, h("div", { class: "rowhead" }, `${detail.algorithm ?? "Host"} key fingerprint`), fp),
      ],
      foot: [button("Cancel", { onclick: () => done(false) }), button("Trust and connect", { kind: "primary", submit: true })],
      onSubmit: () => done(true),
    }))) === true;
  }
  return (await modal<boolean>((done) => ({
    title: `The host key for ${where} changed`,
    body: [
      h(
        "div",
        { class: "callout warn" },
        h("strong", {}, "Don't continue unless you expected this. "),
        "A new key usually means the device was replaced, re-imaged, or had its keys regenerated. It can also mean someone is intercepting the connection.",
      ),
      h("div", { class: "callout" }, h("div", { class: "rowhead" }, "Key the device presented"), fp),
    ],
    foot: [
      button("Replace saved key and connect", { kind: "danger", onclick: () => done(true) }),
      button("Cancel", { kind: "primary", submit: true }),
    ],
    onSubmit: () => done(false),
  }))) === true;
}

export async function pasteConfirm(text: string, target: { label: string; many: boolean }): Promise<boolean> {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  const count = lines.length;
  return (await modal<boolean>((done) => ({
    title: `Paste ${count} lines into ${target.label}?`,
    intro: target.many
      ? h("span", { class: "warn-text" }, `Broadcast is on. Every line goes to ${target.label} and runs as soon as it lands.`)
      : "Each line runs as soon as it lands. Check it's going to the right device.",
    body: h("div", { class: "paste-preview" }, lines.slice(0, 200).join("\n") + (count > 200 ? `\n\u2026 ${count - 200} more` : "")),
    foot: [button("Cancel", { onclick: () => done(false) }), button(`Paste ${count} lines`, { kind: target.many ? "warn" : "primary", submit: true })],
    onSubmit: () => done(true),
  }))) === true;
}

// ---------------------------------------------------------------------------
// Toasts

let toastTimer: number | undefined;
export function toast(message: string, opts: { ms?: number; action?: { label: string; run: () => void } } = {}) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, h("span", {}, message),
    opts.action ? h("button", { type: "button", class: "btn ghost", onclick: () => { el.remove(); opts.action!.run(); } }, opts.action.label) : null);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), opts.ms ?? (opts.action ? 6000 : 2600));
}
