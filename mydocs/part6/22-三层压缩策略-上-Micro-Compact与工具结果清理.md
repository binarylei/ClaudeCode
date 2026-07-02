---
title: "22. 三层压缩策略（上）：Micro-Compact 与工具结果清理"
description: "缓存热用 cache_edits、缓存冷用 content-clear、大结果持久化到磁盘——工具结果级压缩如何在零额外 API 调用的前提下维持上下文窗口健康"
outline: [2, 3]
---

# 22. 三层压缩策略（上）：Micro-Compact 与工具结果清理

在[第 21 章](../part6/21-上下文收集机制)中我们建立了上下文收集的完整管线——System Prompt 分层拼接、CLAUDE.md 注入、对话历史加载、动态附件收集，最终组装为一条完整的 LLM 输入。但有一个问题悬而未决：**上下文窗口是有限的，当工具结果不断堆积，窗口迟早会满。怎么办？**

这就是第 22-23 章要回答的问题。全文围绕**三层压缩策略**展开，本章聚焦第一层——工具结果级的轻量清理。

全文核心线索是**"缓存温度决定清理策略，粒度越细代价越低"**。

## 1. 背景介绍

Micro-Compact 是工具结果级的轻量上下文压缩机制，在每轮 API 调用前自动执行，对用户完全透明。它不删除消息、不调用 LLM，只清理过时工具结果的具体内容——用最小的代价维持上下文窗口健康。

### 1.1 三层压缩全景图

```
上下文压缩体系（第 22-23 章）

第 22 章（本章）                                    第 23 章
工具结果级 —— 轻量、透明、每轮自动                     对话级 —— 重量、LLM 驱动、阈值触发
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│                                  │     │                                  │
│  microcompactMessages           │     │  autocompact                     │
│    ├─ Cached MC                  │     │    ├─ sessionMemoryCompact      │
│    │   (cache_edits API，缓存热)  │     │    └─ compactConversation       │
│    └─ Time-based MC              │     │      (forked agent → LLM 摘要)  │
│        (content-clear，缓存冷)    │     │                                  │
│                                  │     │  规划中：                         │
│  applyToolResultBudget          │     │  · snipCompact (stub)            │
│    └─ 大结果持久化到磁盘           │     │  · contextCollapse (stub)       │
│                                  │     │                                  │
│  apiMicrocompact                │     │                                  │
│    └─ API 侧清理策略              │     │                                  │
│                                  │     │                                  │
│  触发：每轮自动（pre-API）         │     │  触发：Token > 阈值              │
│  代价：零 API 调用                │     │  代价：1 次额外 LLM 调用           │
│  感知：完全透明                   │     │  感知：用户可见压缩提示             │
└──────────────────────────────────┘     └──────────────────────────────────┘
```

两层之间有明确的分工和升级路径：

- **日常维持**：Micro-Compact 每轮自动清理旧工具结果，像"垃圾回收"一样默默运行
- **危机干预**：当 Micro-Compact 清理后仍逼近窗口上限，autoCompact 介入做 LLM 级对话摘要
- **递归守卫**：`shouldAutoCompact()` 中对 `session_memory`、`compact`、`marble_origami` 等 querySource 直接返回 false，防止"压缩触发压缩"的无限递归

### 1.2 为什么工具结果是最优先的压缩目标

工具结果有三个特征，使其成为最理想的压缩对象：

| 特征 | 说明 | 设计含义 |
|------|------|---------|
| **体积最大** | 一次 `cat` 或 `grep` 可能产生数万 token | 压缩收益最高 |
| **时效性最强** | 上一轮的 grep 输出对当前推理通常无价值 | 压缩损失最小 |
| **结构独立** | 每条工具结果有独立的 `tool_use_id` 标识 | 可精确到单条粒度操作 |

关键洞察：**清理工具结果内容 ≠ 删除工具调用记录。** 消息骨架（tool_use + tool_result 结构）完整保留，模型仍然能看到"我执行过什么操作"，只是不再看到"那次操作的具体输出"。这是信息完整性和窗口节约之间的精妙平衡。

