---
title: "05. QueryEngine 全景解析"
description: "46K 行查询引擎的架构、模块分解与调用链路"
outline: [2, 3]
---

# 05. QueryEngine 全景解析

`QueryEngine.ts` 是 Claude Code 中最核心的文件，承担了 LLM 查询引擎的完整职责。它是连接"用户意图"和"模型能力"的中枢通道——把一次自然语言请求翻译为 System Prompt 组装 → API 调用 → 工具循环 → 标准化结果产出的完整流水线。

## 1. 背景介绍

在理解 QueryEngine 之前，我们先看一个事实：Claude Code 的每一次"对话回合"本质上都是同一件事——把用户输入和上下文打包发给 Anthropic API，拿到响应后决定是执行工具还是返回结果。QueryEngine 就是把这件事从"手工调用"变成"工程化流水线"的那一层。

### 1.1 认知锚点：从手工调用到工程化封装

理解 QueryEngine 最直接的锚点，是把它和直接调用 Anthropic API 做对比：

```
手工调用 Anthropic API：
  client.messages.create() → 检查 stop_reason → 执行工具 → 回流结果 → 重复
  问题：每次手写相同的循环、重试、压缩、格式转换

QueryEngine：
  同一件事的工程化封装。不抽象掉 API 细节，但消除重复工程。
```

一句话说清：手工调用 API 的核心问题不是"写不出来"，而是"每次都要重写相同的工程保障"。QueryEngine 不抽象掉模型选择、thinking 配置、stop_reason 语义这些 API 细节——它只封装那些与 API 无关、但每次做 Agent 都必须有的东西。

### 1.2 核心职责

QueryEngine 的职责可以归结为两件事：**管理会话状态**和**驱动每次 turn 的完整流水线**。

- **会话状态**：消息历史、累计用量、权限拒绝记录、文件缓存，跨 turn 持续，是"一份对话一个 QueryEngine"的具象化。
- **Turn 流水线**：权限包装 → System Prompt 装配 → 用户输入处理 → 转录写入 → 进入循环 → 终止判定，每次 `submitMessage()` 调用走一遍。

本章聚焦于 QueryEngine 自身的关键设计决策，内层循环的微观机制留给[第 6 章](../part2/06-Agent-Loop机制)。

### 1.3 在 Harness 中的位置

QueryEngine 在整个 Claude Code 架构中的位置可以这样理解：

```
用户输入 → commands.ts（分拣）
              ├── /command → 命令执行（本地斜杠命令直接返回）
              └── 自然语言 → QueryEngine → API → 流式响应 → 工具调用循环
                                ↑
                    所有 Harness 机制在这里叠加：
                    压缩、预算、重试、技能发现、记忆、权限……
```

它是 Harness 机制的**聚合点**。工具系统、技能系统、压缩系统、权限系统都在 QueryEngine 的循环体中被调用，但循环本身的结构从不被修改——这就是 06 章的核心论点：「循环属于 Agent，机制属于 Harness」。

---

## 2. 核心逻辑：为什么要分成两层

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

问题不在于代码多，而在于**两类职责被混在了一起**：

| 会话级职责 | 循环级职责 |
|---|---|
| 消息历史归谁管？多轮对话如何恢复？ | 每次迭代前要不要压缩？压缩到多少？ |
| 转录什么时候写入磁盘？ | API 调用参数怎么构造？ |
| 结果以什么格式产出给消费者？ | 工具执行失败怎么处理？ |
| 孤儿权限如何解锁？ | max_output_tokens 截断后怎么恢复？ |
| 斜杠命令如何分拣和短路？ | 迭代如何优雅终止？ |

当只有一种上游消费者时（比如只有 REPL），混在一起也可以工作。但当出现 SDK 模式后，矛盾就变得尖锐：SDK 需要输出 `SDKMessage` 格式、需要逐条 yield 给外部、需要独立的中断控制——这些需求跟 REPL 完全不同，但核心循环逻辑应该是一样的。

### 2.3 落脚：双层架构

QueryEngine 的答案是**分层**——把会话级职责和循环级职责分到两个不同的函数/类中：

