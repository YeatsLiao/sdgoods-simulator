export const SIZE = 360;
const EMPTY = new Uint8Array();
const RGB565 = new Uint32Array(65536);
const colors = new Uint8ClampedArray(RGB565.buffer);
for (let value = 0; value < RGB565.length; value++) {
  const offset = value * 4;
  colors[offset] = ((value >> 11) * 255) / 31;
  colors[offset + 1] = (((value >> 5) & 63) * 255) / 63;
  colors[offset + 2] = ((value & 31) * 255) / 31;
  colors[offset + 3] = 255;
}

// Coordinates are LCD address-window coordinates, which the BSP already
// expresses in the same orientation as its LVGL canvas.
export class Panel {
  pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  packed = new Uint32Array(this.pixels.buffer);
  dirty = false;
  command = 0;
  headerBytes = 0;
  parameters = [];
  x0 = 0;
  x1 = SIZE - 1;
  y0 = 0;
  y1 = SIZE - 1;
  x = 0;
  y = 0;
  highByte = null;

  transfer(message) {
    const bytes = message[3] ?? EMPTY;
    let offset = 0;
    while (this.headerBytes < 4 && offset < bytes.length) {
      const byte = bytes[offset++];
      if (this.headerBytes++ === 2) this.select(byte);
    }
    if (this.headerBytes === 4 && offset < bytes.length) {
      const data = bytes.subarray(offset);
      if (this.command === 0x2c || this.command === 0x3c) {
        this.writePixels(data);
      } else if (this.command === 0x2a || this.command === 0x2b) {
        this.parameters.push(...data.subarray(0, 4 - this.parameters.length));
        if (this.parameters.length === 4) {
          const [a, b, c, d] = this.parameters;
          if (this.command === 0x2a) {
            this.x0 = (a << 8) | b;
            this.x1 = (c << 8) | d;
          } else {
            this.y0 = (a << 8) | b;
            this.y1 = (c << 8) | d;
          }
        }
      }
    }
    if (!message[12]) this.headerBytes = 0;
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

  writePixels(data) {
    let offset = 0;
    if (this.highByte !== null) {
      this.writeOne((this.highByte << 8) | data[offset++]);
      this.highByte = null;
    }
    while (offset + 1 < data.length) {
      const count = Math.min(this.x1 - this.x + 1, (data.length - offset) >> 1);
      if (count <= 0) return;
      const visible = this.y < SIZE ? Math.max(0, Math.min(count, SIZE - this.x)) : 0;
      let destination = this.y * SIZE + this.x;
      for (let i = 0; i < visible; i++) {
        this.packed[destination++] = RGB565[(data[offset] << 8) | data[offset + 1]];
        offset += 2;
      }
      offset += (count - visible) * 2;
      this.x += count;
      this.advanceRow();
    }
    if (offset < data.length) this.highByte = data[offset];
  }

  writeOne(color) {
    if (this.x < SIZE && this.y < SIZE) this.packed[this.y * SIZE + this.x] = RGB565[color];
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
