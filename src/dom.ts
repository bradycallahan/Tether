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
};
