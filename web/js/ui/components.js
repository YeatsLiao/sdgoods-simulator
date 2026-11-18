import { el } from "../shared/dom.js";

export { el };

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inline stroke icons; paths are static project data, never user input. */
const ICONS = {
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  restart: '<path d="M20 11a8 8 0 1 0-.7 4.5"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6.5 7l.8 11.2A1.8 1.8 0 0 0 9.1 20h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7"/><path d="M10 11v5M14 11v5"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/>',
  volumeOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  camera: '<path d="M4 8.5h3l1.8-2.8h6.4L17 8.5h3V19H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  record: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  stop: '<circle cx="12" cy="12" r="7"/><rect x="8.8" y="8.8" width="6.4" height="6.4" rx="1" fill="currentColor" stroke="none"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
  link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5v4h4"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4.5 20h15"/>',
  star: '<path d="M12 3.8l2.5 5.1 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="M8 10l3 2.5L8 15M13.5 15H16"/>',
  gauge: '<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="M12 15.5l4-4.5"/><circle cx="12" cy="16" r="1.4"/>',
  wrench: '<path d="M14.8 6.2a4 4 0 0 0-5 5L4.5 16.5V20h3.5l5.3-5.3a4 4 0 0 0 5-5l-2.6 2.6-2.4-2.4z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  mic: '<path d="M9 5.5a3 3 0 0 1 6 0v5.5a3 3 0 0 1-6 0z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21M9 21h6"/>',
  alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.2M12 17.2h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5.5 15V6a2 2 0 0 1 2-2h9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  layers: '<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 12.5l8 4.5 8-4.5"/><path d="M4 16.5l8 4.5 8-4.5"/>',
};

/**
 * Build an inline SVG icon.
 * @param {keyof typeof ICONS | string} name
 * @param {{ size?: number, className?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 18, className = "" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  for (const token of className.split(/\s+/).filter(Boolean)) svg.classList.add(token);
  svg.innerHTML = ICONS[name] ?? ICONS.info;
  return svg;
}

/**
 * @param {string} label Visible label, also used as accessible name for icon-only buttons.
 * @param {{
 *   id?: string, kind?: "primary"|"ghost"|"danger"|"subtle",
 *   iconName?: string, iconOnly?: boolean, title?: string, ariaLabel?: string,
 *   onClick?: (event: MouseEvent) => void, className?: string,
 *   disabled?: boolean, type?: "button"|"submit"
 * }} [options]
 */