### 1.3 正交分解：四个子问题

将 Micro-Compact 分解为四个独立维度：

```
              第 22 章 — 工具结果级压缩

   WHEN                    HOW                       WHAT
┌──────────┐        ┌──────────────┐          ┌──────────────┐
│ 何时触发？ │        │ 通过什么机制？  │          │ 清理哪些结果？ │
│          │        │              │          │              │
│ · 每轮自动 │        │ · cache_edits│          │ · 8 类可压缩  │
│ · 缓存冷时 │        │ · content-clr│          │   工具白名单   │
│ · 结果超大 │        │ · 磁盘持久化   │          │ · Read 豁免   │
│          │        │ · API 侧策略   │          │ · 图片豁免     │
└──────────┘        └──────────────┘          └──────────────┘

              WHERE
        ┌──────────────┐
        │ 在哪里执行？   │
        │              │
        │ · 客户端（MC） │
        │ · 服务端（API）│
        │ · 仅主线程     │
        └──────────────┘
```

四个维度互相独立又环环相扣：缓存温度决定用什么机制（HOW），机制决定能在哪里执行（WHERE），工具类型决定是否可清理（WHAT），触发条件决定清理时机（WHEN）。

---

## 2. 核心逻辑

本章回答两个独立问题，它们在每轮 API 调用前自动执行——一个处理"新的太大"（单条超标），一个处理"旧的太多"（跨轮次堆积）：

1. **大结果的内容如何截断？** 处理对象是当前轮次中体积超标的工具结果，核心约束是截断决策一旦被模型看见就不可逆。
2. **旧结果的内容何时可以丢弃？** 处理对象是历史轮次中过时的工具结果，核心约束是不能破坏 prompt cache 前缀。

```
每轮 API 调用前（Agent Loop）
  │
  ├─ ① 大结果截断
  │     单条结果 > 阈值 ?  → 持久化到磁盘，替换为预览引用
  │     单条结果 ≤ 阈值 ?  → 原样保留
  │
  ├─ ② 旧结果清理
  │     ├─ 缓存已冷（gap > 60min）?  → 清空内容（content-clear）
  │     ├─ 缓存还热 + 主线程 ?         → 标记服务端删除（cache_edits）
  │     └─ 都不满足                    → 跳过，留给对话级压缩
  │
  └─ ③ 携带精简后的上下文 → 发送 API 请求
```

### 2.1 问题一：大结果内容如何截断？

当一条工具结果超过体积阈值（如 `cat` 了一个 200K 的日志），不能直接丢弃——模型后续可能需要查阅完整内容。做法是将完整结果写入磁盘文件，原消息中只保留一段简短的摘要引用（如"结果已保存，前 500 字符：..."）。模型看到的是摘要而非原始数据，上下文窗口压力随之释放。

但这个操作有一个隐藏约束：**一旦模型看到了某个结果，它就成为了服务端缓存前缀的一部分。** 后续再改它，整个前缀缓存失效。考虑这条时间线：

```markdown
1. 第 3 轮：一条工具结果体积在阈值内，判定为"不替换"，模型看到了完整内容
2. 第 5 轮：累计 token 压力增加，想替换它来省空间
3. 但不行，它已经在缓存前缀里了
```

这意味着处理决策必须永久冻结。每条工具结果在生命周期中只会经历三种状态：

```
每条工具结果
  │
  ├─ 之前替换过？
  │     本轮直接复用上次的占位符，零 I/O、字节完全一致、缓存命中
  │
  ├─ 之前看过但没替换过？
  │     永久保留原样。它已经在缓存前缀里了，再改会让缓存全部失效
  │
  └─ 新结果（从未见过）？
        可以自由决定：太大就替换为占位符，否则原样保留
```

三种状态的判定有严格顺序：**先判断是否替换过，再判断是否看过。** 因为替换过的结果必然也看过——如果反过来先查"看过"，被替换过的结果会被错误归入"看过但没替换"，导致本该复用占位符的结果被永久冻结在完整内容上。

