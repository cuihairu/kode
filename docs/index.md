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

# Kode Documentation


Kode is a VS Code extension for KBEngine projects, covering `.def` language support, diagnostics, navigation, entity browsing, logs, monitoring, dependency graphs, and code generation.

## What you can find here

- [Quick start](./guide/)
- [Feature overview](./guide/features.md)
- [Language features](./guide/language.md)
- [Commands and panels](./guide/commands.md)
- [Full configuration reference](./guide/configuration.md)
- [Database simulation](./guide/database-simulation.md)
- [Development and release](./guide/development.md)

## Working on the docs

```bash
pnpm install
pnpm run docs:dev
```

Build the static site:

```bash
pnpm run docs:build
```