```
┌─────────────────────────────────────────────────┐
│  QueryEngine.submitMessage()                    │  ← 外层：会话层
│                                                 │
│  职责：                                          │
│  · System Prompt 四段拼接                       │
│  · 用户输入处理（斜杠命令分拣、孤儿权限）        │
│  · SDKMessage 格式转换（标准化消息类型）         │
│  · 转录持久化（进入循环前就写入）                │
│  · 结果成功/失败判定（isResultSuccessful）       │
│  · 中断控制（AbortController）                   │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  query() → queryLoop()                  │  │  ← 内层：循环层
│  │                                         │  │
│  │  职责：                                  │  │
│  │  · ReAct while(true) 循环本体           │  │
│  │  · 5 步预处理流水线（截断/裁剪/压缩）    │  │
│  │  · API 调用 + 流式事件消费              │  │
│  │  · 工具执行调度（runTools）              │  │
│  │  · 恢复路径（max_tokens / PTL / RC）     │  │
│  │  · Continue / Terminal 状态判定         │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**外层面向 SDK 消费者说话**，产出标准化 `SDKMessage` 格式——外界不关心循环内部发生了什么，只关心"有没有新消息"和"最终结果是什么"。

**内层面向机制说话**，产出内部 `Message` 类型——包括 `progress`、`attachment`、`tombstone` 等机械信号，这些信号对上层消费者透明，但对循环自身的正确性至关重要。

### 2.4 三个设计收益

**可测试性**。内层 `query()` 通过 `deps` 参数接受 4 个可替换抽象（callModel、两种压缩、uuid），使核心循环可脱离网络独立测试。这些抽象在生产中走默认实例，QueryEngine 本身不感知注入。

**复用性**。同一套 `query()` 同时服务于：
- 主会话（REPL → SDK）
- 子代理（AgentTool fork）
- 后台任务（task summary）
- 压缩代理（compact agent）

每个场景有不同的会话层包装，但核心循环一模一样。如果循环和会话层混在一起，每次新场景都要重写一遍。

**中断控制**。外层持有 `AbortController`，调用 `interrupt()` 就能立终止内层循环：

```typescript
// src/QueryEngine.ts:1158-1160
interrupt(): void {
  this.abortController.abort()
}
```

如果循环和会话层的职责边界模糊，中断信号到底该传给谁、中断后状态如何恢复，都会变成难以回答的问题。

---

## 3. 源码解读

### 3.1 源码地图

在深入具体逻辑之前，先建立一份完整的源码地图。QueryEngine 不是一个文件，而是一个**函数协作体**：

#### 核心文件清单

| 文件 | 约行数 | 职责 |
|---|---|---|
| `src/QueryEngine.ts` | 1296 | 外层入口：会话生命周期、SDK 消息适配、结果产出 |
| `src/query.ts` | ~900 | 内层核心：Agent Loop 的 `while(true)` 迭代体 |
| `src/utils/queryContext.ts` | 80 | 上下文构建：并行获取 System Prompt + User Context + System Context |

#### 完整调用链路

```
用户输入
  │
  ▼
QueryEngine.submitMessage()                    ← 外层入口（每次 turn 一个调用）
  │
  ├─ fetchSystemPromptParts()                  ← 构建 System Prompt 三件套
  │   ├─ getSystemPrompt()                     ← 默认 System Prompt（或跳过）
  │   ├─ getUserContext()                      ← 用户运行时上下文
  │   └─ getSystemContext()                    ← 系统级上下文（或跳过）
  │
  ├─ asSystemPrompt([...])                     ← 四段拼接
  │   default/custom + memoryMechanics + append
  │
  ├─ processUserInput()                        ← 用户输入处理
  │   ├─ 斜杠命令分拣（/command → 本地执行）
  │   ├─ 消息规范化
  │   └─ 返回 shouldQuery（是否需要调用 API）
  │
  ├─ processUserInputContext 重建              ← 斜杠命令后更新消息和模型
  │
  ├─ recordTranscript()                        ← 转录持久化（进入循环前）
  │
  ├─ Skills / Plugins 加载                     ← 缓存优先（Headless 不阻塞网络）
  │
  ├─ buildSystemInitMessage()                  ← SDK 初始化消息
  │
  ▼
