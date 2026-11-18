# 平台引导层

这里是从 `SDGOODS-ESP32S3/platform/prebuilt/` 同步的官方平台引导层，用于把市场纯 app 包拼成可从 `0x0` 启动的调试镜像。

- `bootloader.bin`：SHA-256 `14d86c17e4787a756451ba5d0d42a36500ea574852d2c4b0e8a6050407ee45e2`
- `partition-table.bin`：SHA-256 `0b9b034d9ad6e8aee524e74405a98fc9b414d79712132c807145489048fdc1ff`

分区表与平台官方一致：`launcher` 位于 `0x10000`，OTA 槽 `ota_0..3` 位于 `0x320000/0x620000/0x920000/0xC20000`，每槽 3 MiB。纯 app 包拼装时写入 `launcher` 所在的 factory 偏移以便直接调试；正式多应用安装仍由设备 launcher 管理槽位。

更新引导层时先从官方平台同步上述两个文件，再更新本文件的哈希。