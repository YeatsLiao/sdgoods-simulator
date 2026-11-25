# 工作台中文字体

Noto Sans SC 可变字体，SIL Open Font License 1.1（见 OFL.txt）。上游：https://github.com/notofonts/noto-cjk/tree/main/Sans 。本项目从本机已安装的 NotoSansSC-VF.ttf 制作 UI 字符子集，覆盖 web/index.html 与 web/js 内全部文字及 ASCII；其他用户文件名使用系统中文后备字体。没有外部字体请求或运行时依赖。

原始本机字体 SHA-256：`763146584cf0710223441356b4395e279021b0806c196614377a7a0174ae074a`。

`noto-sans-sc-ui.ttf` 保留可变字重。增加 UI 中文时需要补入子集；可使用 fontTools.subset 从有许可证的原字体生成。
