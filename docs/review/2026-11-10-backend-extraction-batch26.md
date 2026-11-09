# TS 后端独立目录抽取 · 批次 26(用户类型契约/片段五件)2026-11-10

续批次 1-25,同式推进。

## 范围(5 件,`git mv` 至 src/backend/)

userTypeContract(145 行,零 import)/ userTypeContractSource(139 行)/
definitionWorkspaceXml(144 行)/ snippetGenerator(134 行,零 import)/
inferredCopy(133 行,仅 path)

选族依据:零 `from 'vscode'` 的用户类型契约/def XML 工作区/片段生成/
推断复制面(共 ~705 行)。**留 src/**:activate/diagnostics(±utilityCommands)/
hoverBuilders/inferPipeline/definitionWorkspace(经 `../backend/` 回引)。

## 改动面

- import 重基 15 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- 锚点 1 处手工锁步:lintRuleRegistry KBE-DEF-010 `source` 串
  `src/userTypeContract.ts` → `src/backend/`(rebase 脚本按设计不触
  非相对串,此类锚全手动);零静态文件读锚(snippetGeneratorCommand
  读的是用户片段产物文件)、零 ANCHORS 面;活文档路径对账:features.md
  en+zh 各 3(含双命中行)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 18 文件(含 features en+zh + lintRuleRegistry),
  违禁项检查 0。
- **提交 71b46e59**(2026-11-10 推 main)。
