# 架构与模块契约

2026-11-22 设备展示更新：以用户提供的 1.85 英寸设备照片为参考，使用正视圆屏、黑色玻璃面、窄银边及右上方金属侧键。仅改变 DOM/CSS 展示，Canvas 仍是 360×360，触摸换算与 GPIO6 协议保持。侧键扩展点击区域并支持指针取消释放；App.key 统一更新按下视觉与设备输入，短按/长按语义由固件处理。固件面板增加三步操作说明，继续使用单一本地 BIN 主入口。

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
  ├─ DirectStreamPlayer  跟随设备电台地址，浏览器直接取流连续收听
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
| `stats` | ← | `{fps, frameMs, mips, realTime, frames, transport}`；本机模式 `realTime` 来自 `SIM/CLOCK` 模拟时间增量，WASM 模式按 CPU 周期折算，`mips` 为 null。主线程在 `app.js` 合并渲染与音频读数（`audioQueue`/`audioArrival`/`audioUnderruns`）后交给 `StatsPanel` |
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

- `codec.js`：纯函数（Node 可测）。`pcm16ToFloat32`、`pcm32ToFloat32`、`interleaveStereo`、`encodeMic32`、`mixLevel`，以及流式重采样 `createResampler`、响度自适应 `applyMakeupGain`、到达率统计 `trackArrival`。
- `engine.js`：`AudioEngine`。`init()`、`play(pcm, format)`、`setVolume(v)`、`setMuted(b)`、`createRecordingStream()`、`levels`（输出 RMS、排队帧数、欠载、补偿增益、到达率、`capture`、`replay`）、`startCapture(seconds)`、`playCapture()`、`autoReplay`／`setAutoReplay({enabled,target})`、`flush()`、`close()`。
- `mic.js`：`MicCapture`。`start()`、`stop()`、事件 `data`（Int32Array，16 kHz 单声道）、`level`。
- `worklet.js`：`speaker-processor` 与 `mic-processor` 两个 AudioWorkletProcessor。扬声器侧做环形缓冲、±1 安全钳位、自适应预缓冲与 5 ms 淡入淡出、欠载计数与每 100 ms 电平上报，并响应主线程的 `{type:"live", on}` 停放消息；麦克风侧做线性抽取到 16 kHz 并按 320 样本成块。
- 播放链路（`engine.js`）：按报文 `bits` 解码 → 立体声先分声道 → 每声道一个 `createResampler` 实例流式重采样到 AudioContext 采样率（游标跨报文保持相位，最新样本持平等下一块补右邻居；`rate/channels/contextRate` 不变就复用实例，`flush()` 后重建）→ 合并为交织立体声 → `applyMakeupGain` 就地做响度自适应 → 送 `speaker-processor` 环形缓冲；自动连续回放开启时改道写入缓存（见下），环形缓冲同时被停放。
- 响度自适应参数（`codec.js`）：目标 RMS 0.12、期望增益限在 1×–16×、RMS 达到 0.096（目标的 0.8 倍）即视为已够响不再抬升、低于一个 16-bit LSB 视为数字静音并冻结当前增益、头余量按 `0.9/峰值保持` 封顶（峰值每块衰减 0.995）、按块平滑（快攻 0.04、慢放 0.02）。工作点以下只抬升、从不压制到 unity 以下，固件音量与底部音量条仍然有效。`levels.makeup` 是本块实际施加的增益。
- 到达率：`engine.js` 用 `trackArrival` 每 1 秒窗口统计「音频秒数／墙钟秒数」（上限 2×），随 `levels.audioRatio` 暴露给「音频」面板与性能面板。实时倍率是另一个口径：本机模式由 `server/native_worker.py` 从协同仿真的 `SIM/CLOCK` 模拟时间增量算出（模拟秒／墙钟秒），经 `stats.realTime` 上报；WASM 模式由 CPU 周期数折算。两者不可互相比较，也不要与到达率混用。电台类音频受 ESP-EMU 算力限制，到达率会低于 100%，表现为断续而非无声。电台实测两者同为 0.18–0.35（`esp-emu` 独占一核 100%，调 `--batch-size` 无改善），播放占空比就等于到达率：实时路径的缓冲只改变断续的形状，不改变音频总量，连续播放由下面的缓存回放承担。
- 扬声器环形缓冲容量 3 秒，写入溢出时丢最旧帧以约束延迟。读取端按自适应预缓冲起播：60 ms 起、每出现一次断流翻倍到 1 s 上限、连续 2 秒无断流再减半；缓冲降到 30 ms 低水位时用 5 ms 淡出结束这一段，淡出期间若缓冲回补则重新打开，之后补静音，一次断流只计一次欠载。上限取 1 s 是因为听感抱怨来自「切换次数」而不是占空比：再长只会把静音拉得更久。收到 `{type:"live", on:false}` 时环形缓冲清空并停放：只输出静音、不计欠载、不做预缓冲自适应，因为这段静音是设计的一部分而不是故障；`on:true` 恢复。停放状态由 `engine.js` 的 `#syncLive()` 统一推导（既不在缓存也不在回放才算实时），`play()` 每次送样本前再同步一次，避免 AudioContext 被挂起时 `onended` 没触发导致一直停放。
- 连续回放（`engine.js`，默认开启，`autoReplay.target` 默认 4 秒）：`play()` 在没有缓存且自动开启时武装一次 `startCapture()`，把补偿后的交织样本按块存进 `#capture.chunks`；攒到 `target` 秒即 `playCapture()` 拼成一个 `AudioBuffer`，两端各 5 ms 线性淡入淡出，顺带算出整段 RMS，然后 `createBufferSource()` 接 `#gain`，起播时刻 `when = max(ctx.currentTime, 上一段 endsAt)`——上一段还没播完就无缝接上，播完了就立刻起播。`onended` 里 disconnect、清 `#replay` 并重新同步停放状态；自动开启时立刻武装下一段缓存，于是「播放这一段」与「缓存下一段」重叠进行。`setAutoReplay({target})` 会就地改写正在进行的缓存目标；关闭自动则丢弃缓存并恢复实时。`flush()`／`close()` 通过 `#stopReplay()` 摘掉 `onended` 再 `stop()`，防止已释放的 source 回调把状态改回去。回放期间 `levels.outRms` 取整段 RMS、`outQueued` 取 `remaining × sampleRate`，面板读数与实际听到的声音一致。
- 连续回放的 UI 与持久化：「音频」面板的「连续回放」区块按 `levels.capture`／`levels.replay` 渲染 waiting／caching／playing／live 四态（缓存琥珀色、播放青色），给出进度条、`缓存中 X.X / N 秒`、按到达率估算的 `约还需 N 秒`、`连续播放 剩余 X.X 秒` 与下一段缓存进度；自动开关与每段时长（2／4／8／16 秒）写入 `shared/storage.js` 的 `audioReplay` 键，`app.js` 启动时读回并夹到合法档位。手动按钮在缓存中是「立即播放缓存」（播已攒到的部分），空闲时是「缓存 N 秒后播放」。
- `direct.js`：连续收听（浏览器取流），与 `engine.js` 平行的第二条出声路径。
  - `parseStreamUrl(text)`：从设备串口文本里取当前流地址，认 `streaming: <url>` 与 `http 30x -> <url>` 两种播放器日志行，不认 `GET https://…`（那是取电台列表）。带 `g` 标志并**取最后一条匹配**：调用方为拼跨块的行会留一段尾巴缓冲，旧地址还在里面。`isDirectPlayable(url)` 只按形态拒绝 `.m3u8`／`.mpd`／`.pls` 与非 http(s)；`stationLabel(url)` 用主机名+路径末段命名，不替电台编名字。
  - `DirectStreamPlayer`：懒建一个 `<audio>`（`preload="auto"`），`play({url})` → `state` 给出 `playing/buffering/name/url/buffered/continuous/gaps/position/volume/muted/error`。`continuous` 是从最近一次开播起的连续秒数，`gaps` 是断流后重新开播的次数；直播流的 `buffered` 只是两三秒滚动窗口，不能当"还能听多久"显示。失败原因按 `MediaError.code` 分类成中文短句，`NotAllowedError` 单独提示要点第二次。**切台让路**：上一路 `await element.play()` 被浏览器中断时，若 `#station.url` 已变就返回 false 且不写 `#error`；`error` 事件在 `#station` 为空时忽略。`onChange` 供 app 订阅。
  - 跟随与交还：`app.js` 在 `session.on("log")` 里调 `maybeFollowStream(text)`（尾巴 400 字符），跟随开启且地址变化时接同一路流；`lastDeviceAudioAt` 由设备 I2S 报文刷新，跟随那一路若 4 秒没有设备音频就 `stopDirect()` 交还输出，手动地址不受此约束。`audioDirect` 存跟随开关，默认开。
  - 与设备音频的交接：起流时 `audio.setExternalAudio(true)`，引擎把设备 PCM 降为「只统计到达率」（不解码、不重采样、不入环、不唤醒 AudioContext），同时清缓存、停回放并停放环形缓冲；停止或取流失败时 `setExternalAudio(false)` 交还。`engine.js` 的 `#syncLive()` 把 `external` 与 `capture`／`replay` 一起算作停放条件，`#setup()` 末尾按当前归属重停一次。
  - UI：「音频」面板的「连续收听（浏览器取流）」区块 = 跟随开关 + 停止 + 进度条（0–60 秒刻度）+ 四态（idle／buffering／playing／error，青色在播、琥珀建缓冲、橙红失败）+ 折叠的「改用其他地址」。**面板不列电台清单**，避免变成第二个电台客户端。扬声器区多一枚标签写明「实时输出／输出暂停 · 连续回放／输出暂停 · 浏览器取流」，避免把设计中的静音读成设备没声音。

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
- `stats.js`：`StatsPanel`，更新 FPS/帧耗时/MIPS/实时倍率/传输/丢帧，另有音频队列、音频到达、音频欠载三张卡片（首次带值才显示）。
- `inspector.js`：`Inspector`，固件信息、分区、寄存器、GPIO、内存、Flash 导出/清除、ELF 选择。
- `macros.js`：`MacroRecorder`，记录 `{t, touch|key}`，按时间回放。
- 录屏逻辑放 `web/js/render/recorder.js`：`Recorder`，WebM + 可选音轨。

