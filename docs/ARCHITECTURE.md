# 架构与模块契约

> 本文件是本轮重构的施工图。新增代码按此目录和接口落位；市场 API 本轮不接。

## 1. 目标

- 从平铺脚本整理为 `web/` + `server/` + `tools/` + `tests/` + `docs/`。
- 前端保持原生 ES 模块与零构建依赖，`python server/serve.py` 即可运行。
- 同一套 UI 支持浏览器 WASM 与本机加速两种设备会话。
- 本机模式改为常驻 Worker + WebSocket，支持音频、低延迟输入和快速切换。
- 浏览器模式补齐 WebGL 渲染、I2S 音频、Flash 快照、串口/寄存器等调试能力。
- 官方市场接口留到下一轮；本轮只做本地示例、文件、URL 三种来源。

## 2. 目录

```text
sdgoods-simulator/
├── start.cmd
├── AGENTS.md
├── README.md
├── web/
│   ├── index.html
│   ├── css/
│   ├── js/
│   │   ├── main.js
│   │   ├── app/          # App 装配、状态、快捷键、引导
│   │   ├── device/       # 会话、Worker、协议、WASM/本机运行时、屏幕解码、固件解析
│   │   ├── render/       # WebGL/2D 渲染、截图、录屏
│   │   ├── audio/        # PCM、AudioWorklet、麦克风
│   │   ├── flash/        # 稀疏快照、镜像拼装
│   │   ├── library/      # 示例/文件/URL 三类固件来源与缓存
│   │   ├── debug/        # 串口、性能、检查器、输入宏
│   │   ├── ui/           # DOM 组件与面板
│   │   └── shared/       # 事件、DOM、格式化、存储
│   ├── platform/         # 官方 prebuilt bootloader/分区表
│   └── assets/           # 虚拟网络 NVS 预置镜像
├── server/
│   ├── serve.py          # 静态资源、/api/status、/demo.bin、WebSocket、中继路由
│   ├── runtime.py        # ESP-EMU 下载、校验、WSL 检测
│   ├── ws.py             # 最小 WebSocket 服务端实现（无三方依赖）
│   ├── relay.py          # 浏览器模式 TCP/UDP/DNS 网络中继
│   └── native_worker.py  # 常驻本机 Worker（在 WSL/Linux 中运行）
├── tools/                # 可选命令行工具
├── tests/                # Node 内置 test runner 的单元测试
├── docs/
│   ├── PRODUCT_PLAN.md
│   ├── ARCHITECTURE.md
│   └── PROTOCOL.md
└── runtime/              # 下载的 ESP-EMU、会话 Flash（gitignore）
```

## 3. 总体数据流

```text
UI (main thread)
  ├─ DeviceSession ── Worker ── WasmRuntime ── ESP-EMU WASM
  │                        └── NativeRuntime ── WebSocket ── serve.py ── native_worker.py ── ESP-EMU 原生
  ├─ Renderer       画布与截图/录屏
  ├─ AudioEngine    AudioWorklet 播放；MicCapture 采集
  └─ Library        示例 / 本地文件 / URL / 最近使用
```

- 主线程只做 UI、渲染、音频输出和存储；模拟器运行在 Worker。
- 两种模式共用 `Panel` 屏幕解码、`protocol` 编解码、`firmware` 解析、`flash` 快照。
- 本机模式的 Worker 只负责 WebSocket，不在浏览器里跑 WASM。
- 浏览器模式的网络流量由 WASM NAT 经 `ws://<host>/relay` 交给 `server/relay.py`，再访问本机网络。

## 4. 前端契约

### 4.1 DeviceSession（`web/js/device/session.js`）

主线程使用的类，内部创建 `worker.js`。

```js
const session = new DeviceSession();
session.on("frame", ({ packed, frame }) => {/* Uint16Array RGB565 */});
session.on("audio", ({ pcm, format }) => {/* ArrayBuffer */});
session.on("audioformat", (format) => {});
session.on("log", (text) => {});
session.on("status", (text) => {});
session.on("booted", (info) => {});
session.on("error", (message) => {});
session.on("stats", (stats) => {});
session.on("flash", (bytes) => {});
session.on("registers", (data) => {});
session.on("memory", (data) => {});
session.on("gpio", (data) => {});
session.on("fault", (report) => {});

await session.boot({
  mode: "wasm" | "native",
  firmware: ArrayBuffer,       // 原始固件
  flash: ArrayBuffer | null,   // 可选：已保存的 Flash 快照
  name, flashKey, preserveFlash
});
session.touch({ x, y, down });
session.key(down);
session.uart(text);
session.mic(arrayBuffer);      // Int32 PCM，16 kHz 单声道
session.restart({ clearFlash: false });
session.stop();
session.requestFlash();
session.requestRegisters();
session.requestMemory(addr, len);
session.requestGpio();
session.loadElf(arrayBuffer);
```

