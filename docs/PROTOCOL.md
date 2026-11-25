# 协议说明

本文件只描述跨进程/跨线程的线格式。UI 与模块 API 见 `ARCHITECTURE.md`。

## 1. ESP-EMU 协同仿真

### 1.1 帧格式

TCP 方向（ESP-EMU ↔ native_worker）：

```text
[u32 LE len][frame]
frame = [u16 LE topic_len][topic utf-8][EmulatorMessage]
```

- `topic` 以 `@` 开头表示只发给该消费者；`SIM/CLOCK`、`SIM/RESET`、`SIM/EN`、`HW/GPIO/...` 为广播。
- 发往 ESP-EMU 的帧是裸 `EmulatorMessage`，无 topic。
- 主题之后一律是 `EmulatorMessage`，字段 1 是模拟时间 ns；`SIM/CLOCK` 的 `payload` 里是 `ClockSync`（字段 1 `events_fired_late`、2 `max_lateness_ns`、3 `broadcasts_dropped`、4 `scheduled_dropped`），`native_worker` 对 `SIM/CLOCK` 只取信封的模拟时间后立即返回，不解析其事务字段；其余广播（`SIM/RESET`、`SIM/EN`、`HW/GPIO/...`）本实现不处理。其它帧按 `EmulatorMessage` 解析并同样更新时钟（供 `key()`/`reply()` 打时间戳）。

### 1.2 Protobuf 线格式

本项目只使用 varint 和 length-delimited：

```text
key = tag << 3 | wire_type
wire_type 0: varint
wire_type 2: length-delimited
```

JS 实现在 `web/js/device/protocol.js`；Python 实现在 `server/native_worker.py`。

### 1.3 注册

`Register` 字段：

| 字段 | 值 |
|---|---|
| 1 | 协议版本，固定 1 |
| 2 | 消费者名，`sdgoods-dimension-screen` |
| 3 | 重复 claim |

Claim 字段：

| 字段 | 含义 |
|---|---|
| 1 | GPIO |
| 2 | I2C |
| 3 | SPI |
| 17 | I2S |

本板注册：

```text
SPI claim(1): cs_pin = 21
I2C claim(2): addr = 0x15, scl = 10, sda = 11
GPIO claim(1): drive_pins = 1 << 6
I2S claim(17): bclk = 48, ws = 38, dout = 47, din = 17
```

### 1.4 总线请求与回复

`EmulatorMessage` 字段：

| 字段 | 含义 |
|---|---|
| 1 | 模拟时间 ns |
| 5 | 注册 ack |
| 7 | 总线请求 |
| 8 | 总线回复 |
| 29 | I2sFormat |
| 30 | I2sOut |
| 31 | I2sIn |

总线请求字段：

| 字段 | 含义 |
|---|---|
| 1 | correlation id |
| 2 | I2C 事务 |
| 3 | SPI 事务 |

SPI 事务字段：

| 字段 | 含义 |
|---|---|
| 1 | op |
| 2 | bus |
| 3 | 写数据 |
| 4 | 读数据（回复用） |
| 12 | 传输结束标记 |

I2C 事务字段：

| 字段 | 含义 |
|---|---|
| 3 | 写数据（首字节为寄存器地址） |
| 4 | 读取字节数 |

回复字段：

| 字段 | 值 |
|---|---|
| 1 | correlation id |
| 2 | 1 |
| 3 | 数据 |
| 4 | op（触摸 1，SPI 2） |

### 1.5 触摸

CST816S 报告 5 字节：

```text
[down][x_hi][x_lo][y_hi][y_lo]
```

- 固件按寄存器地址读取；实现要支持从任意寄存器开始的连续读取。
- 坐标换算：`x = 359 - touch.y`，`y = touch.x`（与现有实现一致）。
- 快速点击在固件完成一次完整读取前不释放；保留现有 `pendingRelease` / `sampled` 逻辑。

### 1.6 音频

