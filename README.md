# 谷仓次元屏模拟器

在浏览器里运行 ESP32-S3 次元屏整机固件，支持本机加速、扬声器与麦克风、Flash 持久化、串口/寄存器调试、截图与录屏。支持本地完整版与静态浏览器版。

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

## 开始试玩

1. 点击「打开 BIN」，或把固件拖到设备预览区。支持 ESP32-S3 整机 BIN 和兼容的 SDGOODS 纯 app 包。
2. 等圆屏亮起，再触摸圆屏或操作右上的银色侧键。
3. 点击「试玩示例」可运行谷仓官方电子徽章。已有固件也可从「最近使用」重新打开。

本机加速适合较重的游戏。浏览器模式使用 WASM，无需 WSL。重启会保留运行数据，清除运行数据会重置当前固件。

## 文档

- [使用指南](docs/USER_GUIDE.md) · 操作、数据和常见问题
- [发布与 GitHub Pages](docs/RELEASE.md) · 打包、部署、验收与回退
- [变更记录](CHANGELOG.md) · 发布候选版本
- [架构](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [设计规范](DESIGN.md)

## 开发与测试

```powershell
node tools/run-tests.mjs
python tools/offline_realtime_check.py
```

前端使用原生 ES 模块，服务端使用 Python 标准库。模拟运行时来自 [Espressif ESP-EMU 1.1.0](https://github.com/espressif/esp-emulator/releases/tag/v1.1.0)。
