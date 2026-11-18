# 虚拟网络预置

`nvs-seed.bin` 是 0x6000 字节的 NVS 分区镜像，内容与 `tools/nvs/seed.csv` 对应：

- `radio`：`ssid=myssid`、`pass=mypassword`、`gw=""`
- `bmb_net`：`ssid=myssid`、`pass=mypassword`
- `wifi`：`ssid=myssid`、`password=mypassword`
- `sdg_cc`：`vol=70`、`bri=60`、`volunmute=70`（平台控制中心默认音量/亮度）

空白 NVS 的纯 app 包和整机镜像都会写入这份预置；已有 NVS 数据不覆盖。

重新生成（只需在凭据或命名空间变化时执行）：

```powershell
python -m pip install esp-idf-nvs-partition-gen
python -m esp_idf_nvs_partition_gen generate tools/nvs/seed.csv web/assets/nvs-seed.bin 0x6000
```

生成工具属于开发依赖，不进入运行时；模拟器只读取生成的二进制。