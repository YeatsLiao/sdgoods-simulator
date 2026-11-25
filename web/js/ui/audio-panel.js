import { button, meter, setButtonLabel } from "./components.js";

/** Basic microphone controls only; playback and diagnostics belong to the engine. */
export function createAudioPanel() {
  const micButton = button("启用麦克风", { id: "mic", iconName: "mic" });
  const input = meter({ label: "麦克风电平", id: "audio-in-level" });
  input.el.hidden = true;
  micButton.setAttribute("aria-pressed", "false");
  let enabled = false;
  return {
    micButton,
    micMeter: input.el,
    setAudioLevels(levels = {}) {
      if (enabled) input.set(levels.in ?? levels.inRms ?? 0);
    },
    setMicActive(active) {
      enabled = Boolean(active);
      input.el.hidden = !enabled;
      micButton.setAttribute("aria-pressed", String(enabled));
      micButton.classList.toggle("is-active", enabled);
      setButtonLabel(micButton, enabled ? "停止麦克风" : "启用麦克风");
      if (!enabled) input.set(0);
    },
  };
}
