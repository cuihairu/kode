import { withMermaid } from "vitepress-plugin-mermaid";
import { defineConfig } from 'vitepress';

// 多语言结构（2026-10-21 双语对调为舰队口径）：英文留在 srcDir 根
// （locale `root`，URL `/`），中文整体收在 `docs/zh/`（locale `zh`，
// URL `/zh/`）。两个 locale 的目录树同名同构，VitePress 内置的语言
// 切换器按「同名相对路径」互跳，无需手写切换链接。
// 每个 locale 的 label / lang / nav / sidebar 各自独立配置，不共用一份。
export default withMermaid(defineConfig({
  title: 'Kode',
  description: 'KBEngine VSCode Extension Documentation',
  base: process.env.GITHUB_ACTIONS ? '/kode/' : '/',
  rewrites: {
    'guide/README.md': 'guide/index.md',
    'zh/guide/README.md': 'zh/guide/index.md'
  },
  lastUpdated: true,
  // 单语内部工作稿（review/、reference/ 为英文工作文档，无另一语言对位
  // 文件）：不进入双语站点构建，避免语言切换器渲染指向不存在页面的链接。
  srcExclude: ['review/**', 'reference/**', '**/mixin-jump.md'],
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'Kode',
      description: 'KBEngine VSCode Extension Documentation',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Features', link: '/guide/features' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'Start',
              items: [
                { text: 'Quick start', link: '/guide/' },
                { text: 'Configuration', link: '/guide/configuration' },
                { text: 'Feature overview', link: '/guide/features' },
                { text: 'Commands and panels', link: '/guide/commands' },
                { text: 'Language features', link: '/guide/language' },
                { text: 'Log viewer', link: '/guide/logging' },
                { text: 'Entity dependency graph', link: '/guide/dependency-graph' },
                { text: 'Code generator', link: '/guide/generator' },
                { text: 'Client entity SDK', link: '/guide/client-sdk' },
                { text: 'Database simulation', link: '/guide/database-simulation' },
                { text: 'Database drift check', link: '/guide/database-drift-check' },
                { text: 'Extension migration', link: '/guide/migration' },
                { text: 'Development and release', link: '/guide/development' }
              ]
            }
          ],
          '/': [
            {
              text: 'Docs',
              items: [
                { text: 'Docs home', link: '/' },
                { text: 'Redesign notes', link: '/redesign' },
                { text: 'Entity index source analysis', link: '/source-analysis' },
                { text: 'Reference plugin feature gap', link: '/reference-feature-gap' },
                { text: 'Doc consistency audit', link: '/审计-文档一致性' },
                { text: 'Quick actions and db hint design', link: '/design/quick-actions-and-db-hint' },
                { text: 'Def/utype to .pyi stubs feasibility', link: '/design/def-pyi-stubs' },
                { text: 'Space Viewer / Watcher protocol forensics', link: '/design/space-viewer-watcher' }
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
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Kode 文档',
      description: 'KBEngine VSCode 扩展文档',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/' },
          { text: '配置', link: '/zh/guide/configuration' },
          { text: '功能', link: '/zh/guide/features' },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '开始',
              items: [
                { text: '快速开始', link: '/zh/guide/' },
                { text: '配置说明', link: '/zh/guide/configuration' },
                { text: '功能概览', link: '/zh/guide/features' },
                { text: '命令与面板', link: '/zh/guide/commands' },
                { text: '语言能力', link: '/zh/guide/language' },
                { text: '日志查看', link: '/zh/guide/logging' },
                { text: '实体依赖图', link: '/zh/guide/dependency-graph' },
                { text: '代码生成器', link: '/zh/guide/generator' },
                { text: '客户端实体 SDK', link: '/zh/guide/client-sdk' },
                { text: '数据库模拟', link: '/zh/guide/database-simulation' },
                { text: '数据库漂移校验', link: '/zh/guide/database-drift-check' },
                { text: '扩展迁移', link: '/zh/guide/migration' },
                { text: '开发与发布', link: '/zh/guide/development' }
              ]
            }
          ],
          '/zh/': [
            {
              text: '文档',
              items: [
                { text: '文档首页', link: '/zh/' },
                { text: '重设计说明', link: '/zh/redesign' },
                { text: '实体索引源码分析', link: '/zh/source-analysis' },
                { text: '参考插件功能差距', link: '/zh/reference-feature-gap' },
                { text: '文档一致性审计', link: '/zh/审计-文档一致性' },
                { text: '快捷动作与数据库提示设计', link: '/zh/design/quick-actions-and-db-hint' },
                { text: '.pyi 类型桩可行性分析', link: '/zh/design/def-pyi-stubs' },
                { text: 'Space Viewer/Watcher 协议取证', link: '/zh/design/space-viewer-watcher' }
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
    }
  },
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/kode/logo.svg' }]],
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
