# 发布说明

## GitHub Pages

在仓库的 Settings → Pages 中选择 GitHub Actions 作为来源。确认代码、品牌、平台文件及运行时可公开分发后，从 Actions 手动运行「Publish browser simulator」。工作流从固定上游版本取得 WASM，校验归档 SHA-256 后生成静态发布包。项目站点支持 `/<仓库名>/` 子路径。

静态版提供浏览器 WASM、打开本地 BIN 和本地进度。原生进程、Python WebSocket 和网络中继由本地完整版提供。公开包内置谷仓次元屏 Doom 整机示例，记录见 `web/demo/README.md`。

### Windows PowerShell

```powershell
python tools/package_pages.py runtime/pages-preview/sdgoods-simulator
python -m http.server 8767 --bind 127.0.0.1 --directory runtime/pages-preview
```

### Linux

```bash
python3 tools/package_pages.py runtime/pages-preview/sdgoods-simulator
python3 -m http.server 8767 --bind 127.0.0.1 --directory runtime/pages-preview
```

访问 `http://127.0.0.1:8767/sdgoods-simulator/`。输出目录需是新目录。回退时对已验证的上一个发布版本重新执行部署工作流，或用其源版本重新生成发布包。

## 发布检查

- [ ] 维护者确认项目许可证及品牌、平台预构建文件、运行时和可选示例的分发许可。资源来源见各 assets 和 platform 目录的 README。
- [ ] 从干净检出测试首次下载及校验、端口冲突和 Windows 启动。
- [ ] 检查本机和浏览器模式的 BIN 加载、输入、重启保留、清除数据、声音、截图和录屏。
- [ ] 检查 Doom 音频、电台联网，以及小智和傻妞固件的配网状态。仅将实际验证结果写入版本说明。
- [ ] 检查 1440×900、1280×720 与 390×844 的圆屏接缝、操作区和开发工具停靠。
- [ ] 检查静态产物只含发布文件。私有 BIN、预览稿、缓存和日志留在本地。
- [ ] 发布后通过 HTTPS 实测项目子路径、WASM 启动、打开 BIN 和本地进度。

GitHub Pages 操作参考 [GitHub 官方文档](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 当前验收记录

- 公开包内置谷仓次元屏 Doom v1.0.0 整机 BIN，SHA-256 与上游发布一致。
- 201 项主机单测通过。本地静态发布包用浏览器 WASM 启动 Doom 并显示标题画面，性能页可即时切换目标倍率。
- 本机浏览器在 Doom 标题画面两次抽样约为 4 FPS，2× 目标档未带来可见提升。该数值只反映这次试跑。
- Doom 听感、电台联网、小智和傻妞配网以及全套交互验收仍待记录。
