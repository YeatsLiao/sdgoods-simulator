import { createDock } from "./dock.js";
import { createWorkspace, confirmClearData } from "./workspace.js";
import { createLibraryPanel } from "./library-panel.js";
import { createAudioPanel } from "./audio-panel.js";
import { createSlotsPanel } from "./slots-panel.js";
import { el } from "../shared/dom.js";
import { formatBytes } from "../shared/format.js";
import { button, icon, tabs, toastHost } from "./components.js";

const TAB_DEFS = [
  { id: "library", label: "最近使用", icon: "file" },
  { id: "console", label: "日志", icon: "terminal", devOnly: true },
  { id: "performance", label: "性能", icon: "gauge", devOnly: true },
  { id: "debug", label: "设备", icon: "wrench", devOnly: true },
  { id: "sound", label: "声音", icon: "volume", devOnly: true },
  { id: "settings", label: "设置", icon: "settings", devOnly: true },
  { id: "about", label: "关于", icon: "info", devOnly: true },
];

function applyIcon(node, name) {
  if (!node || node.querySelector("svg.icon")) return;
  const label = node.dataset.label ?? node.textContent.trim();
  const iconOnly = node.classList.contains("btn-icon") || !label;
  node.replaceChildren(icon(name, { size: iconOnly ? 18 : 16 }));
  if (label) node.append(el("span", { class: "btn-label" }, label));
}

/**
 * Build the full simulator shell and return control handles for the app layer.
 * @param {HTMLElement} [root]
 * @returns {object} See docs/ARCHITECTURE.md and the ID map in web/index.html.
 */
