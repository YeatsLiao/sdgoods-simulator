/** Compatibility signals from the SDGOODS BSP; never infer sleep from quiet frames. */
export class FirmwarePower {
  constructor() { this.tail = ""; }

  push(chunk) {
    const lines = (this.tail + String(chunk)).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
    this.tail = lines.pop().slice(-2048);
    const states = [];
    for (const line of lines) {
      const match = /^\s*I\s+\(\d+\) power: (.+)$/.exec(line);
      if (match) {
        const text = match[1];
        if (/^entering deep sleep \(wake on power key press/.test(text)) states.push("deep");
        else if (/^entering light sleep \(wake on power key press/.test(text)) states.push("light");
        else if (/^screen suspended \(low power\)/.test(text)) states.push("suspended");
        else if (/^screen resumed$|^resumed from light sleep \(screen lit\)/.test(text)) states.push("on");
      }
      // Older firmware logs no power-off line; the emulator exposes the actual call stack.
      if (/^\s*#\d+\s+0x[\da-f]+ in sdgoods_power_off \(/i.test(line)) states.push("off");
    }
    return states;
  }
}

export function powerRuntimeExit(state, message) {
  return ["deep", "light", "off"].includes(state)
    && /ESP-EMU 已退出|协同仿真连接中断|(?:esp_sleep_start|deep_sleep_start|sdgoods_power_off)\s*\(/.test(String(message));
}