### 4.11 UI（`web/js/ui/` + `web/css/`）

- `components.js`：`el`、`button`、`card`、`field`、`tabs`、`toast` 等 DOM 帮助函数。
- `panels.js` 装配工具导航和通用面板；固件、音频与内部槽分别由独立模块构建。「声音」面板的扬声器区显示格式、输出去向和电平；响度补偿、到达率与欠载放入折叠的高级区域，「连续收听」区块显示跟随开关、当前地址、连续秒数与打断进度（`setDirectState` 驱动，控件走 `sdg:direct` 事件），「连续回放」区块显示缓存/播放状态、进度条、自动开关、每段时长与手动播放按钮（`setAudioLevels` 驱动四态，`setReplayPrefs` 同步控件，`setCaptureActive` 切换按钮文案），麦克风区显示 16 kHz／32-bit／单声道与输入电平。
- 静态资源不带版本哈希，`serve.py` 对未显式设置缓存头的响应补 `Cache-Control: no-cache`（`/api/status`、`/demo.bin`、`/runtime/*` 仍是 `no-store`），否则浏览器会拿旧的 CSS 或 `worklet.js`，改完面板看不到效果。
- 布局：桌面左侧工具导航、中间设备、右侧可收起面板；窄屏导航置顶，首次打开先显示导入，运行后显示设备。
- 默认简洁模式；`?dev=1` 或「调试工具」开启串口、性能与检查器。
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
- 音频格式：扬声器接受 16-bit／32-bit PCM，采样率与声道数按 `I2sFormat` 报文自适应（电台常见 48 kHz 立体声），跨报文保持相位地流式重采样到 AudioContext；麦克风固定 16 kHz / 32-bit / 单声道。
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