### 4.2 Worker 消息（`web/js/device/worker.js`）

主 → Worker 使用与上节方法同名的 `{ type, ... }` 消息；二进制用 transferable。
Worker → 主使用事件名 `{ type: "frame" | "audio" | ... }`。

字段约定：

| type | 方向 | 负载 |
|---|---|---|
| `boot` | → | `mode, firmware, flash, name, flashKey, preserveFlash` |
| `restart` | → | `clearFlash` |
| `touch` | → | `touch: {x,y,down}` |
| `key` | → | `down` |
| `uart` | → | `text` |
| `mic` | → | `pcm: ArrayBuffer` |
| `requestFlash` | → | 无 |
| `requestRegisters` / `requestMemory` / `requestGpio` | → | 参数 |
| `loadElf` | → | `bytes` |
| `frame` | ← | `packed: ArrayBuffer, frame: number` |
| `audio` | ← | `pcm: ArrayBuffer, format: {rate, channels, bits, receive}` |
| `audioformat` | ← | 同上 format |
| `log` / `status` / `error` | ← | 字符串 |
| `booted` | ← | `{name, version, project, idf, size, mode}` |
| `stats` | ← | `{fps, frameMs, mips, realTime, frames, transport}` |
| `flash` | ← | `bytes: ArrayBuffer` |
| `registers` / `memory` / `gpio` | ← | WASM 调试数据 |
| `fault` | ← | 崩溃报告字符串 |

### 4.3 Runtime 接口

`WasmRuntime` 与 `NativeRuntime` 都实现：

```js
start(options)      // options 同 boot
stop()
restart({clearFlash})
touch({x,y,down})
key(down)
uart(text)
mic(arrayBuffer)
requestFlash()
requestRegisters()
requestMemory(addr,len)
requestGpio()
loadElf(bytes)
```

Runtime 通过构造参数拿到 `emit(type, payload, transfer?)`。

### 4.4 Panel（`web/js/device/panel.js`）

- 解析 ST77916 QSPI 的 0x2A/0x2B/0x2C/0x3C。
- 内部保存 `Uint16Array(360*360)` RGB565 与 `dirty`。
- `transfer(fields)` 接收 SPI 传输字段。
- `takeFrame()` 返回一帧副本 `Uint16Array`，无新帧返回 null。
- `reset()` 复位窗口/命令/半字节状态。
- 保留现有奇偶字节、跨窗口和越界裁剪行为。

### 4.5 Renderer（`web/js/render/renderer.js`）

```js
const r = new Renderer(canvas);
r.draw(packed);              // 调度 rAF，只画最新帧
r.reset();
await r.screenshot();        // Blob image/png
r.captureStream(30);         // MediaStream
r.type;                      // "webgl" | "2d"
r.stats;                     // {frames, drawMs, dropped}
```

优先 WebGL2 + `RGB565` 纹理；不可用时 2D + RGB565 LUT。画布固定 360×360，CSS 缩放。

页面隐藏时 `requestAnimationFrame` 可能完全停摆，所以 `draw()` 在 `visibilityState === "hidden"` 下改用 32 ms 短定时器合并绘制，`visibilitychange` 恢复可见时立即同步绘制最新帧。两种情况都只保留最新帧，`dropped` 只统计被替换的未绘制帧。

### 4.6 Audio（`web/js/audio/`）

- `codec.js`：纯函数。`pcm16ToFloat32`、`pcm32ToFloat32`、`resampleLinear`、`interleaveStereo`、`encodeMic32`、`mixLevel`。
- `engine.js`：`AudioEngine`。`init()`、`play(pcm, format)`、`setVolume(v)`、`setMuted(b)`、`createRecordingStream()`、`levels`、`close()`。
- `mic.js`：`MicCapture`。`start()`、`stop()`、事件 `data`（Int32Array，16 kHz 单声道）、`level`。
- `worklet.js`：`speaker-processor` 与 `mic-processor` 两个 AudioWorkletProcessor。
- 播放缓冲目标 100–150 ms；欠载补静音；电平每 100 ms 上报。

### 4.7 Firmware（`web/js/device/firmware.js`）

- `parseAppDescriptor(bytes)`：扫描 `esp_app_desc_t` 魔数，返回 `{project, version, time, date, idf}`。
- `parsePartitionTable(bytes)`：从 0x8000 解析分区。
- `describeFirmware(bytes)`：合并信息，失败返回 `{error}`。
- `sha256Hex(buffer)`：浏览器/Node 通用。
- 纯函数，无 DOM 依赖，便于 Node 测试。

### 4.8 Flash（`web/js/flash/`）

