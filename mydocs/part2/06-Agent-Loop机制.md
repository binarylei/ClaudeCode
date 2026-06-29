---
title: "06. Agent Loop 机制"
description: "工具调用循环的 Harness 实现、伪代码解析与状态机"
outline: [2, 2]
---

# 06. Agent Loop 机制

## 1. 背景介绍

### 1.1 什么是 Agent Loop

Agent Loop 是所有 AI Agent 系统的通用骨架：模型接收消息、决定行动、执行工具、获取结果、再次决策。它在概念上极其简单，可以在 5 行伪代码里讲清楚：

```
def agent_loop(messages, tools):
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

这个模型只做三件事：调用模型 → 如果有工具调用就执行并回流结果 → 如果模型输出文本就结束。它在架构中的位置已在[第 5 章](../part2/05-QueryEngine全景解析)中标注——`queryLoop()` 就是这段伪代码在 Claude Code 中的真实实现。

### 1.2 Harness 意义

这个循环的设计哲学是：**循环属于 Agent，机制属于 Harness。**

Claude Code 的所有其他 Harness 机制——工具系统、技能加载、上下文压缩、子智能体——都是在这个循环之上层层叠加的，而不改变循环本身的结构。

换句话说，如果把 Agent Loop 看作心跳，那么 Harness 就是血液循环系统——心跳本身是简单的、不变的，但围绕它建立的一整套保障机制（血压调节、氧气运输、废物清除）才是让有机体存活的关键。本章聚焦于这个"心跳"本身的微观运作。

---

## 2. 核心逻辑：一次迭代的生命周期

### 2.1 迭代体的输入与输出

`queryLoop` 的每一次迭代可以抽象为：

```
输入 → [预处理] → [API 调用] → [分支判定] → 输出
                                      ├── Continue → 回到输入
                                      └── Terminal  → 退出
```

- **输入**：一个不可变的 `State` 对象（消息历史、工具上下文、压缩追踪、恢复计数……参见 3.1 节）
- **预处理**：5 步流水线，在 API 调用前对消息历史做减法（截断 / 裁剪 / 压缩）和加法（附件注入）
- **API 调用**：通过 `deps.callModel()` 发起流式请求，消费流式事件
- **分支判定**：
  - 如果有 `tool_use`：执行工具，产出 `tool_result`，更新 State → **Continue**
  - 如果无 `tool_use` 且未被 withhold：执行 Stop Hook → **Terminal**
  - 如果被 withhold（PTL / max_output_tokens / media size error）：触发**恢复路径** → Continue

### 2.2 为什么是 while(true) 而不是递归

`queryLoop` 的循环体是一个 `while(true)`，而不是递归调用自身。这是因为一次完整的 Agent 会话可能包含数十甚至上百轮工具调用——每一次工具调用都会触发一次新的迭代。如果使用递归，调用栈会随着轮次线性增长，最终爆栈。

`while(true)` 的另一个好处是**恢复路径的语义清晰**。当 `max_output_tokens` 截断发生时，恢复路径不是"递归进入一个新的 queryLoop"，而是"在当前循环体内重新构造 API 请求"——它们是同一次 Agent 回合的不同尝试，而非嵌套的子回合。

---

## 3. 源码解读

> **前置阅读**：本章的源码分析建立在[第 5 章](../part2/05-QueryEngine全景解析)的架构全景之上。阅读本章前，请先了解 QueryEngine 的双层架构（外层 `QueryEngine` + 内层 `queryLoop`）。

### 3.1 State 不可变更新模式

进入 query loop 后，核心状态被收集到一个 `State` 对象中，每次迭代通过解构读取、通过 spread 更新：

```typescript
// src/query.ts:204-217
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

迭代体顶部，`toolUseContext` 用 `let` 单独解构（因为它在同一次迭代内也会变化），其余字段用 `const`：

```typescript
// src/query.ts:308-321
while (true) {
  let { toolUseContext } = state     // let — 迭代内可能变
  const {
    messages,                         // const — 迭代内只读
    autoCompactTracking,
    maxOutputTokensRecoveryCount,
    // ...
  } = state
```

Continue 站点统一通过整体替换更新：

```typescript
// 统一模式：不修改 state 的单个字段，而是整体替换
state = {
  ...state,
  messages: [...state.messages, ...newMessages],
  toolUseContext: updatedToolUseContext,
  transition: { reason: 'tool_use' },
  // ...
}
```