export function button(label, options = {}) {
  const {
    id, kind, iconName, iconOnly = false, title, ariaLabel,
    onClick, className = "", disabled = false, type = "button",
  } = options;
  const classes = ["btn"];
  if (kind) classes.push(`btn-${kind}`);
  if (iconOnly) classes.push("btn-icon");
  if (className) classes.push(...className.split(/\s+/).filter(Boolean));

  const props = { class: classes.join(" "), type };
  if (id) props.id = id;
  const accessibleName = ariaLabel ?? (iconOnly ? label : undefined);
  if (accessibleName) props["aria-label"] = accessibleName;
  const accessibleTitle = title ?? (iconOnly ? label : undefined);
  if (accessibleTitle) props.title = accessibleTitle;

  const node = el("button", props);
  if (iconName) node.append(icon(iconName, { size: iconOnly ? 18 : 16 }));
  if (!iconOnly && label) node.append(el("span", { class: "btn-label" }, label));
  if (disabled) node.disabled = true;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** Replace the text of a button without destroying its icon. */
export function setButtonLabel(node, text) {
  const label = node.querySelector(".btn-label");
  if (label) {
    label.textContent = text;
    return;
  }
  node.setAttribute("aria-label", text);
  node.setAttribute("title", text);
}

/**
 * @param {{
 *   title?: string, subtitle?: string, eyebrow?: string,
 *   actions?: Node|Node[], className?: string, children?: Node|Node[]|string
 * }} [options]
 */
export function card({ title, subtitle, eyebrow, actions, className = "", children } = {}) {
  const hasHead = Boolean(title || subtitle || eyebrow || actions);
  const head = hasHead
    ? el(
        "header",
        { class: "card-head" },
        el(
          "div",
          { class: "card-heading" },
          eyebrow ? el("p", { class: "card-eyebrow" }, eyebrow) : null,
          title ? el("h3", { class: "card-title" }, title) : null,
          subtitle ? el("p", { class: "card-subtitle" }, subtitle) : null,
        ),
        actions ? el("div", { class: "card-actions" }, Array.isArray(actions) ? actions : [actions]) : null,
      )
    : null;
  return el(
    "article",
    { class: ["card", className].filter(Boolean).join(" ") },
    head,
    el("div", { class: "card-body" }, Array.isArray(children) ? children : [children]),
  );
}

/** @param {{ label?: string, hint?: string, control: Node, id?: string, className?: string }} options */
export function field({ label, hint, control, id, className = "" } = {}) {
  const props = { class: ["field", className].filter(Boolean).join(" ") };
  if (id) props.for = id;
  return el(
    "label",
    props,
    label ? el("span", { class: "field-label" }, label) : null,
    control,
    hint ? el("span", { class: "field-hint" }, hint) : null,
  );
}

/** Small status/kind pill. */
export function chip(text, { kind, className = "" } = {}) {
  return el(
    "span",
    { class: ["chip", kind ? `chip-${kind}` : "", className].filter(Boolean).join(" ") },
    text,
  );
}

/**
 * Accessible tab bar. Hidden buttons are skipped by keyboard navigation.
 * @param {{ id: string, label: string, icon?: string }[]} items
 * @param {{ onChange?: (id: string) => void, ariaLabel?: string }} [options]
 */
export function tabs(items, { onChange, ariaLabel = "面板" } = {}) {
  const element = el("nav", { class: "tabs", role: "tablist", "aria-label": ariaLabel, "aria-orientation": "horizontal" });
  const buttons = new Map();
  let active = null;

  for (const item of items) {
    const node = el(
      "button",
      {
        id: `tab-${item.id}`,
        class: "tab",
        type: "button",
        role: "tab",
        "aria-controls": `panel-${item.id}`,
        "aria-selected": "false",
        tabindex: "-1",
        dataset: { tab: item.id },
      },
      icon(item.icon ?? "info", { size: 17 }),
      el("span", { class: "tab-label" }, item.label),
    );
    node.addEventListener("click", () => select(item.id));
    buttons.set(item.id, node);
    element.append(node);
  }

  /**
   * @param {string} id
   * @param {{ notify?: boolean, focus?: boolean }} [options]
   */
  function select(id, { notify = true, focus = false } = {}) {
    const node = buttons.get(id);
    if (!node || node.hidden) return false;
    active = id;
    for (const [key, other] of buttons) {
      const selected = key === id;
      other.classList.toggle("is-active", selected);
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
    }
    if (focus) node.focus();
    if (notify) onChange?.(id);
    return true;
  }

  element.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const visible = [...buttons.values()].filter((node) => !node.hidden);
    if (!visible.length) return;
    event.preventDefault();
    const current = visible.findIndex((node) => node.classList.contains("is-active"));
    let index;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = visible.length - 1;
    else index = (current + (event.key === "ArrowRight" ? 1 : -1) + visible.length) % visible.length;
    select(visible[index].dataset.tab, { focus: true });
  });

  return {
    element,
    buttons,
    select,
    get active() {
      return active;
    },
  };
}

/** Toast container; callers append `.toast` nodes. */
export function toastHost() {
  return el("div", {
    id: "toast-host",
    class: "toast-host",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "false",
  });
}

/**
 * Horizontal level meter returning an updater for 0..1 values.
 * @param {{ label?: string, id?: string }} [options]
 */
export function meter({ label, id } = {}) {
  const fill = el("span", { class: "meter-fill" });
  const value = el("span", { class: "meter-value", "aria-hidden": "true" }, "0%");
  const node = el(
    "div",
    { class: "meter", id },
    label ? el("span", { class: "meter-label" }, label) : null,
    el("div", { class: "meter-track" }, fill),
    value,
  );
  /** @param {number} level 0..1 */
  function set(level) {
    const value01 = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
    fill.style.width = `${(value01 * 100).toFixed(1)}%`;
    value.textContent = `${Math.round(value01 * 100)}%`;
    node.dataset.level = value01.toFixed(2);
  }
  return { el: node, set };
}
