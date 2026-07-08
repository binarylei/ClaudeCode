---
title: "05. QueryEngine 全景解析"
description: "46K 行查询引擎的架构、模块分解与调用链路"
outline: [2, 3]
---

# 05. QueryEngine 全景解析

`QueryEngine.ts` 是 Claude Code 中最核心的文件，承担了 LLM 查询引擎的完整职责。它是连接"用户意图"和"模型能力"的中枢通道——把一次自然语言请求翻译为 System Prompt 组装 → API 调用 → 工具循环 → 标准化结果产出的完整流水线。

## 1. 背景介绍

### 1.1 从手工调用到工程化封装

理解 QueryEngine 最直接的锚点，是把它和直接调用 Anthropic API 做对比：

```
手工调用 Anthropic API：
  client.messages.create() → 检查 stop_reason → 执行工具 → 回流结果 → 重复
  问题：每次手写相同的循环、重试、压缩、格式转换

QueryEngine：
  同一件事的工程化封装。不抽象掉 API 细节，但消除重复工程。
```

手工调用 API 的核心问题不是"写不出来"，而是"每次都要重写相同的工程保障"。QueryEngine 不抽象掉模型选择、thinking 配置、stop_reason 语义这些 API 细节——它只封装那些与 API 无关、但每次做 Agent 都必须有的东西。

### 1.2 在 Harness 中的位置

QueryEngine 在整个 Claude Code 架构中的位置可以这样理解：

```
用户输入 → commands.ts（分拣）
              ├── /command → 命令执行（本地斜杠命令直接返回）
              └── 自然语言 → QueryEngine → API → 流式响应 → 工具调用循环
                                ↑
                    所有 Harness 机制在这里叠加：
                    压缩、预算、重试、技能发现、记忆、权限……
```

它是 Harness 机制的**聚合点**。工具系统、技能系统、压缩系统、权限系统都在 QueryEngine 的循环体中被调用，但循环本身的结构从不被修改——这就是 06 章的核心论点。


---

## 2. 核心逻辑

### 2.1 基线：最简单的 ReAct 模型

ReAct（Reasoning + Acting）是所有 AI Agent 系统的通用骨架，可以在 5 行伪代码里讲清楚：

```
def react_loop(messages, tools):
    while True:
        response = model.invoke(messages, tools)
        messages.append(response)

        if response.stop_reason != "tool_use":
            return response.text

        for tc in response.tool_calls:
            result = execute(tc)
            messages.append(tool_result(tc.id, result))
```

这个模型只做三件事：调用模型 → 如果有工具调用就执行并回流结果 → 如果模型输出文本就结束。它足够简单，任何人都能在一屏代码里理解 Agent 的本质。

### 2.2 问题：把它塞进生产环境会怎样？

如果把这条 5 行伪代码直接部署到 Claude Code 的生产场景中，立刻会暴露出以下缺口：

1. **消息历史无限增长** → 上下文窗口会被撑爆，需要**自动压缩**
2. **API 抖动 / 529 过载 / 速率限制** → 需要**重试策略**，且不同错误的重试逻辑不同
3. **工具结果可能超长** → Bash 命令可能输出 10MB 日志，需要**截断预算**
4. **模型可能输出 max_tokens 截断** → 需要**恢复循环**（让模型从断点继续）
5. **结果要同时喂给多个消费者** → SDK 需要标准化 `SDKMessage` 格式、REPL 需要流式渲染、transcript 需要持久化

第一个直觉反应是把这些能力逐个加到 `react_loop` 里。结果就是 `ask()` 函数膨胀成一个千行巨物——这正是 QueryEngine 重构之前的状态。

问题不在于代码多，而在于两类职责被混在了一起。当只有一种上游消费者时（比如只有 REPL），混在一起也可以工作。但当出现 SDK 模式后，矛盾就变得尖锐：SDK 需要输出 `SDKMessage` 格式、需要逐条 yield 给外部、需要独立的中断控制——这些需求跟 REPL 完全不同，但核心循环逻辑应该是一样的。

### 2.3 落脚：双层架构

QueryEngine 的答案是**分层**——把会话级职责和循环级职责分到两个不同的函数/类中：

