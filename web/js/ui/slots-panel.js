import { el } from "../shared/dom.js";
import { formatBytes } from "../shared/format.js";
import { button, chip } from "./components.js";

export function createSlotsPanel({ mountPanel, dispatchSlots, refs }) {
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

  launcherOpenButton.addEventListener("click", () => dispatchSlots("open-launcher"));
  return { slotsApi, launcherApi, slotList, launcherOpenButton, launcherList };
}
