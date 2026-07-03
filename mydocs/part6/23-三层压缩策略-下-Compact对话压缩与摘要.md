---
title: "23. 三层压缩策略（下）：Compact 对话压缩与摘要"
description: "阈值触发分级响应、Session Memory 复用零成本路径、Forked Agent 缓存共享——对话级压缩如何用最少 API 调用将数万 token 的对话历史压缩为结构化摘要"
outline: [2, 3]
---

# 23. 三层压缩策略（下）：Compact 对话压缩与摘要

[第 22 章](../part6/22-三层压缩策略-上-Micro-Compact与工具结果清理) 中我们分析了 Micro-Compact——它在每轮 API 调用前自动清理过时工具结果，零额外成本、对用户完全透明。但这里有一个它无法处理的场景：**对话轮次足够多时，即便工具结果全部清空，Assistant 的思考链和 User 的消息本身也足以撑满窗口。** 清理东西只能延缓，不能根治——当"东西本身"就是问题时，需要的不是清理，而是**重写**。

这就是第 23 章的核心命题：用 LLM 把冗长的对话历史重写为一段简短的摘要，以 1 次额外 API 调用的代价，换取窗口压力的根本性缓解。

## 1. 背景介绍

Compact 是对话级的上下文压缩机制。它调用一次 LLM，将整段对话历史压缩为一份结构化摘要——保留"做了什么、为什么、接下来要做什么"的语义，丢弃具体的工具输出和逐轮交互细节。和 Micro-Compact 不同，它不是每轮自动执行的——它有成本，所以只在必要时才触发。

### 1.1 和 Micro-Compact 的分工

用一句话说清两者的关系：**Micro-Compact 是"打扫房间"，Compact 是"搬家换小房子"。**

| | Micro-Compact（第 22 章） | Compact（本章） |
|---|---|---|
| **操作对象** | 工具结果的内容 | 整段对话历史 |
| **操作方式** | 清空 / 标记删除 | LLM 生成摘要 |
| **API 调用** | 零 | 1 次 |
| **触发时机** | 每轮自动 | 阈值触发 |
| **比喻** | 扔掉过期报纸 | 把整屋东西写成清单，丢掉原件 |

这也是第 22 章五步管线中那条触发边界线的含义—— **能免费的先用免费的，免费的扛不住了再上付费的。** 这是贯穿两章的核心经济逻辑。

### 1.2 为什么不能简单截断？

面对窗口溢出，最直觉的方案是"滑动窗口"——保留最近 N 轮，丢弃更早的消息。这是 ChatGPT 等产品的常见做法。但它有一个致命缺陷：**丢弃历史 = 丢弃上下文。** 模型会忘记对话前半段做出的技术决策、踩过的坑、用户给过的反馈——然后重蹈覆辙。

Compact 在"全保留"和"全丢弃"之间找到第三条路：**保留语义，丢弃细节。** 不是删掉旧消息然后假装它们不存在，而是先把它们"读一遍、写个摘要"，再把摘要放进上下文。模型看不到原始的 tool 输出细节，但知道"我曾经读过 fileA、改过 functionB、遇到了 errorC 并修复了"。这就是摘要压缩和截断的本质区别。

### 1.3 三个子问题

用「极端假设法」框定问题空间：

- **从不 Compact**：对话持续增长，最终窗口溢出，会话中断——用户只能手动 `/compact` 或开新会话
- **每轮都 Compact**：每轮都在做摘要，API 调用成本爆炸，且摘要必然丢失细节、语义逐轮漂移

正确的做法在中间：**在窗口快满时触发，够用就不动。** 这引出了 Compact 设计的三个核心子问题：

1. **WHEN** — 什么时候算"快满了"？阈值怎么定？触发前还有哪些条件要检查？
2. **HOW** — 怎么用最少的成本完成这次 LLM 摘要调用？
3. **WHAT** — 摘要生成后，丢了哪些细节，怎么补回来？

---

## 2. 核心逻辑

### 2.1 什么时候触发

```
contextWindow (200K)           ─── 物理上限
│  -20K  output 空间（input+output 共用窗口）
├─ effectiveContextWindow (180K) ── 有效输入边界
│  -3K   手动命令空间             ←── 阻断线
│  -13K  执行余量                  ←── 触发线
│
│  ── 167K 以上 → 自动 compact
│  ── 177K 以上 → 强制手动 /compact
│  ── 167K 以下 → 安全区
```

**第一步：起点——上下文窗口**

模型的上下文窗口（比如 200K）是硬上限。对话中所有内容——system prompt、tools、消息历史——都必须塞进这个窗口。看起来很简单：token 用量逼近 200K 就该触发 compact。但真的能用满 200K 吗？

**第二步：有效输入窗口——为什么不能全用？**

API 窗口限制的是 **input + output 总和**，不是只限制 input。compact 把整段对话当 input 发出去，等待 LLM 生成摘要。如果 input 已经占满 200K，output 连一个 token 都无处可写——compact 请求本身就不成立。所以首先要从物理窗口中扣掉 output 空间：

```
effectiveContextWindow = contextWindow - 20K
```

20K 来自线上 p99.99 摘要输出量（17,387 token），做上限覆盖。现在 compact 有了安全的运作边界 180K——但能等 180K 满了再触发吗？

