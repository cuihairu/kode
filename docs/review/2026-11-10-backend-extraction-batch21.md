# TS 后端独立目录抽取 · 批次 21(独立分析四件)2026-11-10

续批次 1-20,同式推进。

## 范围(4 件,`git mv` 至 src/backend/)

redisDrift / behaviorKnowledge / inferredEnrichment / defCallChain

选族依据:零 `from 'vscode'` 的独立分析面(~1.6k 行):redisDrift 仅依赖
net;behaviorKnowledge 零 import;inferredEnrichment 仅 backend/
pythonLexicalMask+path;defCallChain 依 backend/pythonLanguageUtils+
entityMapping(留守)。跨批组合面 backend/behaviorLints 的 behaviorKnowledge
引用经规则 (c) 收敛为兄弟。**留 src/**:defCallChainProvider /
languageProviders(inlay/hover/codeAction)/ redisKeyspaceCommand /
inferredMirrorLookup / databaseManagementWebView / entityMapping(经
`../backend/` 回引)。

## 改动面

- import 重基 33 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- 零静态锚、零动态拼路径读(预检:behaviorKnowledge.test 只读知识
  markdown,inferredEnrichmentProviders 静态审计读 pythonExtraPaths/
  pythonStubExport 两留守件,均不受影响);零 perfCallChainDoc ANCHORS
  与 baseline 引用;活文档路径对账 3 处:features.md en 2/zh 1。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 30 文件(含 features en+zh),违禁项检查 0。
- **提交 e62f98a0**(2026-11-10 推 main)。
