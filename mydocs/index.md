---
layout: home

hero:
  name: "ClaudeCode 源码分析"
  text: "深入理解 Claude Code"
  tagline: 基于还原源码的架构分析与模块解读
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/getting-started
    - theme: alt
      text: 项目仓库
      link: https://github.com/binarylei/ClaudeCode

features:
  - title: 架构分析
    details: 深入分析 Claude Code 的整体架构、模块划分和核心设计模式
  - title: 模块解读
    details: 逐个剖析 CLI、Agent、Tool、MCP 等关键模块的实现细节
  - title: 学习笔记
    details: 记录源码阅读过程中的思考与心得
---

::: tip 📖 阅读指引
如果你是第一次访问，建议先阅读 **[00. 目录与阅读指引](./guide/00-目录与阅读指引)**，了解博客的设计思路、全书结构和推荐阅读路线。
:::

## 组织逻辑

以 QueryEngine 为核心的同心圆结构，每一层有且仅有一个清晰的职责：

```
                     ┌─────────────────────┐
                     │   Part 6: 平台基础    │  运行环境（安全、沙箱、UI、远程）
                     │  ┌───────────────┐   │
                     │  │  Part 5: 服务层 │   │  外部系统对接（API、MCP、插件）
                     │  │ ┌───────────┐ │   │
                     │  │ │ Part 4:   │ │   │
                     │  │ │ 智能体系统 │ │   │  高级编排（Agent、Skill、Workflow）
                     │  │ │ ┌───────┐ │ │   │
                     │  │ │ │Part 3 │ │ │   │
                     │  │ │ │工具系统│ │ │   │  能力提供（AI 的手和眼）
                     │  │ │ │┌───┐ │ │ │   │
                     │  │ │ ││引擎│ │ │ │   │
                     │  │ │ ││Part2│ │ │ │   │  核心：对话循环 + 输入分发
                     │  │ │ │└───┘ │ │ │   │
                     │  │ │ └───────┘ │ │   │
                     │  │ └───────────┘ │   │
                     │  └───────────────┘   │
                     └─────────────────────┘
```

| Part | 职责 | 一句话 |
|------|------|--------|
| 1. 入口 | 程序怎么起来 | 启动链路 |
| 2. 引擎 | 对话怎么运转 | 主循环 + 所有输入分发 |
| 3. 工具 | 模型能做什么 | AI 的手和眼 |
| 4. 智能体 | 复杂任务怎么拆 | 委派、编排、记忆 |
| 5. 服务 | 对接什么外部系统 | API、MCP、插件 |
| 6. 平台 | 在什么环境里运行 | 安全、沙箱、UI、远程 |
| 7. 总结 | 全局视角回看 | 模式提炼 |

---

### 架构总览

```
入口层   dev-entry.ts → cli.tsx → main.tsx → init.ts
             │
引擎层   QueryEngine.ts ←→ query.ts ←→ services/api
             │          ←→ commands.ts（指令分发，同一条输入链路）
             │
抽象层   Tool.ts  Task.ts  AppState  bootstrap/state
             │
实现层   tools/*(40+)  tasks/*  services/*
             │
渲染层   ink/*  components/*  screens/*
             │
基础层   utils/*(60+)  types/*  constants/*
```

---

### Part 1：入口与启动（4 篇）

| # | 模块 | 核心文件 | 说明 |
|---|------|---------|------|
| 01 | 项目全景 | `package.json`、`bun.lock` | 技术栈选型（Bun + TypeScript + Ink/React），模块依赖总览 |
| 02 | 启动链路 | `src/dev-entry.ts` → `src/entrypoints/cli.tsx` → `src/main.tsx` | 三级级联启动：导入校验 → 快速路由分发 → 完整启动 |
| 03 | 初始化系统 | `src/entrypoints/init.ts` | 一次性初始化：OAuth、遥测、代理、LSP、信任对话框 |
| 04 | 全局状态 | `src/bootstrap/state.ts` | 单例 STATE 对象，整个代码库的依赖叶子节点 |

### Part 2：查询引擎（6 篇）

| # | 模块 | 核心文件 | 说明 |
|---|------|---------|------|
| 05 | 主循环 | `src/QueryEngine.ts` | 对话循环核心：接收输入 → 调用模型 → 处理工具调用 → 回流结果 |
| 06 | 查询编排 | `src/query.ts` | 底层 API 交互、流式响应处理 |
| 07 | 应用状态 | `src/state/AppState.ts` | 会话级 React 状态树，驱动 UI 更新 |
| 08 | 上下文管理 | `src/services/compact/`、`src/services/contextCollapse/` | 上下文窗口压缩与折叠策略 |
| 09 | 指令注册与路由 | `src/commands.ts` | 80+ 个 `/` 斜杠指令的注册与路由分发 |
| 10 | 核心指令 | `/help`、`/config`、`/mcp`、`/review`、`/session` 等 | 高频指令的实现：配置管理、会话控制、MCP 管理 |