- `node tools/run-tests.mjs`：协议、Panel、固件解析、镜像拼装、音频 PCM。
- `python server/serve.py --port 8766 --no-browser` 手动验收；不要占用/终止 8765 上的旧会话。
- 验收两种模式：启动、画面、触摸、侧键、重启、音频格式、Flash 持久化、截图。
- 本机模式额外验收：WS 重连、切固件、Worker 回收、麦克风数据。
- 浏览器模式额外验收：WebGL/2D 回退、WASM 音频、寄存器/GPIO 面板。

## 8. 工作台界面职责（2026-11-20）

- `web/js/ui/panels.js`：界面装配、工具导航、通用状态与提示。App 唯一负责开发者模式切换；界面只渲染该状态。
- `web/js/ui/library-panel.js`：导入、URL 与最近使用。发出 `sdg:library` 事件，`file` 动作和文件选择均调用 App.addFile。
- `web/js/ui/audio-panel.js`：电平、麦克风、声音来源与折叠的高级播放/诊断。保留原事件及音频策略，不处理 PCM。
- `web/js/ui/slots-panel.js`：内部应用槽和虚拟 launcher，仍默认隐藏。
- `web/js/ui/workspace.js`：面板开合、布局反馈、拖放与清除数据确认。
- `web/js/app/workspace-state.js`：纯状态转换。idle → preparing → starting → waiting → running；error 可重新导入。booted 仅代表固件启动，收到屏幕帧才进入 running。
- `web/js/app/slot-controller.js`：内部槽安装、镜像与启动流程，接收 App 的共享服务；不增加主界面入口。
- `web/js/app/firmware-info.js`：两种启动流程共用的数据转换与固件摘要。

