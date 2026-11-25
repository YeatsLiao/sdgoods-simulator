export const initialWorkspace = Object.freeze({ phase: "idle", panel: "library", open: true, autoClose: false });

const PHASES = new Set(["idle", "preparing", "starting", "waiting", "running", "error"]);

/** A panel opened explicitly during boot stays open when the first frame arrives. */
export function workspaceTransition(state, action) {
  if (action.type === "panel") return { ...state, panel: action.panel, open: true, autoClose: false };
  if (action.type === "close") return { ...state, open: false, autoClose: false };
  if (action.type === "phase" && PHASES.has(action.phase)) {
    const phase = action.phase;
    const autoClose = phase === "preparing" ? state.open && state.panel === "library" : state.autoClose;
    return { ...state, phase, autoClose, open: phase === "running" && autoClose ? false : state.open };
  }
  return state;
}

export function droppedFirmware(files) {
  if (files.length !== 1) return { error: "请每次拖入一个 BIN 文件" };
  const file = files[0];
  if (!/\.bin$/i.test(file.name)) return { error: "请选择 .bin 固件文件" };
  if (file.size > 32 * 1024 * 1024) return { error: "固件不能超过 32 MB" };
  return { file };
}
