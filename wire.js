// ESP-EMU co-simulation protobuf v1 uses varints and length-delimited fields.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function varint(value) {
  const bytes = [];
  do {
    const next = Math.floor(value / 128);
    bytes.push((value % 128) | (next ? 128 : 0));
    value = next;
  } while (value);
  return bytes;
}

function numberField(tag, value) {
  return [...varint(tag * 8), ...varint(value)];
}

function bytesField(tag, value) {
  return [...varint(tag * 8 + 2), ...varint(value.length), ...value];
}

export function fields(bytes) {
  const result = {};
  let offset = 0;
  function read() {
    let value = 0;
    let factor = 1;
    while (offset < bytes.length) {
      const byte = bytes[offset++];
      value += (byte & 127) * factor;
      if (byte < 128) return value;
      factor *= 128;
    }
    throw new Error("不完整的外设消息");
  }
  while (offset < bytes.length) {
    const key = read();
    const tag = key >>> 3;
    if ((key & 7) === 0) {
      result[tag] = read();
    } else if ((key & 7) === 2) {
      const length = read();
      if (offset + length > bytes.length) throw new Error("外设消息长度错误");
      result[tag] = bytes.subarray(offset, offset + length);
      offset += length;
    } else {
      throw new Error("未知的外设消息格式");
    }
  }
  return result;
}

export function unpack(frame) {
  const length = frame[0] | (frame[1] << 8);
  return [textDecoder.decode(frame.subarray(2, 2 + length)), frame.subarray(2 + length)];
}

export function register(name) {
  const display = bytesField(3, numberField(1, 21));
  const touch = bytesField(2, [
    ...numberField(1, 0x15), ...numberField(2, 10), ...numberField(3, 11),
  ]);
  return Uint8Array.from(bytesField(4, [
    ...numberField(1, 1), ...bytesField(2, textEncoder.encode(name)),
    ...bytesField(3, display), ...bytesField(3, touch),
  ]));
}

export function reply(id, op, data) {
  return Uint8Array.from(bytesField(8, [
    ...numberField(1, id), ...numberField(2, 1),
    ...bytesField(3, data), ...numberField(4, op),
  ]));
}