右侧工作面板默认显示固件导入，首帧后自动收起；如果用户在启动中主动打开工具，该面板保持。收起面板时恢复工具按钮焦点。窄屏首次打开将导入区置于设备之前，运行中打开工具自动滚动到对应面板。

清除当前固件数据使用原生 dialog；取消不会调用 flashStore.clear 或 session.restart。按键、输入框、对话框内的键盘操作不会触发设备快捷键。

视觉设计与回归记录见 [UI_REDESIGN_PLAN.md](UI_REDESIGN_PLAN.md)。不再保留历史单轮并行所有权列表。

## 9. 风格

- 原生 ES 模块、JSDoc 类型、无构建步骤、无第三方运行时依赖。
- 文件名小写连字符；导出用具名导出。
- 注释只写非显而易见的约束，不写逐行解释。
- UI 文案中文；标识符英文。
- 新增模块先写纯函数，再接 DOM/网络。

## 游戏实时音频补充（2026-11-20）

App 将播放方式同步到 AudioEngine 的自动回放偏好；Worklet 通过内部 `latency` 消息选择实时互动与原语音缓冲配置。实时队列最多 120 ms，预缓冲 20–80 ms，统计 `queueMs/prerollMs/dropped`。多段 BufferSource 由 Set 管理，退出分段回放立即全部停止。此消息只在主线程和 AudioWorklet 间传递，不改设备 Worker/WebSocket/协同仿真协议。测试与实测限制见 `AGENTS_AUDIO.md`。

## 小智类分区与虚拟配网修复（2026-11-20）

`flash/network-seed.js` 统一定位 data/nvs 且名称为 `nvs` 的分区，供 app-package 与内部槽布局共用。小智/傻妞整机表首先列出 `nvsfactory`（0x9000），随后才是默认 `nvs`（0x3b000）；旧逻辑按 subtype 首项选择，把正确的 wifi 命名空间写到了错误分区。固件使用默认 nvs_open，因读不到已保存网络而进入 SoftAP 配网。

修复仅改空白分区的预置位置，不改原固件、不导出真实热点、不代理 192.168.4.1。非空 NVS 保留，旧会话的快照是否仍覆盖预置需要区别处理。测试使用独立 flashKey，避免接触用户正在运行的会话。Wi-Fi、云端服务与账号激活分开记录。

验证：178 项主机测试通过，新增 nvsfactory 在前、nvs 在后的回归，覆盖空白与已有数据保护。傻妞 0.1.0 本机模式已取得 IP，并解析到 MQTT 服务地址；小智 2.5.0 在本机与 WASM 模式均取得 IP。尚未验证账号激活与麦克风语音对话。截图在忽略目录 `.playwright-cli/` 的 `shaniu-network-later.png`、`xiaozhi-network-fixed.png` 和 `xiaozhi-wasm-network-fixed.png`。


## 2026-11-22 产品界面收敛（当前行为）

主页面固定为视口高度，设备随高度与宽度缩放；长列表和开发工具只在各自容器内部滚动。去掉常驻数据保存说明、规格与重复引导。

`panels.js` 继续作为 App 的 UI 装配入口，但 `workspace-panel` 根据 `data-surface` 呈现最近使用浮层、声音浮层、关于/配网说明或独立开发工具。普通浮层无页签；仅开发工具显示日志、性能、设备、音频四个页签。小屏浮层隔离背景交互并限制焦点，Escape 与关闭恢复入口焦点；桌面短浮层点击外部可收起；占位的开发工具由关闭按钮或 Escape 收起，设备输入不会关闭它。

