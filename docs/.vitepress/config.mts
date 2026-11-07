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
    'zh/guide/README.md': 'zh/guide/index.md',
    'knowledge/README.md': 'knowledge/index.md',
    'zh/knowledge/README.md': 'zh/knowledge/index.md'
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
          { text: 'Knowledge', link: '/knowledge/' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Features', link: '/guide/features' },
        ],
        sidebar: {
          '/knowledge/': [
            {
              text: 'Knowledge base',
              items: [
                { text: 'Overview', link: '/knowledge/' },
                { text: 'Entity lifecycle & reference release', link: '/knowledge/entity-lifecycle-reference' },
                { text: 'Entity teleport & cross-process references', link: '/knowledge/entity-migration-and-cross-process-references' },
                { text: 'Fixed directories & path resolution', link: '/knowledge/fixed-directories-and-path-resolution' },
                { text: 'Entry script SPI methods', link: '/knowledge/entry-script-spi-methods' },
                { text: 'Startup flow and stack', link: '/knowledge/startup-flow-and-stack' },
                { text: 'Python version baseline (3.7 vs fork 3.12)', link: '/knowledge/python-version-baseline' },
                { text: 'API: client', link: '/knowledge/api-client' },
                { text: 'API: baseapp module & Entity/Proxy', link: '/knowledge/api-baseapp' },
                { text: 'API: baseapp entity classes', link: '/knowledge/api-baseapp-entity' },
                { text: 'API: cellapp', link: '/knowledge/api-cellapp' },
                { text: 'API: interfaces', link: '/knowledge/api-interfaces' },
                { text: 'API: loginapp / dbmgr / logger', link: '/knowledge/api-loginapp-dbmgr-logger' },
                { text: 'API: bots', link: '/knowledge/api-bots' },
                { text: 'API: core concepts map', link: '/knowledge/api-core-concepts' },
                { text: 'API usage patterns & stats', link: '/knowledge/api-usage-stats' },
                { text: 'Traps index', link: '/knowledge/traps-index' }
              ]
            }
          ],
          '/guide/': [
            {
              text: 'Start',
              items: [
                { text: 'Quick start', link: '/guide/' },
                { text: 'Configuration', link: '/guide/configuration' },
                { text: 'Feature overview', link: '/guide/features' },
                { text: 'Feature flags before/after', link: '/guide/feature-flags' },
                { text: 'Commands and panels', link: '/guide/commands' },
                { text: 'Language features', link: '/guide/language' },
                { text: 'Startup parameters', link: '/guide/startup-parameters' },
                { text: 'KBEngine lint rules', link: '/guide/kbengine-lint-rules' },
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
                { text: 'Player Data Clone plan (v0.2.1)', link: '/design/v0.2.1-player-data-clone-plan' },
                { text: 'Player data clone (db-clone)', link: '/player-clone/' },
                { text: 'db-clone capability & pipeline overview', link: '/player-clone/db-clone-overview' },
                { text: 'Space Viewer / Watcher protocol forensics', link: '/design/space-viewer-watcher' },
                { text: 'File change meta (identity + version)', link: '/design/file-change-meta' }
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
          { text: '知识库', link: '/zh/knowledge/' },
          { text: '配置', link: '/zh/guide/configuration' },
          { text: '功能', link: '/zh/guide/features' },
        ],
        sidebar: {
          '/zh/knowledge/': [
            {
              text: '知识库',
              items: [
                { text: '总览', link: '/zh/knowledge/' },
                { text: '实体生命周期与引用释放', link: '/zh/knowledge/entity-lifecycle-reference' },
                { text: '实体传送与跨进程引用', link: '/zh/knowledge/entity-migration-and-cross-process-references' },
                { text: '固定目录与路径解析链', link: '/zh/knowledge/fixed-directories-and-path-resolution' },
                { text: '入口脚本 SPI 方法表', link: '/zh/knowledge/entry-script-spi-methods' },
                { text: '启动流程与堆栈', link: '/zh/knowledge/startup-flow-and-stack' },
                { text: 'Python 版本口径（3.7 源料 vs fork 3.12）', link: '/zh/knowledge/python-version-baseline' },
                { text: 'API：client 面', link: '/zh/knowledge/api-client' },
                { text: 'API：baseapp 模块与 Entity/Proxy', link: '/zh/knowledge/api-baseapp' },
                { text: 'API：baseapp 实体类', link: '/zh/knowledge/api-baseapp-entity' },
                { text: 'API：cellapp 面', link: '/zh/knowledge/api-cellapp' },
                { text: 'API：interfaces 面', link: '/zh/knowledge/api-interfaces' },
                { text: 'API：loginapp / dbmgr / logger', link: '/zh/knowledge/api-loginapp-dbmgr-logger' },
                { text: 'API：bots', link: '/zh/knowledge/api-bots' },
                { text: 'API：核心概念地图', link: '/zh/knowledge/api-core-concepts' },
                { text: 'API 使用模式与统计', link: '/zh/knowledge/api-usage-stats' },
                { text: '语义陷阱索引', link: '/zh/knowledge/traps-index' }
              ]
            }
          ],
          '/zh/guide/': [
            {
              text: '开始',
              items: [
                { text: '快速开始', link: '/zh/guide/' },
                { text: '配置说明', link: '/zh/guide/configuration' },
                { text: '功能概览', link: '/zh/guide/features' },
                { text: '配置开关前后对照', link: '/zh/guide/feature-flags' },
                { text: '命令与面板', link: '/zh/guide/commands' },
                { text: '语言能力', link: '/zh/guide/language' },
                { text: '启动参数', link: '/zh/guide/startup-parameters' },
                { text: 'KBEngine lint 规范', link: '/zh/guide/kbengine-lint-rules' },
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
                { text: '玩家数据克隆计划 (v0.2.1)', link: '/zh/design/v0.2.1-player-data-clone-plan' },
                { text: '玩家数据克隆 (db-clone)', link: '/zh/player-clone/' },
                { text: 'db-clone 能力边界与克隆全链路', link: '/zh/player-clone/db-clone-overview' },
                { text: 'Space Viewer/Watcher 协议取证', link: '/zh/design/space-viewer-watcher' },
                { text: '文件变化元信息(identity+version)', link: '/zh/design/file-change-meta' }
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