这个设计承认了一个不可回避的事实：**在 prompt cache 约束下，有些决策是不可逆的。** "看过但没替换"不是 bug，而是缓存一致性模型的一部分——本质上是一个只增的决策日志。

既然决策不可逆，每轮面对新结果时就必须让每一次替换尽可能高效：**优先截最大的，而非先来先截。** 替换一条 100K 的结果比替换十条 2K 的结果更高效——节省的 token 相近，但磁盘 I/O 次数少一个数量级。使用贪心策略（降序排列，从最大的开始）在"最少 I/O"约束下逼近"最小总体积"。

文件读取（Read）在此豁免——它的截断阈值被设为无穷大。原因有二：Read 自身已有 `maxTokens` 上游截断；将 Read 输出写入磁盘再让模型读回逻辑上循环。

### 2.2 问题二：旧结果内容何时可以丢弃？

旧结果清理的核心约束仍然是 prompt cache——一旦改了历史消息，缓存前缀就失效。这意味着清理方式必须根据缓存状态分策略：

```
旧结果清理入口
  │
  ├─ ① 检查时间间隔：gap > 60min ?
  │    └─ YES → 冷缓存路径：content-clear
  │         （缓存已过期，直接清空工具结果内容，缩小请求体）
  │
  ├─ ② 检查热缓存条件：
  │    feature gate 开启 + 模型支持 + 当前是主线程 ?
  │    └─ YES → 热缓存路径：cache_edits
  │         （缓存还温热，不动消息内容，通过 API 标记服务端删除）
  │
  └─ ③ 都不满足 → 跳过（留给对话级压缩处理）
```

#### 缓存热时不动消息，缓存冷时直接清空

两套清理策略由 prompt cache 的冷热状态决定。

**缓存热时**，最简单的方案——直接把旧结果替换为占位符——行不通：修改消息内容会导致前缀缓存全部失效，延迟和成本双杀。但通过 `cache_edits` API 告诉服务端"这些 tool_result 可以当作不存在"，删除指令发生在服务端内部，客户端消息字节完全不变，缓存完美保留。

**缓存冷时**，策略反过来：服务端缓存已过期，前缀反正要重写，不如在请求发出前直接清空旧结果内容——重算的前缀更短，成本更低。做法是遍历消息列表，将内容替换为 `[Old tool result content cleared]`，消息骨架完整保留，模型仍然知道"执行过什么操作"。

为什么用时间（60min）判断冷热，而非累计条数？因为判断的根本问题是"缓存还在不在"，而非"东西多不多"。条数多不代表缓存冷，条数少不代表缓存热——只有时间直接检测缓存状态本身。60 分钟阈值保守对齐 Anthropic 服务端缓存 TTL（约 1 小时）：宁可多等几分钟，也不在缓存仍热时误触发 content-clear。

无论哪种路径，旧结果清理都遵循一条安全底线：始终保留最近几条结果不清，避免模型失去全部工作上下文。

#### cache_edits 的跨轮次状态管理

cache_edits 通过 API 参数告知服务端删除指定 tool_result，客户端消息字节不变、缓存不受影响。它引入两个需跨轮次解决的问题：

- **哪些结果该删？** 决策不能每轮独立做出——需要累积多轮的工具结果，超阈值时触发。因此依赖跨轮次存活的状态容器。
- **删除指令如何维持？** cache_edits 非幂等——服务端每轮都要被告知哪些条目已删除，否则缓存前缀可能引用到已清理条目。

这形成了一个跨轮次循环：

```
每轮：consume（取出待删条目）→ API 请求 → 服务端标记 → pin（重新装载）→ 下轮 consume ...
```

状态容器（模块级单例）是全局可变的，因此入口必须过滤：只有主线程能操作，forked agent 的注册会被拒绝，防止删除不属于自己对话的内容。

### 2.3 清理边界：什么能清、什么不能清？

#### 2.3.1 白名单即风险分级

