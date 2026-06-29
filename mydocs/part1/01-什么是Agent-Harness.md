---
title: "01. 什么是 Agent Harness"
description: "理解 Harness 的核心定义 —— Tools + Knowledge + Observation + Action Interfaces + Permissions"
outline: deep
---

# 01. 什么是 Agent Harness

> Harness（缰绳/套具）：围绕大语言模型构建的、使 Agent 能够在特定领域中有效运作的完整基础设施体系。

## 核心定义

在 AI Agent 领域中，"Harness" 是一个至关重要的工程概念。它回答了一个根本问题：**当模型有了智能，谁来为它提供手脚、眼睛、记忆和安全边界？**

```
Harness = Tools + Knowledge + Observation + Action Interfaces + Permissions

    Tools:          file I/O, shell, network, database, browser
    Knowledge:      product docs, domain references, API specs, style guides
    Observation:    git diff, error logs, browser state, sensor data
    Action:         CLI commands, API calls, UI interactions
    Permissions:    sandboxing, approval workflows, trust boundaries
```

## 模型决定做什么，Harness 负责执行怎么做

Claude Code 的设计哲学可以浓缩为一句话：**模型即智能体，代码即缰绳。**

Claude Code 不试图通过复杂的规则引擎、决策树或工作流编排来模拟智能——它完全信任 Claude 模型的决策能力，将全部工程精力投入到为模型提供一个清晰、丰富、安全的工作环境中。

::: tip 关键洞察
最好的 Agent 产品来自于那些理解"自己的工作是 Harness，而非智能"的工程师。
:::

## 本文系列的组织逻辑

本系列文章按照 Harness 的五要素 + 核心循环 + 基础设施的框架组织：

1. **Part 1**：建立 Harness 分析框架
2. **Part 2**：核心循环（Agent Loop）
3. **Part 3-5**：Tools / Knowledge / Observation
4. **Part 6-8**：Context / Coordination / Permissions
5. **Part 9-10**：Action Interfaces / Infrastructure
6. **Part 11**：方法论总结

> 本系列文章由 [从Harness角度对Claude Code源码深度解读](http://www.uml.org.cn/ai/202606164.asp) 启发，以 Harness 工程视角重新组织源码分析。
