# 谷仓次元屏模拟器

在浏览器里运行 ESP32-S3 次元屏整机固件，支持本机加速、扬声器与麦克风、Flash 持久化、串口/寄存器调试、截图与录屏。当前版本是产品化重构后的本地版；官方市场 API 接入留到下一阶段。

## 快速开始

Windows 双击 `start.cmd`，或在项目目录运行：

```powershell
python server/serve.py
```

默认打开 `http://127.0.0.1:8765/`。首次运行会联网下载并校验 ESP-EMU 1.1.0，缓存到 `runtime/`。端口被占用时：

```powershell
python server/serve.py --port 8766
```

要求：

- Python 3.10+。
- 浏览器 Edge / Chrome（WebGL2、AudioWorklet、IndexedDB）。
- 本机加速：x86-64 Linux，或 Windows 上的 Ubuntu WSL。没有时使用浏览器 WASM 模式。

## 功能

| 能力 | 浏览器 WASM | 本机加速 |
|---|---|---|
| 360×360 ST77916 画面 | 支持 | 支持 |
| CST816S 触摸、GPIO6 侧键 | 支持 | 支持 |
| 扬声器 / 麦克风 | 支持，取决于浏览器音频权限 | 支持 |
| Flash 跨重启持久化 | 稀疏快照存 IndexedDB | 会话目录 + `--save-state` |
| 串口输出 / 输入 | 支持 | 输出与输入均支持 |
| 寄存器 / 内存 / GPIO 读取 | 支持 | 暂不支持 |
| 截图 / 录屏 / 输入宏 | 支持 | 支持 |
| 需要联网的固件 | 支持，经内置网络中继 | 支持，ESP-EMU 用户态网络 |
| 官方市场玩法 | 尚未接入 | 尚未接入 |

### 固件来源

- **示例**：读取同级 `sdgoods-chiikawa-go/dist/` 的最新整机包（优先 0.1.1），由 `server/serve.py` 的 `/demo.bin` 提供。
- **本地文件**：选择从 `0x0` 开始的 ESP32-S3 合并镜像。
- **固件链接**：填写可访问的 `.bin` URL，可选 SHA-256 校验；跨域失败时页面会提示。
- 最近使用保存在浏览器；固件内容按 SHA-256 缓存在 IndexedDB，刷新后可重跑。
- 本地纯 app 包（无分区表、应用描述符在 0x10000 之前）会自动用 `web/platform/` 的官方 bootloader/分区表拼成可启动镜像；分区表与平台一致。
- 官方市场列表、在线安装和官网深链在后续版本接入。

### 运行方式

- **浏览器**：ESP-EMU WASM 在 Web Worker 中执行；画面经 WebGL2 渲染，失败时回退 2D。
- **本机加速**：`server/native_worker.py` 在 WSL/Linux 中常驻，浏览器通过 WebSocket 传输画面、音频、日志和输入。同一页面会话复用 Worker，切换固件不必重新启动 WSL。
- 切换运行方式会重新启动当前固件；设置与 Flash 默认保留。

### 虚拟网络与配网

- 模拟器提供固定虚拟热点：SSID `myssid`，密码 `mypassword`。设备连上后经用户态 NAT 访问本机网络（含局域网与公网）。关于页也会显示这组凭据。
- 镜像载入时，如果 NVS 分区为空，会自动写入这组凭据，覆盖 SDGOODS 常用命名空间：`radio`（`ssid/pass/gw`）、`bmb_net`（`ssid/pass`）、`wifi`（`ssid/password`），以及控制中心的 `sdg_cc`（音量 70、亮度 60）。纯 app 包和整机镜像都适用；已有 NVS 数据不会被覆盖。
- 使用其他 NVS 命名空间、仍需设备自身配网的固件：在设备的 Wi-Fi 列表里选择 `myssid`，密码 `mypassword` 即可。进入配网时模拟器也会弹出这组提示。
- 本机加速使用 ESP-EMU 的 `--net user`；浏览器模式经 `server/relay.py` 内置的 `esp-emu-relay` 兼容中继（TCP／UDP／DNS）访问网络，无需另装中继程序。
- 中继和虚拟网络只监听 `127.0.0.1`，仅在本地模拟器内使用。

### 声音与麦克风

- 扬声器：16-bit PCM，输入采样率按 I2S 报文自适应（16/48 kHz 等）后统一重采样；网络音频等低电平流会做 3× 响度补偿并限幅。
- 麦克风：16 kHz、32-bit、单声道；首次使用时请求权限，默认关闭。
- 平台应用的控制中心音量默认为 70%（NVS 预置），可在固件内调节；底部音量条控制模拟器输出。
- 音频诊断在「音频」面板：输出/输入电平、缓冲队列、欠载次数。

### Flash 与重启

- 「重启」默认保留 NVS、设置、进度等 Flash 数据。
- 「清除数据」删除当前固件的 Flash 覆盖层，回到原始镜像。
- 调试面板可导出完整 Flash；浏览器模式可导入；本机模式的导入暂未开放。

