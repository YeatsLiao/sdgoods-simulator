import { el } from "../shared/dom.js";
import { button } from "./components.js";

export function createLibraryPanel({ mountPanel, dispatchLibrary, openFile, toast }) {
  let busyFlag = false;
  let currentId = null;
  // Library panel -----------------------------------------------------------
  const sampleButton = document.getElementById("try-sample");
  const addFileButton = button("打开其他 BIN", { id: "library-file", kind: "primary", iconName: "upload" });
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

  const libraryList = el(
    "div",
    { id: "library-list", class: "library-list" },
    el("p", { class: "library-empty" }, "暂无最近使用"),
  );

  const libraryPanel = mountPanel("library", "panel-library", libraryBusy, libraryList, addFileButton);

  function entryCard(entry) {
    const name = entry.name ?? "firmware.bin";
    const displayName = name.length > 36 ? `${name.slice(0, 20)}…${name.slice(-14)}` : name;
    const run = button(displayName, { className: "firmware-run recent-open", disabled: busyFlag, iconName: "file", title: name, ariaLabel: `打开 ${name}` });
    if (name.length > 26) {
      run.querySelector(".btn-label").replaceChildren(
        el("span", { class: "recent-name-prefix" }, name.slice(0, -14)),
        el("span", { class: "recent-name-tail" }, name.slice(-14)));
    }
    run.addEventListener("click", () => dispatchLibrary("run", { entry: { ...entry } }));
    const hide = button("", { iconOnly: true, iconName: "close", className: "recent-hide", title: "移除记录（保留固件数据）", ariaLabel: `移除 ${name} 的最近记录`, disabled: busyFlag });
    hide.addEventListener("click", () => dispatchLibrary("hide-history", { entry: { ...entry } }));
    const row = el("article", { class: "recent-row", dataset: { id: entry.id } }, run, hide);
    row.classList.toggle("is-current", entry.id === currentId);
    if (entry.id === currentId) run.setAttribute("aria-current", "true");
    return row;
  }

  const libraryApi = {
    setCurrent(id) {
      currentId = id;
      for (const row of libraryList.querySelectorAll(".recent-row")) {
        const active = row.dataset.id === currentId;
        row.classList.toggle("is-current", active);
        const run = row.querySelector("button");
        if (active) run.setAttribute("aria-current", "true"); else run.removeAttribute("aria-current");
      }
    },
    /** @param {Array<object>} entries */
    render(entries = []) {
      const list = Array.isArray(entries) ? entries.filter((entry) => !entry.recentHidden && entry.kind !== "market" && (entry.kind !== "sample" || entry.lastUsed)) : [];
      if (!list.length) {
        libraryList.replaceChildren(
          el("p", { class: "library-empty" }, "暂无最近使用"),
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
      for (const id of ["open-firmware", "try-sample"]) {
        const control = document.getElementById(id);
        if (control) control.disabled = busyFlag;
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

  addFileButton.addEventListener("click", openFile);
  urlForm.addEventListener("submit", (event) => { event.preventDefault(); submitUrl(); });
  return { libraryApi, libraryPanel, libraryList, sampleButton, addFileButton, urlInput, urlSha, addUrlButton, urlForm };
}
