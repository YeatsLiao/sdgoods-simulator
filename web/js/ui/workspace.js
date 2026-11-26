import { initialWorkspace, workspaceTransition, droppedFirmware } from "../app/workspace-state.js";

export const COMPACT_WORKSPACE = "(max-width: 800px), (max-width: 960px) and (max-height: 540px)";

const SCREEN_COPY = {
  idle: ["等待你的固件", "打开 BIN，让次元屏亮起来"],
  preparing: ["正在准备固件", "读取、校验并恢复本地数据"],
  starting: ["正在启动设备", "首次使用可能需要准备运行环境"],
  waiting: ["固件已启动", "正在等待屏幕的第一帧"],
  running: ["运行中", ""],
  error: ["暂时无法运行", "查看下方提示，或重新打开固件"],
};

/** Owns layout and progress only; firmware and sessions remain owned by App. */
export function createWorkspace(root, { onFile, onError }) {
  let state = { ...initialWorkspace };
  let dragDepth = 0;
  const byId = (id) => document.getElementById(id);
  const panel = byId("workspace-panel");
  const overlay = byId("drop-overlay");
  let returnFocus = null;
  function syncPanelSurface() {
    const modal = state.open && Boolean(window.matchMedia?.(COMPACT_WORKSPACE).matches);
    panel.setAttribute("role", modal ? "dialog" : "region");
    if (modal) panel.setAttribute("aria-modal", "true");
    else panel.removeAttribute("aria-modal");
    for (const selector of [".app-header", ".welcome", ".device-column"]) {
      const node = root.querySelector(selector);
      if (node) node.inert = modal;
    }
  }
  function restoreFocus() {
    const target = returnFocus?.isConnected && returnFocus.getClientRects().length && !returnFocus.disabled
      ? returnFocus : byId("open-firmware");
    (target?.tagName === "H2" ? byId("open-firmware") : target)?.focus({ preventScroll: true });
  }
  function update(action) {
    state = workspaceTransition(state, action);
    root.dataset.phase = state.phase;
    const statusText = byId("status-text");
    if (statusText) statusText.textContent = ({ idle: "未启动", preparing: "准备中", starting: "启动中", waiting: "等待画面", running: "运行中", error: "异常" })[state.phase];
    root.dataset.panelOpen = String(state.open);
    panel.inert = !state.open;
    panel.hidden = !state.open;
    const dock = byId("dock-open");
    if (dock) dock.setAttribute("aria-expanded", String(state.open && root.dataset.surface === "tools"));
    const dev = byId("dev");
    if (dev) dev.setAttribute("aria-expanded", String(state.open && root.dataset.surface === "tools"));
    syncPanelSurface();
    byId("run-cta").hidden = state.phase === "running";
    const [title, hint] = SCREEN_COPY[state.phase];
    byId("screen-state").textContent = title;
    byId("screen-state-hint").textContent = hint;
    byId("screen").setAttribute("aria-busy", String(["preparing", "starting", "waiting"].includes(state.phase)));
    for (const tab of root.querySelectorAll(".tab")) {
      const selected = state.open && tab.dataset.tab === state.panel;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("is-active", selected);
      tab.tabIndex = selected || (!state.open && tab.dataset.tab === state.panel) ? 0 : -1;
    }
  }
  function close() {
    const restore = panel.contains(document.activeElement);
    update({ type: "close" });
    if (restore) restoreFocus();
  }
  byId("panel-close").addEventListener("click", close);
  root.addEventListener("pointerdown", (event) => {
    if (!state.open || panel.contains(event.target)) return;
    if (root.dataset.surface === "tools") return;
    if (event.target.closest?.("#recent-open, #sound-open, #dev, #settings-open, #setup-open, #help-open, #dock-open, #mobile-recent")) return;
    close();
  });
  root.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape") {
      if (byId("device-more")?.open) byId("device-more").open = false;
      else close();
    }
    if (event.key === "Tab" && panel.getAttribute("aria-modal") === "true") {
      const nodes = [...panel.querySelectorAll("button, input, select, textarea, a[href], summary, [tabindex]")]
        .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  window.addEventListener("resize", syncPanelSurface);
  root.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
  });
  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  root.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  root.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const result = droppedFirmware([...event.dataTransfer.files]);
    if (result.error) onError(result.error);
    else onFile(result.file);
  });
  window.addEventListener("blur", () => { dragDepth = 0; overlay.hidden = true; });
  update({ type: "init" });
  return {
    phase(phase) {
      const hadFocus = state.open && panel.contains(document.activeElement);
      update({ type: "phase", phase });
      if (hadFocus && !state.open) restoreFocus();
    },
    panel(id, title) {
      const opening = !state.open;
      if (opening) returnFocus = document.activeElement;
      if (byId("device-more")) byId("device-more").open = false;
      byId("workspace-panel-title").textContent = title;
      update({ type: "panel", panel: id });
      if (opening) byId("panel-close").focus({ preventScroll: true });
    },
    close,
  };
}

/** Native dialog keeps focus inside the destructive confirmation and supports Escape. */
export function confirmClearData(name) {
  const dialog = document.getElementById("clear-dialog");
  if (dialog.open) return Promise.resolve(false);
  document.getElementById("clear-description").textContent = name;
  const more = document.getElementById("device-more");
  const previous = more?.open ? more.querySelector("summary") : document.activeElement;
  if (more) more.open = false;
  return new Promise((resolve) => {
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => {
      previous?.focus();
      resolve(dialog.returnValue === "clear");
    }, { once: true });
    dialog.showModal();
  });
}
