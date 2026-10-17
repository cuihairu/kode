<script setup lang="ts">
// 首次访问按浏览器语言选择文档语言（vitepress 无此能力，GitHub Pages 不支持 _redirects）
// 优先级：localStorage 手动选择 > navigator.language > 保持当前 locale
import { onBeforeMount } from 'vue'
const KEY = 'kode-lang-auto-picked'
const BASE = '/kode/'
const ROOT_PATH = BASE
const ZH_PATH = BASE + 'zh/'
onBeforeMount(() => {{
  if (typeof window === 'undefined') return
  const p = window.location.pathname
  if (p !== ROOT_PATH && p !== ROOT_PATH.slice(0, -1)) return
  const picked = localStorage.getItem(KEY)
  if (picked) {{ if (picked !== p) window.location.replace(picked); return }}
  const langs = (navigator.languages?.length ? navigator.languages : [navigator.language]).map(l => l.toLowerCase())
  if (langs.some(l => l.startsWith('zh'))) window.location.replace(ZH_PATH)
}})
if (typeof window !== 'undefined') {{
  window.addEventListener('click', (e) => {{
    const a = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null
    const href = a?.getAttribute('href') || ''
    if (href.startsWith(ZH_PATH) || href.startsWith('zh/')) localStorage.setItem(KEY, ZH_PATH)
    else if (href === ROOT_PATH || href === ROOT_PATH.slice(0, -1)) localStorage.setItem(KEY, ROOT_PATH)
  }}, true)
}}
</script>

# Kode 文档


Kode 是一个面向 KBEngine 项目的 VSCode 扩展，覆盖 `.def` 语言支持、诊断、跳转、实体浏览、日志、监控、依赖图和代码生成。

## 你可以在这里找到什么

- [快速开始](./guide/)
- [功能概览](./guide/features.md)
- [语言能力](./guide/language.md)
- [命令与面板](./guide/commands.md)
- [完整配置说明](./guide/configuration.md)
- [数据库模拟](./guide/database-simulation.md)
- [开发与发布](./guide/development.md)

## 文档开发

```bash
pnpm install
pnpm run docs:dev
```

构建静态文档：

```bash
pnpm run docs:build
```