`I2sFormat`：

| 字段 | 含义 |
|---|---|
| 1 | bool，true = 接收（麦克风），false = 发送（扬声器） |
| 2 | 采样率 Hz |
| 3 | 通道数 |
| 4 | 位宽（容器字节的位数：8/16/24/32） |

`I2sOut` / `I2sIn`：

| 字段 | 含义 |
|---|---|
| 1 | PCM 字节 |

本板格式：

- 扬声器：16 bit PCM，采样率与通道数随固件 I2S 配置（常见 16 kHz、48 kHz 立体声）；浏览器端输出前重采样。
- 麦克风：16000 Hz、1 通道、32 bit、小端。

麦克风 32-bit 容器内使用 16-bit 样本左移 16 位，其余位补零。

## 2. 浏览器 ↔ serve.py（WebSocket）

- URL：`/ws/native`
- 仅接受同源 Origin。
- 文本消息：JSON。
- 二进制消息：首字节为类型。

### 2.1 浏览器 → 服务端

| 类型 | 名称 | 负载 |
|---|---|---|
| `0x10` | load | `u32 LE jsonLen` + JSON + 固件字节 |
| `0x11` | elf | ELF 字节 |
| `0x12` | mic | `u32 LE rate` + `u8 channels` + `u8 bits` + `u16 reserved` + PCM |
| `0x13` | flash import | 完整 Flash 字节（可选） |

load JSON：

```json
{
  "name": "chiikawa-go-demo-0.1.1-full.bin",
  "size": 1334240,
  "sha256": "…",
  "flashKey": "…",
  "preserveFlash": true,
  "flashPatch": { "offset": 3211264, "data": "base64…" }
}
```

`flashPatch` 可省略；槽启动时用它把 otadata 重写到恢复的 Flash 快照上（最大 64 KiB）。

文本控制：

```json
{"type":"touch","touch":{"x":180,"y":180,"down":true}}
{"type":"key","down":true}
{"type":"uart","text":"?"}
{"type":"restart","clearFlash":false}
{"type":"stop"}
{"type":"flash"}
{"type":"registers"}
{"type":"memory","addr":1073741824,"len":64}
{"type":"gpio"}
```

### 2.2 服务端 → 浏览器

| 类型 | 名称 | 负载 |
|---|---|---|
| `0x01` | frame | `u32 LE frame` + SPI 传输消息 |
| `0x02` | audio | `u32 LE rate` + `u8 channels` + `u8 bits` + `u8 receive` + `u8 reserved` + PCM |
| `0x03` | log | UTF-8 |
| `0x04` | event | UTF-8 JSON |
| `0x05` | flash | 完整 Flash 字节 |

event JSON：

```json
{"kind":"booted","info":{"name":"…","version":"…","project":"…","idf":"…","size":1334240,"mode":"native"}}
{"kind":"status","message":"已启动"}
{"kind":"error","message":"…"}
{"kind":"fault","report":"…"}
{"kind":"stats","stats":{"fps":25.0,"frames":123,"transport":"ws","realTime":0.62}}
{"kind":"audioformat","format":{"receive":false,"rate":16000,"channels":2,"bits":16}}
{"kind":"registers","data":{...}}
{"kind":"memory","data":{"addr":...,"bytes":"base64"}}
{"kind":"gpio","data":{...}}
```

`stats.realTime`（协同仿真秒／墙钟秒，本机模式由 `server/native_worker.py` 上报）：

- 取两次上报之间模拟时间的增量除以墙钟秒数。模拟时间是广播帧 `EmulatorMessage` 的字段 1，`SIM/CLOCK` 与其它帧都会更新它；小于 1 表示 ESP-EMU 跑不到实时，扬声器会补静音，表现为电台断续而非无声。
- 没有可用增量时为 `null`（面板显示 `—`），包括：首个上报窗口、尚未收到任何时钟消息、模拟时间停滞、固件复位导致模拟时间归零或回退。复位后要先重新建立基准，因此归零后的第一个窗口仍是 `null`，不会出现负倍率或被放大的倍率。
- `mips` 本机模式取不到，恒为 `null`。
- 浏览器 WASM 模式不经该通道，倍率在 `web/js/device/wasm-runtime.js` 内由 CPU 周期数折算，与本字段口径不同，不要互相比较。

