# mini_bot_client

opencode / 外部工具的 mini_bot 接入层。提供 OpenAI-compatible HTTP API，智能路由到 mini_bot。

## 它干嘛？

让你在任何支持 OpenAI API 的工具（opencode、Cursor、自定义客户端）里，直接使用 mini_bot 支持的所有模型（Qwen、DeepSeek、GLM、Kimi 等 17 个）。

**智能路由：**

- **内网**（mini_bot API Server 在线）→ 直连转发，秒回，支持 streaming
- **外网**（API Server 不可达）→ 自动走 lark-cli 飞书通道，通过 mini_bot 回复

```
                        ┌─ API Server 在线 → 直连 localhost:9877 (快)
opencode → proxy(:9876) ─┤
                        └─ API Server 离线 → lark-cli → 飞书 → mini_bot (稳)
```

## 快速开始

### 前提

- Node.js >= 18
- [lark-cli](https://github.com/nicholaschenai/lark-cli)（外网模式需要）
- [mini_bot](https://github.com/xpeng/mini_bot) 正在运行

### 安装

```bash
git clone https://github.com/xpeng/mini_bot_client.git
cd mini_bot_client
npm install
npm run build
```

### 启动

```bash
npm run proxy
# 或
node dist/proxy.js
```

默认监听 `http://localhost:9876`。

### 在 opencode 中使用

在 `~/.config/opencode/opencode.json` 的 `provider` 下添加：

```json
{
  "provider": {
    "mb": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "apiKey": "local",
        "baseURL": "http://localhost:9876/v1"
      },
      "models": {
        "mb-lite": { "name": "MB-Lite" },
        "mb-efficient": { "name": "MB-Efficient" },
        "mb-auto": { "name": "MB-Auto" },
        "mb-deepseek-v4-flash": { "name": "MB-DeepSeek-V4-Flash" },
        "mb-deepseek-v4-pro": { "name": "MB-DeepSeek-V4-Pro" },
        "mb-glm-5": { "name": "MB-GLM-5" },
        "mb-glm-5.1": { "name": "MB-GLM-5.1" },
        "mb-kimi-k2.6": { "name": "MB-Kimi-K2.6" },
        "mb-minimax-m2.7": { "name": "MB-MiniMax-M2.7" },
        "mb-qwen3.5-plus": { "name": "MB-Qwen3.5-Plus" },
        "mb-qwen3.6-plus": { "name": "MB-Qwen3.6-Plus" },
        "mb-qwen3.7-max": { "name": "MB-Qwen3.7-Max" },
        "mb-performance": { "name": "MB-Performance" },
        "mb-ultimate": { "name": "MB-Ultimate" },
        "mb-fuyao-deepseek": { "name": "MB-Fuyao-DeepSeek" },
        "mb-fuyao-glm": { "name": "MB-Fuyao-GLM" },
        "mb-fuyao-kimi": { "name": "MB-Fuyao-Kimi" }
      }
    }
  }
}
```

然后在 opencode 中选模型时就能看到 `mb/mb-fuyao-deepseek`、`mb/mb-lite` 等。

### 直连 mini_bot API Server（跳过 proxy）

如果你只在内网使用，可以直接让 opencode 指向 mini_bot 的 API Server，无需启动 proxy：

```json
"baseURL": "http://localhost:9877/v1"
```

## API 接口

### `POST /v1/chat/completions`

标准 OpenAI 聊天补全接口。支持 streaming（SSE）和非 streaming。

```bash
# 非 streaming
curl -X POST http://localhost:9876/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mb-fuyao-deepseek",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# streaming
curl -N -X POST http://localhost:9876/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mb-fuyao-deepseek",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### `GET /v1/models`

列出所有可用模型。

### `GET /health`

健康检查，同时显示当前路由模式（`direct` 或 `lark-bridge`）。

```bash
curl http://localhost:9876/health
# {"status":"ok","mode":"direct"}
```

## 可用模型

| 模型 ID | 底层模型 | 说明 |
|---|---|---|
| `mb-lite` | Lite | 省配额，快速回复 |
| `mb-efficient` | Efficient | 平衡性能与成本 |
| `mb-auto` | Auto | 自动选择 |
| `mb-deepseek-v4-flash` | DeepSeek-V4-Flash | 快速推理 |
| `mb-deepseek-v4-pro` | DeepSeek-V4-Pro | 高质量推理 |
| `mb-glm-5` | GLM-5 | 中文能力强 |
| `mb-glm-5.1` | GLM-5.1 | GLM 最新版 |
| `mb-kimi-k2.6` | Kimi-K2.6 | 长上下文 |
| `mb-minimax-m2.7` | MiniMax-M2.7 | 多模态 |
| `mb-qwen3.5-plus` | Qwen3.5-Plus | 通义千问 |
| `mb-qwen3.6-plus` | Qwen3.6-Plus | 通义千问新版 |
| `mb-qwen3.7-max` | Qwen3.7-Max | 通义千问旗舰 |
| `mb-performance` | Performance | 高质量 |
| `mb-ultimate` | Ultimate | 最高质量 |
| `mb-fuyao-deepseek` | Fuyao-DeepSeek | 内部网关 |
| `mb-fuyao-glm` | Fuyao-GLM | 内部网关 |
| `mb-fuyao-kimi` | Fuyao-Kimi | 内部网关 |

## 路由模式详解

### Direct 模式（内网）

当 mini_bot API Server（默认 `localhost:9877`）可达时，proxy 直接转发请求：

```
opencode → proxy(:9876) → API Server(:9877) → 模型 API
```

- 延迟：最低（直连模型 API）
- Streaming：完整支持（SSE 透传）
- 前提：mini_bot 已启动且 `BOT_API_SERVER=1`

### Lark-Bridge 模式（外网）

当 API Server 不可达时，自动回退到飞书通道：

```
opencode → proxy(:9876) → lark-cli → 飞书消息 → mini_bot → 模型 API → 飞书回复 → proxy → opencode
```

- 延迟：较高（需经过飞书消息传递）
- Streaming：模拟（收到完整回复后分块发送）
- 前提：`lark-cli` 已配置，mini_bot 正在监听飞书消息

**自动检测：** proxy 每次请求前会检查 API Server 是否可达，无需手动切换。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `9876` | proxy 监听端口 |
| `MINI_BOT_DIRECT_URL` | `http://localhost:9877` | mini_bot API Server 地址 |
| `MINI_BOT_CHAT_ID` | `oc_7ea1907fb...` | 飞书群聊 ID（lark-bridge 模式用） |
| `MINI_BOT_EVENTS_PATH` | `.../state/logs/events.jsonl` | mini_bot 事件日志路径 |
| `LARK_CLI_PATH` | `/opt/homebrew/bin/lark-cli` | lark-cli 可执行文件路径 |
| `MINI_BOT_TIMEOUT` | `180` | lark-bridge 模式等待回复超时（秒） |

## MCP Server（可选）

除了 HTTP API proxy，还提供了 MCP Server 模式，可以直接在 opencode 中作为工具使用：

```bash
npm run start
# 或
node dist/server.js
```

MCP 工具：

| 工具 | 说明 |
|---|---|
| `chat` | 发送消息并等待回复 |
| `set_model` | 切换 mini_bot 模型 |
| `bot_status` | 查看 bot 状态 |
| `reset_session` | 重置会话 |

在 opencode.json 的 `mcp` 下添加：

```json
{
  "mcp": {
    "mini-bot": {
      "type": "local",
      "command": ["node", "/path/to/mini_bot_client/dist/server.js"]
    }
  }
}
```

## 项目结构

```
mini_bot_client/
├── src/
│   ├── proxy.ts          # HTTP API proxy（智能路由）
│   ├── server.ts         # MCP Server
│   ├── lark-cli.ts       # lark-cli 封装
│   └── events-tailer.ts  # events.jsonl 轮询
├── dist/                  # 编译输出
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
