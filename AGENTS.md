# SDGOODS 次元屏模拟器开发规范

本文件适用于 `sdgoods-simulator`。项目目标是在浏览器里运行 ESP32-S3 次元屏整机固件与官方纯 app 包，并提供接近真机的调试与体验能力。先读 `README.md`、`docs/ARCHITECTURE.md` 和 `docs/PROTOCOL.md`。

## 1. 结构与技术基线

- 前端：原生 ES 模块 + JSDoc，零构建、零第三方运行时依赖。不要引入 npm 依赖或打包器，除非先更新架构文档。
- 服务端：Python 3.10+ 标准库。静态资源、`/api/status`、`/demo.bin`、`/ws/native` 由 `server/serve.py` 提供。
- 模拟器：锁定 ESP-EMU 1.1.0；WASM 与 Linux 原生二进制由 `server/runtime.py` 下载并校验 SHA-256。
- 目录：
  - `web/js/app/` 应用装配、状态、快捷键
  - `web/js/device/` 会话、Worker、协议、WASM/本机运行时、屏幕解码、固件解析
  - `web/js/render/` 渲染、截图、录屏
  - `web/js/audio/` PCM、AudioWorklet、麦克风
  - `web/js/flash/` 稀疏快照、镜像拼装
  - `web/js/library/` 示例/文件/URL 固件来源
  - `web/js/debug/` 串口、性能、检查器、输入宏
  - `web/js/ui/` DOM 组件与面板
  - `server/` HTTP、WebSocket、本机 Worker、浏览器网络中继、运行时下载
  - `web/platform/` 官方 prebuilt 引导层；`web/assets/` 虚拟网络 NVS 预置镜像
  - `tests/` Node 内置 test runner
  - `docs/` 架构、协议、产品方案
- 市场 API 接入暂缓；不要把市场请求写进当前版本。`library` 的 `market` 类型只是占位。
- 本地纯 app 包（无分区表、描述符在 0x10000 之前）由 `web/js/flash/app-package.js` 用 `web/platform/` 的官方引导层拼成 factory 调试镜像；平台引导层只从官方 `SDGOODS-ESP32S3/platform/prebuilt/` 同步，不手改。
- 拼装时若 NVS 分区为空，会写入 `web/assets/nvs-seed.bin`（`myssid`／`mypassword`，覆盖 `radio`、`bmb_net`、`wifi` 命名空间，并把 `sdg_cc` 音量预置为 70），纯 app 包和整机镜像都适用。已有 NVS 数据不覆盖。
- 多应用模式由 `web/js/flash/device-image.js`＋`otadata.js`＋`slots.js` 模拟，当前是内部能力：主界面只保留单应用运行，槽/启动器入口默认隐藏。官方 launcher 需要官方初始整机固件，拿到后直接按整机镜像加载，不要另造官方 UI。
- 网络验证使用 ESP-EMU 的虚拟 Wi-Fi `myssid` / `mypassword`；本机经 `--net user`，浏览器经 `server/relay.py` 的 `esp-emu-relay` 兼容中继（`/relay/tcp`、`/relay/udp`、`/relay/dns`）。浏览器端不依赖设备 192.168.4.1 配网页面。

## 2. 运行与测试

- 启动：双击 `start.cmd` 或 `python server/serve.py`，默认 `http://127.0.0.1:8765/`。
- 本机加速：x86-64 Linux 直接运行；Windows 需要 Ubuntu WSL。首次运行会下载原生包。
- 单元测试：`node --test tests/*.test.js` 或 `tools/test.cmd`。
- 手动验收使用 8766 及更高端口；不要终止 8765 上可能存在的旧会话。
- 修改后至少验证：
  1. 两种模式都能启动示例固件并出画面。
  2. 触摸、长按、拖动、侧键、控制中心开合。
  3. 重启保留数据；清除数据回到初始。
  4. 扬声器有声音，音量/静音有效；麦克风权限与电平。
  5. 串口日志、截图、录屏、寄存器/GPIO/内存（WASM）。
  6. 切换固件、切换模式、关闭页面后 Worker/ESP-EMU 进程被回收。
- 性能回归：同一 BIN、同一场景比较 FPS、输入响应和音频欠载；不要把渲染开销与模拟速度混为一谈（性能面板分别显示）。

