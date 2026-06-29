import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ClaudeCode 源码分析',
  description: '以 Harness 工程视角深度解读 Claude Code 源码',
  lang: 'zh-CN',
  base: '/ClaudeCode/',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '指引', link: '/guide/00-目录与阅读指引' },
    ],

    sidebar: [
      {
        text: '指南',
        items: [
          { text: '00. 目录与阅读指引', link: '/guide/00-目录与阅读指引' },
        ],
      },
      {
        text: 'Part 1：Harness 总览 — 架构全景与设计哲学',
        collapsed: false,
        items: [
          { text: '01. 什么是 Agent Harness', link: '/part1/01-什么是Agent-Harness' },
          { text: '02. 架构公式拆解', link: '/part1/02-架构公式拆解' },
          { text: '03. 源码地图', link: '/part1/03-源码地图' },
          { text: '04. 关键文件速览', link: '/part1/04-关键文件速览' },
        ],
      },
      {
        text: 'Part 2：核心循环 — Agent 的大脑中枢',
        collapsed: true,
        items: [
          { text: '05. QueryEngine 全景解析', link: '/part2/05-QueryEngine全景解析' },
          { text: '06. Agent Loop 机制', link: '/part2/06-Agent-Loop机制' },
          { text: '07. 流式响应与思考模式', link: '/part2/07-流式响应与思考模式' },
          { text: '08. Token 与成本管理', link: '/part2/08-Token与成本管理' },
        ],
      },
      {
        text: 'Part 3：工具系统 — Agent 的双手',
        collapsed: true,
        items: [
          { text: '09. 工具基类设计', link: '/part3/09-工具基类设计' },
          { text: '10. 工具注册与延迟发现', link: '/part3/10-工具注册与延迟发现' },
          { text: '11. 行动层工具', link: '/part3/11-行动层工具' },
          { text: '12. 感知层工具', link: '/part3/12-感知层工具' },
          { text: '13. 协调层工具', link: '/part3/13-协调层工具' },
          { text: '14. 扩展与隔离层', link: '/part3/14-扩展与隔离层' },
        ],
      },
      {
        text: 'Part 4：命令系统 — 用户驱动的操作入口',
        collapsed: true,
        items: [
          { text: '15. 命令注册与路由', link: '/part4/15-命令注册与路由' },
          { text: '16. 命令分类解析', link: '/part4/16-命令分类解析' },
          { text: '17. 特性门控命令', link: '/part4/17-特性门控命令' },
        ],
      },
      {
        text: 'Part 5：知识系统 — 按需学习与渐进式披露',
        collapsed: true,
        items: [
          { text: '18. 技能系统设计', link: '/part5/18-技能系统设计' },
          { text: '19. 渐进式披露', link: '/part5/19-渐进式披露' },
          { text: '20. 插件架构', link: '/part5/20-插件架构' },
        ],
      },
      {
        text: 'Part 6：上下文管理 — Agent 的记忆工程',
        collapsed: true,
        items: [
          { text: '21. 上下文收集机制', link: '/part6/21-上下文收集机制' },
          { text: '22. 三层压缩策略（上）：子智能体隔离', link: '/part6/22-三层压缩策略-上-子智能体隔离' },
          { text: '23. 三层压缩策略（下）：压缩与持久化', link: '/part6/23-三层压缩策略-下-压缩与持久化' },
          { text: '24. 记忆目录', link: '/part6/24-记忆目录' },
        ],
      },
      {
        text: 'Part 7：多智能体协调 — Team Harness',
        collapsed: true,
        items: [
          { text: '25. 子智能体生成', link: '/part7/25-子智能体生成' },
          { text: '26. 六种架构模式', link: '/part7/26-六种架构模式' },
          { text: '27. 团队协作机制', link: '/part7/27-团队协作机制' },
          { text: '28. Worktree 隔离', link: '/part7/28-Worktree隔离' },
        ],
      },
      {
        text: 'Part 8：权限系统 — Agent 的安全边界',
        collapsed: true,
        items: [
          { text: '29. 多级权限模式', link: '/part8/29-多级权限模式' },
          { text: '30. 细粒度权限控制', link: '/part8/30-细粒度权限控制' },
          { text: '31. Hook 生命周期', link: '/part8/31-Hook生命周期' },
        ],
      },
      {
        text: 'Part 9：Bridge 与终端交互 — 跨越 CLI 的 Harness 延伸',
        collapsed: true,
        items: [
          { text: '32. Bridge 架构全景', link: '/part9/32-Bridge架构全景' },
          { text: '33. IDE 集成', link: '/part9/33-IDE集成' },
          { text: '34. 终端 UI 体系', link: '/part9/34-终端UI体系' },
          { text: '35. 辅助交互系统', link: '/part9/35-辅助交互系统' },
        ],
      },
      {
        text: 'Part 10：基础设施 — Harness 的运行底座',
        collapsed: true,
        items: [
          { text: '36. 启动链路', link: '/part10/36-启动链路' },
          { text: '37. 状态管理', link: '/part10/37-状态管理' },
          { text: '38. 性能优化', link: '/part10/38-性能优化' },
          { text: '39. 技术栈与遥测', link: '/part10/39-技术栈与遥测' },
          { text: '40. 配置迁移', link: '/part10/40-配置迁移' },
        ],
      },
      {
        text: 'Part 11：总结 — Harness 工程的启示',
        collapsed: true,
        items: [
          { text: '41. Harness 工程师的五大职责', link: '/part11/41-Harness工程师的五大职责' },
          { text: '42. 模块依赖全景图', link: '/part11/42-模块依赖全景图' },
          { text: '43. 设计原则回顾与通用化', link: '/part11/43-设计原则回顾与通用化' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/binarylei/ClaudeCode' },
    ],

    footer: {
      message: '基于 Claude Code 还原源码，以 Harness 工程视角深度解读',
      copyright: '© 2026',
    },
  },
})