`library-panel.js` 显示最近使用名称与打开按钮，不展示来源/大小/时间标签。首页和更换调用同一个文件输入，链接表单移至设备工具，仍发出原 sdg:library 事件。声音浮层持有现有 mute/volume/mic 控件，`audio-panel.js` 保留于开发工具进行诊断，未修改 PCM 或播放算法。`clear-open` 是更多菜单清除入口，继续调用 App.restart(true) 和原生确认框。检测到配网时开放说明入口；已有工具打开时只提示，不抢换面板。上文旧侧栏布局记录由本节替代。


### 字体、控件与占位侧栏（2026-11-22）

base.css 统一界面字体、圆角、边框、焦点与控件高度（常规 42px、紧凑 36px）。debug.css 的界面文字与表单继承同一变量，日志/寄存器数值保留等宽。中文系统字体现已通过浏览器实际字体查询确认为 Microsoft YaHei；不需要加载在线字体或增加运行时依赖。

桌面（>800px）开发工具宽度由 --tools-width 控制，主区及顶部动作同步让出空间；运行画布依然正圆，布局变化不改变屏幕坐标换算。普通短浮层与手机覆盖面板维持原行为。CSS 机身以现有硬件参考图为依据，简化为单条金属边与低反光侧壳，侧键位于约两点钟方向、短且接近齐平。图片缺少正面 CAD 标定，不把此效果视为精确尺寸模型。

外观依据补充（2026-11-22）：以用户最新实拍为准，正视机身不显示厚重底部凸边；侧键可见细线完全收在圆形轮廓内，保留透明点击区，输入协议不变。此前正视外凸短键的实现已被替代。


### 2026-11-25 蓝白工具工作台

按用户当次附图替换展示型首页。`web/index.html` 的左侧固件栏常驻，运行方式是同一个 `#mode` 控件，历史列表在桌面挂载到 `#sidebar-library`，手机移动回固件面板以保留已有事件与列表状态。`layout.css` 负责工作台与响应式布局，`device.css` 单独负责机身材质与侧键，不包含业务逻辑。

开发工具在桌面停靠设备区底部；打开后设备尺寸根据剩余高度缩小，点击画面不关闭。底部入口发出 `sdg:tools`，由 App 统一打开开发者模式。手机工具保持模态、焦点限制与关闭恢复；设置是非技术的音量/静音/麦克风面板，顶栏帮助和左侧关于共用兼容性说明。固件状态、第一帧反馈、DeviceSession 与 Flash 语义沿用原实现。

侧键位于约 1 点半方向，显示尺寸随设备缩放，保留透明输入区域。画布无边框，真实画面与触摸坐标不随金属边装饰改变。未使用生成稿中的示意游戏图替代实际固件画面。


工作台视觉资源（2026-11-25）：base.css 从 web/assets/fonts/ 托管 Noto Sans SC UI 字符子集及可变字重，OFL 与来源说明同目录。device.css 使用 web/assets/device/silver-shell-v1.png 的透明机身素材；Canvas 仍独立位于3.2%内边距内，侧键为透明交互层，运行中不叠加示意游戏截图。此实现替代旧的 conic/mask 材质伪元素，但不改输入协议或运行时。字体与机身都从本地静态服务读取。


### IDE 停靠与统一设置（2026-11-25）

`web/js/ui/dock.js` 提供 `dockGeometry` 纯函数以及停靠控制器：在根节点写 `data-dock`、`data-dock-max` 和两个尺寸变量，支持 Pointer Capture 拖动与方向键调节，约束持久化输入。偏好保存在 localStorage 的 `sdg:workbench:dock:v1`；窗口缩小时只约束实际尺寸，不覆盖用户偏好；最大化不持久化。手机仍由 workspace 管理模态、焦点和背景 inert。

`workbench-panels.css` 管理停靠、设置分组和谷仓色彩，沿用 base.css 字体与控件变量。开发工具仍由 App 的开发者状态驱动，左侧入口重复点击可关闭；设备区域按停靠方让位。日志内部弹性滚动，发送行始终可见。设置替代帮助/关于/更多菜单，清除按钮移动同一个节点以保留 App 业务绑定及确认语义；重置布局只修改停靠偏好。配网帮助仍仅检测到后显示。

