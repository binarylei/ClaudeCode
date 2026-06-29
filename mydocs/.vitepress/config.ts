import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ClaudeCode 源码分析',
  description: '深入理解 Claude Code —— 架构分析与模块解读',
  lang: 'zh-CN',
  base: '/ClaudeCode/',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '指南', link: '/guide/getting-started' },
    ],

    sidebar: [
      {
        text: '指南',
        items: [
          { text: '快速开始', link: '/guide/getting-started' },
        ],
      },
      {
        text: '架构分析',
        items: [],
      },
      {
        text: '模块解读',
        items: [],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/binarylei/ClaudeCode' },
    ],

    footer: {
      message: '基于 Claude Code 还原源码分析',
      copyright: '© 2026',
    },
  },
})
