---
title: "附录2：Anthropic 协议信息"
description: "Anthropic Messages API 的完整协议参考——请求/响应格式、ContentBlock 类型、SSE 流式事件、Tool Use 协议、Prompt Caching、Extended Thinking 等 wire format 细节"
outline: [2, 3]
---

# 附录2：Anthropic 协议信息

本文是 Anthropic Messages API 的**纯协议参考手册**，展示 Claude Code 与 API 交互的完整 wire format——请求参数、响应字段、ContentBlock 类型、SSE 事件序列等。不分析设计意图，只列事实，方便阅读源码时对照查阅。

## 0. 协议速览

以下是一张 API 调用的完整字段树，可作为全文索引：

```
POST /v1/messages
Headers: x-api-key | anthropic-version | content-type | anthropic-beta

Request Body:
├── model: string                          # 模型 ID
├── system?: string | ContentBlock[]       # System Prompt
├── messages: MessageParam[]               # 对话历史
│   ├── {role: "user", content: ContentBlock[]}
│   └── {role: "assistant", content: ContentBlock[]}
├── tools?: {name, description, input_schema}[]  # 工具定义（最多 256）
├── tool_choice?: {type: "auto"|"any"|"tool"|"none"}
├── thinking?: {type: "enabled"|"disabled"|"adaptive", ...}
├── max_tokens: number                     # 输出 token 上限
├── stream?: boolean                       # 启用 SSE 流式
├── temperature?: number                   # 采样温度 0-1
├── stop_sequences?: string[]              # 停止序列（最多 256）
├── top_p?: number
├── top_k?: number
└── metadata?: {user_id: string}

Response Body:
├── id: string                             # 消息 ID（如 msg_01...）
├── type: "message"
├── role: "assistant"
├── model: string                          # 实际使用的模型
├── content: ContentBlock[]                # 响应内容
├── stop_reason: "end_turn"|"max_tokens"|"stop_sequence"|"tool_use"|"refusal"
├── stop_sequence: string|null
└── usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}
```

---

## 1. API 端点

### 1.1 端点列表

| 端点 | 方法 | 说明 | 状态 |
|------|:---:|------|:---:|
| `/v1/messages` | POST | 发送消息 | GA |
| `/v1/messages/count_tokens` | POST | 预计算 token 数 | GA |
| `/v1/messages/batches` | POST | 批量处理 | GA |
| `/v1/models` | GET | 模型列表 | GA |
| `/v1/files` | POST | 文件上传 | Beta |
| `/v1/skills` | POST/GET | 技能管理 | Beta |

Base URL：`https://api.anthropic.com`

### 1.2 请求头

| Header | 值 | 说明 |
|------|------|------|
| `x-api-key` | 你的 API 密钥 | 认证方式之一 |
| `Authorization` | `Bearer <token>` | Workload Identity Federation 认证 |
| `anthropic-version` | `2023-06-01` | API 版本 |
| `content-type` | `application/json` | 内容类型 |
| `anthropic-beta` | 见 §12 | Beta 功能启用 |

### 1.3 请求大小限制

| 端点 | 上限 |
|------|------|
| Messages / Token 计数 | 32 MB |
| Message Batches | 256 MB |
| Files | 500 MB |

### 1.4 响应头

| Header | 说明 |
|------|------|
| `request-id` | 全局唯一请求 ID |
| `anthropic-organization-id` | 组织 ID |

---

## 2. ContentBlock 类型

ContentBlock 是 Anthropic 协议的核心数据类型，`messages[].content` 数组和响应的 `content` 数组都由它组成。

### 2.1 请求侧可用类型

| type                |      可用角色       | 结构                                                                         |
| ------------------- | :-------------: | ------------------------------------------------------------------------------- |
| `text`              | user, assistant | `{type: "text", text: string, cache_control?: {type: "ephemeral", ttl?: "1h"}}` |
| `image`             |      user       | `{type: "image", source: {type: "base64", media_type: string, data: string}}`   |
| `tool_use`          |    assistant    | `{type: "tool_use", id: string, name: string, input: object}`                   |                       
| `tool_result`       |      user       | `{type: "tool_result", tool_use_id: string, content: string , is_error?: boolean}` |
| `thinking`          |    assistant    | `{type: "thinking", thinking: string, signature: string}`                       |
| `redacted_thinking` |    assistant    | `{type: "redacted_thinking", data: string}`                                     |

