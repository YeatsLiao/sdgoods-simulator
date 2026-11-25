export function normalizeSoundPreferences(value) {
  const volume = typeof value?.volume === "number" && Number.isFinite(value.volume) ? value.volume : .8;
  return { volume: Math.max(0, Math.min(1, volume)), muted: value?.muted === true };
}
