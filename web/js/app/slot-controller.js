import { DeviceSession } from "../device/session.js";
import { describeFirmware } from "../device/firmware.js";
import { isAppPackage, loadPlatformAssets } from "../flash/app-package.js";
import { buildSlotImage, parseSlotLayout } from "../flash/device-image.js";
import { OTA_SECTOR_SIZE } from "../flash/otadata.js";
import { assignSlot, clearSlot, selectSlot, writeSlotState } from "../flash/slots.js";
import { getFirmware } from "../library/cache.js";
import { formatBytes } from "../shared/format.js";
import { toArrayBuffer } from "./firmware-info.js";

/** Internal slot feature. App supplies shared services; no primary UI entry is exposed. */
export class SlotController {
  constructor(app) { this.app = app; }
  ensureSlotLayout() {
    this.app.platformPromise ??= loadPlatformAssets()
      .then((assets) => {
        const layout = parseSlotLayout(assets.partitionTable);
        this.app.slotLayout = layout;
        this.renderSlots();
        return { ...assets, layout };
      })
      .catch((error) => {
        this.app.platformPromise = null;
        throw error;
      });
    return this.app.platformPromise;
  }

  slotView() {
    const layout = this.app.slotLayout?.slots ?? [];
    const byIndex = new Map(layout.map((slot) => [slot.slotIndex, slot]));
    const count = layout.length || this.app.slots.slots.length;
    const slots = [];
    for (let index = 0; index < count; index++) {
      const partition = byIndex.get(index);
      slots.push({
        slotIndex: index,
        offset: partition?.offset ?? null,
        size: partition?.size ?? null,
        app: this.app.slots.slots[index] ?? null,
      });
    }
    return {
      slots,
      selected: this.app.slots.selected,
      runningSlot: this.app.session ? this.app.current?.slotIndex ?? null : null,
      entries: this.app.library.list(),
      busy: this.app.busy,
    };
  }

  renderSlots() {
    if (!this.app.ui?.slots) return;
    const view = this.slotView();
    this.app.ui.slots.render?.(view);
    if (this.app.ui.launcher?.visible) this.app.ui.launcher.render?.(view);
  }

  async openLauncher() {
    if (this.app.busy) return;
    if (this.app.session) {
      await this.app.saveBeforeStop();
      this.app.stopSession();
    }
    this.renderSlots();
    this.app.ui.launcher?.show?.(this.slotView());
    this.app.ui.setStatus?.("启动器：从 OTA 槽启动应用");
  }

  closeLauncher() {
    this.app.ui.launcher?.hide?.();
    this.app.ui.setStatus?.(this.app.session ? "运行中" : "选择一个玩法开始");
  }

  async dropSlotsForEntry(entryId) {
    let changed = false;
    for (let index = 0; index < this.app.slots.slots.length; index++) {
      if (this.app.slots.slots[index]?.entryId === entryId) {
        this.app.slots = clearSlot(this.app.slots, index);
        changed = true;
      }
    }
    if (!changed) return;
    writeSlotState(this.app.slots);
    this.renderSlots();
    this.app.ui.toast?.("固件已移除，引用它的应用槽已清空", "warning");
  }

  async installSlot(slotIndex, entryId) {
    if (this.app.busy) return;
    if (!entryId) {
      this.app.ui.toast?.("请先选择一个固件条目", "warning");
      return;
    }
    this.app.busy = true;
    this.app.ui.showError?.(null);
    this.app.ui.library?.setBusy?.(true);
    this.renderSlots();
    try {
      const { layout } = await this.ensureSlotLayout();
      const slot = layout.slots.find((item) => item.slotIndex === slotIndex);
      if (!slot) throw new Error(`平台分区表没有 OTA${slotIndex} 槽`);
      const raw = await this.app.library.raw(entryId);
      const bytes = new Uint8Array(raw.firmware);
      if (!isAppPackage(bytes)) {
        throw new Error("整机镜像不能装入 OTA 槽，请选择纯 app 包（无分区表、描述符在 0x10000 之前）");
      }
      if (bytes.byteLength > slot.size) {
        throw new Error(
          `应用 ${formatBytes(bytes.byteLength)} 超过 OTA${slotIndex} 槽容量 ${formatBytes(slot.size)}`,
        );
      }
      const app = raw.info?.app ?? {};
      this.app.slots = assignSlot(this.app.slots, slotIndex, {
        entryId: raw.entry.id,
        sha256: raw.sha256,
        name: raw.entry.name,
        version: (typeof app.version === "string" && app.version) || raw.entry.version || "",
        project: (typeof app.project === "string" && app.project) || raw.entry.project || "",
        size: bytes.byteLength,
      });
      writeSlotState(this.app.slots);
      this.app.renderLibrary();
      this.app.ui.toast?.(`已装入 OTA${slotIndex}：${raw.entry.name}`, "success");
      this.app.ui.setStatus?.(`OTA${slotIndex} 已装入 ${raw.entry.name}`);
    } catch (error) {
      this.app.fail(error.message || String(error));
    } finally {
      this.app.busy = false;
      this.app.ui.library?.setBusy?.(false);
      this.renderSlots();
    }
  }