谷仓 G 标识本地保存在 web/assets/brand/，来源及校验见该目录 README。页面不请求官网图片，不新增市场接口。当前固件通过 library.setCurrent 标出；列表点击仍只发一次 sdg:library，真实运行由 App 处理。


### 设置合并为工具页签（2026-11-25）

工具页签现为 console/performance/debug/sound（设置），移除 audio/about/setup 的独立展示面。设置与其他工具共享 data-surface=tools、停靠几何及手机模态，不存在独立设置弹窗。配网帮助保留设置内部文本，检测不自动打开。帮助内含用户指定的 yeatsliao GitHub 主页。

运行方式的原始 select 仅作为 App 事件接口，公开 UI 改为有 aria-checked 的两项选择，禁用状态跟随本机可用性，并同步模式说明；支持方向键、Home/End 和单次 change 事件。音频界面缩减为基础麦克风控制与按需电平，删除全部策略与诊断 DOM，正常启动强制使用既有实时默认值且不删除旧偏好；音频引擎和自动电台跟随保持。


### 当前 UI 分组与持久化（2026-11-25，替代上方历史 UI 分组）

开发工具为 console/performance/debug/sound/settings/about 六页签，共享 IDE 停靠，不再独立弹出设置。audio-panel.js 仅构建麦克风按钮和电平，声音页承载音量/静音；高级播放与诊断引擎可保留内部实现，不暴露旧入口。设置保留同一个 clear-open 节点以沿用确认与清除业务，reset-layout 只改 dock 偏好；关于使用全局字体与独立两行链接。

App.setSoundPreferences 经 sound-preferences.js 校验数值，将 sound 偏好写入现有本地存储，并同步 AudioEngine、DirectStreamPlayer 与 UI。启动会话沿用当前音量/静音；麦克风权限不持久化。默认实时音频路径不改 PCM、Worklet 或固件时序。

FirmwareLibrary.hideRecent 只写 recentHidden，不删除源文件、缓存和 Flash；prepare 时重新显示该条目。UI 发 sdg:library hide-history，App 仅刷新最近使用，不停止会话。

机身银色素材仅绘制在 masked 环带，不覆盖 Canvas 中心；侧键按素材映射定位，hover/pressed 反馈使用同一个几何区域。Canvas 无边框无透视，触摸 rect 与协议保持不变。完整视觉规范见根目录 DESIGN.md。


### 早期银壳实现（历史记录，已由 A 版替代）

index.html 的 device-shell SVG 与确认预览共用 silver-shell-v1.png 和1000×1000映射；环带外499/内470并保留原键帽区域，图像以105%居中。device.css 的2.2%内距控制Canvas及触摸提示基准，中心无反光遮盖；输入仍由原side按钮及App处理。悬停只有短提示，按下通过SVG中同一键帽几何轻微压暗，无新事件绑定和协议改动。


### 圆屏几何演进与休眠兼容（2026-11-26）

`.device-aperture` 用 `aspect-ratio: 1` 和 `border-radius: 50%` 统一裁剪 360×360 Canvas、等待层和触摸提示。屏幕与 SVG 环带遮罩共用 `device.css` 的圆心和直径变量。原素材内缘存在轻微不规则，正圆覆盖其暗边并伸入环带下方，接缝由上层金属边遮住。触摸继续使用 Canvas 的真实 rect。

app/power-state.js仅识别完整SDGOODS power标签信息行及电源关机栈，不按无帧/低FPS推断睡眠。App监听现有log/fault/error，无新增Worker或WebSocket协议：进入休眠后隐藏Canvas、保留固件入口；深睡已知退出/睡眠栈不作为普通崩溃弹窗。下一次侧键松开复用restart(false)，保留Flash。WASM在故障后restart重新启动tick调度。正常返回导航、轻量关屏仍发送真实GPIO；普通故障照常报告。不把此日志兼容层描述为通用LEDC背光或深睡RAM仿真。


## 发布候选版

正式机身为 `web/assets/device/silver-shell-a.webp`。透明开口直接与画布叠合，画面几何与侧键坐标以 DESIGN.md 为准。上文旧素材与遮罩参数为迭代记录。

静态发布包由 `tools/package_pages.py` 生成。入口、WASM 文件、平台引导层和静态状态文件分发在同一站点子路径下。公开站点使用浏览器运行模式，回环服务仍负责本机加速和网络中继。