### 2.2 响应侧类型

| type | 结构 |
|------|------|
| `text` | `{type: "text", text: string}` |
| `tool_use` | `{type: "tool_use", id: string, name: string, input: object}` |
| `thinking` | `{type: "thinking", thinking: string, signature: string}` |
| `redacted_thinking` | `{type: "redacted_thinking", data: string}` |

### 2.3 Image 支持的 media_type

`image/jpeg`、`image/png`、`image/gif`、`image/webp`

### 2.4 message 角色规则

- messages 数组必须是 **user / assistant 交替**
- 连续两个同角色消息会自动合并为一个
- 最后一条为 assistant 时，模型会"续写"该消息
- 不支持 `system` 角色 —— system prompt 应通过顶层 `system` 参数传入

---

## 3. 请求参数

### 3.1 必填参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型 ID（见 §11） |
| `messages` | MessageParam[] | 消息数组（§2.4） |
| `max_tokens` | number | 输出 token 上限；设为 0 时只填充缓存不生成回答 |

### 3.2 可选参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|:---:|------|
| `system` | string \| ContentBlock[] | — | System Prompt，支持 `cache_control` |
| `tools` | Tool[] | — | 工具定义列表（§6.1），最多 256 个 |
| `tool_choice` | object | `{type: "auto"}` | 工具调用策略（§6.2） |
| `thinking` | object | — | 扩展思考配置（§8.1） |
| `stream` | boolean | `false` | 启用 SSE 流式（§5） |
| `temperature` | number | `1.0` | 采样温度，0–1 |
| `stop_sequences` | string[] | — | 停止序列，最多 256 个 |
| `top_p` | number | — | Nucleus 采样 |
| `top_k` | number | — | Top-k 采样 |
| `metadata` | object | — | `{user_id: string}` |

---

## 4. 响应结构

### 4.1 响应体字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 消息 ID（格式 `msg_01...`） |
| `type` | string | 固定 `"message"` |
| `role` | string | 固定 `"assistant"` |
| `model` | string | 实际使用的模型 ID |
| `content` | ContentBlock[] | 响应内容块列表（§2.2） |
| `stop_reason` | string | 停止原因（§4.2） |
| `stop_sequence` | string\|null | 触发的停止序列文本 |
| `usage` | object | Token 用量（§4.3） |

### 4.2 stop_reason 枚举

| 值 | 含义 | Claude Code 行为 |
|------|------|------|
| `end_turn` | 正常完成 | 结束本轮 Agent Loop |
| `max_tokens` | 达到输出上限 | 自动续写（continuation） |
| `stop_sequence` | 遇到停止序列 | 裁剪并结束 |
| `tool_use` | 模型请求工具调用 | 进入工具执行分支 |
| `refusal` | 安全审核拒绝 | 返回拒绝信息 |

### 4.3 usage 对象

| 字段 | 说明 |
|------|------|
| `input_tokens` | 未缓存的输入 token |
| `cache_creation_input_tokens` | 新写入缓存的 token（§7.4） |
| `cache_read_input_tokens` | 缓存命中的 token（§7.4） |
| `output_tokens` | 输出 token |
| `server_tool_use` | 服务端工具使用量，如 `{web_search_requests: N}` |

---

## 5. Streaming（SSE 流式协议）

设置 `stream: true` 后，响应以 Server-Sent Events (SSE) 格式增量返回。

### 5.1 事件类型

| 事件 | 携带字段 | 出现时机 |
|------|------|------|
| `message_start` | `message: {id, type, role, model, content[], usage}` | 流开始 |
| `content_block_start` | `index: number, content_block: {type}` | 每个内容块开始 |
| `content_block_delta` | `index: number, delta: {type: "text_delta", text}` | 文本增量 |
| `thinking_delta` | `index: number, delta: {type: "thinking_delta", thinking}` | 思考增量（§8） |
| `signature_delta` | `index: number, delta: {type: "signature_delta", signature}` | 签名增量（§8） |
| `content_block_stop` | `index: number` | 内容块结束 |
| `message_delta` | `delta: {stop_reason, stop_sequence}, usage` | 消息级增量 |
| `message_stop` | — | 流结束 |
| `ping` | — | 心跳保活 |

