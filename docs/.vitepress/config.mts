import { withMermaid } from "vitepress-plugin-mermaid";
import { defineConfig } from 'vitepress';

// 多语言结构（用户 2026-10-16：「vitepress 自带国际化方案」）：
// 中文留在 srcDir 根（locale `root`，URL `/`），英文整体收在 `docs/en/`
// （locale `en`，URL `/en/`）。两个 locale 的目录树同名同构，VitePress
// 内置的语言切换器按「同名相对路径」互跳，无需手写切换链接。
// 每个 locale 的 label / lang / nav / sidebar 各自独立配置，不共用一份。
export default withMermaid(defineConfig({
  title: 'Kode',
  description: 'KBEngine VSCode Extension Documentation',
  base: process.env.GITHUB_ACTIONS ? '/kode/' : '/',
  rewrites: {
    'guide/README.md': 'guide/index.md',
    'en/guide/README.md': 'en/guide/index.md'
  },
  lastUpdated: true,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Kode 文档',
      description: 'KBEngine VSCode 扩展文档',
      themeConfig: {
        nav: [
          { text: '指南', link: '/guide/' },
          { text: '配置', link: '/guide/configuration' },
          { text: '功能', link: '/guide/features' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: '开始',
              items: [
                { text: '快速开始', link: '/guide/' },
                { text: '配置说明', link: '/guide/configuration' },
                { text: '功能概览', link: '/guide/features' },
                { text: '命令与面板', link: '/guide/commands' },
                { text: '语言能力', link: '/guide/language' },
                { text: '日志查看', link: '/guide/logging' },
                { text: '实体依赖图', link: '/guide/dependency-graph' },
                { text: '代码生成器', link: '/guide/generator' },
                { text: '客户端实体 SDK', link: '/guide/client-sdk' },
                { text: '数据库模拟', link: '/guide/database-simulation' },
                { text: '数据库漂移校验', link: '/guide/database-drift-check' },
                { text: '开发与发布', link: '/guide/development' }
              ]
            }
          ],
          '/': [
            {
              text: '文档',
              items: [
                { text: '文档首页', link: '/' },
                { text: '重设计说明', link: '/redesign' },
                { text: '实体索引源码分析', link: '/source-analysis' },
                { text: '参考插件功能差距', link: '/reference-feature-gap' },
                { text: '文档一致性审计', link: '/审计-文档一致性' },
                { text: '快捷动作与数据库提示设计', link: '/design/quick-actions-and-db-hint' },
                { text: '.pyi 类型桩可行性分析', link: '/design/def-pyi-stubs' }
              ]
            }
          ]
        },
        editLink: {
          pattern: 'https://github.com/cuihairu/kode/edit/main/docs/:path',
          text: '帮助改进此页'
        },
        outline: { label: '本页目录', level: [2, 3] },
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        sidebarMenuLabel: '目录',
        returnToTopLabel: '回到顶部',
        langMenuLabel: '切换语言',
        docFooter: { prev: '上一页', next: '下一页' }
      }
    },
    en: {
      label: 'English',
      lang: 'en-US',
      title: 'Kode',
      description: 'KBEngine VSCode Extension Documentation',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/' },
          { text: 'Configuration', link: '/en/guide/configuration' },
          { text: 'Features', link: '/en/guide/features' },
        ],
        sidebar: {
          '/en/guide/': [
            {
              text: 'Start',
              items: [
                { text: 'Quick start', link: '/en/guide/' },
                { text: 'Configuration', link: '/en/guide/configuration' },
                { text: 'Feature overview', link: '/en/guide/features' },
                { text: 'Commands and panels', link: '/en/guide/commands' },
                { text: 'Language features', link: '/en/guide/language' },
                { text: 'Log viewer', link: '/en/guide/logging' },
                { text: 'Entity dependency graph', link: '/en/guide/dependency-graph' },
                { text: 'Code generator', link: '/en/guide/generator' },
                { text: 'Client entity SDK', link: '/en/guide/client-sdk' },
                { text: 'Database simulation', link: '/en/guide/database-simulation' },
                { text: 'Database drift check', link: '/en/guide/database-drift-check' },
                { text: 'Development and release', link: '/en/guide/development' }
              ]
            }
          ],
          '/en/': [
            {
              text: 'Docs',
              items: [
                { text: 'Docs home', link: '/en/' },
                { text: 'Redesign notes', link: '/en/redesign' },
                { text: 'Entity index source analysis', link: '/en/source-analysis' },
                { text: 'Reference plugin feature gap', link: '/en/reference-feature-gap' },
                { text: 'Doc consistency audit', link: '/en/审计-文档一致性' },
                { text: 'Quick actions and db hint design', link: '/en/design/quick-actions-and-db-hint' },
                { text: 'Def/utype to .pyi stubs feasibility', link: '/en/design/def-pyi-stubs' }
              ]
            }
          ]
        },
        editLink: {
          pattern: 'https://github.com/cuihairu/kode/edit/main/docs/:path',
          text: 'Help improve this page'
        },
        outline: { label: 'On this page', level: [2, 3] },
        darkModeSwitchLabel: 'Appearance',
        lightModeSwitchTitle: 'Switch to light theme',
        darkModeSwitchTitle: 'Switch to dark theme',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Return to top',
        langMenuLabel: 'Change language',
        docFooter: { prev: 'Previous page', next: 'Next page' }
      }
    }
  },
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/cuihairu/kode' }
    ],
    footer: {
      message: 'Kode documentation',
      copyright: 'Apache-2.0'
    }
  }
}))