**第三步：触发线——为什么不能等有效窗口满了？**

compact 不只是"发一个请求"——自身的 prompt（告诉 LLM 怎么写摘要）要占用窗口。如果等 `effectiveContextWindow` 满了才触发，这些空间已被对话塞满，compact 操作无处施展。所以再从有效窗口中扣掉 13K 执行余量：

```
autoCompactThreshold = effectiveContextWindow - 13K = 167K
```

当 token 用量达到 167K 时，`autoCompactIfNeeded()` 自动启动 compact，用户无感。这是正常路径。

**第四步：阻断线——触发失败了怎么办？**

触发线依赖自动机制。如果 auto compact 被用户关闭、或者连续熔断失效了，还需要一条不依赖自动机制的独立防线——强制用户手动 `/compact`：

```
blockingLimit = effectiveContextWindow - 3K = 177K
```

3K 是够发一条 `/compact` 命令的最小空间。达到 177K 时，系统拒绝新请求。

**延伸讨论：为什么是 83.5% 而不是 50%？**

也许你有一个疑问：167K（83.5%）是不是太晚了？上下文超过一半时 LLM 输出质量就会下降——这个直觉有研究支撑（如 Lost in the Middle 效应），把触发线放在 50% 附近似乎更安全。

但这里有两个被忽略的前提。第一，衰减是渐进而非断崖式的——不同模型和任务的衰退起点差异很大，没有一个统一的 50% 红线。第二，167K 触发意味着模型只在长上下文区停留触发前的最后几轮——compact 后上下文骤降到 20K-30K，之后的长时间运行都在短上下文状态。compact 的目的不是"避免衰减"，而是"缩短衰减的持续时间"。

本质仍然是贯穿全章的经济逻辑：把触发线下移到 100K，compact 频率翻倍——更多的 API 费用、更大的摘要漂移风险。在"短期内渐进衰减"和"确定的多花钱"之间，Claude Code 选了前者。

### 2.2 怎么省钱：能不调就不调，调了也要共享缓存

一旦触发线被越过，Compact 必须做一次 LLM 调用。这次调用能省则省——两条路径，成本逐级升高。

**Fast path：复用 Session Memory，零额外调用。**

Session Memory 是 Claude Code 的后台记忆系统——它在 Agent 工作时持续从对话中提取结构化记忆（关键决策、用户偏好、项目约定），写入磁盘文件。这个"提取"过程和 Compact 要做的"摘要"在语义上高度重叠——都是把长对话浓缩为短文本。

既然 session memory 已经有一份现成的"摘要"了，为什么还要再调一次 LLM 重新生成？直接拿来用。`trySessionMemoryCompaction()` 读取 session memory 文件内容，包装为 compact summary message，替换掉旧消息——整个过程是一次文件读取，零 API 调用。

但复用有条件：session memory 文件必须存在且非空（不是初始化模板），能找到 `lastSummarizedMessageId` 来定位"哪些消息已被 memory 覆盖"，以及压缩后的上下文体积确实低于触发线（否则等于没压缩）。三个条件任一不满足，降级到 slow path。

**Slow path：Forked Agent 生成摘要，共享缓存降本。**

走 slow path 意味着要发一条请求给 LLM，让它读完全部对话历史并输出摘要。如果独立发送这条请求——用自己的 system prompt（"你是一个摘要助手"）、自己的 tools（只有 FileReadTool），消息历史独立编码——它和主对话的前缀完全不同，prompt cache 全部重算，缓存读取命中率仅 2%。

Forked Agent 解决了这个问题。它不是独立构建请求，而是**复用主线程的 system prompt + tools + 消息前缀**，只追加一条"请摘要上述对话"的 user message。由于前缀完全一致，服务端的 prompt cache 直接命中。

两条路径的关系是典型的 **fast path / slow path**：

```
autoCompactIfNeeded()
  │
  ├─ trySessionMemoryCompaction()
  │    ├─ session memory 可用? → 零成本，直接返回
  │    └─ 不可用 →
  │
  └─ compactConversation()
       └─ streamCompactSummary()
            ├─ runForkedAgent (复用主线程缓存前缀)
            └─ 失败 → queryModelWithStreaming (独立 streaming，兜底)
```

每一层都有 fallback：session memory 不可用 → fork agent；fork agent 不兼容 → 独立 streaming。用户在任一层的失败都是透明的——降级自动发生，compact 总能完成。

**那 fast path 省掉的到底是什么？**

不只是 1 次 API 调用的费用。传统 compact 的 fork agent 虽然共享缓存，但仍要消耗输出 token（摘要文本）。而 session memory 的提取是在 Agent 正常工作时异步完成的——它的成本已经"摊销"在之前的对话轮次中了。所以 fast path 的**增量成本为零**。这就是"能不调就不调"的真正含义：不是省一次调用，是这件事的成本已经在别处付过了。

### 2.3 怎么补回来：从摘要剩下的空间里恢复关键上下文

Compact 把几万 token 的对话压成一份约 2K token 的摘要。语义保留了——"做了什么、为什么、接下来要做什么"——但细节全丢了。具体来说，模型丢失了四类关键信息：

