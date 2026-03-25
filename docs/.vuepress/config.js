module.exports = {
  title: 'Kode',
  description: 'KBEngine VSCode Extension Documentation',
  base: '/',
  head: [
    ['meta', { name: 'theme-color', content: '#1f6feb' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black' }]
  ],
  themeConfig: {
    repo: 'cuihairu/kode',
    docsDir: 'docs',
    editLinks: true,
    editLinkText: '帮助改进此页',
    lastUpdated: '最近更新',
    smoothScroll: true,
    nav: [
      { text: '指南', link: '/guide/' },
      { text: '配置', link: '/guide/configuration.html' },
      { text: '功能', link: '/guide/features.html' },
      { text: 'GitHub', link: 'https://github.com/cuihairu/kode' }
    ],
    sidebar: {
      '/guide/': [
        {
          title: '开始',
          collapsable: false,
          children: [
            '',
            'configuration',
            'features',
            'commands',
            'language',
            'logging',
            'dependency-graph',
            'generator',
            'development'
          ]
        }
      ]
    }
  }
};