> 指令系统原本在引擎的同一轮事件循环中处理 —— `QueryEngine` 收到输入后分流：`/command` → `commands.ts` 执行，自然语言 → API 调用。它们共享同一套 dispatch 框架，因此归入 Part 2。

### Part 3：工具系统（6 篇）

| # | 模块 | 说明 |
|---|------|------|
| 11 | 工具基类与注册 | `src/Tool.ts` + `src/tools.ts` — 抽象 Tool 接口、JSON Schema 定义、工具注册表 |
| 12 | 文件工具 | FileReadTool、FileWriteTool、FileEditTool、GlobTool、GrepTool、NotebookEditTool |
| 13 | 终端工具 | BashTool、PowerShellTool — 命令执行、沙箱、进程管理 |
| 14 | Web 工具 | WebFetchTool、WebSearchTool、WebBrowserTool |
| 15 | 任务工具 | TaskCreateTool、TaskOutputTool、TaskStopTool 等 — 子任务生命周期管理 |
| 16 | MCP 工具 | MCPTool — Model Context Protocol 工具接入 |

### Part 4：智能体系统（4 篇）

| # | 模块 | 说明 |
|---|------|------|
| 17 | Agent Tool | `src/tools/AgentTool/` — 子 Agent 委托与编排 |
| 18 | 技能系统 | `src/skills/` + `src/services/skillSearch/` — 技能的注册、搜索与调度 |
| 19 | 记忆系统 | `src/memdir/` + `src/services/SessionMemory/` — 文件级记忆持久化 |
| 20 | 工作流引擎 | `src/tools/WorkflowTool/` + `src/tasks/LocalWorkflowTask/` — 多 Agent 工作流编排 |

### Part 5：服务层（5 篇）

| # | 模块 | 说明 |
|---|------|------|
| 21 | API 客户端 | `src/services/api/` — Anthropic API 调用、文件上传、认证 |
| 22 | MCP 客户端 | `src/services/mcp/` — MCP 服务器连接、工具/资源发现、配置管理 |
| 23 | 分析与遥测 | `src/services/analytics/` — GrowthBook 特性开关、OpenTelemetry 指标 |
| 24 | 认证系统 | `src/services/oauth/` + `src/utils/auth.ts` — OAuth 2.0、凭证存储 |
| 25 | 插件系统 | `src/plugins/` + `src/services/plugins/` — 插件加载、CLI 管理 |

### Part 6：平台与基础设施（5 篇）

| # | 模块 | 说明 |
|---|------|------|
| 26 | 交互式 UI | `src/components/` + `src/screens/` — Ink/React 终端 UI 组件体系 |
| 27 | 终端渲染 | `src/ink/` — Ink 底层：组件、事件、Hook、布局、终端 I/O |
| 28 | 远程与桥接 | `src/remote/` + `src/bridge/` — 远程会话、Bridge 模式 |
| 29 | 安全与权限 | `src/utils/permissions/` + `src/services/policyLimits/` — 工具权限、组织策略 |
| 30 | 沙箱与环境 | `src/utils/sandbox/` + `src/utils/bash/` — 终端沙箱、环境变量管理 |

> UI 渲染是运行容器的组成部分，和安全策略、沙箱一样属于"平台基础设施"，不放引擎层。

### Part 7：总结（2 篇）

| # | 模块 | 说明 |
|---|------|------|
| 31 | 架构模式总结 | 设计模式提炼：特征门控（feature gates）、单例状态树、依赖叶节点模式 |
| 32 | 模块依赖全景 | 自顶向下的 DAG 结构，`bootstrap/state` 为全局叶子 |

---

## 推荐阅读路线

| 路线 | 目标读者 | 篇数 | 顺序 |
|------|---------|------|------|
| ⚡ 快速入门 | 想快速了解全局 | 6 篇 | 01→02→05→09→17→31 |
| 🔧 工具开发 | 想了解工具/指令机制 | 8 篇 | 01→11→12→13→14→16→09→10 |
| 🤖 AI 工程 | 关注 LLM 对话引擎 | 8 篇 | 01→05→06→08→17→20→21→22 |
| 📚 完整阅读 | 全面深入 | 32 篇 | 01→32 顺序阅读 |