## 3. 会话与协议

- 主线程只做 UI、渲染、音频和存储；模拟器运行在 Worker。
- `DeviceSession` 是主线程唯一入口；WASM 与原生模式都必须实现同一套方法。
- 浏览器模式调用 `emulator.net_set_relay()` 指向 `/relay`；改中继端点或帧语义必须同时改 `server/relay.py`、`web/js/device/wasm-runtime.js` 与 `docs/ARCHITECTURE.md`（必要时 `docs/PROTOCOL.md`）。
- 中继只绑回环、只转发字节；不执行宿主命令，不对外监听。不要把设备配网页反向代理进浏览器。
- Worker 消息、WebSocket 二进制格式、协同仿真 claim 见 `docs/PROTOCOL.md`。改协议必须同时改：
  - `web/js/device/protocol.js`
  - `web/js/device/wasm-runtime.js`
  - `web/js/device/native-runtime.js`
  - `server/native_worker.py`
  - `docs/PROTOCOL.md`
- 注册 claim 必须保留：SPI 21、I2C 0x15（SCL 10 / SDA 11）、GPIO6 侧键、I2S（bclk 48 / ws 38 / dout 47 / din 17）。
- 触摸坐标换算、快速点击保护和半字节对齐沿用现有实现，改动必须补测试。

## 4. 音频

- 扬声器：16-bit PCM，采样率随 I2S 报文（16/48 kHz 等），在 `engine.js` 重采样到 AudioContext；网络音频等低电平流在 `worklet.js` 做 3× 补偿并限幅。
- 麦克风：16000 Hz、32-bit、1 通道、小端；16-bit 样本左移 16 位。
- 音频播放走 AudioWorklet；不要用 `ScriptProcessorNode` 作为主路径。
- 麦克风默认关闭，使用时才请求权限；回声消除/降噪/自动增益默认关闭，提供诊断电平。
- 音量、静音、PA 使能状态要与 UI 一致；音频缓冲欠载必须计数。

## 5. Flash 与数据

- WASM：`flash_state()` 导出完整 Flash，按 4 KB 块与基础固件做稀疏差分，压缩后存 IndexedDB。
- 原生：每个 `flashKey` 一个会话目录，`base.bin` 是原始固件，`flash.bin` 是工作副本；`--save-state` 与 `--control-tcp read-region` 负责回写。
- “重启”默认保留数据；“清除数据”才删除覆盖层。UI 文案必须区分。
- 槽启动的 `flashKey`、`flashPatch`（重写 otadata）要保留；改槽布局或镜像拼装必须同步改 `web/js/flash/otadata.js`、`device-image.js`、`slots.js` 和对应测试。
- 渲染器在页面隐藏时用 32 ms 定时器兜底、恢复可见立即刷新；不要退回纯 `requestAnimationFrame`，否则 radio 等静态首帧会黑屏。首帧、隐藏与可见恢复由 `tests/renderer.test.js` 覆盖。
- 镜像拼装的空隙填 `0xFF`（擦除态），不要填 0；否则 NVS 初始化会失败。NVS 预置只在空白分区写入，源 CSV 在 `tools/nvs/seed.csv`，生成命令写入 `web/assets/README.md`。
- 不把用户固件上传到服务器；市场文件后续也只从官方域名读取并校验 SHA-256。
- 不在日志中输出完整固件、凭据或麦克风内容。

## 6. 安全与边界

- 服务只绑定 `127.0.0.1`；WebSocket 必须校验同源 `Origin` 与 `Host`。
- 不使用 `shell=True`；WSL/进程参数逐项传递。
- 固件、ELF、URL 限制大小与格式；会话目录名只用哈希，禁止拼接用户文件名。
- 不模拟 BLE、NFC、电池；在关于/兼容性说明中明确。
- 音视频、时序、功耗与真机有差异；发布固件前仍需真机复测。

## 7. 文档与交付

- UI 文案中文，标识符英文；注释只写非显而易见的约束。
- 新增能力同步更新 `README.md`、`docs/ARCHITECTURE.md`，必要时更新 `docs/PROTOCOL.md`。
- 交付说明区分：主机单测通过、编译/启动通过、已烧录、已在真机走通。
- 不自动提交或发布；需要提交/推送时按用户当次指令执行。
