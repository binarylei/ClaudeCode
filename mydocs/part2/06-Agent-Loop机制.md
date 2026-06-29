---
title: "06. Agent Loop 机制"
description: "工具调用循环的 Harness 实现、伪代码解析与状态机"
outline: deep
---

# 06. Agent Loop 机制

## 什么是 Agent Loop

Agent Loop 是所有 AI Agent 系统的通用骨架：模型接收消息、决定行动、执行工具、获取结果、再次决策。

## 伪代码

```
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM,
            messages=messages, tools=TOOLS,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = TOOL_HANDLERS[block.name](**block.input)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

## Harness 意义

这个循环的设计哲学是：**循环属于 Agent，机制属于 Harness。**

Claude Code 的所有其他 Harness 机制——工具系统、技能加载、上下文压缩、子智能体——都是在这个循环之上层层叠加的，而不改变循环本身的结构。