不是所有工具结果都应该被清理。可清理的只有八类工具——文件读取、命令执行、搜索、文件匹配、网页搜索、网页抓取、文件编辑、文件写入。它们的共性是"体积大 + 时效性强"：输出通常很大，且一旦产生，后续推理很少需要回头查阅原文。

不在白名单中的工具，本质上是清理代价太高：

- **协调层**（子任务、子智能体）：子任务执行结果对后续推理有持续参考价值——Agent 需要知道"子任务完成了什么"
- **交互层**（用户问答）：用户的回答是关键的决策输入，不可丢弃
- **扩展层**（MCP 工具）：MCP 工具的结果语义各异，没有统一的清理策略适用

#### 2.3.2 服务端清理的独特价值

除了在客户端做清理，发送给 API 的请求中还可以附带清理策略配置，让服务端在内部执行额外的清理。服务端能做两件客户端做不到的事：

**清理 thinking 块。** thinking 是模型内部推理过程的记录，与普通消息内容受同样的缓存约束——客户端修改它会导致缓存失效。但服务端在内部处理 thinking 清理，不需要改变客户端发送的消息字节，天然不受此约束。

**按 token 阈值清理工具结果。** 这种策略不依赖缓存温度判断——它让服务端根据实际 token 用量直接执行清理，作为一种兜底保障。

### 2.4 预留：对话早期历史的裁剪

`snipCompact.ts` 目前是空实现。它的设计意图是裁剪对话早期历史、保留最近 N 轮。此处不做展开。

---

## 3. 源码解读

### 3.1 核心文件清单

| 文件 | 职责 |
|------|------|
| [`microCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts) | Micro-Compact 主入口：Time-based MC + Cached MC 两条路径分发 |
| [`toolResultStorage.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts) | 大结果截断核心：持久化 + 状态冻结三分法 + 跨轮次重建 |
| [`apiMicrocompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/apiMicrocompact.ts) | API 侧清理策略：thinking 清理 + token 阈值兜底 |

### 3.2 Agent Loop 中的完整调用链

```
query.ts (Agent Loop 每轮)
  │
  ├─ ① applyToolResultBudget(messages, state)
  │      state 为 undefined → 直接透传（功能未开启）
  │      state 存在 → enforceToolResultBudget()
  │           ├─ collectCandidatesByMessage()    // 按 API 消息分组
  │           ├─ partitionByPriorDecision()      // 三分法冻结历史决策
  │           ├─ selectFreshToReplace()          // 最大优先：挑最大的替换
  │           ├─ persistToolResult()             // 写入磁盘（'wx' 排他写）
  │           └─ replaceToolResultContents()     // 替换为预览引用
  │
  ├─ ② microcompactMessages(messages, toolUseContext, querySource)
  │      ├─ maybeTimeBasedMicrocompact()
  │      │    ├─ evaluateTimeBasedTrigger()       // 纯函数，无副作用
  │      │    ├─ collectCompactableToolIds()      // 白名单过滤
  │      │    └─ map → content-clear + resetMicrocompactState()
  │      └─ cachedMicrocompactPath()
  │           ├─ registerToolResult()             // 跨轮次累积
  │           ├─ registerToolMessage()            // 按 user message 分组
  │           ├─ getToolResultsToDelete()         // 触发条件判定
  │           └─ createCacheEditsBlock()          // 生成 cache_edits 指令块
  │
  ├─ ③ consumePendingCacheEdits() → 注入到 API 请求的 cache_edits 字段
  │
  └─ ④ callModel(messages, {
        context_management: getAPIContextManagement({ hasThinking, ... })
      })
```

### 3.3 关键路径源码

#### 3.3.1 入口分发：[`microcompactMessages()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L253-L293)

`microcompactMessages` 是两条路径的分发器，在每轮 API 调用前被 `query.ts` 调用。核心逻辑是 time-based 优先短路 + cached MC 条件检查：