```
┌─────────────────────────────────────────────────┐
│  QueryEngine.submitMessage()                    │  ← 外层：会话层
│                                                 │
│  职责：                                          │
│  · System Prompt 上下文拼接                       │
│  · 用户输入处理（斜杠命令分拣、孤儿权限）            │
│  · 会话日志持久化（进入循环前就写入）                │
│  · 结果仲裁（isResultSuccessful）                │
│  · 中断控制（AbortController）                   │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  query() → queryLoop()                  │  │  ← 内层：循环层
│  │                                         │  │
│  │  职责：                                  │  │
│  │  · ReAct while(true) 循环本体           │  │
│  │  · 预处理流水线（截断/裁剪/压缩）         │  │
│  │  · API 调用 + 流式事件消费              │  │
│  │  · 工具执行调度（runTools）              │  │
│  │  · 恢复路径（max_tokens / PTL / RC）     │  │
│  │  · Continue / Terminal 状态判定         │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

QueryEngine 管理会话状态，包括 `mutableMessages`（消息历史）、`totalUsage`（累计用量）、`permissionDenials`（权限拒绝记录）、`readFileState`（文件状态缓存）。一个 QueryEngine 实例 = 一份对话，状态随每个 turn 累积更新。

而每次 `submitMessage()` 调用，可进一步分解为四个步骤：

**① 装配系统上下文** — System Prompt 四段拼接、User Context 获取、System Context 获取、用户输入处理（斜杠命令分拣）、会话日志写入、Skills/Plugins 加载、SDK 初始化消息。7 步准备完，循环拿到的是一份完整装配好的上下文。

**② API 执行** — `for await (const message of query({...}))` 是会话层和内层的唯一接触点。装配好的上下文通过 `QueryParams` 传入，会话层不介入循环内部的预处理、API 调用、工具执行，只通过 AsyncGenerator 逐条消费产出。

**③ 处理内部消息** — `query()` 逐条产出 8 种内部消息类型（assistant / user / progress / attachment / stream_event / system / tool_use_summary / tombstone），`submitMessage` 在循环体中逐条消费：每种消息对应不同的 yield 策略（哪些透传给 SDK、哪些只写会话日志、哪些触发终止检查），转译完成后外部看到的是标准化 `SDKMessage`，完全不知道循环内部的存在。

**④ 仲裁最终结果** — 5 条终止路径按优先级判定：斜杠命令短路 → max_turns → max_budget → structured_output_retries → isResultSuccessful 兜底。硬限制优先于软判定，确保异常不被合法输出掩盖。

---

## 3. 源码解读

### 3.1 源码地图："装配→执行→仲裁"全流程

在深入具体逻辑之前，先建立一份完整的源码地图。QueryEngine 不是一个文件，而是一个**函数协作体**：

#### 核心文件清单

| 文件 | 职责 |
|---|---|
| `src/QueryEngine.ts` | 外层入口：会话生命周期、SDK 消息适配、结果产出 |
| `src/query.ts` | 内层核心：Agent Loop 的 `while(true)` 迭代体 |
| `src/utils/queryContext.ts` | 上下文构建：并行获取 System Prompt + User Context + System Context |

#### 完整调用链路

```
submitMessage():
  1. fetchSystemPromptParts() + asSystemPrompt() — System Prompt 组装

  2. processUserInput() — 用户输入处理，含斜杠命令分拣
     - 返回 shouldQuery（决定是否进入循环）

  3. recordTranscript() — 用户消息落盘（进入循环前的断点写入）

  4. query() → queryLoop() — 进入内层循环，详见第6章
     - 消息类型分派（assistant / user / progress / attachment / stream_event / system / tool_use_summary / tombstone）
     - 每条消息 yield 给 SDK
     - 循环内检查：max_turns / max_budget / structured_output_retries

  5. isResultSuccessful() → yield result — 结果仲裁
     - 产出 5 种 result：success / error_max_turns / error_max_budget_usd / error_max_structured_output_retries / error_during_execution
