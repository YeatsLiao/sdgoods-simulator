# sdgoods-simulator — 本对话 Agent 约定

浏览器内运行次元屏固件与纯 app 包。**本线程以本文件为准**；细节见 `README.md`、`docs/ARCHITECTURE.md`、`docs/PROTOCOL.md`。

**启动**：`start.cmd` 或 `python server/serve.py` → `http://127.0.0.1:8765/`

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
- 拼装时若名称为 `nvs` 的 data/nvs 分区为空，会写入 `web/assets/nvs-seed.bin`（`myssid`／`mypassword`，覆盖 `radio`、`bmb_net`、`wifi` 命名空间，并把 `sdg_cc` 音量预置为 70），纯 app 包和整机镜像都适用。已有 NVS 数据不覆盖。
- 多应用模式由 `web/js/flash/device-image.js`＋`otadata.js`＋`slots.js` 模拟，当前是内部能力：主界面只保留单应用运行，槽/启动器入口默认隐藏。官方 launcher 需要官方初始整机固件，拿到后直接按整机镜像加载，不要另造官方 UI。
- 网络验证使用 ESP-EMU 的虚拟 Wi-Fi `myssid` / `mypassword`；本机经 `--net user`，浏览器经 `server/relay.py` 的 `esp-emu-relay` 兼容中继（`/relay/tcp`、`/relay/udp`、`/relay/dns`）。浏览器端不依赖设备 192.168.4.1 配网页面。

## 2. 运行与测试

- 启动：双击 `start.cmd` 或 `python server/serve.py`，默认 `http://127.0.0.1:8765/`。
- 本机加速：x86-64 Linux 直接运行；Windows 需要 Ubuntu WSL。首次运行会下载原生包。
- 单元测试：`node --test tests/*.test.js` 或 `tools/test.cmd`。
- 主机侧行为改动要补单测；无法在浏览器测试里驱动的本机逻辑（模拟时钟、实时倍率、复位回退）用 `python tools/offline_realtime_check.py` 喂合成协同仿真帧验证，改 `_handle_frame`/`_stats_loop` 要同步更新它。
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

- 代码在 `web/js/audio/`；主路径 Worklet + `AudioEngine`，电台断续多为 ESP-EMU 算力上限，先查欠载率而非误判解码失败
- 连续收听 / 连续回放 / 响度与电台 URL 解析：**必读** `docs/AGENTS_AUDIO.md`（仅改音频或排查声音问题时加载）

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

## 8. 工作台 UI 约定

- 视觉规范以根目录 `DESIGN.md` 为准，执行记录见 `docs/UI_REDESIGN_PLAN.md`。沿用用户确认的左右工具站、银色机身、托管 Noto Sans SC 和谷仓品牌，不自行换风格。
- 固定左侧固件栏，右侧设备预览；本地 BIN 为主操作，示例为辅助，最近使用只显示名称与打开/移除记录。删除记录不删除固件缓存或运行数据，不影响当前会话。顶栏不重复放“更换”。URL 放设备工具；市场、槽入口隐藏。
- 开发工具只有一个入口，可停靠下方/右侧、调整尺寸、最大化。桌面占位并缩小设备区域，不能遮住画面/操作栏；点击设备不能收起工具。手机模态覆盖并管理焦点。
- 页签固定为日志、性能、设备、声音、设置、关于。声音只含音量、静音、麦克风；设置包含当前固件清除运行数据和重置布局；关于包含使用/兼容说明与作者、官方两个链接。不加独立设置弹窗、高级播放、音频诊断或手动电台入口。
- 音量/静音保存到本机，刷新、重启、切换固件/方式后保留；麦克风不自动申请或打开。清除运行数据必须明确当前固件并确认；重置布局不能清固件数据。
- 字体、按钮、输入、选择控件沿用全局变量；关于页与其他页签使用同一字体，仅日志/十六进制可用等宽。文案更新后补齐托管字体子集，验收检查实际渲染字体。
- 机身使用 `web/assets/device/silver-shell-a.webp` 的银色材质，正面圆形操作视图。仅在环带显示素材，中心透明；不得用高光、黑色素材或假玻璃遮住固件画面。`#screen` 无边框，它的 rect 是触摸基准，不能做透视变形。
- 侧键位于右上约 1 点半，位置、角度、比例须与素材逐项对齐。透明命中区可扩大，悬停和按下只在真实键帽处反馈，不另画偏移按钮、不用绿色粗框。说明只在悬停/键盘聚焦出现；使用短提示，不自动弹窗。
- 默认窗口高度内完成基础操作，不显示常驻保存/隐私/规格小字。长列表与日志允许内部滚动，不能隐藏滚动条掩盖溢出。检查 1440×900、1280×720、390×844 并截图复核。
- 固件启动与首帧就绪分开反馈；禁用操作说明原因；录屏显示红色状态和“停止录屏”。用户主动打开的工具不自动关闭或跳页。
- UI 发事件，App 处理业务；同一动作只绑定一次。按钮、输入、链接、summary、dialog 中的空格/键盘不能驱动设备侧键。
- 配网检测只开放帮助入口，不抢占面板；虚拟网络按 `label === "nvs"` 定位，保留 nvsfactory 和已有设置，不反向代理设备 SoftAP。
