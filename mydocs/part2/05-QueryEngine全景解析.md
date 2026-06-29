---
title: "05. QueryEngine 全景解析"
description: "46K 行查询引擎的架构、模块分解与调用链路"
outline: deep
---

# 05. QueryEngine 全景解析

`QueryEngine.ts` 是 Claude Code 中最核心的文件，承担了 LLM 查询引擎的完整职责。它是 Agent Loop 的大脑中枢。

## 核心职责

1. **流式响应处理**：处理来自 Anthropic API 的流式响应，实时渲染
2. **工具调用循环**：当模型返回 `tool_use` 时，自动执行工具并回流结果
3. **思考模式集成**：支持 Extended Thinking，允许模型深度推理
4. **重试逻辑**：内置完善的重试机制应对 API 错误和速率限制
5. **Token 计数**：精确追踪每次调用的 Token 消耗

## 在 Harness 中的位置

```
用户输入 → commands.ts（分拣）
              ├── /command → 命令执行
              └── 自然语言 → QueryEngine → API → 流式响应 → 工具调用循环
```

QueryEngine 是连接"用户意图"和"模型能力"的中枢通道。
