# 谷仓次元屏模拟器

在本机网页上运行 ESP32-S3 次元屏整机固件。首个验证样例是 Chiikawa GO 0.1.0，网页从同级项目的 `dist/chiikawa-go-demo-full.bin` 读取现有固件。

## 本地运行

Windows 双击 `start.cmd`，或在项目目录运行：

```powershell
python serve.py
```

首次运行需要联网下载 ESP-EMU 1.1.0。脚本检查官方发行包的 SHA-256，并把运行库缓存到 `runtime/`。启动后打开 [本地页面](http://127.0.0.1:8765/)。保持终端窗口开启，按 Ctrl+C 结束。端口被占用时可运行 `python serve.py --port 8766`。

- 点「运行 Chiikawa GO」加载工作区示例，或点「选择整机 BIN」选取本机文件。当前支持从 `0x0` 开始、分区表位于 `0x8000` 的 ESP32-S3 合并镜像。
- 用鼠标或手指点按、长按和拖动圆屏。圆屏右侧是 GPIO6 侧键。
- 打开「固件串口日志」查看启动和应用状态。「重新启动」从选中的原始镜像创建一台新虚拟设备，虚拟 Flash 的本次写入随之清除。

## 运行方式

- **本机加速**在 x86-64 Linux 或装有 Ubuntu WSL 的 x86-64 Windows 上默认启用。ESP-EMU 原生程序在本机执行固件，并把压缩后的写屏数据送给网页。首次使用会下载并校验官方 Linux 发行包。WSL 内需要 Python 3。
- **浏览器**在网页的 Web Worker 中执行 ESP-EMU WebAssembly。两种方式都使用同一份原版 BIN 和同一套圆屏解码。更改「运行方式」会重新启动当前固件。

## 当前范围

使用 ESP32-S3 内置 ROM 和整机镜像启动，通过 ESP-EMU 外设总线接收 GPIO21 上的 ST77916 QSPI 写屏数据，解码 RGB565 并绘制到 360×360 画布。触摸经 I²C 地址 `0x15` 返回 CST816S 坐标，按 Chiikawa GO BSP 的方向换算。

第一版验证同板型整机包。市场纯 app 包需要配合对应平台 Flash、启动器和 OTA 槽。音频、Wi-Fi、跨重启 Flash 持久化和电源闩锁留待适配。

已在 Windows Edge 上使用原版 Chiikawa GO 整机包验证画面、点击菜单、长按并向右拖动进入伙伴页，以及重新启动。

同一台 Windows 主机上，Chiikawa GO 的草地讨伐场景在浏览器模式约 5 帧/秒，本机加速实际绘制约 18 帧/秒。速度随固件负载和电脑配置变化。

## 上游

- [ESP-EMU 1.1.0](https://github.com/espressif/esp-emulator/releases/tag/v1.1.0) 提供浏览器运行时。脚本从上游下载，项目源码不附带该发行包。
- [ESP-EMU 外设协议](https://github.com/espressif/esp-emulator/blob/v1.1.0/proto/esp_cosim.proto) 和 [ST77916 解码示例](https://github.com/espressif/esp-emulator/blob/v1.1.0/tools/cosim-lcd-view.py) 用于核对总线行为。
