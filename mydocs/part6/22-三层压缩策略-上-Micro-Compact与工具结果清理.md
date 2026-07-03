---
title: "22. 三层压缩策略（上）：Micro-Compact 与工具结果清理"
description: "缓存热用 cache_edits、缓存冷用 content-clear、大结果持久化到磁盘——工具结果级压缩如何在零额外 API 调用的前提下维持上下文窗口健康"
outline: [2, 3]
---

# 22. 三层压缩策略（上）：Micro-Compact 与工具结果清理

在[第 21 章](../part6/21-上下文收集机制)中我们建立了上下文收集的完整管线——System Prompt 分层拼接、CLAUDE.md 注入、对话历史加载、动态附件收集，最终组装为一条完整的 LLM 输入。但有一个问题悬而未决：**上下文窗口是有限的，当消息不断堆积，窗口迟早会满。怎么办？**

这就是第 22-23 章要回答的问题。全文围绕**三层压缩策略**展开，本章聚焦第一层——工具结果级的轻量清理。

## 1. 背景介绍

Micro-Compact 是工具结果级的轻量上下文压缩机制，在每轮 API 调用前自动执行，对用户完全透明。它不删除消息、不调用 LLM，只清理过时工具结果的具体内容——用最小的代价维持上下文窗口健康。

### 1.1 压缩体系全景图

上下文压缩共 5 个预处理步骤，在 Agent Loop 每轮 API 调用前依次执行，按触发时机分为两层：

```
Agent Loop 每轮 API 调用前（pre-API）
│
├── ① applyToolResultBudget    大结果截断（当前轮次）           │
├── ② microcompactMessages     旧结果清理（历史轮次）           │ 第 22 章
│       缓存热 → cache_edits / 缓存冷 → content-clear          │ 工具结果级
│                                                              │ 零 API 调用
├── ③ snipCompact              早期历史裁剪 (stub)              │ 每轮自动
│
│  ─ ─ ─ ─ ─ ─ ─ ─ 触发边界：每轮自动 ↑ ↓ 阈值触发 ─ ─ ─ ─ ─ │
│
├── ④ contextCollapse          上下文折叠 (stub)                │ 阈值触发
└── ⑤ autocompact              对话摘要 + Session Memory 复用   │ 第 23 章
        compactConversation (fork agent → LLM 摘要)             │ 对话级
        sessionMemoryCompact                                    │ 1 次 LLM 调用
```

五步之间有明确的分工和升级路径：

- **日常维持①②**：每轮自动执行，先截断当前轮的超大新结果，再清理历史轮的过时旧结果，零 API 调用、完全透明
- **危机干预⑤**：当 Micro-Compact 清理后仍逼近窗口上限，autoCompact 介入做 LLM 级对话摘要，代价为 1 次额外 API 调用

### 1.2 为什么工具结果是最优先的压缩目标

工具结果有三个特征，使其成为最理想的压缩对象：

| 特征 | 说明 | 设计含义 |
|------|------|---------|
| **体积最大** | 一次 `cat` 或 `grep` 可能产生数万 token | 压缩收益最高 |
| **时效性最强** | 上一轮的 grep 输出对当前推理通常无价值 | 压缩损失最小 |
| **结构独立** | 每条工具结果有独立的 `tool_use_id` 标识 | 可精确到单条粒度操作 |

关键洞察：**清理工具结果内容 ≠ 删除工具调用记录。** 消息骨架（tool_use + tool_result 结构）完整保留，模型仍然能看到"我执行过什么操作"，只是不再看到"那次操作的具体输出"。这是信息完整性和窗口节约之间的平衡。

---

## 2. 核心逻辑

本章回答两个独立问题，它们在每轮 API 调用前自动执行——一个处理"新的太大"（单条超标），一个处理"旧的太多"（跨轮次堆积）：

1. **当前轮的大结果如何截断？** 处理对象是当前轮次中超标的工具结果，核心约束是截断决策，一旦被模型看见就不可逆。
2. **历史轮的旧结果何时可以丢弃？** 处理对象是历史轮次中过时的工具结果，核心约束是不能破坏 prompt cache 前缀。

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

Budget 控制以 API 消息组为粒度——LLM 一次响应可能触发多个工具调用，它们的执行结果合并为一条 API user message。以组为单位检查有双重好处：已处理过的消息组不会被重新评估（组内没有新结果，直接跳过），避免在同一个工具调用的产物之间做取舍时丢失上下文关联。

但这个操作有一个隐藏约束：**一旦模型看到了某个结果，它就成为了服务端缓存前缀的一部分。** 后续再改它，整个前缀缓存失效：

