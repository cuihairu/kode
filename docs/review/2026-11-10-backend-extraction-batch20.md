# TS 后端独立目录抽取 · 批次 20(index 数据三件)2026-11-10

续批次 1-19,同式推进。

## 范围(3 件,`git mv` 至 src/backend/)

globalDataIndexCore / semanticIndex / eventIndexTypes

选族依据:零 `from 'vscode'` 的索引数据面(globalDataIndexCore 1365 行
仅依赖 perf_hooks;semanticIndex 378 行;eventIndexTypes 22 行纯数据)。
**留 src/**:globalDataIndex / workspaceIndex / eventApi / extension /
entityMapping / definitionWorkspace(经 `../backend/` 回引)。
**workspaceDiscovery(1024 行)本批延后**:importer 含并发在编面
serverConfigResolve(共树保护件),避免牵连,待其落库后入批。

## 改动面

- import 重基 19 处,UNRESOLVED 恰为既有 13 假阳性零新增;
  backend/semanticIndex→definitionSemantics 改 `../`。
- 锚点手工锁步 2 处(tests/eventIndexSeam.test.ts)::38 import 文本断言
  `from './backend/eventIndexTypes'`、:42 纯度审计 readFileSync 路径
  `src/backend/eventIndexTypes.ts`;rebase 脚本按设计不动字符串断言
  (13 假阳性之 :37/:38 即此面)。
- features.md 零引用(预检)零对账;perfCallChainDoc ANCHORS 与
  2026-baseline.md 引用均零涉及(baseline :192 仅行文提及 semanticIndex
  非路径引用)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 22 文件,违禁项检查 0;8 个 src importer diff 逐一
  --stat 核验仅 1-2 行重基。
- **提交 29e99efb**(2026-11-10 推 main)。
