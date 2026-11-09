# TS 后端独立目录抽取 · 批次 23(实体图/代码生成渲染三件)2026-11-10

续批次 1-22,同式推进。

## 范围(3 件,`git mv` 至 src/backend/)

entityWizard(341 行,零 import 全独立)/ codeGeneratorRender(598 行)/
entityFlowGraph(759 行,仅 backend/definitionSemantics 兄弟化)

选族依据:零 `from 'vscode'` 的实体向导/代码生成渲染/实体流图分析面。
**留 src/**:codeGenerator(vscode 混合,出向两件改 `../backend/`)、
entityFlowWebView、languageProviders/hoverBuilders(经 `../backend/`
回引);codeGeneratorRender↔entityWizard 兄弟互引,codeGeneratorRender→
codeGenerator 改 `../`(跨目录环,TS/ESM 合法)。

## 改动面

- import 重基 22 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- 零静态锚、零动态拼路径读(entityWizardFlow 的 readFileSync 全是
  tmpdir 夹具面)、零 ANCHORS/零 baseline 引用;活文档路径对账 6 处:
  features.md en+zh 各 3。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 8389 过 4 skip
  1 失败=tests/hoverDeadlineContext「15ms 预算」已知满载抖动族
  (当时 load 78+,并发会话 rust 构建打满),隔离复跑 10/10 绿证环境性
  非回归;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 19 文件,违禁项检查 0。
- **提交 5f281a12**(2026-11-10 推 main)。
