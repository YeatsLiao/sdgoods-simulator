export const DEFAULT_DOCK = Object.freeze({ position: "bottom", height: 310, width: 430 });

/** Clamp persisted/user input before it affects the workspace geometry. */
export function dockGeometry(value = {}, viewport = { width: 1440, height: 900 }) {
  const number = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
  const clamp = (n, min, max) => Math.min(Math.max(min, max), Math.max(min, n));
  return {
    position: value.position === "right" ? "right" : "bottom",
    height: clamp(number(value.height, 310), 210, Math.min(540, viewport.height * .6)),
    width: clamp(number(value.width, 430), 320, Math.min(680, viewport.width * .45)),
  };
}

/** IDE-style geometry only; opening panels and running firmware remain outside. */
export function createDock(root) {
  const byId = id => document.getElementById(id);
  const handle = byId("dock-resize");
  if (!handle) return { reset() {} };
  const key = "sdg:workbench:dock:v1";
  let prefs = { ...DEFAULT_DOCK }, maximized = false, drag = null;
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(key) || "{}") }; } catch {}
  const viewport = () => ({ width: innerWidth, height: innerHeight });
  function save() { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch {} }
  function render() {
    const geometry = dockGeometry(prefs, viewport());
    root.dataset.dock = geometry.position;
    root.dataset.dockMax = String(maximized);
    root.style.setProperty("--dock-height", `${geometry.height}px`);
    root.style.setProperty("--dock-width", `${geometry.width}px`);
    handle.setAttribute("aria-orientation", geometry.position === "right" ? "vertical" : "horizontal");
    handle.setAttribute("aria-valuemin", geometry.position === "right" ? "320" : "210");
    handle.setAttribute("aria-valuemax", String(geometry.position === "right" ? Math.max(320, Math.min(680, innerWidth * .45)) : Math.max(210, Math.min(540, innerHeight * .6))));
    handle.setAttribute("aria-valuenow", String(Math.round(geometry.position === "right" ? geometry.width : geometry.height)));
    for (const position of ["bottom", "right"]) byId(`dock-${position}`).setAttribute("aria-pressed", String(position === geometry.position));
    byId("dock-max").setAttribute("aria-pressed", String(maximized));
    byId("dock-max").title = maximized ? "还原面板" : "最大化面板";
  }
  for (const position of ["bottom", "right"]) byId(`dock-${position}`).addEventListener("click", () => { prefs.position = position; maximized = false; save(); render(); });
  byId("dock-max").addEventListener("click", () => { maximized = !maximized; render(); });
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || maximized) return;
    const geometry = dockGeometry(prefs, viewport());
    drag = { x: event.clientX, y: event.clientY, ...geometry };
    handle.setPointerCapture(event.pointerId);
    root.classList.add("is-resizing");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", event => {
    if (!drag) return;
    const value = drag.position === "right" ? { width: drag.width + drag.x - event.clientX } : { height: drag.height + drag.y - event.clientY };
    prefs = dockGeometry({ ...prefs, ...value }, viewport());
    render();
  });
  function finish() { if (!drag) return; drag = null; root.classList.remove("is-resizing"); save(); }
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, finish);
  window.addEventListener("blur", finish);
  handle.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const geometry = dockGeometry(prefs, viewport()), amount = event.shiftKey ? 40 : 16;
    const delta = ["ArrowLeft", "ArrowUp"].includes(event.key) ? amount : -amount;
    prefs = { ...prefs, [geometry.position === "right" ? "width" : "height"]: (geometry.position === "right" ? geometry.width : geometry.height) + delta };
    prefs = dockGeometry(prefs, viewport()); save(); render();
  });
  window.addEventListener("resize", render);
  render();
  return { reset() { prefs = { ...DEFAULT_DOCK }; maximized = false; save(); render(); } };
}