- `store.js`：`FlashStore`，IndexedDB。
  - `save(key, base, flash)`：4 KB 块稀疏差分，`CompressionStream("deflate")` 压缩后存储。
  - `load(key, base)`：返回重建后的 `Uint8Array` 或 null。
  - `clear(key)`、`list()`。
- `image.js`：`assembleParts(parts)`、`assembleSingleApp({bootloader, partitionTable, app, offset=0x10000})`，纯函数，带重叠/越界校验；空隙填 `0xFF`，与擦除态 Flash 一致。
- `app-package.js`：`isAppPackage(bytes)` 识别无分区表的纯 app 包；`toBootImage(firmware)` 用 `web/platform/` 的官方引导层拼成 factory 调试镜像。纯 app 包和整机镜像在 NVS 分区为空时都会写入 `web/assets/nvs-seed.bin`（`myssid`／`mypassword`，覆盖 `radio`、`bmb_net`、`wifi` 命名空间；`sdg_cc` 音量 70%），已有 NVS 数据不覆盖。
- `otadata.js`：按 IDF 格式写入/解析 `esp_ota_select_entry_t`（`ota_seq = slot+1`，CRC32、状态），用于选槽。
- `device-image.js`：从官方分区表解析 `otadata` 与 `ota_0..3`，把纯 app 包写入选中槽并生成完整 Flash；factory 区留空。
- `slots.js`：4 槽元数据（entry id、SHA-256、名称、版本）持久化在 localStorage，固件字节复用 SHA-256 缓存；启动槽使用 `slot-<index>-<sha>` 作为 `flashKey`，并通过 `flashPatch` 在恢复的 Flash 快照上重写 otadata。
- 槽能力默认隐藏，普通使用以单应用运行（拼成 factory 调试镜像）为主；官方 launcher 固件 UI 需要提供官方初始整机镜像后直接按整机镜像运行。

### 4.9 Library（`web/js/library/`）

```js
class FirmwareLibrary {
  list();                         // 条目数组
  async loadSample();             // /demo.bin
  async addFile(file);
  async addUrl(url, {sha256});
  async prepare(entry);           // 返回 {firmware, info, flashKey}
  remove(id);
}
```

条目：`{id, name, kind: "sample"|"file"|"url", size, version, project, source, lastUsed}`。
文件内容按 `flashKey` 存 IndexedDB（`library-cache`），刷新页面后仍可重跑。最近使用用 localStorage，列表按最近使用排序。
市场来源留 `kind: "market"` 的占位，不在本轮实现。

### 4.10 Debug（`web/js/debug/`）

- `console.js`：`DebugConsole`，支持追加、分级、搜索、暂停、清空、下载、发送。
- `stats.js`：`StatsPanel`，更新 FPS/帧耗时/MIPS/实时倍率/传输。
- `inspector.js`：`Inspector`，固件信息、分区、寄存器、GPIO、内存、Flash 导出/清除、ELF 选择。
- `macros.js`：`MacroRecorder`，记录 `{t, touch|key}`，按时间回放。
- 录屏逻辑放 `web/js/render/recorder.js`：`Recorder`，WebM + 可选音轨。

### 4.11 UI（`web/js/ui/` + `web/css/`）

- `components.js`：`el`、`button`、`card`、`field`、`tabs`、`toast` 等 DOM 帮助函数。
- `panels.js`：玩法库、串口、性能、音频、调试、关于六个面板的 DOM 构建。
- 布局：桌面左侧设备、右侧面板；移动端设备置顶、面板底部 Tab。
- 默认简洁模式；`?dev=1` 或按钮开启开发者模式。
- 不引入前端框架与第三方依赖。

## 5. 本机模式协议

### 5.1 浏览器 ↔ serve.py（WebSocket）

- 地址：`ws://<host>/ws/native`，仅接受同源 `Origin`。
- 文本帧：JSON 控制消息。
- 二进制帧：首字节类型。

浏览器 → 服务端：

| 类型 | 负载 |
|---|---|
| `0x10` load | `u32 jsonLen + json + firmware bytes`，json 含 `name/size/sha256/flashKey/preserveFlash/flashPatch` |
| `0x11` elf | ELF 字节（重启后生效） |
| `0x12` mic | `u32 rate + u16 channels + u16 bits + PCM` |
| 文本 | `{type:"touch"|"key"|"uart"|"restart"|"clearFlash"|"stop"|"flash"|"registers"|"memory"|"gpio", ...}` |

服务端 → 浏览器：

| 类型 | 负载 |
|---|---|
| `0x01` frame | `u32 frame + SPI 传输消息`（由 `Panel.transfer(fields(...))` 解码） |
| `0x02` audio | `u32 rate + u8 channels + u8 bits + u8 receive + u8 reserved + PCM` |
| `0x03` log | UTF-8 日志 |
| `0x04` event | UTF-8 JSON：`{kind:"booted"|"status"|"error"|"fault"|"flash"|"stats"|"audioformat"}` |
| `0x05` flash | 完整 Flash 字节（导出） |

