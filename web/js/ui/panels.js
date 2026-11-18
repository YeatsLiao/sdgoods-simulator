import { el } from "../shared/dom.js";
import { formatBytes } from "../shared/format.js";
import { button, chip, icon, meter, setButtonLabel, tabs, toastHost } from "./components.js";

const TAB_DEFS = [
  { id: "library", label: "固件库", icon: "chip" },
  { id: "console", label: "串口", icon: "terminal", devOnly: true },
  { id: "performance", label: "性能", icon: "gauge", devOnly: true },
  { id: "audio", label: "音频", icon: "volume" },
  { id: "debug", label: "调试", icon: "wrench", devOnly: true },
  { id: "about", label: "关于", icon: "info" },
];

const KIND_LABELS = { sample: "示例", file: "本地文件", url: "链接", market: "市场" };

function relativeTime(time) {
  if (!Number.isFinite(time) || time <= 0) return "";
  const delta = Date.now() - time;
  if (delta < 60_000) return "刚刚使用";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

function sourceText(entry) {
  if (entry.kind === "sample") return "内置示例 · /demo.bin";
  if (entry.kind === "market") return "官方市场占位，暂不可运行";
  return entry.source || "来源未知";
}

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
    mode: need("mode"),
    dev: need("dev"),
    share: need("share"),
    tabsHost: need("tabs"),
    panelHost: need("panel-host"),
    launcher: need("launcher"),
    launcherOverlay: need("launcher-overlay"),
    launcherList: need("launcher-list"),
    launcherHint: need("launcher-hint"),
    launcherClose: need("launcher-close"),
    run: need("run"),
    restart: need("restart"),
    reset: need("reset"),
    mute: need("mute"),
    volume: need("volume"),
    screenshot: need("screenshot"),
    record: need("record"),
    fullscreen: need("fullscreen"),
    fileInput: need("file"),
    runCta: need("run-cta"),
    runCtaButton: need("run-cta-button"),
    touchOverlay: need("touch-overlay"),
    touchDot: need("touch-dot"),
    touchReadout: need("touch-readout"),
    onboarding: need("onboarding"),
    onboardingNative: need("onboarding-native"),
    errorCard: need("error-card"),
    errorMessage: need("error-message"),
    errorActions: need("error-actions"),
  };

  for (const [node, name] of [
    [refs.launcher, "layers"],
    [refs.run, "play"],
    [refs.restart, "restart"],
    [refs.reset, "trash"],
    [refs.screenshot, "camera"],
    [refs.record, "record"],
    [refs.fullscreen, "expand"],
    [refs.share, "link"],
    [refs.launcherClose, "close"],
    [need("onboarding-close"), "close"],
    [need("error-close"), "close"],
  ]) {
    applyIcon(node, name);
  }

  const nativeOption = refs.mode.querySelector('option[value="native"]');
  const activePanelIds = new Set();

  let devMode = false;
  let activePanel = "library";
  let hasRun = false;
  let busyFlag = false;
  let onboardingOpen = false;
  let onboardingReturnFocus = null;
  let touchHideTimer = 0;

  const tabController = tabs(
    TAB_DEFS.map(({ id, label, icon: iconName }) => ({ id, label, icon: iconName })),
    { onChange: (id) => showPanel(id), ariaLabel: "模拟器面板" },
  );
  refs.tabsHost.replaceChildren(tabController.element);
  const tabsElement = tabController.element;

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

  function dispatchOnboarding(action) {
    refs.onboarding.dispatchEvent(
      new CustomEvent("sdg:onboarding", { bubbles: true, detail: { action } }),
    );
  }

  function mountPanel(id, className, ...children) {
    const section = el(
      "section",
      {
        id: `panel-${id}`,
        class: ["panel", className].filter(Boolean).join(" "),
        role: "tabpanel",
        "aria-labelledby": `tab-${id}`,
        hidden: id !== "library",
      },
      ...children,
    );
    activePanelIds.add(id);
    refs.panelHost.append(section);
    return section;
  }

  // Library panel -----------------------------------------------------------
  const sampleButton = button("运行示例", { id: "library-sample", kind: "primary", iconName: "play" });
  const addFileButton = button("选择本地文件", { id: "library-file", iconName: "upload" });
  const urlInput = el("input", {
    id: "url",
    class: "text-input",
    type: "url",
    inputmode: "url",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "https://example.com/firmware.bin",
    "aria-label": "固件链接",
  });
  const urlSha = el("input", {
    id: "url-sha",
    class: "text-input",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "粘贴 64 位十六进制 SHA-256",
    "aria-label": "固件 SHA-256 校验值（可选）",
  });
  const addUrlButton = button("添加链接", { id: "url-add", iconName: "plus", type: "submit" });
  const urlForm = el(
    "form",
    { class: "url-form", novalidate: "" },
    el("div", { class: "url-row" }, urlInput, addUrlButton),
    el(
      "details",
      { class: "url-advanced" },
      el("summary", {}, "粘贴 SHA-256 校验（可选）"),
      el("div", { class: "url-sha-row" }, urlSha),
    ),
    el("p", { class: "field-hint" }, "支持 http(s) 链接；目标服务器需允许跨域（CORS）。"),
  );

  const libraryBusy = el(
    "div",
    { id: "library-busy", class: "library-busy", hidden: "" },
    el("span", { class: "spinner", "aria-hidden": "true" }),
    el("span", {}, "正在读取并校验固件…"),
  );

  const marketCard = el(
    "div",
    {
      class: "market-card",
      "aria-disabled": "true",
      title: "官方市场接入将在后续版本提供",
    },
    el("span", { class: "market-icon" }, icon("lock", { size: 18 })),
    el(
      "div",
      { class: "market-copy" },
      el("strong", {}, "官方市场"),
      el("span", {}, "接入官方固件市场将在后续版本提供。本轮支持示例、本地文件与链接。"),
    ),
    chip("即将上线"),
  );

  const libraryList = el(
    "div",
    { id: "library-list", class: "library-list" },
    el("p", { class: "library-empty" }, "固件会显示在这里。可以先运行示例或添加本地文件。"),
  );

  const libraryPanel = mountPanel(
    "library",
    "panel-library",
    el(
      "div",
      { class: "panel-head" },
      el("p", { class: "eyebrow" }, "本机固件"),
      el("h2", { class: "panel-title" }, "固件库"),
      el(
        "p",
        { class: "panel-subtitle" },
        "运行内置示例、本地 BIN 或链接。固件只在本机加载并缓存，不会上传到服务器。",
      ),
    ),
    el("div", { class: "source-actions" }, sampleButton, addFileButton),
    urlForm,
    libraryBusy,
    marketCard,
    libraryList,
  );

  // OTA slot panel ----------------------------------------------------------
  const launcherOpenButton = button("打开启动器", { id: "launcher-open", iconName: "layers" });
  const slotsStatus = el("p", { id: "slots-status", class: "slots-status" }, "正在读取平台分区表…");
  const slotList = el("div", { id: "slot-list", class: "slot-list" });

  mountPanel(
    "slots",
    "panel-slots",
    el(
      "div",
      { class: "panel-head" },
      el("p", { class: "eyebrow" }, "多应用槽"),
      el("h2", { class: "panel-title" }, "应用槽"),
      el(
        "p",
        { class: "panel-subtitle" },
        "模拟官方平台的 4 个 OTA 槽（ota_0..ota_3）：把固件库里的纯 app 包装入任意空槽，再从槽启动。槽分配保存在本机，刷新页面后仍保留。",
      ),
    ),
    el("div", { class: "slots-actions" }, launcherOpenButton, chip("官方 launcher UI 未运行", { className: "slot-mode-chip" })),
    slotsStatus,
    slotList,
    el(
      "p",
      { class: "panel-note" },
      "启动槽会按官方分区表拼出完整 Flash（官方 bootloader + 分区表 + otadata + 空 NVS 预置），由 bootloader 从对应槽启动。这里只模拟槽机制与启动流程，官方启动器界面仍由真机或后续平台镜像提供；整机镜像不能装入槽。",
    ),
  );

  function slotCard(slot, model) {
    const index = slot.slotIndex;
    const app = slot.app;
    const running = model.runningSlot === index;
    const selected = model.selected === index;
    const tags = [];
    if (running) tags.push(chip("运行中", { kind: "success" }));
    else if (selected) tags.push(chip("上次启动"));

    const picker = el("select", {
      class: "slot-select",
      "aria-label": `选择要装入 OTA${index} 的固件`,
    });
    picker.append(el("option", { value: "" }, "从固件库选择纯 app 包…"));
    for (const entry of model.entries ?? []) {
      if (entry.kind === "market") continue;
      const version = entry.version ? ` · v${entry.version}` : "";
      picker.append(el("option", { value: entry.id }, `${entry.name}${version}`));
    }

    const assign = button("装入", {
      iconName: "upload",
      className: "slot-assign",
      disabled: model.busy || !(model.entries ?? []).some((entry) => entry.kind !== "market"),
    });
    assign.addEventListener("click", () => {
      if (!picker.value) {
        toast("请先选择一个固件条目", "warning");
        picker.focus();
        return;
      }
      dispatchSlots("assign", { slotIndex: index, entryId: picker.value });
    });

    const launch = button("启动", {
      kind: "primary",
      iconName: "play",
      className: "slot-launch",
      disabled: !app || model.busy,
    });
    launch.addEventListener("click", () => dispatchSlots("launch", { slotIndex: index }));

    const clear = button("清空", {
      iconName: "trash",
      className: "slot-clear",
      disabled: !app || model.busy,
    });
    clear.addEventListener("click", () => dispatchSlots("clear", { slotIndex: index }));

    const meta = [];
    if (app) {
      if (app.version) meta.push(`v${app.version}`);
      if (app.project) meta.push(app.project);
      if (app.size) meta.push(formatBytes(app.size));
    } else {
      meta.push("空槽");
    }
    if (slot.offset !== null && slot.offset !== undefined) {
      meta.push(`0x${slot.offset.toString(16).toUpperCase()}`);
    }
    if (slot.size) meta.push(formatBytes(slot.size));

    return el(
      "article",
      {
        class: ["slot-card", app ? "is-filled" : "is-empty", running ? "is-running" : ""]
          .filter(Boolean)
          .join(" "),
        dataset: { slot: String(index) },
      },
      el(
        "div",
        { class: "slot-card-head" },
        el(
          "div",
          { class: "slot-title-row" },
          el("span", { class: "slot-index" }, `OTA${index}`),
          el("h3", { class: "slot-name", title: app?.name ?? "空槽" }, app?.name ?? "空槽"),
          ...tags,
        ),
        el("p", { class: "slot-meta" }, meta.join(" · ")),
      ),
      el("div", { class: "slot-picker" }, picker, assign),
      el("div", { class: "slot-actions" }, launch, clear),
    );
  }

  const slotsApi = {
    /** @param {{slots: Array<object>, selected: number|null, runningSlot: number|null, entries: object[], busy: boolean}} model */
    render(model = {}) {
      const slots = Array.isArray(model.slots) ? model.slots : [];
      const filled = slots.filter((slot) => slot?.app).length;
      const parts = [`${slots.length || 4} 个槽`, `已装入 ${filled} 个`];
      if (model.runningSlot !== null && model.runningSlot !== undefined) {
        parts.push(`运行中 OTA${model.runningSlot}`);
      } else if (model.selected !== null && model.selected !== undefined) {
        parts.push(`上次启动 OTA${model.selected}`);
      }
      slotsStatus.textContent = parts.join(" · ");
      if (!slots.length) {
        slotList.replaceChildren(el("p", { class: "library-empty" }, "正在读取平台分区表…"));
        return;
      }
      slotList.replaceChildren(...slots.map((slot) => slotCard(slot, model)));
    },
  };

  // Virtual launcher overlay -------------------------------------------------
  function launcherItem(slot, model) {
    const app = slot.app;
    const meta = [];
    if (app) {
      if (app.version) meta.push(`v${app.version}`);
      if (app.size) meta.push(formatBytes(app.size));
    } else {
      meta.push("空槽");
    }
    const run = app
      ? button("启动", {
        kind: "primary",
        iconName: "play",
        className: "launcher-run",
        disabled: model.busy,
      })
      : chip("空", { kind: "neutral" });
    if (app) {
      run.addEventListener("click", () => dispatchSlots("launch", { slotIndex: slot.slotIndex }));
    }
    return el(
      "article",
      { class: ["launcher-item", app ? "is-filled" : "is-empty"].join(" ") },
      el("span", { class: "launcher-item-slot" }, `OTA${slot.slotIndex}`),
      el(
        "div",
        { class: "launcher-item-main" },
        el("strong", { class: "launcher-item-name", title: app?.name ?? "空槽" }, app?.name ?? "空槽"),
        el("span", { class: "launcher-item-meta" }, meta.join(" · ")),
      ),
      run,
    );
  }

  const launcherApi = {
    render(model = {}) {
      const slots = Array.isArray(model.slots) ? model.slots : [];
      const filled = slots.filter((slot) => slot?.app).length;
      launcherList.replaceChildren(...slots.map((slot) => launcherItem(slot, model)));
      refs.launcherHint.textContent = filled
        ? `${filled} 个应用已装入 · 选择后从对应槽启动`
        : "槽为空：先在「应用槽」面板装入纯 app 包";
    },
    show(model = {}) {
      launcherApi.render(model);
      refs.launcherOverlay.hidden = false;
      refs.app.classList.add("launcher-open");
    },
    hide() {
      refs.launcherOverlay.hidden = true;
      refs.app.classList.remove("launcher-open");
    },
    get visible() {
      return !refs.launcherOverlay.hidden;
    },
  };

  // `#slot-list` is created above; the launcher list comes from static markup.
  const launcherList = refs.launcherList;

  // Audio panel -------------------------------------------------------------
  const outMeter = meter({ label: "扬声器输出", id: "audio-out-level" });
  const inMeter = meter({ label: "麦克风输入", id: "audio-in-level" });
  const micButton = button("启用麦克风", { id: "mic", iconName: "mic" });
  micButton.setAttribute("aria-pressed", "false");

  mountPanel(
    "audio",
    "panel-audio",
    el(
      "div",
      { class: "panel-head" },
      el("p", { class: "eyebrow" }, "声音"),
      el("h2", { class: "panel-title" }, "音频"),
      el("p", { class: "panel-subtitle" }, "扬声器与麦克风的实时电平。音量与静音位于底部控制栏。"),
    ),
    el(
      "div",
      { class: "audio-block" },
      el(
        "div",
        { class: "audio-block-head" },
        el("h3", {}, "扬声器"),
        el("div", { class: "audio-tags" }, chip("16 kHz"), chip("16-bit"), chip("立体声")),
      ),
      outMeter.el,
    ),
    el(
      "div",
      { class: "audio-block" },
      el(
        "div",
        { class: "audio-block-head" },
        el("h3", {}, "麦克风"),
        el("div", { class: "audio-tags" }, chip("16 kHz"), chip("32-bit"), chip("单声道")),
      ),
      el(
        "div",
        { class: "mic-row" },
        el(
          "p",
          { class: "field-hint" },
          "默认关闭。启用时浏览器会请求麦克风权限，声音只送入虚拟设备。",
        ),
        micButton,
      ),
      inMeter.el,
    ),
    el(
      "p",
      { class: "panel-note" },
      "电平显示的是模拟器观测值；实际采样格式以固件初始化为准。",
    ),
  );

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
    el("div", { class: "inspector-mount panel-mount", "aria-label": "设备检查器" }),
    el("div", { class: "macro-mount panel-mount", "aria-label": "输入宏" }),
  );

  // About panel -------------------------------------------------------------
  mountPanel(
    "about",
    "panel-about",
    el(
      "div",
      { class: "panel-head" },
      el("p", { class: "eyebrow" }, "参考板型"),
      el("h2", { class: "panel-title" }, "关于"),
      el(
        "p",
        { class: "panel-subtitle" },
        "谷仓次元屏模拟器在本机运行 ESP32-S3 圆屏固件，浏览器模式与本机加速共用同一份整机镜像。",
      ),
    ),
    el(
      "dl",
      { class: "info-grid" },
      el("dt", {}, "开发板"),
      el("dd", {}, "ESP32-S3-R8 · 32 MB Flash · 8 MB Octal PSRAM"),
      el("dt", {}, "屏幕"),
      el("dd", {}, "360 × 360 ST77916 QSPI · RGB565 圆屏"),
      el("dt", {}, "触摸"),
      el("dd", {}, "CST816S · I²C 地址 0x15"),
      el("dt", {}, "按键"),
      el("dd", {}, "侧键 GPIO6 · 电源闩锁 GPIO7"),
      el("dt", {}, "音频"),
      el("dd", {}, "I²S 扬声器 16 kHz 立体声 · 麦克风 16 kHz 单声道"),
      el("dt", {}, "运行方式"),
      el("dd", {}, "浏览器 WASM，或 x86-64 Linux / Ubuntu WSL 本机加速"),
      el("dt", {}, "网络"),
      el("dd", {}, "虚拟热点 myssid · 密码 mypassword（设备配网页选它）"),
      el("dt", {}, "固件来源"),
      el("dd", {}, "内置示例、本地 BIN、http(s) 链接；纯 app 包自动拼装"),
    ),
    el(
      "p",
      { class: "panel-note" },
      "BLE、NFC、电池与真实射频不在模拟范围内。需要配网的固件请选虚拟热点 myssid，密码 mypassword。",
    ),
    el(
      "p",
      { class: "about-links" },
      el(
        "a",
        {
          href: "https://github.com/espressif/esp-emulator",
          target: "_blank",
          rel: "noreferrer noopener",
        },
        "ESP-EMU 上游 ↗",
      ),
      el("span", { class: "about-version" }, "模拟器界面 v0.1.0"),
    ),
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
    run: refs.run,
    restart: refs.restart,
    reset: refs.reset,
    mute: refs.mute,
    volume: refs.volume,
    screenshot: refs.screenshot,
    record: refs.record,
    fullscreen: refs.fullscreen,
    dev: refs.dev,
    share: refs.share,
    mic: micButton,
    fileInput: refs.fileInput,
    urlInput,
    urlSha,
    addUrlButton,
    sampleButton,
    addFileButton,
    libraryList,
    libraryPanel,
    runCta: refs.runCtaButton,
    onboarding: refs.onboarding,
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
    refs.statusText.textContent = message;
    refs.status.title = message;
    refs.status.classList.toggle("is-idle", !message);
  }

  function setFirmwareInfo(info) {
    const hasInfo = Boolean(info && typeof info === "object");
    refs.firmwareMeta.classList.toggle("has-firmware", hasInfo);
    if (!hasInfo) {
      refs.firmwareName.textContent = "未载入固件";
      refs.firmwareName.removeAttribute("title");
      refs.firmwareVersion.hidden = true;
      refs.runCtaButton.textContent = "运行示例固件";
      return;
    }
    const meta = info.app && typeof info.app === "object" ? info.app : info;
    const name = info.name || meta.project || "固件已载入";
    const version = meta.version && meta.version !== "—" ? meta.version : "";
    const project = meta.project && meta.project !== "—" ? meta.project : "";
    const idf = meta.idf && meta.idf !== "—" ? meta.idf : "";
    refs.firmwareName.textContent = name;
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
    refs.runCtaButton.textContent = "运行所选固件";
  }

  function setNativeAvailable(available) {
    const enabled = Boolean(available);
    nativeOption.disabled = !enabled;
    nativeOption.textContent = "本机加速";
    refs.mode.dataset.nativeAvailable = String(enabled);
    refs.mode.title = enabled
      ? "运行方式：本机加速或浏览器"
      : "本机加速需要 x86-64 Linux 或 Windows 上的 Ubuntu WSL；当前使用浏览器模式";
    refs.onboardingNative.textContent = enabled ? "当前环境可用" : "当前环境不可用";
    refs.onboardingNative.dataset.state = enabled ? "available" : "unavailable";
    if (!enabled && refs.mode.value === "native") refs.mode.value = "wasm";
  }

  function setMode(mode) {
    const option = [...refs.mode.options].find((item) => item.value === mode && !item.disabled);
    refs.mode.value = option ? option.value : "wasm";
    return refs.mode.value;
  }

  // Panels / dev mode -------------------------------------------------------
  function showPanel(name) {
    const def = TAB_DEFS.find((item) => item.id === name);
    if (!def) return false;
    if (def.devOnly && !devMode) setDevMode(true);
    if (!tabController.select(name, { notify: false })) return false;
    activePanel = name;
    for (const id of activePanelIds) {
      const section = refs.panelHost.querySelector(`#panel-${id}`);
      if (section) section.hidden = id !== name;
    }
    refs.panelHost.scrollTop = 0;
    return true;
  }

  function setDevMode(on) {
    devMode = Boolean(on);
    app.classList.toggle("dev-mode", devMode);
    refs.dev.setAttribute("aria-pressed", String(devMode));
    for (const item of TAB_DEFS) {
      const node = tabController.buttons.get(item.id);
      if (node) node.hidden = Boolean(item.devOnly && !devMode);
    }
    if (!devMode && TAB_DEFS.find((item) => item.id === activePanel)?.devOnly) {
      showPanel("library");
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
  function entryCard(entry) {
    const isMarket = entry.kind === "market";
    const run = button(isMarket ? "即将上线" : "运行", {
      kind: "primary",
      iconName: "play",
      className: "firmware-run",
      disabled: isMarket || busyFlag,
    });
    if (isMarket) run.dataset.alwaysDisabled = "true";
    run.addEventListener("click", () => dispatchLibrary("run", { entry: { ...entry } }));

    let remove = null;
    if (entry.kind !== "sample" && !isMarket) {
      remove = button("移除", {
        iconOnly: true,
        iconName: "trash",
        ariaLabel: `移除 ${entry.name}`,
        className: "firmware-remove",
      });
      remove.disabled = busyFlag;
      remove.addEventListener("click", () => dispatchLibrary("remove", { entry: { ...entry } }));
    }

    return el(
      "article",
      {
        class: [
          "firmware-card",
          `kind-${entry.kind}`,
          isMarket ? "is-disabled" : "",
        ]
          .filter(Boolean)
          .join(" "),
        dataset: { id: entry.id },
      },
      el(
        "div",
        { class: "firmware-card-main" },
        el(
          "div",
          { class: "firmware-title-row" },
          el("h3", { class: "firmware-name", title: entry.name }, entry.name),
          chip(KIND_LABELS[entry.kind] ?? entry.kind, {
            kind: "neutral",
            className: "firmware-kind",
          }),
        ),
        el("p", { class: "firmware-source", title: entry.source }, sourceText(entry)),
        el(
          "div",
          { class: "firmware-meta" },
          entry.version ? chip(`v${entry.version}`) : null,
          entry.project ? el("span", { class: "firmware-project" }, entry.project) : null,
          el(
            "span",
            { class: "firmware-size" },
            entry.size ? formatBytes(entry.size) : entry.kind === "sample" ? "运行后读取" : "大小未知",
          ),
          entry.lastUsed ? el("span", { class: "firmware-used" }, relativeTime(entry.lastUsed)) : null,
        ),
      ),
      el("div", { class: "firmware-actions" }, run, remove),
    );
  }

  const libraryApi = {
    /** @param {Array<object>} entries */
    render(entries = []) {
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) {
        libraryList.replaceChildren(
          el("p", { class: "library-empty" }, "固件会显示在这里。可以先运行示例或添加本地文件。"),
        );
        return;
      }
      libraryList.replaceChildren(...list.map(entryCard));
    },
    /** @param {boolean} busy */
    setBusy(busy) {
      busyFlag = Boolean(busy);
      libraryPanel.classList.toggle("is-busy", busyFlag);
      libraryBusy.hidden = !busyFlag;
      for (const control of [sampleButton, addFileButton, urlInput, urlSha, addUrlButton]) {
        control.disabled = busyFlag;
      }
      for (const control of libraryList.querySelectorAll("button")) {
        control.disabled = busyFlag || control.dataset.alwaysDisabled === "true";
      }
    },
  };

  function submitUrl() {
    if (busyFlag) return;
    const url = urlInput.value.trim();
    if (!url) {
      toast("请先填写固件链接", "warning");
      urlInput.focus();
      return;
    }
    const sha256 = urlSha.value.trim() || undefined;
    dispatchLibrary("url", { url, sha256 });
  }

  // Running / audio states --------------------------------------------------
  function setRecording(recording) {
    const active = Boolean(recording);
    refs.record.setAttribute("aria-pressed", String(active));
    refs.record.classList.toggle("is-active", active);
    refs.record.title = active ? "停止录屏" : "录制页面与声音";
    refs.record.setAttribute("aria-label", active ? "停止录屏" : "开始录屏");
    refs.record.replaceChildren(
      icon(active ? "stop" : "record", { size: 16 }),
      el("span", { class: "btn-label" }, active ? "停止" : "录屏"),
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
    refs.volume.style.setProperty("--volume-fill", `${percent}%`);
    refs.volume.setAttribute("aria-valuetext", `${percent}%`);
    return level;
  }

  function setAudioLevels(levels = {}) {
    if (levels.out !== undefined) outMeter.set(levels.out);
    if (levels.in !== undefined) inMeter.set(levels.in);
  }

  function setMicActive(active) {
    const on = Boolean(active);
    micButton.setAttribute("aria-pressed", String(on));
    micButton.classList.toggle("is-active", on);
    setButtonLabel(micButton, on ? "停止麦克风" : "启用麦克风");
  }

  function setRunning(running) {
    const active = Boolean(running);
    if (active) {
      hasRun = true;
      launcherApi.hide();
    }
    app.classList.toggle("is-running", active);
    app.classList.toggle("has-run", hasRun);
    refs.run.disabled = active;
    refs.restart.disabled = !hasRun;
    refs.reset.disabled = !hasRun;
    refs.screenshot.disabled = !hasRun;
    refs.record.disabled = !active;
    refs.side.disabled = !active;
    refs.runCta.hidden = active;
    refs.canvas.setAttribute("aria-busy", String(active));
    if (active) refs.errorCard.hidden = true;
    if (!active) setRecording(false);
  }

  // Onboarding --------------------------------------------------------------
  const onboardingApi = {
    show() {
      if (onboardingOpen) return;
      onboardingOpen = true;
      onboardingReturnFocus = document.activeElement;
      refs.onboarding.hidden = false;
      document.body.classList.add("onboarding-open");
      requestAnimationFrame(() => need("onboarding-sample").focus());
    },
    hide() {
      if (!onboardingOpen) return;
      onboardingOpen = false;
      refs.onboarding.hidden = true;
      document.body.classList.remove("onboarding-open");
      if (onboardingReturnFocus && typeof onboardingReturnFocus.focus === "function") {
        onboardingReturnFocus.focus();
      }
      onboardingReturnFocus = null;
    },
  };

  need("onboarding-close").addEventListener("click", () => {
    dispatchOnboarding("dismiss");
    onboardingApi.hide();
  });
  need("onboarding-sample").addEventListener("click", () => {
    dispatchLibrary("sample");
    dispatchOnboarding("sample");
    onboardingApi.hide();
  });
  need("onboarding-file").addEventListener("click", () => {
    dispatchOnboarding("file");
    refs.fileInput.click();
  });
  need("onboarding-url").addEventListener("click", () => {
    dispatchOnboarding("url");
    onboardingApi.hide();
    showPanel("library");
    urlInput.focus();
  });
  refs.onboarding.addEventListener("click", (event) => {
    if (
      event.target === refs.onboarding ||
      (event.target instanceof Element && event.target.classList.contains("onboarding-backdrop"))
    ) {
      dispatchOnboarding("dismiss");
      onboardingApi.hide();
    }
  });
  refs.onboarding.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dispatchOnboarding("dismiss");
      onboardingApi.hide();
    }
  });

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

  // Share link --------------------------------------------------------------
  function fallbackCopy(text) {
    const area = el("textarea", { class: "sr-only", "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("copy failed");
  }

  async function copyShareLink() {
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else fallbackCopy(url);
      toast("页面链接已复制", "success");
    } catch {
      try {
        fallbackCopy(url);
        toast("页面链接已复制", "success");
      } catch {
        toast("复制失败，请手动复制地址栏链接", "error");
      }
    }
  }

  // Wiring ------------------------------------------------------------------
  refs.dev.addEventListener("click", () => setDevMode(!devMode));
  refs.share.addEventListener("click", copyShareLink);
  refs.launcher.addEventListener("click", () => dispatchSlots("open-launcher"));
  refs.launcherClose.addEventListener("click", () => dispatchSlots("close-launcher"));
  launcherOpenButton.addEventListener("click", () => dispatchSlots("open-launcher"));
  refs.runCtaButton.addEventListener("click", () => {
    if (!refs.run.disabled) refs.run.click();
  });
  sampleButton.addEventListener("click", () => dispatchLibrary("sample"));
  addFileButton.addEventListener("click", () => refs.fileInput.click());
  urlForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitUrl();
  });
  refs.volume.addEventListener("input", () => {
    const percent = Number(refs.volume.value) || 0;
    refs.volume.style.setProperty("--volume-fill", `${percent}%`);
    refs.volume.setAttribute("aria-valuetext", `${percent}%`);
  });
  refs.fileInput.addEventListener("change", () => onboardingApi.hide());

  // Initial state -----------------------------------------------------------
  setRunning(false);
  setMuted(false);
  setVolume(0.8);
  setMicActive(false);
  setDevMode(false);
  showPanel("library");
  setStatus(refs.statusText.textContent || "等待载入固件");
  setAudioLevels({ out: 0, in: 0 });

  return {
    elements,
    setStatus,
    setMode,
    setFirmwareInfo,
    setNativeAvailable,
    showPanel,
    setDevMode,
    toast,
    onboarding: onboardingApi,
    library: libraryApi,
    slots: slotsApi,
    launcher: launcherApi,
    setRunning,
    setRecording,
    setMuted,
    setVolume,
    setAudioLevels,
    setMicActive,
    showError,
  };
}