```

3.2 ~ 3.5 各节按 submitMessage 的执行时序展开：System Prompt 装配 → 会话日志写入 → 终止判定。

### 3.2 会话状态：四个跨 turn 字段

在进入装配管线之前，先看 QueryEngine 实例化时初始化的四个核心状态——它们贯穿整个请求生命周期，后续每一步都会读写。

```typescript
// src/QueryEngine.ts:186-191
private mutableMessages: Message[]
private permissionDenials: SDKPermissionDenial[]
private totalUsage: NonNullableUsage
private readFileState: FileStateCache
```

每个字段在流水线中的角色：

- **`mutableMessages`** — 消息历史，作为 `query()` 的 `messages` 参数传入循环体。循环内每次 API 调用和工具执行都会追加新消息。跨 turn 累积，是"一份对话"的具象化。
- **`totalUsage`** — 累计 API 用量，每次 API 调用后通过 `updateTotalUsage()` 累加。循环内的预算检查（`maxBudgetUsd`）读取它来判定是否触顶，结果消息中也携带此数据供 SDK 展示。
- **`permissionDenials`** — 权限拒绝记录。`submitMessage` 入口构造 `wrappedCanUseTool` 时注入拦截逻辑：每次工具被拒绝，拒绝信息压入此数组。最终由结果仲裁写入 result 的 `permission_denials` 字段，SDK 消费者从中获取完整的拒绝列表。权限拦截对工具执行层完全透明。
- **`readFileState`** — 文件状态缓存，以文件路径为 key。工具权限判定依赖它：如果文件已被读取且未修改，后续读取不再弹窗询问。每次文件读取操作后更新，`--resume` 恢复会话时通过 transcript 重建。

四个字段都在 `submitMessage` 入口通过闭包捕获，循环体内部不直接持有引用——所有读写通过 `processUserInputContext` 或消息更新回调间接完成。

### 3.3 System Prompt 系统上下文组装

```typescript
// src/QueryEngine.ts:286-325
// Narrow once so TS tracks the type through the conditionals below.
const customPrompt =
  typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
const {
  defaultSystemPrompt,
  userContext: baseUserContext,
  systemContext,
} = await fetchSystemPromptParts({
  tools,
  mainLoopModel: initialMainLoopModel,
  additionalWorkingDirectories: Array.from(
    initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
  ),
  mcpClients,
  customSystemPrompt: customPrompt,
})

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

这四段拼接的设计意图：

- **defaultSystemPrompt**：默认系统提示词，包含工具定义、环境信息、行为规范。但当 `customSystemPrompt` 存在时，**跳过生成**。
- **memoryMechanicsPrompt**：跨会话记忆，加载 `MEMORY.md` 记忆文件。
- **appendSystemPrompt**：自定义系统提示词，始终追加在最后，可以**覆盖**前面所有 Prompt 的策略指令，适合注入临时策略调整（如"本次会话只能用只读工具"）。--append-system-promp 或 --append-system-prompt-file
- **customSystemPrompt**：自定义系统提示词。--system-prompt

- **加载顺序**：`custom > memoryMechanics > append`。memoryMechanics 必须在 custom 之后、append 之前——因为它是对 custom prompt 的补充说明，而 append 是最终覆盖层。

#### 3.3.1 System Prompt vs User Context  vs System Context

`fetchSystemPromptParts()` 并行获取三件套，而非揉成一个，背后是四个设计考量：

| 维度       | System Prompt   | User Context            | System Context       |
| -------- | --------------- | ----------------------- | -------------------- |
| **语义**   | 行为指令（你该怎么干活）    | 用户偏好（这个项目要你注意什么）        | 环境快照（当前世界长什么样）       |
| **典型内容** | 角色定义、工具列表、输出规范  | CLAUDE.md 内容、当前日期       | Git 状态、分支名、commit 历史 |

- **缓存效率**：Anthropic API 的 prompt caching 按前缀匹配。System Prompt 的静态部分（角色定义、工具 Schema）是整个会话的缓存前缀，只要它不变，所有 turn 都能命中缓存。如果把 Git 状态和 CLAUDE.md 揉进 System Prompt，变化频率不同的数据会互相拖累缓存命中率。
- **语义正确性**：CLAUDE.md 是用户写的，走 `user` 角色而非 `system` 角色，符合"谁说的话归谁"的角色模型。`<system-reminder>` 标签也明确告诉模型"这些是背景信息，不一定与当前任务相关"。

### 3.4 会话日志持久化

会话消息以 JSONL 格式写入 session 文件，通过 `parentUuid` 串联成完整对话链条，为 `--resume` 和 `--continue` 提供可恢复的会话数据。

#### 3.4.1 全景：四种落盘场景

`recordTranscript()` 的调用散布在 `submitMessage` 的三个阶段，加上 `handleOrphanedPermission` 内部的补写，共四种场景：