### 5.2 serve.py ↔ native_worker.py

- 子进程 stdin/stdout，帧格式：`u32 len + u8 type + payload`，与浏览器二进制类型一致；文本控制统一包装为 `0x04` JSON。
- Worker 负责启动/停止 ESP-EMU 子进程、协同仿真、触摸、I2S、日志、Flash 文件。
- Worker 在 WSL/Linux 中运行；serve.py 负责 `wslpath` 转换和进程回收。
- 每浏览器会话一个 Worker；WS 关闭即回收。

### 5.3 本机协同仿真注册

- 显示：现有 QSPI claim。
- 触摸：CST816S `0x15`，SCL 10 / SDA 11。
- 侧键：GPIO6，输入驱动。
- 音频：一个 I2S claim，`dout=47, din=17, bclk=48, ws=38`。
- 音频格式：扬声器接受 16-bit PCM，采样率按 I2S 报文自适应（16/48 kHz 等），统一重采样到 AudioContext；麦克风 16 kHz / 32-bit / 单声道。
- I2S 消息字段：`I2sFormat`=29（`receive=1, rate=2, channels=3, bits=4`）、`I2sOut`=30（`pcm=1`）、`I2sIn`=31（`pcm=1`）。
- 触摸快速点击保护、半字节对齐等现有逻辑保留。

### 5.4 浏览器网络（`server/relay.py`）

- 浏览器模式的 WASM 只在页面内跑 Wi-Fi 和 DHCP；访问真实网络需要按 `esp-emu-relay` 协议把 TCP/UDP 流带到宿主。
- `WasmRuntime.start()` 调用 `emulator.net_set_relay("ws://<host>/relay")`；`serve.py` 把 `/relay/*` 交给 `relay.py`。
- 端点：`/relay/tcp?host=H&port=P`、`/relay/udp?host=H&port=P`（WebSocket 二进制即流数据，空帧表示 FIN）、`/relay/dns?dns=<base64url>`（只回 A 记录）、`/relay/version`、`/relay/listen`（保持连接，无端口转发）。
- 中继只接受回环 Host 与回环 Origin；仅 IPv4；不终结 TLS，证书校验仍在固件内完成。
- 本机模式不经过该中继，直接使用 ESP-EMU 的 `--net user`。

## 6. 安全

- 本机服务只绑定 `127.0.0.1`，WS/HTTP 校验 `Origin` 与 `Host`；网络中继同样只接受回环来源。
- 网络中继不执行宿主命令，只转发字节流；DNS 只返回 A 记录，不做递归服务对外监听。
- 固件、ELF、URL 都做大小与格式校验；市场文件校验 SHA-256（后续）。
- 不执行固件中的宿主命令；不把固件上传到远端。
- 日志与 Flash 默认仅本地；清除数据入口明确。

## 7. 质量与测试

- `node --test tests/*.test.js`：协议、Panel、固件解析、镜像拼装、音频 PCM。
- `python server/serve.py --port 8766 --no-browser` 手动验收；不要占用/终止 8765 上的旧会话。
- 验收两种模式：启动、画面、触摸、侧键、重启、音频格式、Flash 持久化、截图。
- 本机模式额外验收：WS 重连、切固件、Worker 回收、麦克风数据。
- 浏览器模式额外验收：WebGL/2D 回退、WASM 音频、寄存器/GPIO 面板。

## 8. 文件所有权（本轮并行）

| 区域 | 负责 |
|---|---|
| `web/js/device/panel.js`、`firmware.js`、`web/js/flash/image.js`、对应 tests | 子代理 1 |
| `web/js/audio/**`、对应 tests | 子代理 2 |
| `server/**`、`tools/ws_smoke.py` | 子代理 3 |
| `web/index.html`、`web/css/**`、`web/js/ui/**`、`web/js/library/**` | 子代理 4 |
| `web/js/debug/**`、`web/js/render/recorder.js` | 子代理 5 |
| `web/js/device/session.js`、`worker.js`、`wasm-runtime.js`、`native-runtime.js`、`protocol.js`、`web/js/flash/store.js`、`web/js/app/**`、`web/js/main.js`、`start.cmd`、文档 | 主代理 |

## 9. 风格

- 原生 ES 模块、JSDoc 类型、无构建步骤、无第三方运行时依赖。
- 文件名小写连字符；导出用具名导出。
- 注释只写非显而易见的约束，不写逐行解释。
- UI 文案中文；标识符英文。
- 新增模块先写纯函数，再接 DOM/网络。