  async resolveSlotApp(assignment, slotIndex) {
    let firmware = assignment.sha256
      ? await getFirmware(assignment.sha256).catch(() => null)
      : null;
    let entry = null;
    let info = null;
    let sha = assignment.sha256;
    if (!firmware && assignment.entryId) {
      const raw = await this.app.library.raw(assignment.entryId).catch(() => null);
      if (raw) {
        firmware = raw.firmware;
        entry = raw.entry;
        info = raw.info;
        sha = raw.sha256;
      }
    }
    if (!firmware) {
      throw new Error(`OTA${slotIndex} 的固件缓存已丢失（${assignment.name}），请重新装入`);
    }
    if (sha && sha !== assignment.sha256) {
      throw new Error(`OTA${slotIndex} 的固件与槽记录不一致，请重新装入`);
    }
    info ??= describeFirmware(firmware);
    entry ??= {
      id: assignment.entryId,
      name: assignment.name,
      version: assignment.version,
      project: assignment.project,
      kind: "file",
      size: assignment.size,
    };
    return { entry, firmware, info, sha256: assignment.sha256 };
  }

  /** Slot boots re-stamp otadata on the restored snapshot (see DeviceSession). */
  otadataPatch(built) {
    const size = Math.max(OTA_SECTOR_SIZE, built.otadata.size);
    const data = new Uint8Array(size).fill(0xff);
    data.set(built.bytes.subarray(built.otadata.offset, built.otadata.offset + OTA_SECTOR_SIZE));
    return { offset: built.otadata.offset, data };
  }

  async launchSlot(slotIndex) {
    if (this.app.busy) return;
    const assignment = this.app.slots.slots[slotIndex];
    if (!assignment) {
      this.app.ui.toast?.(`OTA${slotIndex} 是空槽`, "warning");
      return;
    }
    this.app.busy = true;
    this.app.ui.showError?.(null);
    this.app.ui.library?.setBusy?.(true);
    try {
      const { bootloader, partitionTable, seed, layout } = await this.ensureSlotLayout();
      const slot = layout.slots.find((item) => item.slotIndex === slotIndex);
      if (!slot) throw new Error(`平台分区表没有 OTA${slotIndex} 槽`);

      const selectedApp = await this.resolveSlotApp(assignment, slotIndex);
      const apps = [{ slotIndex, bytes: new Uint8Array(selectedApp.firmware) }];
      for (let index = 0; index < this.app.slots.slots.length; index++) {
        if (index === slotIndex) continue;
        const item = this.app.slots.slots[index];
        if (!item) continue;
        const raw = await this.resolveSlotApp(item, index);
        apps.push({ slotIndex: index, bytes: new Uint8Array(raw.firmware) });
      }

      const built = buildSlotImage({ bootloader, partitionTable, seed, apps, selected: slotIndex });
      const firmware = toArrayBuffer(built.bytes);
      const flashKey = `slot-${slotIndex}-${assignment.sha256}`;
      this.app.ui.setStatus?.(`正在从 OTA${slotIndex} 启动 ${assignment.name}`);

      if (this.app.session) {
        await this.app.saveBeforeStop();
        this.app.stopSession();
      }
      const flash = this.app.mode === "wasm"
        ? await this.app.flashStore.load(flashKey, firmware).catch(() => null)
        : null;
      const flashPatch = this.otadataPatch(built);

      this.app.current = {
        entry: selectedApp.entry,
        firmware,
        info: selectedApp.info,
        flashKey,
        slotIndex,
      };
      const info = this.app.firmwareInfo();
      this.app.ui.setFirmwareInfo?.(info);
      this.app.inspector.clearFault();
      this.app.inspector.setMode(this.app.mode);
      this.app.inspector.setFirmware(info);
      this.app.inspector.setPartitions(describeFirmware(firmware).partitions);
      this.app.console.clear();
      this.app.renderer.reset();
      this.app.hasFrame = false;
      this.app.beginRunHintState();
      this.app.running = true;
      this.app.ui.setRunning?.(true);
      this.app.ui.setPhase?.("starting");
      this.app.ui.launcher?.hide?.();
      this.app.ui.setStatus?.(this.app.mode === "native" ? "正在启动本机模拟器…" : "正在启动浏览器模拟器…");
      try {
        await this.app.audio.init();
        this.app.audio.setVolume(0.8);
      } catch (error) {
        this.app.ui.toast?.(`音频未启用：${error.message || error}`, "error");
      }
      this.app.session = new DeviceSession();
      this.app.wireSession(this.app.session);
      this.app.session.boot({
        mode: this.app.mode,
        firmware: this.app.current.firmware,
        flash,
        flashPatch,
        name: `${selectedApp.entry.name} · OTA${slotIndex}`,
        flashKey,
        preserveFlash: true,
      });
      this.app.startAutoSave();
      this.app.slots = selectSlot(this.app.slots, slotIndex);
      writeSlotState(this.app.slots);
      this.renderSlots();
    } catch (error) {
      this.app.fail(error.message || String(error));
      this.app.ui.launcher?.show?.(this.slotView());
    } finally {
      this.app.busy = false;
      this.app.ui.library?.setBusy?.(false);
      this.renderSlots();
    }
  }

  async clearSlot(slotIndex) {
    if (this.app.busy) return;
    if (!this.app.slots.slots[slotIndex]) return;
    this.app.slots = clearSlot(this.app.slots, slotIndex);
    writeSlotState(this.app.slots);
    if (this.app.current?.slotIndex === slotIndex) {
      await this.openLauncher();
    } else {
      this.renderSlots();
    }
    this.app.ui.toast?.(`已清空 OTA${slotIndex}`, "info");
  }

}