### 2.3 浏览器网络中继（`/relay`）

WASM 侧调用 `emulator.net_set_relay("ws://<host>/relay")`，由 ESP-EMU 内部按 `esp-emu-relay` 协议连接：

| 请求 | 语义 |
|---|---|
| `WS /relay/tcp?host=H&port=P` | 一条 TCP 流的字节；空二进制帧为 FIN；可带 `credit=1`，文本帧为信用计数（中继接受并忽略） |
| `WS /relay/udp?host=H&port=P` | 每个二进制帧是一份 UDP 数据报 |
| `GET /relay/dns?dns=<base64url>` | 返回 `application/dns-message`，只含 A 记录；AAAA 为空答案 |
| `GET /relay/version` | `{"name":"esp-emu-relay","version":"1.0.0"}` |
| `WS /relay/listen` | 保持连接；本模拟器不提供端口转发，不发送转发条目 |

中继只监听回环地址，拒绝非回环 `Origin`；不终结 TLS，不解析应用层内容。

## 3. serve.py ↔ native_worker.py

### 3.1 传输

- 子进程 stdin/stdout。
- 帧：`u32 LE len` + `u8 type` + payload。
- `type` 沿用浏览器二进制类型；JSON 事件统一用 `0x04` + UTF-8 JSON。
- 日志用 `0x03`；音频 `0x02`；画面 `0x01`；Flash `0x05`。

### 3.2 Worker 生命周期

1. serve.py 启动 Worker，传入项目根目录与 ESP-EMU 二进制路径。
2. Worker 等待 `0x10 load`。
3. Worker 写固件到会话目录，启动 ESP-EMU，连接 co-sim。
4. 注册 claim，进入事件循环。
5. 收到 `restart`：优先 `--control-tcp reset`，失败则重启子进程。
6. 收到 `clearFlash`：停止子进程、删除 Flash 文件、用原始固件重启。
7. WS 关闭：停止子进程、保存 Flash、退出。

### 3.3 会话目录

```text
runtime/sessions/<sha256前16位>/
├── base.bin    原始固件
├── flash.bin   工作 Flash（存在则复用）
└── app.elf     可选符号文件
```

- `flash.bin` 不存在时从 `base.bin` 复制。
- ESP-EMU 使用 `--save-state` 退出时写回 `flash.bin`。
- 切换固件时按 `flashKey` 复用目录。

## 4. 错误与降级

| 场景 | 行为 |
|---|---|
| WSL 不存在 | `/api/status.native=false`；UI 置灰本机模式并说明 |
| Worker 启动失败 | 发送 `error` 事件；UI 提供切换到浏览器模式 |
| WebSocket 断开 | Worker 回收；UI 提示可重连 |
| 固件校验失败 | 不启动；显示具体原因 |
| I2S 格式未知 | 缓存音频直到格式到达；超时丢弃并计数 |
| 音频缓冲欠载 | 补静音，累计 underrun |
| 模拟器 fault | 暂停、发送 fault 报告、保留日志 |
| 不支持的调试项 | UI 显示“本机模式暂不支持”，不阻塞运行 |

## 5. 安全

- 只监听 `127.0.0.1`。
- WebSocket 握手校验 `Origin` 与 `Host` 同源。
- load 的固件大小上限 32 MiB；ELF 上限 32 MiB；mic 单帧上限 64 KiB。
- 会话目录名只使用十六进制哈希；不拼接用户文件名。
- 不使用 `shell=True`；WSL 参数逐项传递。
- 错误信息不回显任意文件内容。