### 5.2 典型事件序列

**无 Thinking 时（纯文本回答）：**

```
message_start
→ content_block_start (type: "text")
→ content_block_delta ×N (text_delta)
→ content_block_stop
→ message_delta (stop_reason, usage)
→ message_stop
```

**有 Thinking 时（summarized 模式）：**

```
message_start
→ content_block_start (type: "thinking")
→ thinking_delta ×N
→ signature_delta
→ content_block_stop
→ content_block_start (type: "text")
→ content_block_delta ×N (text_delta)
→ content_block_stop
→ message_delta (stop_reason, usage)
→ message_stop
```

**有 Thinking，display: "omitted" 模式：**

```
message_start
→ content_block_start (type: "thinking")
→ signature_delta  ← 直接发送签名，无 thinking_delta
→ content_block_stop
→ content_block_start (type: "text")
→ content_block_delta ×N (text_delta)
→ content_block_stop
→ message_delta (stop_reason, usage)
→ message_stop
```

**工具调用时的流：**

```
message_start
→ content_block_start (type: "tool_use")
→ content_block_delta ×N (input_json_delta)  ← 工具的 JSON input 增量
→ content_block_stop
→ message_delta (stop_reason: "tool_use", usage)
→ message_stop
```

### 5.3 SSE 原始格式

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01...","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"usage":{"input_tokens":100,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

---

## 6. Tool Use 协议

### 6.1 工具定义格式

```json
{
  "name": "get_weather",
  "description": "Get the current weather for a location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {"type": "string", "description": "City and state, e.g. San Francisco, CA"}
    },
    "required": ["location"]
  }
}
```

`input_schema` 使用标准 JSON Schema。可选属性 `strict: true` 可确保模型的 tool_use 调用严格匹配 schema。

### 6.2 tool_choice 取值

| 值 | 说明 |
|------|------|
| `{"type": "auto"}` | 模型自主决定（默认） |
| `{"type": "any"}` | 强制调用任意工具 |
| `{"type": "tool", "name": "tool_name"}` | 强制调用指定工具，`disable_parallel_tool_use` 可选 |
| `{"type": "none"}` | 禁用工具调用 |

### 6.3 一轮工具调用的完整消息序列

```
→ 请求1:
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "tools": [{"name": "get_weather", "description": "...", "input_schema": {...}}],
  "messages": [{"role": "user", "content": "What's the weather in SF?"}]
}

← 响应1:
{
  "id": "msg_01...",
  "stop_reason": "tool_use",
  "content": [{
    "type": "tool_use",
    "id": "toolu_01AbCdEfGhIjKlM...",
    "name": "get_weather",
    "input": {"location": "San Francisco, CA"}
  }]
}

→ 请求2:
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "tools": [{"name": "get_weather", ...}],
  "messages": [
    {"role": "user", "content": "What's the weather in SF?"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_01AbC...", "name": "get_weather", "input": {...}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_01AbC...", "content": "Sunny, 72°F"}]}
  ]
}

← 响应2:
{
  "id": "msg_02...",
  "stop_reason": "end_turn",
  "content": [{"type": "text", "text": "The weather in San Francisco is sunny, 72°F."}]
}
```

### 6.4 tool_result 格式

```json
{
  "role": "user",
  "content": [{
    "type": "tool_result",
    "tool_use_id": "toolu_01AbCdEf...",
    "content": "执行结果文本或 ContentBlock[]",
    "is_error": false
  }]
}
```

- `tool_use_id` 必须匹配上一轮 assistant 消息中的 `tool_use.id`
- `is_error: true` 标记工具执行失败

### 6.5 并行工具调用

单轮响应可包含多个 tool_use block：

```json
{
  "stop_reason": "tool_use",
  "content": [
    {"type": "tool_use", "id": "toolu_01...", "name": "read_file", "input": {"file_path": "..."}},
    {"type": "tool_use", "id": "toolu_02...", "name": "grep", "input": {"pattern": "..."}}
  ]
}
```

### 6.6 工具调用中断（Interleaved Thinking）

支持在工具调用过程中插入思考（特定模型，见 §11.1）。启用时 `budget_tokens` 可超过 `max_tokens`：

```
content:
  thinking → tool_use → thinking → tool_use → thinking → text
```

---

## 7. Prompt Caching

### 7.1 cache_control 标记

```json
// 在 system 参数中标记
{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}

// 在 messages content block 中标记
{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}

// 延长 TTL 至 1 小时（默认 5 分钟）
{"type": "text", "text": "...", "cache_control": {"type": "ephemeral", "ttl": "1h"}}
```

### 7.2 自动缓存

无需手动标记 `cache_control`，API 自动识别请求前缀中的可复用内容并缓存。与显式断点可混合使用。

### 7.3 缓存限制

| 指标 | 限制 |
|------|------|
| 最小可缓存 token（Claude 4/5） | 1024 |
| 最小可缓存 token（Claude 3.5） | 2048 |
| 最多 cache_control 标记数 | 32 |
| 默认 TTL | 5 分钟 |
| 延长 TTL | 1 小时（`ttl: "1h"`） |

### 7.4 usage 中的缓存指标

```
总输入 token = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

| 字段 | 含义 | 计费 |
|------|------|------|
| `input_tokens` | 未缓存的输入 token | 正常输入单价 |
| `cache_creation_input_tokens` | 新写入缓存的 token | 输入单价 × 1.25 |
| `cache_read_input_tokens` | 缓存命中读取的 token | 输入单价 × 0.1 |

### 7.5 缓存失效条件

| 操作 | 影响范围 |
|------|------|
| 修改 system 参数 | system 部分缓存失效 |
| 修改 messages 中断点之前的内容 | messages 部分缓存失效 |
| 修改 tools 定义 | 全部缓存失效 |
| 修改 thinking 参数 | messages 部分缓存失效 |
| 修改 temperature / stop_sequences | 不影响缓存 |

### 7.6 缓存预热

`max_tokens: 0` 时模型不生成回答，仅填充缓存：

```json
// 预热请求
{"model": "...", "max_tokens": 0, "messages": [...], "system": "..."}

// 后续真实请求（缓存命中，cache_read_input_tokens > 0）
{"model": "...", "max_tokens": 1024, "messages": [...], "system": "..."}
```

---

## 8. Extended Thinking

### 8.1 thinking 配置

```json
// 手动模式：指定思考预算
{"thinking": {"type": "enabled", "budget_tokens": 4000}}

// 自适应模式（Claude Fable 5 / Sonnet 5 等）
{"thinking": {"type": "adaptive"}}

// 关闭思考
{"thinking": {"type": "disabled"}}
```

`budget_tokens` 必须 ≤ `max_tokens`（interleaved thinking 时可超过，见 §6.6）。在 Opus 4.6 / Sonnet 4.6 已弃用。

### 8.2 响应中的 thinking block

```json
{
  "type": "thinking",
  "thinking": "Let me think through this step by step...",
  "signature": "EqYMCwiRGU..."
}
```

### 8.3 display 模式

| display | thinking 字段内容 | signature | 流式 thinking_delta | 默认模型 |
|------|:---:|:---:|:---:|------|
| `summarized` | 摘要文本 | ✅ | ✅ | Claude 4 系列 |
| `omitted` | `""`（空字符串） | ✅ | ❌ | Claude Fable 5 / Mythos 5 / Sonnet 5 / Opus 4.8 |

`display: "omitted"` 时流中不发 `thinking_delta`，直接从 `signature_delta` 开始——以更快的 time-to-first-text-token 为设计目标。

### 8.4 Thinking 签名与多轮传递

多轮对话中，**必须原封不动回传** assistant 消息中的 thinking block（含 `thinking` 文本 + `signature`）：

```json
// 第二轮请求必须包含第一轮返回的完整 thinking block
{
  "messages": [
    {"role": "user", "content": "问题"},
    {"role": "assistant", "content": [
      {"type": "thinking", "thinking": "...", "signature": "EqYM..."},
      {"type": "text", "text": "回答"}
    ]},
    {"role": "user", "content": "追问"}
  ]
}
```

修改 thinking block 的任一字段会返回 `400 invalid_request_error`。

### 8.5 Thinking 与 Tool Use 的交互规则

- `tool_choice` 仅支持 `auto` / `none`
- 不能在同一个 assistant turn 中切换 thinking 模式（含 tool_use → tool_result 循环）
- 需要切换 thinking 时，必须在当前 turn 结束后再开始新 turn
- interleaved thinking 时 `budget_tokens` 可超过 `max_tokens`

---

## 9. Token 计数

### 9.1 独立计数端点

`POST /v1/messages/count_tokens`

请求参数与 Messages API 相同（model + messages + system + tools + thinking 等），不产生费用。

### 9.2 响应

```json
{
  "input_tokens": 1234
}
```

---

## 10. 错误处理

### 10.1 错误响应格式

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "具体错误描述"
  }
}
```

### 10.2 错误类型

| error.type | HTTP 状态码 | 说明 |
|------|:---:|------|
| `invalid_request_error` | 400 | 请求格式错误（参数、schema 不合法等） |
| `authentication_error` | 401 | API Key 无效或缺失 |
| `permission_error` | 403 | 无权限访问该组织/资源 |
| `not_found_error` | 404 | 资源不存在（模型 ID 错误等） |
| `request_too_large` | 413 | 请求体超过大小限制 |
| `rate_limit_error` | 429 | 速率限制或额度用尽 |
| `api_error` | 500 | 服务器内部错误 |
| `overloaded_error` | 529 | 服务过载，建议重试 |

---

## 11. 模型体系

### 11.1 主要模型

| 模型 | First-party ID | 上下文窗口 | max_tokens |
|------|------|:---:|:---:|
| Claude Fable 5 | `claude-fable-5` | 200K | 32K |
| Claude Mythos 5 | `claude-mythos-5` | 200K | 32K |
| Claude Opus 4.8 | `claude-opus-4-8` | 200K | 32K |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 200K | 32K |
| Claude Sonnet 5 | `claude-sonnet-5` | 200K | 32K |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | 200K | 32K |

### 11.2 跨平台模型 ID 映射

| 模型 | First-party | Bedrock | Vertex | Foundry |
|------|------|------|------|------|
| Opus 4.8 | `claude-opus-4-8` | `us.anthropic.claude-opus-4-8-v1` | `claude-opus-4-8` | `claude-opus-4-8` |
| Sonnet 4.6 | `claude-sonnet-4-6` | `us.anthropic.claude-sonnet-4-6-v1` | `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | `claude-haiku-4-5@20251001` | `claude-haiku-4-5` |
| Opus 4.6 | `claude-opus-4-6` | `us.anthropic.claude-opus-4-6-v1` | `claude-opus-4-6` | `claude-opus-4-6` |
| Sonnet 5 | `claude-sonnet-5` | — | — | — |

**平台说明：**
- **First-party**：Anthropic 直连 API
- **Bedrock**：AWS Bedrock，Managed by AWS
- **Vertex**：Google Cloud Vertex AI，Managed by Google
- **Foundry**：Microsoft Azure Foundry，Managed by Anthropic

### 11.3 模型能力差异

| 模型 | Thinking | Interleaved Thinking | Tool Use | Prompt Caching |
|------|:---:|:---:|:---:|:---:|
| Claude Fable 5 | adaptive | ✅ | ✅ | ✅ |
| Claude Mythos 5 | adaptive | ✅ | ✅ | ✅ |
| Claude Opus 4.8 | adaptive | ✅ | ✅ | ✅ |
| Claude Sonnet 5 | adaptive | ✅ | ✅ | ✅ |
| Claude Sonnet 4.6 | enabled | ✅ | ✅ | ✅ |
| Claude Haiku 4.5 | enabled | ✅ | ✅ | ✅ |

---

## 12. 版本与 Beta Headers

### 12.1 API 版本

| Header | 值 |
|------|------|
| `anthropic-version` | `2023-06-01` |

### 12.2 Beta Headers（部分）

| 值 | 启用功能 |
|------|------|
| `interleaved-thinking-2025-05-14` | 交织思考（旧模型需要） |
| `message-batches-2024-09-24` | 批量处理 |
| `computer-use-2025-05-14` | 计算机使用工具 |
| `prompt-caching-2024-07-31` | 隐式缓存 |

---

## 13. 请求/响应完整示例

### 13.1 最简单的文本请求

```json
// Request
POST /v1/messages
Headers: x-api-key, anthropic-version, content-type

{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hello, Claude!"}]
}

// Response
{
  "id": "msg_01AbCdEfGhIjKlMnOpQrStUv",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [{"type": "text", "text": "Hello! How can I help you today?"}],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {"input_tokens": 10, "output_tokens": 25}
}
```

### 13.2 带 System Prompt + Tool Use + Streaming 的完整请求

```json
// Request
POST /v1/messages
Headers: x-api-key, anthropic-version, content-type

{
  "model": "claude-opus-4-8",
  "max_tokens": 4096,
  "system": [
    {
      "type": "text",
      "text": "You are a helpful assistant.",
      "cache_control": {"type": "ephemeral"}
    }
  ],
  "tools": [{
    "name": "get_weather",
    "description": "Get the current weather for a location",
    "input_schema": {
      "type": "object",
      "properties": {
        "location": {"type": "string", "description": "City name"}
      },
      "required": ["location"]
    }
  }],
  "messages": [{"role": "user", "content": "What's the weather in SF?"}],
  "stream": true
}
```

---

## 14. 与 Claude Code 源码的对照索引

| 协议概念 | Claude Code 源码关键文件 |
|------|------|
| Messages API 请求构建 | `src/utils/queryContext.ts`、`src/utils/messages.ts` |
| System Prompt 组装 | `src/constants/prompts.ts` |
| 流式响应解析 | `src/utils/streamlinedTransform.ts` |
| Tool Use 处理循环 | `src/utils/toolResultStorage.ts` |
| Prompt Caching 策略 | `src/utils/sessionStorage.ts` |
| Thinking 配置 | `src/utils/thinking.ts` |
| Token 计数与 usage 提取 | `src/utils/tokens.ts` |
| 模型 ID 与配置 | `src/utils/model/configs.ts` |
| API 错误处理 | `src/services/api/errors.js` |

---

## 总结

1. Anthropic Messages API 以 **ContentBlock**（text / image / tool_use / tool_result / thinking / redacted_thinking）为消息原子单位，`messages[].content` 和响应 `content` 均由它构成
2. **SSE 流式**通过 9 种事件（message_start → content_block_start → content_block_delta / thinking_delta / signature_delta → content_block_stop → message_delta → message_stop → ping）实现文本、思考、签名的增量传输
3. **Tool Use** 通过 `tool_use.id` ↔ `tool_result.tool_use_id` 关联，`stop_reason: "tool_use"` 驱动多轮工具调用循环，`tool_choice` 控制调用策略
4. **Prompt Caching** 通过 `cache_control: {type: "ephemeral"}` 标记缓存断点，自动缓存为补充；缓存 TTL 默认 5 分钟，可延长至 1 小时；读取价为输入价的 10%
5. **Extended Thinking** 通过 `thinking.budget_tokens` 控制思考预算，`signature` 保证多轮回传完整性，`display` 控制思考可见性
6. **stop_reason** 五种取值（end_turn / max_tokens / stop_sequence / tool_use / refusal）驱动 Agent Loop 的分支逻辑
7. 四条云平台路径（First-party / Bedrock / Vertex / Foundry）共享相同的 Messages API 语义，仅模型 ID 格式不同

---

## 参考文献

- [Anthropic API 概述](https://platform.claude.com/docs/en/api)
- [Messages API 参考](https://platform.claude.com/docs/en/api/messages/create)
- [Streaming 文档](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Tool Use 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use)
- [Extended Thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Prompt Caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [模型概览](https://platform.claude.com/docs/en/about-claude/models/overview)
- Claude Code 源码：见 §14 对照索引
