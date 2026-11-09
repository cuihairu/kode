# TS 后端独立目录抽取 · 批次 18(http 服务对)2026-11-09

续批次 1-17,同式推进。

## 范围(2 件,`git mv` 至 src/backend/)

httpRequests / httpRequestService

选族依据:零 `from 'vscode'` 的 HTTP 请求目录/传输服务(共 ~487 行)。
**留 src/**:quickActions / hotReload 编排器(经 `../backend/` 回引);
跨批次组合面 backend/hotReloadTransport 与 hotReloadDefaultHotfix 的
`../httpRequests`/`../httpRequestService` 经规则 (c) 收敛为兄弟引用
(批次 7 预告面落位)。

## 改动面

- import 重基 31 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内
  httpRequestService→httpRequests 兄弟解析。
- 零静态锚、零动态拼路径读(预检);活文档路径对账 4 处:features.md
  en+zh 各 2。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动 693 文件 /
  8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- **提交 0774cf4b**(2026-11-09 推 main):16 文件 44+/20-,违禁项检查 0
  (批次 17 事故后严格化)。