- **文件上下文**：刚读过哪些文件？内容是什么？不知道了，只能重新 read。
- **技能内容**：用户调用了哪些 skill？skill 的指令是什么？不知道了，只能重新加载。
- **Plan 状态**：是否在 plan mode？plan 写了什么？不知道了，可能中断 plan 流程。
- **后台任务**：有没有异步子 agent 还在跑？进度如何？不知道了，可能重复启动。

如果什么都不做，模型 compact 后的第一轮会处于"失忆"状态——它知道之前做了什么（摘要告诉它了），但缺少执行下一轮动作所需的细节。所以 compact 之后要做**附件恢复**：从摘要省下的 token 空间里，拿出一部分还给上下文质量。

每类附件有独立的 token 预算和恢复策略：

```
Compact 后附件恢复管线
  │
  ├─ 文件恢复     ≤5 个文件, 50K budget, 按最近访问时间排序
  ├─ 技能恢复     ≤25K budget, 每 skill 截断至 5K, 按最近调用时间排序
  ├─ Plan 恢复    单条, 不计入 budget（通常很小）
  ├─ Plan Mode    plan_mode attachment（确保模型继续 plan 行为）
  ├─ 异步 Agent   task_status attachment（谁在跑、跑完了没）
  └─ Tool/MCP 增量 重新通告工具和 MCP 指令（与 compact 前做 diff）
```

恢复逻辑遵循三条原则：

1. **按紧迫性而非完整性排序**。不是把所有读过的文件都恢复——只恢复最近 5 个，不够的模型自己重新 read。目标是"让模型能继续工作"，而非"让模型回到 compact 前一模一样的状态"。

2. **每类附件有独立上限，互不挤占**。文件最多 50K、技能最多 25K，不设全局上限。这是基于一个观察：不同类型附件的语义功能不同，限制总量会导致"文件把技能挤出"或反之，任何一种被挤出都会损害特定的恢复维度。

3. **优先级由"最近使用"决定，而非"体积大小"**。文件和技能都按最近使用时间降序排列——用户刚摸过的东西最可能下一轮还要用。这和 Micro-Compact 中按体积大小贪心的策略正好相反：那边是"清除最大的最划算"，这边是"恢复最近的最有用"。

### 2.4 极端场景怎么兜底

Compact 流程自身也需要应对两种极端失败场景：

**PTL 重试：当压缩请求本身超限。** 对话可能长到连 compact 请求本身都发不出去（触发 API 的 `prompt_too_long`）。此时按 API 轮次从旧到新丢弃消息，每丢弃一组重试一次，最多重试 3 次。按轮次而非按消息数丢弃，是为了避免切断 tool_use 和 tool_result 的配对——那会产生 API 拒绝的孤儿引用。

**熔断器：连续失败三次就停。** 如果上下文已不可恢复地超过窗口上限（例如用户一次性贴了 500K 文本），每轮重试 compact 只会浪费 API 调用。实际线上数据：1,279 个会话曾出现 50+ 次连续失败（最多 3,272 次），每天浪费约 250K 次 API 调用。3 次熔断是一个代价极小、收益极大的防御性设计。

---

## 3. 源码解读

### 3.1 源码地图：一张图走完"触发→压缩→恢复"全流程

Compact 涉及 10+ 个源文件，但核心调用路径收敛在一条主线上。先看全貌：

**核心文件清单**