```typescript
// microCompact.ts:253-293
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  // Time-based 优先：短路执行。如果时间间隔超过阈值，缓存已冷，
  // 直接 content-clear 旧工具结果，缩小后续请求体积。
  // Cached MC 在此场景下被跳过——编辑假定缓存温热，我们刚确认它是冷的
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // Cached MC 仅主线程运行，防止 forked agent（session_memory、
  // prompt_suggestion 等）向全局 cachedMCState 注册工具结果——
  // 那会导致主线程尝试删除不属于其对话的工具
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // 都不满足：跳过，留给 autocompact 处理
  return { messages }
}
```

设计要点：
- **Time-based 优先 + 短路**：一旦判断缓存已冷，不再检查 Cached MC 条件——cache_edits 的前提已不成立
- **`feature('CACHED_MICROCOMPACT')` 包裹**：`feature()` 来自 `bun:bundle`，是 DCE 标记——外部构建中整个 cached MC 路径会被 tree-shake 掉
- **三层检查才能进入 Cached MC**：feature gate + model support + isMainThreadSource，每层过滤一类场景

#### 3.3.2 Time-based MC 判定：[`evaluateTimeBasedTrigger()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L422-L444)

独立的纯函数，只做条件判断，不修改任何状态。提取的目的是让其他 pre-request 路径复用同一判断逻辑：

```typescript
// microCompact.ts:422-444
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}
```

设计要点：
- **显式要求 `querySource` 非空**：`/context`、`/compact` 等分析型调用不应触发实际清理
- **`findLast` 而非 `messages[last]`**：最后一条消息不一定是 assistant（可能是 user 或 system）

#### 3.3.3 Time-based MC 执行：[`maybeTimeBasedMicrocompact()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L446-L530)

判定通过后执行 content-clear。核心是将旧工具结果内容替换为占位符，并处理连锁副作用：

```typescript
// microCompact.ts:446-465（核心清理逻辑）
function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) { return null }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // floor 为 1：slice(-0) 返回全数组（悖论性地保留一切），
  // 清空所有结果则模型零工作上下文。两者都不合理——始终至少保留最后一条
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) { return null }
  // ... 遍历 message，content 替换为 '[Old tool result content cleared]' ...
}
```

设计要点：
- **`Math.max(1, keepRecent)` 防止双退化**：`keepRecent = 0` 时 `slice(-0)` 返回全数组，floor 为 1 同时避免了"全不清"和"全清"两个极端
- **Set 而非 Array**：后续 `map` 遍历每条消息时做 O(1) 查重
- **清理后 `resetMicrocompactState()` + `notifyCacheDeletion()`** 两个副作用缺一不可

#### 3.3.4 Budget 入口：[`applyToolResultBudget()`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts#L924-L936)

`query.ts` 的集成点。`state` 为 `undefined` 时直接透传（功能未开启），有 state 时委托 `enforceToolResultBudget` 执行实际替换：

```typescript
// toolResultStorage.ts:924-936
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages  // 功能未开启，直接透传
  const result = await enforceToolResultBudget(messages, state, skipToolNames)
  if (result.newlyReplaced.length > 0) {
    writeToTranscript?.(result.newlyReplaced)  // 记录到 transcript 以备 resume 重建
  }
  return result.messages
}
```

设计要点：
- **`state` 是可选参数**：GrowthBook 开关关闭时 `ContentReplacementState` 为 `undefined`，整个 Budget 路径零开销透传
- **`writeToTranscript` 回调**：将替换决策持久化到 transcript，确保 resume 时能重建相同的 `ContentReplacementState`

#### 3.3.5 Budget 三分法：[`partitionByPriorDecision()`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts#L649-L667)

将每条工具结果按照 `ContentReplacementState` 中的历史决策分为三类：

```typescript
// toolResultStorage.ts:649-667
function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ContentReplacementState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (acc, c) => {
      const replacement = state.replacements.get(c.toolUseId)
      if (replacement !== undefined) {
        acc.mustReapply.push({ ...c, replacement })  // 之前替换过 → 复用
      } else if (state.seenIds.has(c.toolUseId)) {
        acc.frozen.push(c)                            // 之前看过但没替换 → 冻结
      } else {
        acc.fresh.push(c)                             // 新结果 → 可自由决策
      }
      return acc
    },
    { mustReapply: [], frozen: [], fresh: [] },
  )
}
```

