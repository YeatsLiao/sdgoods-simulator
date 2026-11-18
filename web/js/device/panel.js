export const SIZE = 360;

const EMPTY = new Uint8Array(0);

function bytesOf(value) {
  if (!value) return EMPTY;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return EMPTY;
}

/**
 * Decodes ST77916 QSPI transfers into a 360x360 RGB565 framebuffer.
 * Window coordinates are LCD addresses; pixels outside the panel are clipped.
 */
export class Panel {
  static SIZE = SIZE;

  constructor() {
    this.packed = new Uint16Array(SIZE * SIZE);
    this.dirty = false;
    this.command = 0;
    this.headerBytes = 0;
    this.parameters = [];
    this.x0 = 0;
    this.x1 = SIZE - 1;
    this.y0 = 0;
    this.y1 = SIZE - 1;
    this.x = 0;
    this.y = 0;
    this.highByte = null;
  }

  /**
   * Consume one parsed SPI transfer message.
   * @param {Record<number, any>} message Parsed fields: [3] write bytes, [12] burst-continuation flag.
   */
  transfer(message) {
    const bytes = bytesOf(message?.[3]);
    let offset = 0;
    while (this.headerBytes < 4 && offset < bytes.length) {
      const byte = bytes[offset++];
      const index = this.headerBytes++;
      if (index === 2) this.select(byte);
    }
    if (this.headerBytes === 4 && offset < bytes.length) {
      const data = bytes.subarray(offset);
      if (this.command === 0x2c || this.command === 0x3c) this.writePixels(data);
      else if (this.command === 0x2a || this.command === 0x2b) this.readWindow(data);
    }
    // The emulator marks every transfer of a burst except the last one, so the
    // header state must survive until field 12 is absent.
    if (!message?.[12]) this.headerBytes = 0;
  }

  /**
   * Copy the framebuffer for transfer to the main thread.
   * @returns {Uint16Array|null} RGB565 pixels, or null when nothing new was rendered.
   */
  takeFrame() {
    if (!this.dirty) return null;
    const frame = this.packed.slice();
    this.dirty = false;
    return frame;
  }

  reset() {
    this.command = 0;
    this.headerBytes = 0;
    this.parameters.length = 0;
    this.x0 = 0;
    this.x1 = SIZE - 1;
    this.y0 = 0;
    this.y1 = SIZE - 1;
    this.x = 0;
    this.y = 0;
    this.highByte = null;
    this.dirty = false;
  }

  select(command) {
    this.command = command;
    this.parameters = [];
    if (command === 0x2c) {
      this.x = this.x0;
      this.y = this.y0;
      this.highByte = null;
    }
  }

  readWindow(data) {
    const remaining = 4 - this.parameters.length;
    for (let i = 0; i < data.length && i < remaining; i++) this.parameters.push(data[i]);
    if (this.parameters.length !== 4) return;
    const [a, b, c, d] = this.parameters;
    if (this.command === 0x2a) {
      this.x0 = (a << 8) | b;
      this.x1 = (c << 8) | d;
    } else {
      this.y0 = (a << 8) | b;
      this.y1 = (c << 8) | d;
    }
  }

  writePixels(data) {
    let offset = 0;
    if (this.highByte !== null) {
      this.writePixel((this.highByte << 8) | data[offset++]);
      this.highByte = null;
    }
    const packed = this.packed;
    while (offset + 1 < data.length) {
      const count = Math.min(this.x1 - this.x + 1, (data.length - offset) >> 1);
      if (count <= 0) return;
      const visible = this.y < SIZE ? Math.max(0, Math.min(count, SIZE - this.x)) : 0;
      let destination = this.y * SIZE + this.x;
      for (let i = 0; i < visible; i++) {
        packed[destination++] = (data[offset] << 8) | data[offset + 1];
        offset += 2;
      }
      offset += (count - visible) * 2;
      this.x += count;
      this.advanceRow();
    }
    if (offset < data.length) this.highByte = data[offset];
  }

  writePixel(color) {
    if (this.x < SIZE && this.y < SIZE) this.packed[this.y * SIZE + this.x] = color;
    this.x++;
    this.advanceRow();
  }

  advanceRow() {
    if (this.x > this.x1) {
      this.x = this.x0;
      if (++this.y > this.y1) {
        this.y = this.y0;
        this.dirty = true;
      }
    }
  }
}