**为什么这样做？** `queryLoop` 有 **7 个 continue 站点**——分别对应工具调用后继续、压缩后继续、max_output_tokens 恢复后继续、reactiveCompact 恢复后继续等场景。如果状态是分散的 9 个 `let` 变量，每个 continue 站点都需要显式更新每一个可能变化的变量。遗漏任何一个，下一次迭代就会读到脏值。

`state = { ...state, ... }` 模式让每次更新都是**显式的整体替换**。TypeScript 编译器会检查 `State` 类型的完整性——漏了哪个字段都能被 catch 到。`transition` 字段记录"上一次迭代为什么继续"（如 `{ reason: 'tool_use' }`、`{ reason: 'max_output_tokens' }`），让测试可以断言恢复路径是否被触发，而不需要检查消息内容。

设计要点：

- **9 个字段放进一个对象而非 9 个独立变量**：continue 站点越多，分散变量的风险越大。一个对象包裹 + spread 更新消除了不一致的可能性
- **toolUseContext 用 let 单独解构**：它是唯一在同一次迭代内也会被修改的字段（queryTracking、messages、contentReplacementState），单独拿出来让其他字段安心用 const
- **transition 不是冗余信息**：它让"这次迭代为什么会继续"成为可查询的状态，而不是散落在 7 个 continue 站点的代码路径中

### 3.2 5 步预处理流水线的顺序设计

每次 API 调用前，消息历史要经过 5 步预处理。这个流水线的顺序不是随意的——它遵循"先做减法，后做加法"的原则：

```
① applyToolResultBudget  →  截断过长的工具结果
② snipCompactIfNeeded    →  裁剪早期历史（保留最近 N 轮）
③ microcompactMessages   →  微压缩（合并/删除短小消息）
③.5 contextCollapse      →  上下文折叠（把长段内容替换为摘要）
④ autocompact            →  自动压缩（触发完整压缩流程）
⑤ getAttachmentMessages  →  注入新的记忆/技能附件
```

**为什么①最先执行？** 工具结果截断不依赖其他步骤的结果。它只检查每个 `tool_result` block 的内容长度，超出阈值的截断。先执行它可以让后续步骤（尤其是 autocompact）看到的 token 数更准确——如果先压缩再截断，可能会浪费压缩机会在不必要的内容上。

**为什么②③③.5④集中做减法？** 这四个步骤的目标一致：减少上下文 token 数。但它们有渐进式关系：

| 步骤 | 代价 | 效果 |
|---|---|---|
| ② snip | 极低（只移动指针） | 删掉最老的 N 轮对话 |
| ③ microcompact | 低（本地合并短消息） | 释放少量 token |
| ③.5 contextCollapse | 中（本地折叠长段） | 折叠大段内容为摘要 |
| ④ autocompact | 高（调用一次完整 API） | 大幅压缩，产出摘要 |

先做轻量操作，如果不满足再做重量操作——这个顺序避免了"能贴创可贴解决的问题非要做手术"。

**为什么⑤最后做加法？** 附件注入会增加上下文 token，如果放在压缩之前执行，刚注入的附件可能立即被压缩掉。更重要的是，压缩后的上下文窗口释放出了新的空间，此时注入附件才是最安全的。

**一个微妙的细节**：`③.5 contextCollapse` 必须跑在 `④ autocompact` **之前**。如果 collapse 就能把 token 数降到压缩阈值以下，autocompact 看到的是一个已经"够小"的消息数组，直接跳过。这样做的结果是保留了更细粒度的上下文（collapse 只折叠长段，保留消息结构和工具调用链），而不是直接用一个摘要文本替代全部历史。

设计要点：

- **顺序不是"按作者喜好排列"**：每一步对 token 数的计算有影响，前一步的输出决定后一步是否需要执行
- **减法优先于加法**：如果先加附件再减压缩，附件会被无谓地压缩掉
- **同类的渐进式关系**：snip → microcompact → contextCollapse → autocompact，代价递增、效果递增

### 3.3 Continue vs Terminal：状态转换

每次迭代结束后，有两条路：

**Continue**：迭代产生了新的消息（工具结果、压缩结果、恢复结果），需要继续循环：

```typescript
// 伪代码——具体实现在 query.ts 的各个 continue 站点
state = {
  ...state,
  messages: [...state.messages, ...newMessages],
  toolUseContext: updatedContext,
  transition: { reason: 'tool_use' | 'max_output_tokens' | 'reactive_compact' | ... },
  // 可能还会更新 autoCompactTracking、turnCount 等
}
// → 回到 while(true) 顶部
```