设计要点：
- **mustReapply 的 replacement 来自 Map 缓存**：不重新读磁盘、不重新生成预览——字节级一致，保证 prompt cache 命中
- **检查顺序不可交换**：先检查 `replacements`（`!== undefined`），再检查 `seenIds`。被替换过的结果同时在两个集合中，但应归入 mustReapply 而非 frozen
- **frozen 是不可逆决策的编码**：一旦模型看到了完整结果，即便后来发现该结果其实很大，也不能再替换

---

## 4. 总结

1. **两条路径不是过度设计，而是缓存约束的必然结果**——热缓存要求消息内容不可变（只能用 cache_edits），冷缓存允许直接修改（content-clear），没有任何一种方案能在两种状态下都最优
2. **Cached MC 的三阶段生命周期（consume → pin → re-send）** 是因为 cache_edits 非幂等——服务端需要每轮都被告知哪些条目已删除
3. **Time-based MC 的 60 分钟阈值是保守对齐 Anthropic 缓存 TTL 的结果**——宁可多等几分钟，也不要在缓存仍热时误触发 content-clear
4. **`applyToolResultBudget` 与 Micro-Compact 一纵一横**——Budget 截断当前轮的超大新结果，MC 清理历史轮的过时旧结果，两者在 Agent Loop 同一 pre-API 路径上紧邻执行
5. **`ContentReplacementState` 的状态冻结承认了一个事实：在 prompt cache 约束下，有些决策不可逆**——`frozen` 不是 bug 的 workaround，而是缓存一致性模型的一部分
6. **Budget 选择最大优先而非 FIFO**——目标是最大化每次替换的 token 节省量，贪心策略在"最少 I/O 次数"约束下逼近"最小总体积"
7. **COMPACTABLE_TOOLS 白名单的本质是语义风险分级**——感知层工具清理代价低，协调层工具清理代价高（丢失子任务上下文）
8. **API-side MicroCompact 和客户端 MC 的分工原则**：客户端受缓存约束能做且安全的（cache_edits）自己做；受缓存约束不能做的（thinking 清理）放 API 侧

**覆盖边界**：本章聚焦工具结果级的轻量压缩。对话级的 LLM 摘要（`compactConversation`）、Session Memory Compact 的复用优化、post-compact 附件恢复管线、以及 context collapse 的规划方向，见第 23 章。

---

## 5. 参考文献

- [Anthropic Prompt Caching 文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — Anthropic 的 Agent 设计指南
- 系列文章：
  - [第 21 章：上下文收集机制](../part6/21-上下文收集机制) — System Prompt 分层拼接到动态附件注入的完整管线
  - 第 23 章：三层压缩策略（下）：Compact 对话压缩与摘要 — LLM 驱动的对话级摘要、Session Memory Compact、post-compact 恢复管线
- Claude Code 源码：
  - [`src/services/compact/microCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts) — Micro-Compact 主入口，两条路径分发
  - [`src/utils/toolResultStorage.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts) — 工具结果持久化与 Budget 控制
  - [`src/services/compact/apiMicrocompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/apiMicrocompact.ts) — API 侧 Context Management 策略
  - [`src/services/compact/timeBasedMCConfig.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/timeBasedMCConfig.ts) — Time-based MC 的 GrowthBook 动态配置
  - [`src/services/compact/compactWarningState.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compactWarningState.ts) — 压缩后警告抑制的全局 Store
  - [`src/services/compact/autoCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts) — 对话级压缩的触发决策（第 23 章核心）
  - [`src/services/compact/compact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts) — Compact 完整实现（第 23 章核心）
  - [`src/query.ts`](https://github.com/binarylei/claudecode/blob/main/src/query.ts) — Agent Loop 主循环，pre-API 压缩管线的调用方
