import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'Kode',
  description: 'KBEngine VSCode Extension Documentation',
  base: process.env.GITHUB_ACTIONS ? '/kode/' : '/',
  rewrites: {
    'README.md': 'index.md',
    'guide/README.md': 'guide/index.md'
  },
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/' },
      { text: '配置', link: '/guide/configuration' },
      { text: '功能', link: '/guide/features' },
      { text: 'GitHub', link: 'https://github.com/cuihairu/kode' }
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
            { text: '开发与发布', link: '/guide/development' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/cuihairu/kode' }
    ],
    editLink: {
      pattern: 'https://github.com/cuihairu/kode/edit/main/docs/:path',
      text: '帮助改进此页'
    },
    footer: {
      message: 'Kode documentation',
      copyright: 'Apache-2.0'
    }
  }
});