| 文件 | 职责 |
|---|---|
| [`autoCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts) | 阈值计算、触发判断、fast/slow path 调度、熔断器 |
| [`sessionMemoryCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/sessionMemoryCompact.ts) | Session Memory 复用路径（零成本 compact） |
| [`compact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts) | 核心编排：摘要生成、PTL 重试、附件恢复、消息重建 |
| [`prompt.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/prompt.ts) | Compact 专用 prompt 模板（BASE / PARTIAL / PARTIAL_UP_TO） |
| [`postCompactCleanup.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/postCompactCleanup.ts) | Compact 后的缓存清理 |
| [`grouping.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/grouping.ts) | 按 API 轮次分组消息（PTL 重试的前置步骤） |
| [`forkedAgent.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/forkedAgent.ts) | Forked Agent 机制——缓存共享的核心实现 |

**完整调用链**

```
Agent Loop (query/)
  │
  └─ autoCompactIfNeeded()                    [autoCompact.ts]
       │
       ├─ shouldAutoCompact()                 [autoCompact.ts]
       │    ├─ getEffectiveContextWindowSize() → contextWindow - 20K
       │    ├─ getAutoCompactThreshold()       → effectiveWindow - 13K
       │    └─ calculateTokenWarningState()    → 五个布尔标志
       │
       ├─ trySessionMemoryCompaction()        [sessionMemoryCompact.ts]  ← fast path
       │    ├─ waitForSessionMemoryExtraction()  等待后台提取完成
       │    ├─ isSessionMemoryEmpty()            模板检查
       │    ├─ calculateMessagesToKeepIndex()    双重约束（minTokens + maxTokens）
       │    ├─ adjustIndexToPreserveAPIInvariants()  修复 tool_use/tool_result 配对
       │    └─ buildPostCompactMessages()        组装最终消息数组
       │
       └─ compactConversation()               [compact.ts]  ← slow path
            ├─ executePreCompactHooks()
            ├─ streamCompactSummary()
            │    ├─ runForkedAgent()           [forkedAgent.ts]  ← 缓存共享路径
            │    │    └─ 复用主线程 system prompt + tools + 消息前缀
            │    └─ queryModelWithStreaming()  ← 独立 streaming 兜底
            ├─ truncateHeadForPTLRetry()       ← PTL 重试（最多 3 次）
            ├─ createPostCompactFileAttachments()      ← 文件恢复
            ├─ createSkillAttachmentIfNeeded()          ← 技能恢复
            ├─ createPlanAttachmentIfNeeded()           ← Plan 恢复
            ├─ createPlanModeAttachmentIfNeeded()       ← Plan Mode 恢复
            ├─ createAsyncAgentAttachmentsIfNeeded()    ← 异步 Agent 恢复
            ├─ getDeferredToolsDeltaAttachment()        ← Tool/MCP 增量
            ├─ processSessionStartHooks()               ← Session Start 钩子
            ├─ executePostCompactHooks()
            └─ buildPostCompactMessages()               ← 统一组装
```

调用链值得关注两个设计惯例：**每条路径都返回 `CompactionResult`，由 `buildPostCompactMessages()` 统一组装最终消息数组**——这意味着 fast path 和 slow path 的输出格式完全一致，调用方不需要区分路径。**Compact 后统一调用 `runPostCompactCleanup()`**——无论走哪条路径、无论成功或失败（fast path 内调用、slow path 后在 `autoCompactIfNeeded` 中调用），清理逻辑集中在一处。

接下来的 5 个小节，按调用链的时间顺序展开——从触发判断到压缩执行，再到恢复和防御。

### 3.2 阈值怎么算出来：`calculateTokenWarningState` 的一次性计算

2.1 推演了四级阈值线。看代码如何落地——两个关键函数（`getEffectiveContextWindowSize` 和 `calculateTokenWarningState`）加一个守卫列表。

**怎么定义"有效窗口"：20K 不是硬编码**

[`getEffectiveContextWindowSize()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts#L33-L49) 做的事很简单——从模型的物理窗口减去摘要输出预留：

```typescript
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  // ...环境变量覆盖逻辑省略...
  return contextWindow - reservedTokensForSummary
}
```

设计要点：

- **`Math.min(modelMaxOutput, 20_000)` 不是多此一举**。有些模型的 `maxOutput` 本身就小于 20K（比如某些第三方兼容模型的 `maxOutput` 只有 4K-8K），如果固定减 20K 会造成**过度预留**——明明输出空间只有 4K，却预留了 20K，浪费了 16K 的输入空间。取较小值确保"只预留模型实际能输出的量"。
- **20K 这个值来自线上 p99.99 数据**（注释在第 30 行明确说明：17,387 token），但代码不直接用 17,387 而用 20K——预留的是"上限"，不是"平均值"。如果按平均值预留，p50 以上所有 case 都会超限，compact 请求大面积失败。这个设计体现了工程中"对齐最坏情况而非典型情况"的原则。

**五个布尔标志为什么一次算完**

[`calculateTokenWarningState()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts#L93-L145) 是阈值体系的核心。输入当前 token 用量，一次返回五个标志：

```typescript
export function calculateTokenWarningState(tokenUsage: number, model: string): {
  percentLeft: number
  isAboveWarningThreshold: boolean      // tokenUsage ≥ threshold - 20K
  isAboveErrorThreshold: boolean        // tokenUsage ≥ threshold - 20K
  isAboveAutoCompactThreshold: boolean  // tokenUsage ≥ threshold (effectiveWindow - 13K)
  isAtBlockingLimit: boolean            // tokenUsage ≥ effectiveWindow - 3K
} { /* ... */ }
```

- **为什么不分次计算？** 因为 Agent Loop 中 UI 提示（`TokenWarning.tsx`）和行为决策（`shouldAutoCompact()`）需要**同时**使用这些标志。如果分次调用，token 用量在两次计算之间可能因 background agent 的输出而增长，导致"UI 显示黄色警告，但实际已经到了红色阻断线"的状态不一致。
- **`isAboveErrorThreshold` 和 `isAboveWarningThreshold` 的 buffer 值相同（都减 20K），但语义不同**：warning 是提醒用户"窗口吃紧了"，error 是强烈建议用户手动 compact。两条线平行下移而非分叉——这是因为在空间紧张的场景下，warning 和 error 之间的"缓冲区"没有实际意义，用户反馈"看到 warning 和看到 error 的反应应该是一样的：compact"。

**触发前还有一长串守卫条件**

[`shouldAutoCompact()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts#L160-L238) 在判断阈值之前，先检查一圈守卫条件：

```typescript
// 守卫 1：递归防护——compact/session_memory 子 agent 不能再次触发 compact
if (querySource === 'session_memory' || querySource === 'compact') return false

// 守卫 2：用户主动关闭
if (!isAutoCompactEnabled()) return false

// 守卫 3：REACTIVE_COMPACT 模式下，让 reactive compact 接管（ant-only）
if (feature('REACTIVE_COMPACT')) { /* ... */ return false }

// 守卫 4：CONTEXT_COLLAPSE 模式下，collapse 自己管理窗口
if (feature('CONTEXT_COLLAPSE')) { if (isContextCollapseEnabled()) return false }
```

这些守卫的本质是**防止 Compact 和其它上下文管理机制互相干扰**。Context Collapse 是一个典型的冲突场景——collapse 在 90% 提交、95% 阻断，compact 在 ~93% 触发（`effectiveWindow - 13K` ≈ 187K / 200K ≈ 93.5%），两条线之间只有 1.5% 的间隙，compact 几乎总是比 collapse 先触发。代码注释直接说明了这个决策："collapse IS the context management system when it's on"。

### 3.3 怎么做到零成本：Session Memory 复用的三个失败出口

2.2 得出 fast path 的核心优势是零增量成本。`trySessionMemoryCompaction()` 的源码视角则反过来——重点不是"怎么复用"，而是"什么情况下不能复用"——三个失败出口，每个对应线上一种常见场景。

[`trySessionMemoryCompaction()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/sessionMemoryCompact.ts#L514-L630) 有三个失败出口，每个都对应一个线上常见场景：

```typescript
// 失败出口 1：没有 session memory 文件
const sessionMemory = await getSessionMemoryContent()
if (!sessionMemory) {        // 文件不存在或读取失败
  logEvent('tengu_sm_compact_no_session_memory', {})
  return null  // → 降级到 slow path
}

// 失败出口 2：文件存在但内容是初始模板（LLM 还没提取过任何记忆）
if (await isSessionMemoryEmpty(sessionMemory)) {
  logEvent('tengu_sm_compact_empty_template', {})
  return null  // → 降级到 slow path
}

// 失败出口 3：lastSummarizedMessageId 不存在于当前消息中
// （消息可能被修改过，无法确定哪些消息已被 memory 覆盖）
if (lastSummarizedIndex === -1) {
  logEvent('tengu_sm_compact_summarized_id_not_found', {})
  return null  // → 降级到 slow path
}
```

- **每个失败出口都有对应的事件打点**。这不是过度设计——Session Memory Compact 作为实验性功能（feature flag 控制），这些事件是判断"为什么 fast path 命中率低"的唯一数据来源。线上可以区分是"session memory 还没开启"还是"开启了但提取还没完成"还是"消息被修改导致无法对齐"。
- **失败即降级，用户完全无感**。返回 `null` 后调用方自动进入 `compactConversation()`——从用户视角看，compact 还是发生了，只是多花了一次 API 调用。这种透明降级是 fast path 模式能放心上线的前提：fast path 失败不是 bug，只是省的钱没省到。

**保留多少消息：双重约束的博弈**

[`calculateMessagesToKeepIndex()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/sessionMemoryCompact.ts#L324-L397) 是 fast path 中最微妙的逻辑。它决定从哪个位置开始保留消息：

```typescript
// 从 lastSummarizedIndex + 1 开始（Session Memory 已覆盖之前的消息）
let startIndex = lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length

// 向前扩展直到满足两个"不少于"条件
for (let i = startIndex - 1; i >= 0; i--) {
  totalTokens += msgTokens
  if (msg 含文本) textBlockMessageCount++
  startIndex = i

  if (totalTokens >= config.maxTokens) break    // "不超过"优先
  if (totalTokens >= config.minTokens &&
      textBlockMessageCount >= config.minTextBlockMessages) break
}
```

- **双重约束的设计意图**：`minTokens`（10K）保证模型有足够的最近上下文理解当前状态；`minTextBlockMessages`（5 条）保证至少有 5 条"有语义内容"的消息——纯 tool_result 不算。如果只设 token 下限，可能保留的 10K token 全是工具输出，模型还是不知道"用户在说什么"。
- **maxTokens（40K）优先级最高**：如果 lastSummarizedIndex 之后的消息已经超过 40K，**立即停止扩展，不满足 minimums 也接受**。理由是 40K 已经超过 compact 本身能节省的空间了——超过这个量的"保留"等于没 compact。

**最容易出错的细节：修复 tool_use/tool_result 拆分**

[`adjustIndexToPreserveAPIInvariants()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/sessionMemoryCompact.ts#L232-L314) 是一个典型的"修 bug 修出来的函数"。注释中详细记录了两种 bug 场景：

- **Step 1（工具配对）**：如果需要保留的消息中有 `tool_result` 引用，但对应的 `tool_use` 在保留范围之外，API 会报 orphan 引用。函数向前查找匹配的 `tool_use` 消息并纳入保留范围。
- **Step 2（thinking 块合并）**：Streaming 架构下，同一个 API 响应的 thinking 和 tool_use 可能被拆成多条消息存储（`message.id` 相同但 `uuid` 不同）。如果保留范围从 tool_use 消息开始，thinking 消息会被丢弃——API 端 `normalizeMessagesForAPI` 按 `message.id` 合并时，thinking 块就丢失了。

这两个 bug 都源于同一个根因：**消息的物理存储单元（uuid）和 API 语义单元（message.id + tool_use/tool_result 配对）不是一一对应的。** 这是 streaming 架构引入的复杂性——消息是逐块到达、逐块存储的，但 API 要求它们以完整的"轮次"为单位。

### 3.4 Forked Agent 为什么能共享缓存：前缀复用的一行关键注释

2.2 得出 slow path 的核心挑战是缓存命中率。看 Forked Agent 如何用前缀复用来解决——以及它和独立 streaming 在架构上的三层差异。

[`streamCompactSummary()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts#L1136-L1396) 有两条路径，代码中通过 `tengu_compact_cache_prefix` 开关控制：

```typescript
// 路径 A：Forked Agent（缓存共享）
if (promptCacheSharingEnabled) {
  const result = await runForkedAgent({
    promptMessages: [summaryRequest],
    cacheSafeParams,          // ← 关键：复用主线程的缓存参数
    canUseTool: createCompactCanUseTool(),
    maxTurns: 1,
    // DO NOT set maxOutputTokens here.
  })
}

// 路径 B：独立 streaming（兜底）
const streamingGen = queryModelWithStreaming({
  messages: normalizeMessagesForAPI(/* ... */),
  systemPrompt: asSystemPrompt([
    'You are a helpful AI assistant tasked with summarizing conversations.',
  ]),
  tools: [FileReadTool],     // ← 只有 FileReadTool，与主线程完全不同
  // ...
})
```

Anthropic API 的 prompt cache key 由五个要素决定：`system prompt + tools + model + messages prefix + thinking config`。路径 A 通过 `cacheSafeParams` 原封不动传递这五个要素，前缀完全一致 → 缓存命中率 98%。代码中特别警告 "DO NOT set maxOutputTokens here"——设置它会改变 thinking config（`budget_tokens` 被 clamp），导致缓存 key 不匹配。路径 B 独立构建所有要素，前缀无重叠 → 缓存命中率接近 0%。

缓存只是两条路径差异的一个维度。跳出缓存看架构，两者在调用层次、工具集约束、副作用隔离上还有三层差异。

**调用层次：一个走完整 Agent Loop，一个直调 SDK。** `runForkedAgent` 是 `query()` 的高阶封装——它 fork 了一个完整子对话，经过消息规范化、system prompt 组装、hook 回调、权限检查、usage 追踪等全部 pipeline 环节。重，但功能完整。`queryModelWithStreaming` 绕过 Agent Loop，直调 Anthropic SDK——它只是一个 `AsyncGenerator`，调用方要自己处理 streaming 事件的逐块消费、`setResponseLength` 回调、keep-alive 心跳等周边逻辑。轻，但调用方要补很多逻辑。

**工具集约束：必须带但不能用 vs 只带最少。** `runForkedAgent` 继承了主线程的完整工具集——因为缓存 key 匹配要求 tools schema 完全一致。但它通过 `canUseTool` 禁止任何工具调用，配合 [`NO_TOOLS_PREAMBLE`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/prompt.ts#L19-L26) 中强硬的不准用工具指令。即便如此，Sonnet 4.6 上仍有 2.79% 的 fork compact 尝试工具调用，导致空文本后降级。`queryModelWithStreaming` 只带 `FileReadTool`（可选 `ToolSearchTool`）——工具少、schema 小，即使缓存重算也比全量工具集便宜。

**副作用隔离：子对话级 vs 完全无感知。** `runForkedAgent` 隔离的是"对话上下文"——子 agent 的消息不写回主线程数组，但共享主线程的模块级状态（readFileState cache、权限上下文等）。`queryModelWithStreaming` 隔离更彻底——不经过 Agent Loop，完全不知道主线程的存在。

这两个函数的关系不是"选 A 还是选 B"，而是**有严格优先级的降级链**：fork agent 优先（缓存命中 ~98%），失败则 silent fallback 到 streaming。Fork 失败不是 bug——它只是"省的钱没省到"。具体来说：如果 `runForkedAgent()` 抛出异常或返回空文本（包括用户 ESC 中断产生的 `isApiErrorMessage`），代码自动 fall 到独立 streaming 路径，记录 `tengu_compact_cache_sharing_fallback` 事件后重试。

### 3.5 Compact 后怎么恢复关键上下文：六类附件的恢复管线

2.3 梳理了六类附件恢复策略和三条原则。看代码实现——重点在文件、技能、Plan Mode 三个最有代表性的恢复逻辑。

```typescript
// 以下四类并行恢复：
const [fileAttachments, asyncAgentAttachments] = await Promise.all([
  createPostCompactFileAttachments(/* ... */),    // 文件
  createAsyncAgentAttachmentsIfNeeded(context),   // 异步 Agent
])
const planAttachment = createPlanAttachmentIfNeeded(/* ... */)   // Plan
const planModeAttachment = await createPlanModeAttachmentIfNeeded(/* ... */)  // Plan Mode
const skillAttachment = createSkillAttachmentIfNeeded(/* ... */)   // 技能

// 以下三类做 diff，只注入"新出现"的部分：
for (const att of getDeferredToolsDeltaAttachment(/* ... */))   // Tool 增量
for (const att of getAgentListingDeltaAttachment(/* ... */))      // Agent 列表增量
for (const att of getMcpInstructionsDeltaAttachment(/* ... */))   // MCP 增量
```

下面展开三个最有代表性的恢复逻辑。

**文件恢复：为什么不能"全量恢复"**

[`createPostCompactFileAttachments()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts#L1415-L1464) 的约束链条非常清晰：

```typescript
// 约束 1：最多 5 个文件
const recentFiles = Object.entries(readFileState)
  .sort((a, b) => b.timestamp - a.timestamp)   // 按最近访问时间排序
  .slice(0, maxFiles)                           // 只取前 5 个

// 约束 2：每文件最多 5K token（在 generateFileAttachment 内部通过 fileReadingLimits 控制）

// 约束 3：总预算 50K token
if (usedTokens + attachmentTokens <= POST_COMPACT_TOKEN_BUDGET) {
  usedTokens += attachmentTokens
  return true
}
return false  // 超出预算的文件直接丢弃
```

- **为什么按"最近访问时间"排序，而非按"文件大小"？** 和 Micro-Compact 正好相反。Micro-Compact 是"清除"，按体积贪心——清除大的最划算。附件恢复是"恢复"，用户刚摸过的文件最可能下一轮还要用。时间局部性原理：最近访问的文件有最高的复用概率。
- **跳过已保留文件**：`collectReadToolFilePaths()` 扫描 preserved messages 中已有的 Read tool_result，避免重复注入。但有一个例外——如果 tool_result 是 `FILE_UNCHANGED_STUB`（去重桩），不能跳过，因为桩指向的原始内容可能已被 compact 掉了。

**技能恢复：为什么截断比丢弃好**

[`createSkillAttachmentIfNeeded()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts#L1494-L1534) 面临一个棘手的问题：技能文件可能很大（verify 技能 18.7KB、claude-api 技能 20.1KB），全量恢复会吃掉大量 token。解决方案是**截断保留头部 + 告知模型可以 Read 完整文件**：

```typescript
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000   // 每技能最多 5K
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000    // 技能总预算 25K

const skills = Array.from(invokedSkills.values())
  .sort((a, b) => b.invokedAt - a.invokedAt)              // 最近调用的优先
  .map(skill => ({
    content: truncateToTokens(skill.content, POST_COMPACT_MAX_TOKENS_PER_SKILL),
  }))
  .filter(skill => {
    if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) return false
    usedTokens += tokens
    return true
  })
```

- **截断保留头部而非随机采样**，是因为技能文件的组织惯例：顶部的"使用方法"和"触发条件"是最关键的信息，底部的示例代码和边缘情况说明在需要时可以通过 Read 重新获取。
- **截断后追加标记** `[... skill content truncated for compaction; use Read on the skill path if you need the full text]`——这不是"优雅降级"，是"告诉模型去哪找回丢失的信息"。恢复的目标是"让模型能继续工作"，不是"完美还原"。

**Plan Mode 恢复：一个容易被忽略的状态丢失**

[`createPlanModeAttachmentIfNeeded()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts#L1542-L1560) 只有十几行，但解决的问题很关键：

```typescript
export async function createPlanModeAttachmentIfNeeded(context: ToolUseContext) {
  const appState = context.getAppState()
  if (appState.toolPermissionContext.mode !== 'plan') return null
  // 注入 plan_mode attachment，确保模型继续 plan 行为
  return createAttachmentMessage({ type: 'plan_mode', /* ... */ })
}
```

Plan mode 指令通常只在 tool-use 轮次通过 `getAttachmentMessages` 注入。但 Compact 后的第一轮可能是纯文本回复——模型还不知道自己处于 plan mode，不应该调用工具。如果没有这段恢复逻辑，模型会在 compact 后"忘记"自己处于 plan mode，直接开始执行——这违背了 plan mode 的"只读设计"约束。

### 3.6 极端场景的防御设计：PTL 重试与熔断器

最后一层防御解决两个问题：compact 请求本身太大发不出去怎么办？连续失败怎么办？

**PTL 重试：为什么按 API 轮次丢弃而非按消息数**

场景：对话长到连 compact 请求本身都触发了 API 的 `prompt_too_long`。此时 [`truncateHeadForPTLRetry()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts#L243-L291) 被调用：

```typescript
// 第一步：按 API 轮次分组（一个 assistant turn + 其 tool_results = 一组）
const groups = groupMessagesByApiRound(input)

// 第二步：计算需要丢弃多少组
const tokenGap = getPromptTooLongTokenGap(ptlResponse)
if (tokenGap !== undefined) {
  let acc = 0
  for (const g of groups) {    // 从最旧的组开始累加
    acc += roughTokenCountEstimationForMessages(g)
    dropCount++
    if (acc >= tokenGap) break // 累加到够填平缺口为止
  }
} else {
  dropCount = Math.max(1, Math.floor(groups.length * 0.2))  // 兜底：丢 20%
}

// 第三步：丢弃后至少保留一组（有东西可摘要）
dropCount = Math.min(dropCount, groups.length - 1)
```

- **为什么按 API 轮次而非消息数？** 如果按消息数随意切割，可能把 `tool_use` 从中间切开——某条 `tool_use` 在丢弃部分，但对应的 `tool_result` 在保留部分，API 会报 orphan 引用。按轮次分组天然保证了每组内 tool_use/tool_result 配对完整。这是 [`groupMessagesByApiRound()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/grouping.ts#L22-L63) 存在的原因——它用 `message.id`（同一个 API 响应的所有消息共享一个 id）作为分组边界，保证每组是一个完整的 API 往返。
- **PTL retry 最多 3 次**（`MAX_PTL_RETRIES = 3`），和熔断器的阈值一致——这不是巧合，而是"同一种防御逻辑的两个表达层面"。

**熔断器：3 次从哪来**

[`autoCompactIfNeeded()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts#L257-L265) 的熔断逻辑极其简洁：

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// 熔断：连续失败 N 次后停止尝试
if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}

// 每次失败递增计数
catch (error) {
  const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1
  return { wasCompacted: false, consecutiveFailures: nextFailures }
}
```

为什么是 3？注释引用线上数据："1,279 sessions had 50+ consecutive failures (up to 3,272) in a single session, wasting ~250K API calls/day globally." 如果一个会话已经连续失败 3 次，上下文状态大概率是不可恢复的（比如用户一次性贴了 500K 文本），继续重试只会浪费 API 调用。3 次是"给正常波动留够机会"和"避免极端浪费"之间的折衷。

`consecutiveFailures` 由调用方（Agent Loop）通过 `autoCompactTracking` 跨轮次传递——每次 `wasCompacted: true` 时重置为 0。这意味着熔断器只在"连续"失败时触发，偶尔失败不累计。

**清理管线：为什么区分主线程和子 Agent**

[`runPostCompactCleanup()`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/postCompactCleanup.ts#L31-L77) 是所有 compact 路径（auto / manual / session memory）的终点。但它的一个细节值得注意：

```typescript
const isMainThreadCompact =
  querySource === undefined ||
  querySource.startsWith('repl_main_thread') ||
  querySource === 'sdk'

if (feature('CONTEXT_COLLAPSE')) {
  if (isMainThreadCompact) {
    resetContextCollapse()   // 只清理主线程的 collapse 状态
  }
}
if (isMainThreadCompact) {
  getUserContext.cache.clear?.()
  resetGetMemoryFilesCache('compact')
}
```

子 Agent 和主线程共享 Node.js 进程，因此共享模块级状态（context-collapse store、getMemoryFiles 缓存、getUserContext 缓存）。子 Agent 自己做 compact 时如果清除了这些状态，主线程的上下文会被破坏。通过 `querySource` 前缀做区分，确保只有主线程的 compact 才清理全局状态。

这个设计还有一层隐含含义：子 Agent compact 后，主线程的某些缓存仍然有效——子 Agent 不需要"替主线程打扫房间"。

---

## 4. 总结

1. **三级预留各司其职**：20K 给摘要输出空间、13K 给 compact 执行余量、3K 给手动逃生——缺任何一级都会在对应场景卡死。触发线来自线上 p99.99 数据，不是拍脑袋。

2. **省钱是三级降级链，不是单一开关**：Session Memory 零成本 → Forked Agent 缓存命中 98% → 独立 streaming 兜底。每层失败透明降级——用户只感知到"compact 完成了"，不知道走了哪条路径。

3. **恢复是"能继续工作"，不是"完美还原"**：文件最多 5 个、每技能截断 5K，按紧迫性而非完整性排序。分类独立预算防止某一类挤占其它类。

4. **极端场景用最小代价兜底**：PTL 重试按 API 轮次丢弃而非按消息数——防止拆散 tool_use 和 tool_result 的配对。熔断三次即停——1,279 个真实会话曾连续失败 50+ 次，三次止损是"给正常波动留机会"和"防止极端浪费"的折衷。

5. **Micro-Compact 和 Compact 是同一套思路的两级**：免费层先扛，扛不住才上付费层。当两层压缩都不够时，还有第三条路——换更大的窗口。

---

## 5. 参考文献

- Claude Code 源码：
  - [`src/services/compact/autoCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/autoCompact.ts) — 阈值计算、触发判断与熔断
  - [`src/services/compact/compact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/compact.ts) — 摘要生成、附件恢复与消息重建
  - [`src/services/compact/sessionMemoryCompact.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/sessionMemoryCompact.ts) — Session Memory 零成本复用
  - [`src/services/compact/prompt.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/prompt.ts) — Compact Prompt 模板
  - [`src/services/compact/postCompactCleanup.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/postCompactCleanup.ts) — 缓存清理
  - [`src/services/compact/grouping.ts`](https://github.com/binarylei/claudecode/blob/main/src/services/compact/grouping.ts) — API 轮次分组
  - [`src/utils/forkedAgent.ts`](https://github.com/binarylei/claudecode/blob/main/src/utils/forkedAgent.ts) — Forked Agent 缓存共享
- 外部文献：
  - Liu, N.F., et al. "Lost in the Middle: How Language Models Use Long Contexts." *arXiv:2307.03172*, 2023. — 长上下文中位置注意力衰减的奠基性研究
  - Veseli, F., et al. "Positional Biases Shift as Inputs Approach Context Window Limits." *arXiv:2508.07479*, 2025. — 发现 LiM 效应在超过 50% 填充率后消失，被距离偏差取代
  - Evans, J. "Evans' Law: A Predictive Threshold for Long-Context Accuracy Collapse in Large Language Models." *Zenodo:10.5281/zenodo.17523736*, 2025. — 错误率随 prompt 长度超线性上升的量化模型
  - Chroma Research. "Context Rot: How Increasing Input Tokens Impacts LLM Performance." 2025. — 18 个模型的长上下文性能退化基准测试