| 时机    | 代码位置                                                                                                        | 写入内容                                     |
| ----- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 循环前①a | [QueryEngine.ts:451](https://github.com/binarylei/claudecode/blob/main/src/QueryEngine.ts#L451)             | 用户消息                                     |
| 循环前①b | [queryHelpers.ts:310,331](https://github.com/binarylei/claudecode/blob/main/src/utils/queryHelpers.ts#L310) | 孤儿工具的 tool_use + tool_result             |
| 循环中②  | [QueryEngine.ts:728-834](https://github.com/binarylei/claudecode/blob/main/src/QueryEngine.ts#L728)         | assistant / progress / attachment / 用户确认 |
| 循环后③  | [QueryEngine.ts:712,1078](https://github.com/binarylei/claudecode/blob/main/src/QueryEngine.ts#L1078)       | flush 缓冲区 + compact 后 transcript 重写      |

四种场景的差异不在"写什么"，而在**写入时能不能等**——这决定了 `await` 还是 `void`。循环前必须等（断点锚点不能丢），循环中能不等就不等（不阻塞 generator yield），循环后把循环中欠的账统一结清。

#### 3.4.2 焦点：循环前用户消息落盘

这是 transcript 持久化最关键的一步。如果进程在 API 响应到达之前被杀掉（比如用户在 cowork 中点击 Stop），transcript 里只剩队列操作记录，`--resume` 会因 `getLastSessionLog` 返回 null 而失败。提前写入后，即使用户消息刚发出就被终止，`--resume` 也能从"用户消息已被接受"这个断点恢复——裸写磁盘不可靠，进程随时会死，这就是为什么在消息进入循环前就落盘。

```typescript
// src/QueryEngine.ts:450-463
if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
}
```

#### 3.4.3 循环中与循环后

**循环中（②）** 的策略分化源于 generator 约束：`ask()` 是 async generator，每条消息 yield 出去后调用方才消费。assistant 消息走 `void recordTranscript()` 以避免阻塞 generator——消息还在流式产出，等写入就堵住了管道。代价是数据可能滞留在内存写缓冲区，需要循环后兜底。

**循环后（③）** 做两件事：如果发生过 compact，用 `recordTranscript(mutableMessages.slice(0, tailIdx + 1))` 重写 transcript，只保留被 compact 截断之前的消息段；然后 `flushSessionStorage()` 把循环中所有 fire-and-forget 的写入真正落盘——桌面端在收到 result 消息后立即杀进程，不 flush 就会丢数据。

**循环前的补执行（①b）** 是一个特殊恢复路径：上次会话中工具被批准但进程在返回结果前被杀，工具根本没执行。`handleOrphanedPermission` 补执行该工具，并把 tool_use 和 tool_result 两条消息写入 transcript，确保恢复后的会话历史完整。

### 3.5 会话终止路径全景

`submitMessage` 在 query loop 返回后，会经过多层检查来判定最终结果。共有 5 种可能的 `result` 产出，按代码中的出现顺序：

#### 路径一：提前短路——shouldQuery = false

斜杠命令（如 `/help`）不需要调用 API。此时不进入 query loop，直接返回 success：

```typescript
// src/QueryEngine.ts:556-639
if (!shouldQuery) {
  // 产出 local_command 消息、compact_boundary 消息
  // 然后返回 success result
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText ?? '',
    // ...
  }
  return
}
```

#### 路径二：max_turns_reached ——循环中检查

在 query loop 的消息消费中，如果收到 `attachment.type === 'max_turns_reached'`，立即终止并返回 error：

```typescript
// src/QueryEngine.ts:842-873
else if (message.attachment.type === 'max_turns_reached') {
  yield {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    num_turns: message.attachment.turnCount,
    errors: [`Reached maximum number of turns (${message.attachment.maxTurns})`],
  }
  return
}
```

#### 路径三：max_budget_usd ——循环中检查

在每次消息消费后检查 USD 预算：

```typescript
// src/QueryEngine.ts:972-1002
if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
  yield {
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: true,
    errors: [`Reached maximum budget ($${maxBudgetUsd})`],
  }
  return
}
```

#### 路径四：error_max_structured_output_retries ——循环中检查

仅在 `jsonSchema` 模式且 `StructuredOutput` 工具调用次数超过上限时触发：

```typescript
// src/QueryEngine.ts:1005-1048
if (message.type === 'user' && jsonSchema) {
  const callsThisQuery = currentCalls - initialStructuredOutputCalls
  if (callsThisQuery >= maxRetries) {
    yield { type: 'result', subtype: 'error_max_structured_output_retries', ... }
    return
  }
}
```

#### 路径五：正常终止——循环返回后判定

循环正常返回后，`isResultSuccessful` 会检查最后一条消息是否构成有效的"成功"状态：

```typescript
// src/utils/queryHelpers.ts:56-80
export function isResultSuccessful(
  message: Message | undefined,
  stopReason: string | null = null,
): message is Message {
  if (!message) return false

  if (message.type === 'assistant') {
    const lastContent = last(message.message.content)
    return (
      lastContent?.type === 'text' ||
      lastContent?.type === 'thinking' ||
      lastContent?.type === 'redacted_thinking'
    )
  }

  if (message.type === 'user') {
    // 所有 content blocks 都是 tool_result 类型 → 成功
    const content = message.message.content
    if (Array.isArray(content) && content.length > 0 &&
        content.every(block => 'type' in block && block.type === 'tool_result')) {
      return true
    }
  }
  // stopReason === 'end_turn' 但没有任何 content blocks 也算成功
  return stopReason === 'end_turn'
}
```

不满足则返回 `error_during_execution`：

```typescript
// src/QueryEngine.ts:1082-1118
if (!isResultSuccessful(result, lastStopReason)) {
  yield {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [
      `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
      ...all.slice(start).map(_ => _.error),
    ],
  }
  return
}
```

#### 检查的优先级

这 5 条路径的检查顺序就是它们的优先级：

1. `shouldQuery = false`（最早，在循环外）
2. `max_turns_reached`（循环内，attachment 直接 signal）
3. `max_budget_usd`（循环内，每条消息后检查）
4. `structured_output_retries`（循环内，仅在 user 消息后检查）
5. `isResultSuccessful`（循环外，最终兜底）

这个顺序确保了"硬限制"（max_turns、budget）优先于"软判定"（isResultSuccessful）。即使模型返回了合法的终止信号，如果回合数或预算已经触顶，后者优先生效。

---

## 4. 总结

1. **分层是为了让两类职责各自独立演进**：会话级职责（格式转换、会话日志留存、结果仲裁）和循环级职责（API 调用、工具执行、状态判定）拆到不同函数后，不同入口（SDK / REPL）才能复用同一套循环逻辑。

2. **会话状态是跨 turn 的粘合剂**：消息历史、累计用量、权限记录、文件状态——四个字段在 turn 之间累积，把多次独立的 API 调用串联成"一份对话"。

3. **System Prompt 的组装遵循"能省就省、能覆就覆"**：默认 Prompt 在自定义时跳过生成（省 token），追加 Prompt 始终拼在最后（保证最终话语权），静态和动态上下文分开发送（保缓存命中率）。

4. **会话日志留存的时间线比内容更重要**：四种落盘场景的差异不在"写什么"，而在"什么时候写、能不能等"。循环前必须等（断点不能丢），循环中能不等就不等（不堵 generator），循环后统一兜底。

5. **终止判定的本质是硬限制垄断优先权**：回合上限和预算上限在循环内拦截，不留给 `isResultSuccessful` 判定的机会——即使模型给出了合法的文本回复，只要资源触顶就先报错。

6. **本文是核心循环的上半场**：聚焦会话层的"装配前"和"循环后"——状态管理、上下文组装、日志持久化、结果仲裁。循环内部的微观机制——预处理流水线、恢复路径、Continue/Terminal 状态机——是下一章的主题。

---

## 5. 参考文献

- [Anthropic API Messages 文档](https://docs.anthropic.com/en/docs/build-with-claude/messages) — 流式响应格式、stop_reason 规范
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) — Agent Loop 的概念起源
- Claude Code 源码：
  - [`src/QueryEngine.ts`](https://github.com/binarylei/claudecode/blob/main/src/QueryEngine.ts) — 外层会话管理，submitMessage 入口
  - [`src/query.ts`](https://github.com/binarylei/claudecode/blob/main/src/query.ts) — 内层核心循环，query() / queryLoop()
  - [`src/utils/queryContext.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/queryContext.ts) — System Prompt 三件套并行获取与拼接
  - [`src/utils/queryHelpers.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/queryHelpers.ts) — isResultSuccessful 判定、handleOrphanedPermission 恢复