```markdown
1. 第 3 轮：一条工具结果体积在阈值内，判定为"不替换"，模型看到了完整内容
2. 第 5 轮：累计 token 压力增加，想替换它来省空间
3. 但不行，它已经在缓存前缀里了
```

这意味着处理决策必须永久冻结。每条工具结果一旦被模型看到，它在缓存前缀中的位置就锁死了：

- **已经替换过的**：每轮重复使用完全相同的占位符字符串，保证缓存命中。不重新读写磁盘、不重新生成预览。
- **已经看过但没替换的**：不能再改。即便后续发现它其实很大、想回收空间，也只能接受现状。
- **还没见过的**：可以自由决定——太大就持久化替换，否则保留原样。

三条规则有明确的优先级：先查是否替换过，再查是否见过，最后才归入新结果。在 prompt cache 约束下，这些决策不可逆——替换决定一旦做出，必须在后续每一轮中忠实重现。

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
  │    feature 开启 + 模型支持 + 当前是主线程 ?
  │    └─ YES → 热缓存路径：cache_edits
  │         （缓存还温热，不动消息内容，通过 API 标记服务端删除）
  │
  └─ ③ 都不满足 → 跳过（留给对话级压缩处理）
```

#### 缓存热时不动消息，缓存冷时直接清空

两套清理策略由 prompt cache 的冷热状态决定。

**缓存热时**，修改消息内容会导致前缀缓存全部失效。通过 `cache_edits` API，删除指令发生在服务端内部，客户端消息字节完全不变，缓存完美保留。**缓存冷时**，策略反过来——前缀反正要重写，发请求前直接清空旧内容，重算前缀更短、成本更低。将内容统一替换为占位符 `[Old tool result content cleared]`，消息骨架完整保留，模型仍然知道"执行过什么操作"。

为什么用时间（60min）判断冷热？判断的根本问题是"缓存还在不在"，而非"东西多不多"。60 分钟保守对齐 Anthropic 缓存 TTL（约 1 小时）。

| | 冷缓存 (content-clear) | 热缓存 (cache_edits) |
|---|---|---|
| 触发 | gap > 60min | gap ≤ 60min + feature 开启 + 模型支持 + 主线程 |
| 操作 | 客户端替换内容 | API 参数告知服务端删除 |
| 消息字节 | 改变 | 不变 |
| 缓存影响 | 已冷，无影响 | 前缀完美保留 |
| 额外 API 调用 | 零 | 零 |

无论哪种路径，始终保留最近 N 条结果不清，避免模型失去全部工作上下文。

#### cache_edits 的跨轮次状态管理

cache_edits 通过 API 参数告知服务端删除指定 tool_result，客户端消息字节不变、缓存不受影响。它引入两个需跨轮次解决的问题：

- **哪些结果该删？** 决策不能每轮独立做出——需要累积多轮的工具结果，超阈值时触发。因此依赖跨轮次存活的状态容器。
- **删除指令如何维持？** cache_edits 非幂等——服务端每轮都要被告知哪些条目已删除，否则缓存前缀可能引用到已清理条目。

这形成了一个跨轮次循环：

```
每轮：consume（取出待删条目）→ API 请求 → 服务端标记 → pin（重新装载）→ 下轮 consume ...
```

状态容器（模块级单例）是全局可变的，因此入口必须过滤：只有主线程能操作，forked agent 的注册会被拒绝，防止删除不属于自己对话的内容。

#### 清理范围：白名单即风险分级

不是所有工具结果都应该被清理。可清理的只有八类工具——文件读取、命令执行、搜索、文件匹配、网页搜索、网页抓取、文件编辑、文件写入。它们的共性是"体积大 + 时效性强"：输出通常很大，且一旦产生，后续推理很少需要回头查阅原文。

不在白名单中的工具，本质上是清理代价太高：

- **协调层**（子任务、子智能体）：子任务执行结果对后续推理有持续参考价值——Agent 需要知道"子任务完成了什么"
- **交互层**（用户问答）：用户的回答是关键的决策输入，不可丢弃
- **扩展层**（MCP 工具）：MCP 工具的结果语义各异，没有统一的清理策略适用

---

## 3. 源码解读

### 3.1 核心文件清单

| 文件 | 职责 |
|------|------|
| [`microCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts) | Micro-Compact 主入口：Time-based MC + Cached MC 两条路径分发 |
| [`toolResultStorage.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts) | 大结果截断核心：持久化 + 状态冻结三分法 + 跨轮次重建 |


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
  │                └─ consumePendingCacheEdits()   // 注入到 API 请求的 cache_edits 字段
  │
  └─ ③ callModel(messages)
```

### 3.3 applyToolResultBudget() — 大结果截断

#### 3.3.1 Budget 入口：[`applyToolResultBudget()`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts#L924-L936)

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

#### 3.3.2 Budget 主循环：[`enforceToolResultBudget()`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts#L769-L909)

`enforceToolResultBudget` 是三分法的消费端，按消息组逐组将分区结果转化为实际动作：

```typescript
// toolResultStorage.ts:796-847（核心循环）
for (const candidates of candidatesByMessage) {
  const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, state)

  // mustReapply：纯内存查抄，字节级复用，零 I/O
  mustReapply.forEach(c => replacementMap.set(c.toolUseId, c.replacement))

  // 整组已处理过 → 跳过预算检查，只续标 seenIds
  if (fresh.length === 0) {
    candidates.forEach(c => state.seenIds.add(c.toolUseId))
    continue
  }

  // 豁免工具（Read 等）→ 标记 seenIds，不参与替换，不计入预算
  const eligible = fresh.filter(c => !shouldSkip(c.toolUseId))
  const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0)
  const freshSize = eligible.reduce((sum, c) => sum + c.size, 0)

  // frozenSize + freshSize > limit → 触发贪心选择
  const selected = frozenSize + freshSize > limit
    ? selectFreshToReplace(eligible, frozenSize, limit)
    : []

  // 不被替换的 candidate 立即标记 seenIds
  // 被选中的 candidate 等 persist 成功后再标记
  // （避免并发读取看到 X∈seenIds 但 X∉replacements）
  const selectedIds = new Set(selected.map(c => c.toolUseId))
  candidates.filter(c => !selectedIds.has(c.toolUseId))
    .forEach(c => state.seenIds.add(c.toolUseId))

  if (selected.length > 0) toPersist.push(...selected)
}
// ... 之后并行 persist + 写入 replacementMap + 调用 replaceToolResultContents
```

设计要点：
- **`fresh.length === 0` 短路**：整组已处理过则直接跳过，不重新计算预算。同一消息组的新结果和旧结果不会混合——新结果总是在新消息组中首次出现
- **`frozenSize` 参与预算**：防御 GrowthBook 动态配置降低阈值时，已冻结结果仍占用预算空间
- **selectedIds 的原子性**：被选中的 candidate 不在 persist 前标记 seenIds，确保 `X∈seenIds` 和 `X∈replacements` 同生同灭——防止子智能体并发读取看到不完整状态

#### 3.3.3 Budget 三分法：[`partitionByPriorDecision()`](https://github.com/binarylei/claudecode/blob/main/src/utils/toolResultStorage.ts#L649-L667)

将每条工具结果按 `ContentReplacementState` 中的历史决策分为 `mustReapply`、`frozen`、`fresh` 三类：

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
- **检查顺序不可交换**：被替换过的结果同时在 `replacements` 和 `seenIds` 中。先检查 `replacements` 确保它走 `mustReapply`（复用缓存的精确字符串），后检查 `seenIds` 才正确归入 `frozen`
- **`replacements` 存的是精确字符串而非重新推导**：即使预览模板、文件大小格式化或路径布局的代码发生变化，替换字符串保持不变，缓存前缀命中
- **`frozen` 是防御动态配置变更的兜底**：GrowthBook 可能在会话中途降低阈值，已看过但未替换的结果不能再追补替换——宁可接受 overage，交给 microcompact 后续清理

### 3.4 microcompactMessages() — 旧结果清理

#### 3.4.1 入口分发：[`microcompactMessages()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L253-L293)

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
- **`feature('CACHED_MICROCOMPACT')` 包裹**：Cached MC 路径受 feature gate 控制，关闭时整段代码被 tree-shake 掉
- **三层检查才能进入 Cached MC**：feature gate + model support + isMainThreadSource，每层过滤一类场景

#### 3.4.2 Time-based 判定与执行：[`maybeTimeBasedMicrocompact()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L446-L530)

Time-based MC 分两步：先通过 `evaluateTimeBasedTrigger` 判断最后一条 assistant 消息距今是否超过 60 分钟阈值（保守对齐 Anthropic 缓存 TTL），超过则缓存视为已冷；再由 `maybeTimeBasedMicrocompact` 执行 content-clear，将旧工具结果内容替换为占位符并处理连锁副作用。

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
- **`querySource` 非空 + `isMainThreadSource` 双重检查**：`/context`、`/compact` 等分析型调用不应触发实际清理
- **`findLast` 而非 `messages[last]`**：最后一条消息不一定是 assistant，精确查找避免取到 user 或 system 消息
- **`Math.max(1, keepRecent)` 防止双退化**：`keepRecent = 0` 时 `slice(-0)` 返回全数组，floor 为 1 同时避免了"全不清"和"全清"两个极端
- **Set 而非 Array**：后续遍历每条消息时做 O(1) 查重
- **清理后 `resetMicrocompactState()` + `notifyCacheDeletion()`** 两个副作用缺一不可

#### 3.4.3 Cached MC 执行：[`cachedMicrocompactPath()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L305)

Cached MC 通过 cache_edits API 在服务端删除旧工具结果，客户端消息内容不变、缓存前缀不失效。

```typescript
// microCompact.ts:305-343
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()

  // 注册阶段：将白名单内的 tool_result 按 user message 分组注册到 cachedMCState
  const compactableToolIds = new Set(collectCompactableToolIds(messages))
  for (const message of messages) {
    // ... 遍历 content block，注册未注册过的 tool_result，按 user message 分组 ...
  }

  // 判定阶段：累计超过阈值则返回待删除列表
  const toolsToDelete = mod.getToolResultsToDelete(state)
  // ... 生成 cache_edits 指令块，捕获 baseline ...
}
```

随后生成 `cache_edits` 指令块并捕获 baseline（[microCompact.ts:332-383](https://github.com/binarylei/claudecode/blob/main/src/services/compact/microCompact.ts#L332-L383)）：

```typescript
if (toolsToDelete.length > 0) {
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  if (cacheEdits) {
    pendingCacheEdits = cacheEdits  // 模块变量，由 consumePendingCacheEdits 消费
  }

  // 捕获 baseline：API 返回的 cache_deleted_input_tokens 是累积值，
  // 需减去请求前的 baseline 才能得到本轮 delta
  const lastAsst = messages.findLast(m => m.type === 'assistant')
  const baseline = lastAsst?.type === 'assistant'
    ? ((lastAsst.message.usage as unknown as Record<string, number>)
        ?.cache_deleted_input_tokens ?? 0)
    : 0

  return {
    messages,  // 消息不变——删除在服务端完成
    compactionInfo: {
      pendingCacheEdits: { trigger: 'auto', deletedToolIds: toolsToDelete, baselineCacheDeletedTokens: baseline },
    },
  }
}
```

设计要点：
- **消息内容不变**：删除通过 cache_edits API 参数在服务端完成，客户端消息字节完全一致，prompt cache 前缀不受影响
- **三段式生命周期**：register（累积工具结果）→ decide（超阈值触发）→ create（生成 cache_edits 块），每轮 consume 后必须重新 pin，因为 cache_edits 非幂等
- **baseline 机制**：`cache_deleted_input_tokens` 是累积值而非增量，需在请求前捕获 baseline、响应后做差，才能在 boundary message 中展示本轮实际节省量
- **`isMainThreadSource` 守卫**：`cachedMCState` 是模块级单例，forked agent 的注册会被拒绝，防止跨对话污染

---

## 4. 总结

1. **热缓存和冷缓存的最优策略互斥**：热缓存要求消息内容不可变（只能用 cache_edits），冷缓存允许直接修改（content-clear），两种场景各对应一种最优解，缺一不可
2. **Cached MC 的三阶段生命周期（consume → pin → re-send）** 是因为 cache_edits 非幂等——服务端需要每轮都被告知哪些条目已删除
3. **Time-based MC 的 60 分钟阈值是保守对齐 Anthropic 缓存 TTL 的结果**——宁可多等几分钟，也不要在缓存仍热时误触发 content-clear
4. **`applyToolResultBudget` 与 Micro-Compact 一纵一横**——Budget 截断当前轮的超大新结果，MC 清理历史轮的过时旧结果，两者在 Agent Loop 同一 pre-API 路径上紧邻执行
5. **prompt cache 约束下替换决策不可逆**：`ContentReplacementState` 将这一约束编码为显式状态——`frozen` 不是 bug 的 workaround，而是缓存一致性模型的一部分
6. **Budget 选择最大优先而非 FIFO**——目标是最大化每次替换的 token 节省量，贪心策略在"最少 I/O 次数"约束下逼近"最小总体积"
7. **白名单的本质是语义风险分级**——感知层工具清理代价低，协调层工具清理代价高（丢失子任务上下文）


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

  - [`src/services/compact/timeBasedMCConfig.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/timeBasedMCConfig.ts) — Time-based MC 的 GrowthBook 动态配置
  - [`src/services/compact/compactWarningState.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compactWarningState.ts) — 压缩后警告抑制的全局 Store
  - [`src/services/compact/autoCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts) — 对话级压缩的触发决策（第 23 章核心）
  - [`src/services/compact/compact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts) — Compact 完整实现（第 23 章核心）
  - [`src/query.ts`](https://github.com/binarylei/claudecode/blob/main/src/query.ts) — Agent Loop 主循环，pre-API 压缩管线的调用方