export function createUI(root) {
  const app = root ?? document.getElementById("app");
  if (!app) throw new Error("界面缺少 #app 根节点");

  const find = (id) => app.querySelector(`[id="${id}"]`) ?? document.getElementById(id);
  const need = (id) => {
    const node = find(id);
    if (!node) throw new Error(`界面缺少 #${id}`);
    return node;
  };

  const refs = {
    app,
    canvas: need("screen"),
    side: need("side"),
    status: need("status"),
    statusText: need("status-text"),
    firmwareMeta: need("firmware-meta"),
    firmwareName: need("firmware-name"),
    firmwareVersion: need("firmware-version"),
    mode: el("select", { id: "mode", "aria-label": "运行方式" }, el("option", { value: "wasm" }, "浏览器"), el("option", { value: "native", disabled: "" }, "本机加速")),
    dev: need("dev"),
    tabsHost: need("tabs"),
    panelHost: need("panel-host"),
    launcher: need("launcher"),
    launcherOverlay: need("launcher-overlay"),
    launcherList: need("launcher-list"),
    launcherHint: need("launcher-hint"),
    launcherClose: need("launcher-close"),
    restart: need("restart"),
    reset: need("clear-open"),
    mute: button("", { id: "mute", iconOnly: true, ariaLabel: "静音" }),
    volume: el("input", { id: "volume", type: "range", min: "0", max: "100", value: "80", "aria-label": "音量" }),
    screenshot: need("screenshot"),
    record: need("record"),
    fullscreen: need("fullscreen"),
    fileInput: need("file"),
    touchOverlay: need("touch-overlay"),
    touchDot: need("touch-dot"),
    touchReadout: need("touch-readout"),
    errorCard: need("error-card"),
    errorMessage: need("error-message"),
    errorActions: need("error-actions"),
  };

  for (const [node, name] of [
    [refs.launcher, "layers"],
    [refs.restart, "restart"],
    [refs.reset, "trash"],
    [refs.screenshot, "camera"],
    [refs.record, "record"],
    [refs.fullscreen, "expand"],
    [refs.launcherClose, "close"],
    [need("error-close"), "close"],
  ]) {
    applyIcon(node, name);
  }

  applyIcon(need("try-sample"), "play");
  applyIcon(refs.dev, "terminal");

  const dockController = createDock(app);
  for (const [id, name] of [["dock-bottom", "dockBottom"], ["dock-right", "dockRight"], ["dock-max", "expand"], ["sound-open", "settings"]]) applyIcon(find(id), name);

  const workspace = createWorkspace(app, {
    onFile: (file) => dispatchLibrary("file", { file }),
    onError: (message) => toast(message, "warning"),
  });

  const nativeOption = refs.mode.querySelector('option[value="native"]');
  const activePanelIds = new Set();

  let devMode = false;
  let activePanel = "library";
  let hasRun = false;
  let screenReady = false;
  let touchHideTimer = 0;

  const tabController = tabs(
    TAB_DEFS.map(({ id, label, icon: iconName }) => ({ id, label, icon: iconName })),
    { onChange: (id) => showPanel(id), ariaLabel: "模拟器面板" },
  );
  refs.tabsHost.replaceChildren(tabController.element);
  const tabsElement = tabController.element;
  const orientTabs = () => tabsElement.setAttribute("aria-orientation", "horizontal");
  orientTabs();
  window.addEventListener("resize", orientTabs);

  const toastContainer = toastHost();
  document.body.append(toastContainer);

  function dispatchLibrary(action, detail = {}) {
    refs.panelHost.dispatchEvent(
      new CustomEvent("sdg:library", { bubbles: true, detail: { action, ...detail } }),
    );
  }

  function dispatchSlots(action, detail = {}) {
    refs.app.dispatchEvent(
      new CustomEvent("sdg:slots", { bubbles: true, detail: { action, ...detail } }),
    );
  }

  function mountPanel(id, className, ...children) {
    const section = el(
      "section",
      {
        id: `panel-${id}`,
        class: ["panel", className].filter(Boolean).join(" "),
        role: TAB_DEFS.find((item) => item.id === id)?.devOnly ? "tabpanel" : "region",
        "aria-label": TAB_DEFS.find((item) => item.id === id)?.label ?? id,
        hidden: id !== "library",
      },
      ...children,
    );
    activePanelIds.add(id);
    refs.panelHost.append(section);
    return section;
  }

  const { libraryApi, libraryPanel, libraryList, sampleButton, addFileButton, urlInput, urlSha, addUrlButton, urlForm } =
    createLibraryPanel({ mountPanel, dispatchLibrary, openFile: () => refs.fileInput.click(), toast });

  const { slotsApi, launcherApi, slotList, launcherOpenButton, launcherList } =
    createSlotsPanel({ mountPanel, dispatchSlots, refs });

  const { micButton, micMeter, setAudioLevels, setMicActive } = createAudioPanel();
  micButton.remove();
  const resetLayout = button("重置面板布局", { id: "reset-layout" });
  resetLayout.addEventListener("click", () => { dockController.reset(); toast("面板布局已重置", "info"); });
  const currentName = el("p", { id: "settings-firmware-name", class: "settings-filename" }, "尚未打开固件");
  const networkHelp = el("p", { id: "setup-advice", hidden: true, class: "field-hint" }, "模拟器不创建真实热点。空白配置自动连接虚拟 Wi-Fi；仍停留配网时可重新打开 BIN，或确认后清除当前固件数据。云端激活按固件提示完成。");
  const dataGroup = el("section", { class: "settings-group" }, el("h3", {}, "当前固件"), currentName, refs.reset, need("setup-open"), networkHelp);
  const help = el("section", { class: "about-content" }, el("h2", { class: "panel-title" }, "关于次元屏模拟器"),
    el("p", {}, "打开 BIN 或拖入文件开始。触摸圆屏操作；右上侧键可短按或长按，也可按住空格。"),
    el("p", {}, "重启保留设置和进度；清除运行数据会恢复这份固件的初始状态。"),
    el("p", {}, "本机加速通常更流畅，Windows 需要 Ubuntu WSL；浏览器方式无需 WSL，但复杂固件可能更慢。切换方式会重新启动当前固件。"),
    el("p", {}, "开发工具可停靠下方或右侧，拖动分隔线调整尺寸，也可用方向键调整。"),
    el("p", {}, "ESP-EMU 1.1.0 · ESP32-S3。暂不模拟 BLE、NFC 和电池；发布固件前请用实物复测。"),
    el("a", { href: "https://github.com/yeatsliao", target: "_blank", rel: "noreferrer noopener" }, "作者 · yeatsliao"),
    el("a", { href: "https://sdgoods.ai/home.html", target: "_blank", rel: "noreferrer noopener" }, "谷仓官方 · SDGOODS"));
  mountPanel("sound", "panel-sound",
    el("section", { class: "settings-group" }, el("h3", {}, "声音"),
      el("div", { class: "volume-heading" }, el("span", {}, "音量"), el("output", { id: "volume-value", for: "volume" }, "80%")),
      el("div", { class: "speaker-volume" }, refs.mute, refs.volume),
      el("div", { class: "microphone-control" }, micButton), micMeter));
  mountPanel("settings", "panel-settings", dataGroup,
    el("section", { class: "settings-group" }, el("h3", {}, "工作台布局"), resetLayout));
  mountPanel("about", "panel-about", help);


  const sidebarLibrary = find("sidebar-library");
  function placeLibrary() {
    if (!sidebarLibrary) return;
    const target = window.matchMedia?.("(max-width: 800px)").matches ? libraryPanel : sidebarLibrary;
    target.append(libraryList, find("library-busy"));
  }
  placeLibrary();
  window.addEventListener("resize", placeLibrary);
  const sidebarMode = find("sidebar-mode");
  const modeChoices = el("div", { class: "mode-choices", role: "radiogroup", "aria-label": "运行方式" });
  const modeButtons = new Map();
  for (const [value, label] of [["native", "本机加速"], ["wasm", "浏览器"]]) {
    const choice = button(label, { id: `mode-${value}`, className: "mode-choice" });
    choice.setAttribute("role", "radio");
    choice.addEventListener("click", () => {
      if (choice.disabled || refs.mode.value === value) return;
      refs.mode.value = value;
      refs.mode.dispatchEvent(new CustomEvent("change", { bubbles: true }));
    });
    modeButtons.set(value, choice); modeChoices.append(choice);
  }
  modeChoices.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const enabled = [...modeButtons.values()].filter(node => !node.disabled);
    if (!enabled.length) return;
    event.preventDefault(); event.stopPropagation();
    const index = enabled.findIndex(node => node.getAttribute("aria-checked") === "true");
    const target = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1)
      : enabled[(index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + enabled.length) % enabled.length];
    target.focus(); target.click();
  });
  const modeDescription = el("p", { id: "mode-description", class: "mode-description" });
  function describeMode() {
    for (const [value, node] of modeButtons) {
      node.setAttribute("aria-checked", String(refs.mode.value === value));
      node.tabIndex = refs.mode.value === value ? 0 : -1;
      node.disabled = value === "native" && nativeOption.disabled;
      node.title = node.disabled ? "需要本机运行环境；Windows 使用 Ubuntu WSL" : "";
    }
    modeDescription.textContent = refs.mode.value === "native"
      ? "通常更流畅。使用本机运行环境，Windows 需要 Ubuntu WSL。"
      : "直接在浏览器运行，无需 WSL；较复杂的固件可能更慢。";
  }
  refs.mode.addEventListener("change", describeMode);
  if (sidebarMode) { refs.mode.hidden = true; sidebarMode.append(refs.mode, modeChoices, modeDescription); }
  describeMode();

  // Developer panel shells (filled by other modules) ------------------------
  mountPanel(
    "console",
    "panel-console",
    el("div", { class: "console-mount panel-mount", "aria-label": "串口控制台" }),
  );
  mountPanel(
    "performance",
    "panel-performance",
    el("div", { class: "stats-mount panel-mount", "aria-label": "性能指标" }),
  );
  mountPanel(
    "debug",
    "panel-debug",
    ...(sidebarMode ? [] : [el("label", { class: "select-field" }, el("span", {}, "运行方式"), refs.mode)]),
    el("details", { class: "tool-import" }, el("summary", {}, "从链接打开固件"), urlForm),
    el("div", { class: "inspector-mount panel-mount", "aria-label": "设备检查器" }),
    el("div", { class: "macro-mount panel-mount", "aria-label": "输入宏" }),
  );

  // Elements exposed to the app layer --------------------------------------
  const elements = {
    app,
    device: app.querySelector(".device-stage"),
    canvas: refs.canvas,
    side: refs.side,
    status: refs.status,
    statusText: refs.statusText,
    firmwareMeta: refs.firmwareMeta,
    firmwareName: refs.firmwareName,
    firmwareVersion: refs.firmwareVersion,
    mode: refs.mode,
    launcher: refs.launcher,
    slotList,
    launcherOpenButton,
    launcherList,
    tabs: tabsElement,
    tabButtons: tabController.buttons,
    panelHost: refs.panelHost,
    restart: refs.restart,
    reset: refs.reset,
    mute: refs.mute,
    volume: refs.volume,
    screenshot: refs.screenshot,
    record: refs.record,
    fullscreen: refs.fullscreen,
    dev: refs.dev,
    mic: micButton,
    fileInput: refs.fileInput,
    urlInput,
    urlSha,
    addUrlButton,
    sampleButton,
    addFileButton,
    libraryList,
    libraryPanel,
    toastHost: toastContainer,
    errorCard: refs.errorCard,
    consoleMount: refs.panelHost.querySelector(".console-mount"),
    statsMount: refs.panelHost.querySelector(".stats-mount"),
    inspectorMount: refs.panelHost.querySelector(".inspector-mount"),
    macroMount: refs.panelHost.querySelector(".macro-mount"),
  };

  // Status / firmware / mode ------------------------------------------------
  function setStatus(text) {
    const message = text == null ? "" : String(text);
    refs.statusText.textContent = ({ deep: "已关屏", light: "休眠中", suspended: "已关屏", off: "已关机", waking: "开机中" })[app.dataset.power] ?? ({ idle: "未启动", preparing: "准备中", starting: "启动中", waiting: "等待画面", running: "运行中", error: "异常" })[app.dataset.phase] ?? message;
    refs.status.title = message;
    refs.status.classList.toggle("is-idle", !message);
  }

  function setFirmwareInfo(info) {
    const hasInfo = Boolean(info && typeof info === "object");
    refs.firmwareMeta.classList.toggle("has-firmware", hasInfo);
    if (!hasInfo) {
      refs.firmwareName.textContent = "设备预览";
      currentName.textContent = "尚未打开固件";
      refs.firmwareName.removeAttribute("title");
      refs.firmwareVersion.hidden = true;

      return;
    }
    const meta = info.app && typeof info.app === "object" ? info.app : info;
    const name = info.name || meta.project || "固件已载入";
    const version = meta.version && meta.version !== "—" ? meta.version : "";
    const project = meta.project && meta.project !== "—" ? meta.project : "";
    const idf = meta.idf && meta.idf !== "—" ? meta.idf : "";
    refs.firmwareName.textContent = name;
    currentName.textContent = name;
    const details = [name];
    if (project && project !== name) details.push(`工程 ${project}`);
    if (idf) details.push(`IDF ${idf}`);
    if (Number.isFinite(info.size)) details.push(formatBytes(info.size));
    refs.firmwareName.title = details.join("\n");
    if (version) {
      refs.firmwareVersion.textContent = `v${String(version).replace(/^v/i, "")}`;
      refs.firmwareVersion.hidden = false;
    } else {
      refs.firmwareVersion.hidden = true;
    }

  }

  function setNativeAvailable(available) {
    const enabled = Boolean(available);
    nativeOption.disabled = !enabled;
    nativeOption.textContent = "本机加速";
    refs.mode.dataset.nativeAvailable = String(enabled);
    refs.mode.title = enabled
      ? "运行方式：本机加速或浏览器"
      : "本机加速需要 x86-64 Linux 或 Windows 上的 Ubuntu WSL；当前使用浏览器模式";
    if (!enabled && refs.mode.value === "native") refs.mode.value = "wasm";
    describeMode();
  }

  function setMode(mode) {
    const option = [...refs.mode.options].find((item) => item.value === mode && !item.disabled);
    refs.mode.value = option ? option.value : "wasm";
    describeMode();
    return refs.mode.value;
  }

  // Panels / dev mode -------------------------------------------------------
  function showPanel(name) {
    const def = TAB_DEFS.find((item) => item.id === name);
    if (!def) return false;
    if (def.devOnly && !devMode) setDevMode(true);
    if (def.devOnly && !tabController.select(name, { notify: false })) return false;
    app.dataset.surface = def.devOnly ? "tools" : name;
    refs.tabsHost.hidden = !def.devOnly;
    activePanel = name;
    const dock = find("dock-open");
    if (dock) dock.setAttribute("aria-expanded", String(Boolean(def.devOnly)));
    workspace.panel(name, def.devOnly ? "开发工具" : def.label);
    for (const id of activePanelIds) {
      const section = refs.panelHost.querySelector(`#panel-${id}`);
      if (section) section.hidden = id !== name;
    }
    refs.panelHost.scrollTop = 0;
    if (def.devOnly) tabController.buttons.get(name)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  }

  function setDevMode(on) {
    devMode = Boolean(on);
    app.classList.toggle("dev-mode", devMode);
    refs.dev.setAttribute("aria-pressed", String(devMode));
    for (const item of TAB_DEFS) {
      const node = tabController.buttons.get(item.id);
      if (node) node.hidden = !item.devOnly || !devMode;
    }
    if (!devMode && TAB_DEFS.find((item) => item.id === activePanel)?.devOnly) {
      workspace.close();
    }
  }

  // Toasts / errors ---------------------------------------------------------
  function toast(text, kind = "info") {
    const message = String(text ?? "");
    if (!message) return null;
    const tone = ["info", "success", "warning", "error"].includes(kind) ? kind : "info";
    const toneIcon = tone === "success" ? "check" : tone === "info" ? "info" : "alert";
    const node = el(
      "div",
      { class: `toast toast-${tone}` },
      icon(toneIcon, { size: 16 }),
      el("p", { class: "toast-text" }, message),
      el(
        "button",
        { class: "toast-close", type: "button", "aria-label": "关闭提示" },
        icon("close", { size: 14 }),
      ),
    );
    toastContainer.append(node);
    while (toastContainer.children.length > 4) toastContainer.firstElementChild.remove();

    let timer = setTimeout(dismiss, tone === "error" ? 6000 : 4200);
    function dismiss() {
      clearTimeout(timer);
      node.classList.add("is-leaving");
      setTimeout(() => node.remove(), 180);
    }
    node.querySelector(".toast-close").addEventListener("click", dismiss);
    node.addEventListener("mouseenter", () => clearTimeout(timer));
    node.addEventListener("mouseleave", () => {
      timer = setTimeout(dismiss, 2000);
    });
    return node;
  }

  function showError(message, actions = []) {
    if (!message) {
      refs.errorCard.hidden = true;
      return;
    }
    refs.errorMessage.textContent = String(message);
    refs.errorActions.replaceChildren(
      ...actions.map((action, index) =>
        button(action.label ?? "确定", {
          kind: index === 0 ? "primary" : undefined,
          onClick: () => {
            refs.errorCard.hidden = true;
            action.onClick?.();
          },
        }),
      ),
    );
    refs.errorCard.hidden = false;
  }

  // Library panel -----------------------------------------------------------
  // Running / audio states --------------------------------------------------
  function setRecording(recording) {
    const active = Boolean(recording);
    refs.record.setAttribute("aria-pressed", String(active));
    refs.record.classList.toggle("is-active", active);
    refs.record.title = active ? "停止录屏" : "录制页面与声音";
    refs.record.setAttribute("aria-label", active ? "停止录屏" : "开始录屏");
    refs.record.replaceChildren(
      icon(active ? "stop" : "record", { size: 16 }),
      el("span", { class: "btn-label" }, active ? "停止录屏" : "录屏"),
    );
    app.classList.toggle("is-recording", active);
  }

  function setMuted(muted) {
    const active = Boolean(muted);
    refs.mute.setAttribute("aria-pressed", String(active));
    refs.mute.classList.toggle("is-muted", active);
    refs.mute.replaceChildren(icon(active ? "volumeOff" : "volume", { size: 18 }));
    refs.mute.setAttribute("aria-label", active ? "取消静音" : "静音");
    refs.mute.title = active ? "取消静音" : "静音";
    app.classList.toggle("is-muted", active);
  }

  function setVolume(value) {
    const numeric = Number(value);
    const level = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
    const percent = Math.round(level * 100);
    refs.volume.value = String(percent);
    const volumeValue = find("volume-value");
    if (volumeValue) volumeValue.textContent = `${percent}%`;
    refs.volume.style.setProperty("--volume-fill", `${percent}%`);
    refs.volume.setAttribute("aria-valuetext", `${percent}%`);
    return level;
  }

  function updateControlHints() {
    for (const [node, action] of [[refs.restart, "重启设备，保留设置和进度"], [refs.screenshot, "保存截图"], [refs.record, "录制页面与声音"], [refs.fullscreen, "全屏显示"]]) {
      const reason = node.disabled ? "请先打开固件，等待画面就绪" : action;
      if (!(node === refs.record && node.getAttribute("aria-pressed") === "true")) node.title = reason;
      node.setAttribute("aria-description", reason);
    }
  }
  const controls = app.querySelector(".control-bar");
  controls?.addEventListener("pointermove", event => {
    const node = event.target.closest?.("button");
    controls.dataset.hint = node?.disabled ? node.title : "";
  });
  controls?.addEventListener("pointerleave", () => { controls.dataset.hint = ""; });

  function setRunning(running) {
    const active = Boolean(running);
    if (active) {
      hasRun = true;
      launcherApi.hide();
    }
    app.classList.toggle("is-running", active);
    app.classList.toggle("has-run", hasRun);
    refs.restart.disabled = !hasRun;
    refs.reset.disabled = !hasRun;
    refs.screenshot.disabled = !screenReady;
    refs.fullscreen.disabled = !screenReady;
    refs.record.disabled = !active;
    refs.side.disabled = !active;
    updateControlHints();

    if (active) refs.errorCard.hidden = true;
    if (!active) setRecording(false);
  }

  // Error card --------------------------------------------------------------
  need("error-close").addEventListener("click", () => showError(null));

  // Device overlays ---------------------------------------------------------
  function showTouch(x, y) {
    refs.touchDot.style.left = `${(x / 360) * 100}%`;
    refs.touchDot.style.top = `${(y / 360) * 100}%`;
    refs.touchReadout.textContent = `${x}, ${y}`;
    refs.touchOverlay.classList.add("is-visible");
    clearTimeout(touchHideTimer);
    touchHideTimer = setTimeout(() => refs.touchOverlay.classList.remove("is-visible"), 1200);
  }

  function trackPointer(event) {
    const rect = refs.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(359, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * 360)));
    const y = Math.min(359, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * 360)));
    showTouch(x, y);
  }

  refs.canvas.addEventListener("pointermove", trackPointer);
  refs.canvas.addEventListener("pointerdown", trackPointer);
  refs.canvas.addEventListener("pointerleave", () => {
    clearTimeout(touchHideTimer);
    touchHideTimer = setTimeout(() => refs.touchOverlay.classList.remove("is-visible"), 200);
  });

  // Wiring ------------------------------------------------------------------
  need("open-firmware").addEventListener("click", () => refs.fileInput.click());
  need("try-sample").addEventListener("click", () => dispatchLibrary("sample"));
  if (need("recent-open").tagName === "BUTTON") need("recent-open").addEventListener("click", () => sidebarLibrary ? libraryList.scrollIntoView({ block: "nearest" }) : showPanel("library"));
  find("sound-open")?.addEventListener("click", () => showPanel("sound"));
  find("mobile-recent")?.addEventListener("click", () => showPanel("library"));

  find("dock-open")?.addEventListener("click", () => {
    if (app.dataset.panelOpen === "true" && app.dataset.surface === "tools") workspace.close();
    else app.dispatchEvent(new CustomEvent("sdg:tools", { bubbles: true }));
  });

  need("setup-open").addEventListener("click", () => { networkHelp.hidden = !networkHelp.hidden; });
  refs.launcherClose.addEventListener("click", () => dispatchSlots("close-launcher"));
  refs.volume.addEventListener("input", () => {
    const percent = Number(refs.volume.value) || 0;
    refs.volume.style.setProperty("--volume-fill", `${percent}%`);
    refs.volume.setAttribute("aria-valuetext", `${percent}%`);
    find("volume-value").textContent = `${percent}%`;
  });

  // Initial state -----------------------------------------------------------
  setRunning(false);
  setMuted(false);
  setVolume(0.8);
  setMicActive(false);
  setDevMode(false);
  showPanel("library");
  workspace.close();
  setStatus(refs.statusText.textContent || "等待载入固件");
  setAudioLevels({ out: 0, in: 0 });

  return {
    elements,
    setStatus,
    toggleTools() {
      if (app.dataset.panelOpen === "true" && app.dataset.surface === "tools") { workspace.close(); return true; }
      return false;
    },
    setPhase(phase) {
      if (phase === "preparing") { need("setup-open").hidden = true; networkHelp.hidden = true; }
      workspace.phase(phase);
      screenReady = phase === "running";
      refs.screenshot.disabled = !screenReady;
      refs.fullscreen.disabled = !screenReady;
      updateControlHints();
    },
    confirmClear: confirmClearData,
    setMode,
    setFirmwareInfo,
    setNativeAvailable,
    showPanel,
    showSetupHelp() {
      need("setup-open").hidden = false;
      // Provisioning never opens a panel or steals focus. Help stays in settings.
    },
    setDevMode,
    toast,
    library: libraryApi,
    slots: slotsApi,
    launcher: launcherApi,
    setRunning,
    setPower(state) {
      app.dataset.power = state;
      const dark = state !== "on";
      refs.screenshot.disabled = dark || !screenReady;
      refs.record.disabled = dark || !app.classList.contains("is-running");
      setStatus(dark ? "按侧键唤醒，重启保留数据" : "运行中");
    },
    setRecording,
    setMuted,
    setVolume,
    setAudioLevels,
    setMicActive,
    showError,
  };
}
