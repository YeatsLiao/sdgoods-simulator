import { readFileSync } from "node:fs";
import { describeFirmware } from "../web/js/device/firmware.js";
import { formatBytes, formatHex } from "../web/js/shared/format.js";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("用法: node tools/inspect_firmware.mjs <firmware.bin>");
  process.exit(2);
}

const bytes = readFileSync(file);
const info = describeFirmware(bytes);
console.log(`文件: ${file}`);
console.log(`大小: ${formatBytes(bytes.byteLength)} (${bytes.byteLength} 字节)`);
if (info.app) {
  console.log(`工程: ${info.app.project}`);
  console.log(`版本: ${info.app.version}`);
  console.log(`构建: ${info.app.date} ${info.app.time}`);
  console.log(`IDF:  ${info.app.idf}`);
  console.log(`描述符偏移: 0x${formatHex(info.app.offset)}`);
} else {
  console.log("应用描述符: 未找到");
}
if (info.partitions.length) {
  console.log("分区表:");
  for (const part of info.partitions) {
    console.log(
      `  ${part.label.padEnd(12)} type=${part.type} sub=${part.subtype} ` +
      `offset=0x${formatHex(part.offset, 6)} size=0x${formatHex(part.size, 6)}`,
    );
  }
} else {
  console.log("分区表: 未找到");
}