**Terminal**：模型没有返回 `tool_use`（`needsFollowUp === false`），循环正常结束：

```typescript
// src/query.ts 的返回逻辑
if (!needsFollowUp) {
  // 执行 Stop Hooks（后处理钩子）
  yield* handleStopHooks(...)
  // 返回终止原因
  return { reason: 'end_turn' | 'stop_hook' | ... }
}
```

Terminal 返回到外层 `QueryEngine.submitMessage()`，由 `isResultSuccessful()` 做最终判定（详见[第 5 章 3.6 节](../part2/05-QueryEngine全景解析#_3-6-外层-终止路径全景)）。

### 3.4 恢复路径：当错误不是终点

queryLoop 中有三条恢复路径，它们让"API 错误"成为可处理的信号而非会话终点：

**max_output_tokens 恢复**。当 `stop_reason === 'max_output_tokens'` 时模型被截断，但这不是终点——模型还想继续说。queryLoop 会 withhold 这条消息（不 yield 给 SDK），然后自动发起一次新的 API 调用，让模型从断点继续。最多尝试 3 次：

```typescript
// src/query.ts:164
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
```

每次恢复时 `maxOutputTokensRecoveryCount++`，超过限制后放弃恢复，将截断消息作为最终结果产出。

**reactiveCompact 恢复**。当 prompt 太长（PTL）或媒体尺寸超限时，`reactiveCompact` 会 withhold 错误消息，触发一次紧急压缩，然后用压缩后的消息重新发起 API 调用。恢复循环的入口在流式消费完之后：

```typescript
// 流式消费结束后检查是否有被 withhold 的错误
// 如果有 → 触发 reactiveCompact → state = { ...state, hasAttemptedReactiveCompact: true }
// → 回到 while(true)
```

**contextCollapse 恢复**。与 reactiveCompact 类似，但当 `contextCollapse` 启用时，它会优先尝试折叠上下文中的长段——折叠比压缩更轻量，保留了消息结构。只有当 collapse 不足以恢复时才 fallback 到 reactiveCompact。

这三条恢复路径的优先级是：collapse → reactiveCompact → max_output_tokens recovery。越轻量的恢复越先尝试——collapse 是本地操作，reactiveCompact 可能触发一次 API 调用（用于压缩），max_output_tokens 恢复直接发起一次完整的 API 重试。

---

## 4. 总结

1. **Agent Loop 是 5 行伪代码，但生产级实现的价值在"循环之上的机制"**——预处理流水线、恢复路径、状态管理才是工程血汗所在。

2. **`while(true)` 而非递归**：避免调用栈线性增长，同时让恢复路径的语义清晰——它们是同一次回合的不同尝试，而非嵌套子回合。

3. **State 不可变更新模式**：9 个字段打包成一个对象，7 个 continue 站点统一通过 `state = { ...state }` 更新。避免分散变量在多个 continue 站点间的不一致。

4. **预处理流水线的顺序是精心设计的**：先做减法（截断 → 裁剪 → 微压缩 → 折叠 → 自动压缩），再做加法（附件注入）。同类操作按代价递增排列。

5. **恢复路径让"错误"成为可处理的信号**：max_output_tokens 不是终点，prompt-too-long 不是终点——三种恢复路径让循环有"自愈"能力。

6. **循环结构不变，机制层层叠加**：这是 Harness 设计哲学的核心——压缩、预算、技能发现、记忆附件全部在 `while(true)` 之外定义，循环本身不感知它们的存在。

---

## 5. 边界标注

- 本章聚焦于 Agent Loop 的**微观机制**——一次迭代内的状态变化、预处理步骤、分支判定。架构全景和调用链路见[第 5 章](../part2/05-QueryEngine全景解析)。
- 工具执行机制（`runTools`、权限判定）见 Part 3 工具系统系列。
- 上下文压缩的算法细节见 Part 6 上下文管理系列。
- 流式响应解析与消费见[第 7 章](../part2/07-流式响应与思考模式)。
- Token 计数与预算控制见[第 8 章](../part2/08-Token与成本管理)。

---

## 6. 参考文献

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- Claude Code 源码：
  - `src/query.ts` — queryLoop 核心循环
  - `src/query/transitions.ts` — Continue/Terminal 状态定义
  - `src/query/stopHooks.ts` — Stop Hook 执行
  - `src/services/compact/` — 压缩家族（autoCompact / microCompact / snipCompact / reactiveCompact / contextCollapse）
