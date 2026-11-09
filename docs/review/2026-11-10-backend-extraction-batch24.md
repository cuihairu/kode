# TS 后端独立目录抽取 · 批次 24(quickAction 配置族)2026-11-10

续批次 1-23,同式推进。

## 范围(3 件,`git mv` 至 src/backend/)

quickActionScanner(82 行)/ quickActionConfig(347 行)/
debugConfigBootstrap(441 行)

选族依据:零 `from 'vscode'` 的快捷动作扫描/配置口径与调试引导面
(共 ~870 行)。scanner↔config 既有互引收敛为兄弟;bootstrap 的
backend 依赖(managedDir/variableSubstitution)兄弟化,debugConfig
(留守混合件)改 `../`。**留 src/**:quickActions(装配)/quickActionTree/
debugJsonSchema/logErrorScan/debugConfig/profileInterpreter/
activate(generators/utilityCommands)(经 `../backend/` 回引);
backend/venvInterpreterPicker 的出向收敛为兄弟(批次 19 预告面落位)。

## 改动面

- import 重基 33 处,UNRESOLVED 恰为既有 13 假阳性零新增;
  extension*.test 六件的 vi.mock/出向面同笔重基。
- 零静态锚、零动态拼路径读、零 ANCHORS/零 baseline 引用;
  活文档路径对账 6 处:features.md en+zh 各 3。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 25 文件(含 features en+zh),违禁项检查 0;
  profileInterpreter diff 单行(本批重基)核验无并发牵连。
- **提交 ec05a57a**(2026-11-10 推 main)。
