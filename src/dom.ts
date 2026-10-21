type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/** Tiny hyperscript helper: h("button", { class: "x", onclick }, "Save"). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (k === "style" && typeof v === "object") {
      Object.assign(el.style, v);
    } else if (k === "value" || k === "checked" || k === "selected" || k === "disabled" || k === "hidden") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function icon(name: keyof typeof ICONS, label?: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", label ? "false" : "true");
  if (label) svg.setAttribute("aria-label", label);
  svg.classList.add("icon");
  svg.innerHTML = ICONS[name];
  return svg;
}

const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  lock: `<path ${S} d="M3.5 7.5h9v6h-9zM5.5 7.5V5a2.5 2.5 0 015 0v2.5"/>`,
  plus: `<path ${S} d="M8 3v10M3 8h10"/>`,
  close: `<path ${S} d="M4 4l8 8M12 4l-8 8"/>`,
  gear: `<circle ${S} cx="8" cy="8" r="2.2"/><path ${S} d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>`,
  folder: `<path ${S} d="M2 4.5h4l1.3 1.5H14v6.5H2z"/>`,
  chevron: `<path ${S} d="M6 4l4 4-4 4"/>`,
  broadcast: `<path ${S} d="M2.5 8h6M6.5 5l3 3-3 3M11 3.5v9M13.5 5v6"/>`,
  tile: `<path ${S} d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z"/>`,
  search: `<circle ${S} cx="7" cy="7" r="4"/><path ${S} d="M10 10l3.5 3.5"/>`,
  log: `<path ${S} d="M4 2.5h6l2.5 2.5v8.5H4zM6 7h4.5M6 9.5h4.5M6 12h3"/>`,
  edit: `<path ${S} d="M10.5 2.5l3 3-7.5 7.5H3v-3z"/>`,
  terminal: `<path ${S} d="M2.5 3h11v10h-11zM5 6.5l2 1.5-2 1.5M8.5 10H11"/>`,
  plug: `<path ${S} d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 01-7 0zM8 11.5V14"/>`,
  import: `<path ${S} d="M8 2v8M5 7l3 3 3-3M3 12.5h10"/>`,
  command: `<path ${S} d="M3 4l3 3-3 3M7.5 11H13"/>`,
  up: `<path ${S} d="M4 10l4-4 4 4"/>`,
  down: `<path ${S} d="M4 6l4 4 4-4"/>`,
  trash: `<path ${S} d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>`,
  bolt: `<path ${S} d="M9 1.5L4 9h4l-1 5.5L12 7H8z"/>`,
  sidebar: `<path ${S} d="M2.5 3h11v10h-11zM6.5 3v10"/>`,
  refresh: `<path ${S} d="M13 8.5A5 5 0 1 1 11.6 4.6M13 2.5v3h-3"/>`,
  unplug: `<path ${S} d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 01-7 0zM8 11.5V14M2.5 2.5l11 11"/>`,
  clone: `<path ${S} d="M2.5 5.5h7v8h-7zM5.5 5.5V2.5h8v8h-4"/>`,
  copy: `<path ${S} d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3"/>`,
  paste: `<path ${S} d="M5.5 3H3.5v10.5h9V3h-2M6 2h4v2.2H6z"/>`,
  sliders: `<path ${S} d="M2.5 4.5h3M8.5 4.5h5M2.5 11.5h7M12.5 11.5h1"/><circle ${S} cx="7" cy="4.5" r="1.5"/><circle ${S} cx="11" cy="11.5" r="1.5"/>`,
  keyboard: `<path ${S} d="M1.5 4.5h13v7h-13zM5 9.5h6"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 7h.01M6.7 7h.01M9.4 7h.01M12 7h.01"/>`,
  info: `<circle ${S} cx="8" cy="8" r="6"/><path ${S} d="M8 7.2V11"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8 5h.01"/>`,
  help: `<circle ${S} cx="8" cy="8" r="6"/><path ${S} d="M6.3 6.3a1.8 1.8 0 113 1.3c-.7.4-1.3.8-1.3 1.6"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8 11.3h.01"/>`,
  folderPlus: `<path ${S} d="M2 4.5h4l1.3 1.5H14v6.5H2zM8 7.5v4M6 9.5h4"/>`,
  more: `<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M3.5 8h.01M8 8h.01M12.5 8h.01"/>`,
  clock: `<circle ${S} cx="8" cy="8" r="6"/><path ${S} d="M8 4.8V8l2.2 1.5"/>`,
  serial: `<path ${S} d="M1.8 5.5h12.4l-1.6 5.5H3.4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 8.2h.01M8 8.2h.01M11 8.2h.01"/>`,
  fullscreen: `<path ${S} d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>`,
  play: `<path ${S} d="M5 3.5l7 4.5-7 4.5z"/>`,
  check: `<path ${S} d="M3 8.5l3 3 7-7"/>`,
  eraser: `<path ${S} d="M6 13.5h7.5M3.2 9.8l5.6-5.6a1.4 1.4 0 012 0l2 2a1.4 1.4 0 010 2l-5.4 5.3H5.3z"/>`,
  palette: `<path ${S} d="M8 2a6 6 0 100 12c.9 0 1.3-.7.9-1.5-.4-.9.2-1.7 1.1-1.7H12a2 2 0 002-2.1C13.9 5 11.3 2 8 2z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5.2 7.2h.01M7.3 4.9h.01M10.3 5.3h.01"/>`,
  buttons: `<path ${S} d="M1.5 5.5h3.6v5H1.5zM6.2 5.5h3.6v5H6.2zM10.9 5.5h3.6v5h-3.6z"/>`,
  highlight: `<path ${S} d="M2.5 13.5h11M5 11l1-3 5-5 2 2-5 5z"/>`,
};
