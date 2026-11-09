# TS 后端独立目录抽取 · 批次 25(客户端网络/工具面五件)2026-11-10

续批次 1-24,同式推进。

## 范围(5 件,`git mv` 至 src/backend/)

telnetClient(298 行,仅 net)/ profileDatabaseConnection(235 行)/
debugJsonSchema(191 行)/ pyrightStubGate(204 行,仅 child_process)/
ruffLint(225 行)

选族依据:零 `from 'vscode'` 的 telnet 协议/数据库连接档案/debug schema
构建/pyright 存根闸/ruff lint shell-out 面(共 ~1.15k 行)。**留 src/**:
telnetService/telnetWebView/autoDebugpy/botsControl/databaseWiring/
entityTypeStubs(经 `../backend/` 回引)、serverConfigMerge/serverConfigResolve
(出向留守,importer 零改动)、nlsRuntime;backend 组合面
hotReloadTransport→telnetClient、debugJsonSchema→quickActionConfig、
ruffLint→kodeCoreShadowFaces 兄弟化。

## 改动面

- import 重基 20 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- 零静态锚(debugJsonSchema.test 的 schemaPath 是仓内 schemas/ 产物
  文件非模块路径)、零动态拼路径读;perfCallChainDoc :136/:261 仅行文
  提及 ruffLint/profileDatabaseConnection(import 块行数不变,extension.ts
  ANCHORS 不受影响);零 ANCHORS 面。活文档路径对账 14 处:features.md
  en+zh 各 7。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 19 文件(含 features en+zh),违禁项检查 0。
- **提交 a130c68e**(2026-11-10 推 main)。