query() → queryLoop()                          ← 内层核心循环
  │
  while (true):                                ← Agent Loop 本体
    │
    ├─ [预处理流水线]                           ← 每次 API 调用前的 5 步
    │   ├─ applyToolResultBudget()             ← ① 工具结果截断
    │   ├─ snipCompactIfNeeded()               ← ② 历史裁剪（feature-gated）
    │   ├─ microcompactMessages()              ← ③ 微压缩
    │   ├─ contextCollapse.apply()             ← ③.5 上下文折叠（feature-gated）
    │   └─ autocompact()                       ← ④ 自动压缩
    │       └─ buildPostCompactMessages()
    │
    ├─ [Blocking Limit 检查]                   ← 压缩后仍超限 → 返回 blocking_limit
    │
    ├─ [附件注入]                               ← 记忆/技能附件
    │
    ├─ deps.callModel()                        ← ★ 调用 Anthropic API
    │   └─ withRetry() 包裹                    ← 重试/529/速率限制处理
    │
    ├─ [流式事件消费]                           ← 逐条 yield
    │   ├─ yield assistant                     ← 助手消息
    │   ├─ yield stream_event                  ← 流式事件（可选）
    │   └─ 捕获 tool_use blocks                ← 记录需要执行的工具
    │
    ├─ if needsFollowUp (有 tool_use):         ← 工具调用分支
    │   ├─ runTools()                          ← 执行工具
    │   ├─ yield tool_result                   ← 工具结果回流
    │   ├─ state = { ...state, transition }    ← 更新状态，continue
    │   └─ → 回到 while(true)                  ← 下一轮迭代
    │
    ├─ if !needsFollowUp (无 tool_use):        ← 终止分支
    │   ├─ handleStopHooks()                   ← 执行 Stop Hook
    │   └─ return Terminal                     ← 退出循环
    │
    └─ [恢复路径]                              ← 错误不一定是终点
        ├─ max_output_tokens 恢复（最多 3 次）
        ├─ reactiveCompact 恢复（PTL / 媒体过大）
        └─ contextCollapse 恢复
  │
  ▼
QueryEngine.submitMessage() 续
  ├─ isResultSuccessful()                      ← 结果校验
  │   检查：assistant 有 text/thinking 内容？
  │   或 user 全是 tool_result？
  │   或 stop_reason == 'end_turn'？
  │
  └─ yield result                              ← 最终结果产出
      (success / error_max_turns / error_max_budget_usd
       / error_max_structured_output_retries / error_during_execution)
```

在进入各论之前，先看一眼 QueryEngine 跨 turn 持有的核心状态——这是"会话生命周期"的具象化：

- `mutableMessages` — 消息历史（跨 turn 累积）
- `totalUsage` — 累计 API 用量
- `permissionDenials` — 权限拒绝记录，最终写入 result 消息
- `readFileState` — 文件状态缓存，工具权限判定依赖它

此外，`submitMessage` 入口第一件事是构造 `wrappedCanUseTool`——在原始 `canUseTool` 外包一层拦截，每次拒绝时将记录压入 `permissionDenials`。权限追踪对后续所有代码透明：工具执行层不感知，SDK 消费者从 result 消息中读取。

3.2 ~ 3.5 各节——System Prompt 装配、消息双重建、转录写入、终止判定——都在这些状态之上运行。

### 3.2 外层：System Prompt 的组装管线

QueryEngine 的初始化管线中，System Prompt 的组装是第一个关键决策点。它不是简单地从某个配置文件读出一段文本，而是根据**用户是否提供了自定义 Prompt**，走两条完全不同的路径。

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

- **defaultSystemPrompt**：由 Harness 自动生成，包含工具定义、环境信息、行为规范。但当 `customSystemPrompt` 存在时，**跳过生成**。这不仅节省了构建开销，更关键的是——`getSystemPrompt` 内部会读取大量环境变量和文件状态，如果调用方提供了完全自定义的 Prompt，这些读取就是浪费。`fetchSystemPromptParts`（[src/utils/queryContext.ts:44](src/utils/queryContext.ts#L44)）用 `Promise.all` 并行获取三件套，custom 路径下直接返回空对象。

- **memoryMechanicsPrompt**：仅当 SDK 调用方同时满足两个条件才注入——提供了 `customSystemPrompt` 且设置了 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 环境变量。第一个条件确保 memoryPrompt 不会跟默认 System Prompt 里的记忆指令重复；第二个条件是显式的 opt-in 信号——"我配置了记忆目录，请告诉模型怎么用"。

- **appendSystemPrompt**：始终追加在最后。这个位置意味着它可以**覆盖**前面所有 Prompt 的策略指令，而不会被前面的内容冲掉。适合注入临时策略调整（如"本次会话只能用只读工具"）。

- **顺序**：`custom > memoryMechanics > append`。memoryMechanics 必须在 custom 之后、append 之前——因为它是对 custom prompt 的补充说明，而 append 是最终覆盖层。

#### 3.2.1 三件套的内涵：System Prompt vs User Context vs System Context

前面反复提到 `fetchSystemPromptParts()` 并行获取"三件套"——那这三者分别是什么？为什么要拆成三份而不是揉成一个？

三者的角色可以这样区分：

- **System Prompt**：告诉模型"**你该怎么干活**"——角色定义、工具列表、输出规范、行为准则
- **System Context**：告诉模型"**当前世界长什么样**"——Git 状态、分支名、commit 历史，是整个会话期间不变的环境快照
- **User Context**：告诉模型"**这个项目要你注意什么**"——CLAUDE.md 项目指令、当前日期，是用户和项目维度的个性化数据

##### System Prompt

System Prompt 是整个会话的"行为宪法"，由 [src/constants/prompts.ts](src/constants/prompts.ts#L444) 的 `getSystemPrompt()` 动态生成。它包含的内容维度：

- **角色定义**：`You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK. You are an interactive agent that helps users with software engineering tasks.`
- **Harness 行为规范**：输出格式、权限模式、工具使用约束
- **环境声明**：工作目录、平台、Shell 类型、模型版本
- **工具定义**：所有可用工具的 JSON Schema（通过 tools 参数传入）
- **会话引导**：记忆加载、语言设置、输出风格、Scratchpad 指令等

以你当前会话实际收到的 System Prompt 片段为例：

```
You are Claude Code, Anthropic's official CLI for Claude.