### 调试

- 串口控制台：分级、搜索、暂停、清空、下载、发送。BSP 控制台支持 `?`、`s`、`R`。
- 性能：FPS、帧耗时、模拟 MIPS、实时倍率、传输方式、音频队列/欠载。
- 检查器：固件信息、分区表、Xtensa 寄存器、GPIO、内存十六进制、Flash 导出/导入/清除、ELF 加载。
- 截图保存 PNG；录屏保存 WebM（含可用音轨）；输入宏可录制、回放、导入导出。
- 快捷键：`R` 重启、`S` 截图、`F` 全屏、`D` 开发者模式、空格/回车按住侧键。

## 目录

```text
web/          前端页面、模块、样式、平台引导层与网络预置
server/       HTTP/WebSocket、本机 Worker、网络中继、运行时下载
tests/        Node 单元测试
tools/        测试与固件检查脚本
docs/         产品方案、架构、协议
runtime/      下载的 ESP-EMU、会话 Flash（gitignore）
```

详细模块契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，线格式见 [docs/PROTOCOL.md](docs/PROTOCOL.md)，产品化规划见 [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md)。

## 开发与测试

```powershell
node --test tests/*.test.js
# 或
tools\test.cmd
```

检查固件信息：

```powershell
node tools/inspect_firmware.mjs ..\sdgoods-chiikawa-go\dist\chiikawa-go-demo-0.1.1-full.bin
```

手动验收时建议使用 8766 及以上端口，避免影响正在运行的旧会话。验收两种模式的启动、画面、触摸、侧键、重启、音频、持久化和进程回收；本机模式额外检查 WebSocket 重连与切换固件。

## 当前范围与限制

- 只支持 ESP32-S3、360×360 ST77916 QSPI、CST816S 触摸、GPIO6 侧键和音频编解码格式。
- 官方市场列表与在线安装尚未接入。主界面按单应用方式运行纯 app 包；OTA 槽与 otadata 读写代码保留为内部能力，暂不展示。官方 launcher 需要官方初始整机固件，拿到后可直接作为整机镜像加载；本模拟器不另造启动器界面。
- 需要联网的固件使用模拟器的虚拟热点 `myssid`／`mypassword`。浏览器模式经内置中继访问网络；本机模式用 ESP-EMU 用户态网络。中继只实现 IPv4 TCP／UDP／DNS，端口转发与 TLS 终结不在范围内。
- 页面隐藏时渲染器改用 32 ms 定时器合并绘制，恢复可见立即刷新最新帧；首帧不会因后台停摆的 `requestAnimationFrame` 丢失。
- 不模拟 BLE、NFC、电池、真实功耗和无线射频；Wi-Fi 行为来自 ESP-EMU 的虚拟网络。
- 浏览器 WASM 的帧率受主机和固件负载限制；重负载玩法建议使用本机加速。
- 音频、时序和画面表现可能与真机有差异；发布固件前请在真机复测。

## 上游

- [ESP-EMU 1.1.0](https://github.com/espressif/esp-emulator/releases/tag/v1.1.0)：WASM 与原生运行时。
- [ESP-EMU 外设协议](https://github.com/espressif/esp-emulator/blob/v1.1.0/proto/esp_cosim.proto)：显示、触摸、GPIO、I2S。
- [ST77916 解码示例](https://github.com/espressif/esp-emulator/blob/v1.1.0/tools/cosim-lcd-view.py)：QSPI 总线行为参考。

## 验证记录

- 2026-11-18：重构后单元测试 108 项通过；示例固件 0.1.1 的固件信息与分区解析正确。
- 2026-11-18：本机模式端到端验收通过——示例启动、WebGL 圆屏画面、触摸领取金币（coins 0→30）、串口 `?` 返回 `SDGOODS-CAPS:SHOT`、重启保留 Flash、清除数据后 NVS 恢复出厂；音频 PCM 与提示音在浏览器内输出，电平表有响应。示例固件本身不使用扬声器/麦克风，真实 I2S 音频需用带音频的玩法复测。
- 2026-11-18：`sdgoods-radio` 纯 app 包（3,024,736 字节）在本机与浏览器模式均自动拼装、写入虚拟网络凭据并启动；跳过配网页，直接连上 `myssid`（192.168.4.2），加载 26 个电台并播放（48 kHz 立体声 MP3）。浏览器模式经内置中继完成 DNS、HTTPS 证书校验与流媒体连接。
- 2026-11-18：`sdgoods-radio` 本机模式确认从槽启动后 I2S 持续输出 48 kHz 立体声 PCM，`sdg_cc` 预置把音量从 10% 提升到 70%，输出电平表非零。
- 2026-11-18：OTA 槽内部能力验收通过——radio 装入 `ota_0` 与 `ota_1`，本机日志分别出现 `Loaded app from partition at offset 0x320000` / `0x620000`；浏览器 WASM 从 `ota_0` 启动并加载 26 个电台。该入口默认隐藏，主界面保持单应用。
