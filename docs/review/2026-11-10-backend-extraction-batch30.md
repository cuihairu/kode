# TS 后端独立目录抽取 · 批次 30(小型纯件九件)2026-11-10

续批次 1-29,同式推进。**rootConfigGeneration 本批延后**:8 个 importer
含并发在编保护件 configDerive/serverConfigResolve,与 workspaceDiscovery
同因待其落库。

## 范围(9 件,`git mv` 至 src/backend/)

hoverMarkdown(60)/ processTopologyDiagnostics(69)/ annotationSourceLog(49)/
rootRemovalEvents(45)/ dualActivationConflict(44)/ activationProfile(37)/
performanceBenchmark(35)/ serverCommandTarget(23)/ entityStubRegen(47)

选族依据:零 `from 'vscode'` 的小型纯支撑面(~410 行)。**留 src/**:
languageProviders/hover、loggingWiring、extension、activate 五处
(diagnostics/infrastructure/languageServices/serverControls/utilityCommands)、
serverManager 出向(经 `../backend/` 回引);backend 组合面
pythonReturnTypeInference→annotationSourceLog、processTopologyDiagnostics→
processTopologyRust、hoverMarkdown→entityBuiltinProperties/
selfPropertyTypeInference、serverCommandTarget→serverManager(`../`)
兄弟/出向收敛。src/test/electron/suite/plainVariableHover.test.ts
(mocha 真机层)同笔重基。lintRuleRegistry source 串
(processTopologyDiagnostics)已批次 29 提前锁步入 HEAD,本批落位成真。

## 改动面与锚点

- import 重基 30 处,UNRESOLVED 恰为既有 13 假阳性零新增;features.md
  en+zh 各 3 对账。
- 手工锚 2+1 处:tests/hoverMarkdown.test.ts :86/:114 双 readFileSync
  路径改 `src/backend/`;:99 import 形态正则
  `(\.\.\/)?hoverMarkdown` → `(\.\.\/)+(backend\/)?hoverMarkdown`
  (languageProviders hover render 位源锁断言,旧式不容 backend 段);
  修复后 8/8 绿。
- registry 零新增本批面(批次 29 已预锁)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 35 文件(含 features en+zh),违禁项检查 0。
- **提交 37ea21d2**(2026-11-10 推 main)。

## 战役态势(批次 30 后)

src/backend/ ~190 件。src/ 根剩余纯件全数有明确归属:**受保护待挪**
(kbeModuleIndex/workspaceDiscovery/rootConfigGeneration,均卡并发在编
保护件 importer);**留守胶水/命令层**(compositionRoots/hooks/
languageServiceMetrics/*Command 件/*Integration/*Verification/
watcherProtocolAudit/demoGameTemplate 等);**延后**(pythonTestRunner/
pythonTestDiscovery UX 邻接);bundle 红线(pythonParserWorker/
defParserWorker/extension)不动。易挖纯矿已尽,后续批次待并发面落库
解锁后收尾。