You are an interactive agent that helps users with software engineering tasks.

IMPORTANT: Assist with authorized security testing, defensive security, CTF
challenges, and educational contexts. Refuse requests for destructive purposes...

# Harness
- Text you output outside of tool use is displayed to the user as
  Github-flavored markdown in a terminal.
- Tools run behind a user-selected permission mode...

# Environment
- Primary working directory: e:\leigang\src_ai\ClaudeCode
- Is a git repository: true
- Platform: win32
- Shell: PowerShell (primary); Bash tool also available...
```

设计要点：

- **System Prompt 走 API 的 `system` 角色**——这是 Anthropic API 的原生字段，享受 prompt caching（前缀缓存命中后延迟和成本大幅降低）
- **当 `customSystemPrompt` 存在时，整个 `getSystemPrompt()` 被跳过**——不仅省去构建开销，更重要的是 `getSystemPrompt` 内部会读取大量 I/O（MCP 服务器状态、Skill 命令列表、输出风格配置等），这些读取在自定义 Prompt 场景下全是浪费
- **System Prompt 是唯一"每 turn 可能变化"的部分**——工具集、模型、MCP 服务器连接状态都会影响它

##### System Context

System Context 是"当前世界的一次性快照"，由 [src/context.ts](src/context.ts#L116) 的 `getSystemContext()` 生成。它用 `memoize` 包裹，**整个会话周期只计算一次**。

它的核心产出来自 `getGitStatus()`（[src/context.ts:36](src/context.ts#L36)）——在会话启动时执行一次 `git status --short` + `git log --oneline -n 5` + `git config user.name`，把结果冻结为文本快照。

以当前仓库的实际输出为例——这就是你每次对话中 System Context 的样子：

```
This is the git status at the start of the conversation. Note that this
status is a snapshot in time, and will not update during the conversation.

Current branch: main

Main branch (you will usually use this for PRs): main

Git user: binarylei

Status:
(clean)

Recent commits:
b80f51d [MOD] QueryEngine
53963c9 [MOD] blog
fa1002a [ADD] mydocs init
895221e init: restored runnable Claude Code source from source maps
```

此外，当 `BREAK_CACHE_COMMAND` feature flag 启用时，System Context 还会携带一个 `cacheBreaker` 字段——一个用于强制刷新 prompt cache 的调试标记。

System Context 的注入方式通过 `appendSystemContext()`（[src/utils/api.ts:437](src/utils/api.ts#L437)）——**把 key-value 对象转成纯文本拼接到 System Prompt 数组的尾部**，最终合并为一条 `system` 消息发给 API：

```typescript
// src/utils/api.ts:437-447
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

设计要点：

