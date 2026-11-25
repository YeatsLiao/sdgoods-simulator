export function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new TypeError("固件数据格式不正确");
}

export function flatInfo(entry, info, size) {
  const app = info?.app ?? {};
  return {
    name: entry?.name ?? "firmware.bin",
    project: app.project ?? entry?.project ?? "—",
    version: app.version ?? entry?.version ?? "—",
    idf: app.idf ?? "—",
    size: size ?? entry?.size ?? 0,
  };
}

