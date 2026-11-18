// ESP-EMU's co-simulation protocol uses protobuf wire types 0 and 2.
// The browser/server transport in this project reuses the same type byte names.

export const WIRE = Object.freeze({
  FRAME: 0x01,
  AUDIO: 0x02,
  LOG: 0x03,
  EVENT: 0x04,
  FLASH: 0x05,
  LOAD: 0x10,
  ELF: 0x11,
  MIC: 0x12,
  FLASH_IMPORT: 0x13,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function varint(value) {
  const bytes = [];
  let current = value;
  do {
    const next = Math.floor(current / 128);
    bytes.push((current % 128) | (next ? 128 : 0));
    current = next;
  } while (current);
  return bytes;
}

export function numberField(tag, value) {
  return [...varint(tag * 8), ...varint(value)];
}

export function bytesField(tag, value) {
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

export function unpackFrame(frame) {
  const length = frame[0] | (frame[1] << 8);
  return [
    textDecoder.decode(frame.subarray(2, 2 + length)),
    frame.subarray(2 + length),
  ];
}

export function register(name, { display = true, touch = true, key = true, audio = true } = {}) {
  const claims = [];
  const claim = (bytes) => bytesField(3, bytes);
  if (key) claims.push(claim(bytesField(1, numberField(1, 1 << 6))));
  if (touch) {
    claims.push(claim(bytesField(2, [
      ...numberField(1, 0x15), ...numberField(2, 10), ...numberField(3, 11),
    ])));
  }
  if (display) claims.push(claim(bytesField(3, numberField(1, 21))));
  if (audio) {
    claims.push(claim(bytesField(17, [
      ...numberField(1, 48), ...numberField(2, 38),
      ...numberField(3, 47), ...numberField(4, 17),
    ])));
  }
  return Uint8Array.from(bytesField(4, [
    ...numberField(1, 1), ...bytesField(2, textEncoder.encode(name)), ...claims.flat(),
  ]));
}

export function reply(id, op, data) {
  return Uint8Array.from(bytesField(8, [
    ...numberField(1, id), ...numberField(2, 1),
    ...bytesField(3, data), ...numberField(4, op),
  ]));
}

export function parseI2sFormat(bytes) {
  const value = fields(bytes);
  return {
    receive: Boolean(value[1]),
    rate: value[2] ?? 0,
    channels: value[3] ?? 0,
    bits: value[4] ?? 0,
  };
}

export function parseI2sOut(bytes) {
  return fields(bytes)[1] ?? new Uint8Array(0);
}

export function i2sIn(pcm) {
  return Uint8Array.from(bytesField(31, bytesField(1, pcm)));
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function encodeLoad(json, firmware) {
  const header = textEncoder.encode(JSON.stringify(json));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, header.length, true);
  return concat(Uint8Array.of(WIRE.LOAD), size, header, new Uint8Array(firmware));
}

export function decodeLoad(bytes) {
  const length = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true);
  const header = bytes.subarray(5, 5 + length);
  return {
    json: JSON.parse(textDecoder.decode(header)),
    firmware: bytes.subarray(5 + length),
  };
}

export function encodeAudio({ rate, channels, bits, receive, pcm }) {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, rate, true);
  header[4] = channels;
  header[5] = bits;
  header[6] = receive ? 1 : 0;
  header[7] = 0;
  return concat(header, new Uint8Array(pcm));
}

export function decodeAudio(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    rate: view.getUint32(0, true),
    channels: bytes[4],
    bits: bytes[5],
    receive: Boolean(bytes[6]),
    pcm: bytes.subarray(8),
  };
}

export function encodeMic({ rate = 16000, channels = 1, bits = 32, pcm }) {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, rate, true);
  header[4] = channels;
  header[5] = bits;
  header[6] = 0;
  header[7] = 0;
  return concat(Uint8Array.of(WIRE.MIC), header, new Uint8Array(pcm));
}

export function decodeMic(bytes) {
  return decodeAudio(bytes.subarray(1));
}

export function encodeFrame(frame, transfer) {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, frame, true);
  header[0] = WIRE.FRAME;
  return concat(header, transfer);
}

export function decodeFrame(bytes) {
  return {
    frame: new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true),
    transfer: bytes.subarray(5),
  };
}

export function encodeEvent(type, value) {
  return textEncoder.encode(JSON.stringify({ ...value, kind: type }));
}

export function decodeEvent(bytes) {
  return JSON.parse(textDecoder.decode(bytes));
}

export function concatBytes(...parts) {
  return concat(...parts);
}