- **拼接到 system 角色尾部 → 享受 prompt caching**：System Prompt 在前、System Context 在后，静态的 Prompt 前缀被缓存，变化的 context 只增加少量增量
- **Memoize 而非每 turn 重新获取**：Git 状态在会话期间不会改变（除非模型自己提交了代码——但 prompt 里的快照本来就不承诺实时性），重复计算没有意义
- **`CLAUDE_CODE_REMOTE` 模式下跳过**：远程环境不需要本地 Git 状态
- **当 `customSystemPrompt` 存在时，`getSystemContext()` 也被跳过**（[src/utils/queryContext.ts:71](src/utils/queryContext.ts#L71)）：因为 System Context 是追加到 System Prompt 后的，如果 System Prompt 被完全替换，System Context 就成了无根之木

##### User Context

User Context 是"用户和项目的个性化数据"，由 [src/context.ts](src/context.ts#L155) 的 `getUserContext()` 生成，同样被 `memoize` 包裹。

它的核心产出是 **CLAUDE.md 文件内容**——通过 `getClaudeMds()` 读取项目根目录的 `CLAUDE.md`（以及可能的子目录 CLAUDE.md），加上**当前日期**。

以你当前会话实际收到的 User Context 为例——这就是你看到的 `<system-reminder>` 块：

```xml
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these
instructions. IMPORTANT: These instructions OVERRIDE any default behavior
and you MUST follow them exactly as written.

Contents of e:\leigang\src_ai\ClaudeCode\CLAUDE.md (project instructions,
checked into the codebase):

# CLAUDE.md

## 角色定位
你是一个专门分析源码的工具，只分析源码不写代码。
...

# currentDate
Today's date is 2026/06/29.

IMPORTANT: this context may or may not be relevant to your tasks. You
should not respond to this context unless it is highly relevant to your
task.
</system-reminder>
```

它的注入方式与 System Context 截然不同——通过 `prependUserContext()`（[src/utils/api.ts:449](src/utils/api.ts#L449)）**伪装成一条 `user` 角色消息，插入到消息历史的开头**：

```typescript
// src/utils/api.ts:449-468
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (process.env.NODE_ENV === 'test') return messages
  if (Object.entries(context).length === 0) return messages

  return [
    createUserMessage({
      content: `<system-reminder>\n...${Object.entries(context)
        .map(([key, value]) => `# ${key}\n${value}`)
        .join('\n')}
\n</system-reminder>\n`,
    }),
    ...messages,
  ]
}
```

设计要点：

- **走 `user` 角色而非 `system` 角色**——这是一个经过深思熟虑的选择。CLAUDE.md 的内容是"用户指令"，语义上属于用户说的话，放在 user 消息中比放在 system prompt 中更符合角色模型的语义
- **包装成 `<system-reminder>` 标签**——告诉模型"这些是背景信息，不一定与当前任务相关"。这避免了 CLAUDE.md 中的内容被模型当成当前对话中的直接指令
- **作为消息历史的第一条**——确保它在整个对话中永远处于 prompt cache 的前缀范围内
- **`isBareMode()` 且无 `--add-dir` 时跳过 CLAUDE.md 读取**（[src/context.ts:166](src/context.ts#L166)）：bare 模式是脚本化调用，不需要项目级指令
- **始终包含 `currentDate`**——无论是否 bare 模式，日期总是需要的

##### 三者的对比总览

| 维度 | System Prompt | User Context | System Context |
|---|---|---|---|
| **语义** | 行为指令（你该怎么干活） | 用户偏好（这个项目要你注意什么） | 环境快照（当前世界长什么样） |
| **典型内容** | 角色定义、工具列表、输出规范、权限规则 | CLAUDE.md 内容、当前日期 | Git 状态、分支名、commit 历史 |
| **来源函数** | `constants/prompts.ts` → `getSystemPrompt()` | `context.ts` → `getUserContext()` | `context.ts` → `getSystemContext()` |
| **注入方式** | API `system` 字段（原生角色） | 伪装为 `user` 消息，插入消息历史第一条 | 拼接到 `system` 字段尾部 |
| **变化频率** | 每 turn 可能变化（工具、模型、MCP） | `memoize` 会话级不变 | `memoize` 会话级不变 |
| **custom prompt 下** | 跳过生成 | 始终获取 | 跳过生成 |

##### 为什么拆成三份而不是揉成一个

**缓存效率**。Anthropic API 的 prompt caching 按前缀匹配。System Prompt 的静态部分（角色定义、工具 Schema）是整个会话的缓存前缀——只要它不变，所有 turn 都能命中缓存。如果把 Git 状态（System Context）和 CLAUDE.md（User Context）揉进 System Prompt，每次 Git 状态变化都会导致整个前缀失效。

**语义正确性**。CLAUDE.md 是用户写的，放在 `user` 角色中比放在 `system` 角色中更符合"谁说的话归谁"的角色模型。`<system-reminder>` 标签的 `IMPORTANT: this context may or may not be relevant` 声明也防止模型把项目指令当成硬性任务。

**跳过粒度**。当 SDK 调用方提供 `customSystemPrompt` 时，System Prompt 和 System Context 都可以跳过，但 User Context（尤其是 `currentDate`）仍然需要——拆开才能做这种差异化的跳过决策。

**测试隔离**。在 `NODE_ENV === 'test'` 时，`prependUserContext` 直接返回原消息不做注入——如果三者揉在一起，这种场景化的豁免就会复杂得多。

### 3.3 外层：为什么要建两次 processUserInputContext

在 `submitMessage` 中，`processUserInputContext` 被构建了两次——前后相隔仅约 100 行。这不是代码重复，而是因为**中间插入了斜杠命令处理**，它可能改变消息历史和模型选择。

第一次构建（[src/QueryEngine.ts:335-395](src/QueryEngine.ts#L335)）：

```typescript
let processUserInputContext: ProcessUserInputContext = {
  messages: this.mutableMessages,
  setMessages: fn => {
    this.mutableMessages = fn(this.mutableMessages)
  },
  onChangeAPIKey: () => {},
  handleElicitation: this.config.handleElicitation,
  options: {
    commands,
    tools,
    verbose,
    mainLoopModel: initialMainLoopModel,
    thinkingConfig: initialThinkingConfig,
    mcpClients,
    // ...
  },
  // ...
}
```

重点在 `setMessages`——它指向 `this.mutableMessages`，允许斜杠命令（如 `/force-snip`）直接修改消息数组：

```typescript
setMessages: fn => {
  this.mutableMessages = fn(this.mutableMessages)
},
```

第二次构建（[src/QueryEngine.ts:492-527](src/QueryEngine.ts#L492)）在 `processUserInput()` 返回之后。此时：
- `messagesFromUserInput` 已经产生（可能包含附件、系统消息）
- `modelFromUserInput` 可能跟 `initialMainLoopModel` 不同（斜杠命令 `--model` 覆盖）
- `this.mutableMessages` 可能已经被命令修改

所以第三次 `processUserInputContext.setMessages` 变成了空操作：

```typescript
setMessages: () => {},
```

消息数组不再可变——循环内的所有修改都通过 `state` 的不可变更新完成。这个从"可变"到"不可变"的转换，是循环状态一致性的基础。

### 3.4 外层：转录持久化的时机

一个容易被忽视但影响深远的细节：转录在进入 query loop **之前**就写入。

> **什么是转录？** 转录是会话消息历史的磁盘持久化——每一轮对话的消息（用户输入、助手响应、工具结果）以 JSONL 格式写入 session 文件，通过 `parentUuid` 串联成完整的对话链条。它的作用是为 `--resume` 和 `--continue` 提供可恢复的会话数据。

```typescript
// src/QueryEngine.ts:450-463
if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
  if (isBareMode()) {
    void transcriptPromise           // fire-and-forget
  } else {
    await transcriptPromise          // 阻塞等待写入完成
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
      isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
    ) {
      await flushSessionStorage()
    }
  }
}
```

为什么这么急？源码注释说得很清楚：**如果进程在 API 响应到达之前被杀掉**（比如用户在 cowork 中点击 Stop），transcript 里只有队列操作记录，`getLastSessionLog` 会过滤掉它们返回 null，`--resume` 就会失败并报 "No conversation found"。

现在写入 transcript 后，即使用户消息刚发出就被终止，`--resume` 也能从"用户消息已被接受"这个断点恢复，而不是从零开始。

设计要点：
- **bare 模式走 fire-and-forget**：脚本化调用不需要 `--resume`，没必要为写入阻塞 ~4ms（SSD）到 ~30ms（磁盘争抢）
- **cowork 模式走 eager flush**：桌面端杀死进程很快，必须确保写入真的落盘
- **这不是性能优化，是正确性保证**——transcript 的时间线完整性直接影响会话恢复的可靠性

> **交叉引用**：进入 query loop 之后的细节——State 不可变更新模式、5 步预处理流水线、Continue/Terminal 状态机、恢复路径——属于 Agent Loop 的微观机制，详见[第 6 章](../part2/06-Agent-Loop机制)。

### 3.5 外层：终止路径全景

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

1. **QueryEngine 不是"一个类"，而是一个函数协作体**：外层 `QueryEngine` 管会话生命周期，内层 `query()` 管 Agent Loop 迭代，`QueryDeps` 提供依赖注入接口，各司其职。

2. **双层架构源于"两类职责"的分离**：会话级（格式转换、转录、结果判定）和循环级（压缩、API 调用、工具执行、恢复）如果混在一起，既不可测试也不可复用。分层的代价很小（多一层函数调用），收益很大。

3. **AsyncGenerator 贯穿整条调用链**：从 `submitMessage` 到 `query()` 到 `deps.callModel()`，全部用 `yield*` 串联。这不仅是流式消费的技术选择，更是中断控制的基础——`AbortController` 的信号可以在任何 `yield` 点生效。

4. **System Prompt 的四段拼接体现了"自定义优先，默认兜底"的设计原则**：custom 存在时跳过默认生成，memoryMechanics 只在 SDK opt-in 时注入，append 始终最后保证覆盖权。

5. **转录时机在 Enter Loop 之前**：这不是性能优化，而是正确性保证——保证进程在中途被杀时 `--resume` 有断点可恢复。

6. **`processUserInputContext` 的双重建反映了"斜杠命令是可执行代码"这一事实**：它能在 turn 开始前修改消息历史和模型选择，外层必须为这种修改提供"写窗口"，写完之后立即关窗（setMessages → no-op）。

7. **5 条终止路径的优先级是精心排布的**：硬限制 > 软判定，循环内检查优先于循环外兜底，确保异常状态不会被"看起来合法"的模型输出掩盖。

8. **依赖注入刻意收窄到 4 个**：不是所有依赖都值得注入。callModel + 两种压缩 + uuid 覆盖了测试中最需要 mock 的边界，过度注入会模糊接口的真实意图。

---

## 5. 边界标注

- 本文覆盖的是 QueryEngine 的**架构全景**——模块划分、调用链路、关键设计决策。以下主题在后续章节中深入：
  - Agent Loop 的微观机制（预处理流水线、恢复路径、Continue/Terminal 状态机）→ [第 6 章](../part2/06-Agent-Loop机制)
  - 流式响应的解析与消费、Extended Thinking 集成 → [第 7 章](../part2/07-流式响应与思考模式)
  - Token 计数的精确机制、cost-tracker 设计、预算控制 → [第 8 章](../part2/08-Token与成本管理)
- 工具执行机制（`runTools`、权限判定、工具注册）见 Part 3 工具系统系列。
- 上下文压缩的算法细节（autoCompact / microCompact / snipCompact / reactiveCompact）见 Part 6 上下文管理系列。
- REPL 交互层的 `ask()` 函数是 QueryEngine 的便捷包装，它额外处理了 REPL 特有的 snip replay 和 fileStateCache 同步，详见 Part 9 Bridge 与终端交互系列。

---

## 6. 参考文献

- [Anthropic API Messages 文档](https://docs.anthropic.com/en/docs/build-with-claude/messages) — 流式响应格式、stop_reason 规范
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) — Agent Loop 的概念起源
- Claude Code 源码：
  - `src/QueryEngine.ts` — 外层会话管理
  - `src/query.ts` — 内层核心循环
  - `src/query/deps.ts` — 依赖注入接口
  - `src/query/config.ts` — 不可变配置快照
  - `src/query/transitions.ts` — 状态转换标记
  - `src/query/stopHooks.ts` — Stop Hook 执行
  - `src/query/tokenBudget.ts` — Token 预算追踪
  - `src/services/api/claude.ts` — API 调用层
  - `src/services/api/withRetry.ts` — 重试策略
  - `src/utils/queryContext.ts` — 上下文构建
  - `src/utils/queryHelpers.ts` — 辅助判定函数
  - `src/utils/messages/systemInit.ts` — SDK 初始化消息
