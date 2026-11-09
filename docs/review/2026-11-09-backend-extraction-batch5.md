# TS 后端独立目录抽取 · 批次 5(python 分析核心族)2026-11-09

续批次 1-4,同式推进。

## 范围(11 件,`git mv` 至 src/backend/)

pythonParser / pythonParserWorkerHost / pythonSelfScope / pythonClassIndex /
pythonScanRules / pythonLiteralTypes / pythonLexicalMask /
pythonReturnTypeInference / pythonRoleRoots / pythonApiHoverDocs /
pythonLanguageUtils

选族依据:零 `from 'vscode'` 的 python 分析核心。**留 src/ 的 python 面**:
pythonParserWorker(esbuild bundle 入口红线不动)、pythonStubExport /
pythonTestDiscovery / pythonTestRunner / pythonExtraPaths /
pythonLanguageServiceStatus / pythonScanRules 伴生装配与 UX 邻接件;
serverConfigMerge 被并发会话在编的 serverConfigResolve 引用,本批不动。

## 改动面

- import 重基 181 处(181 计 - 13 既有假阳性 = 168 真改):src 侧 45 处
  (behaviorLints / receiverNoneDiagnostics / defCallChain / defParamInlayHints /
  readOnlyWriteDiagnostics / roleMisuseDiagnostics / pythonTypeStubs /
  workspaceIndex / globalDataIndex / languageProviders 8 文件 / activate 4 文件 /
  pythonParserWorker(bundle 入口内引用指向 backend)/ electron 套件 1 处),
  tests 侧 100+ 处含 perf/*.bench.ts 与 electron。
- 跨批次同层收敛:entityBuiltinProperties `../pythonLexicalMask`→`./pythonLexicalMask`、
  defPythonParity `../pythonParser`→`./pythonParser`(均批次 1 挪入,目标本批跟进)。
- 活文档路径对账 30 处(features en+zh 20、architecture.current-state en+zh 6、
  design.def-pyi-stubs en+zh 2、migration-inventory.csv 2)。
- 依赖面 definitionWorkspace / compositionRoots / scanRoots / indexScheduler /
  dependencyGraph / hoverBudget / navigationLog / languageServiceMetrics /
  annotationSourceLog / generated/apiDocs / hoverLocale 均留 src/ 根。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- **全量套件抓获两类修正(单文件绿掩盖不了的面)**:
  ① **静态路径锚 9 文件 + 活文档 1**:readFileSync/join 硬编码 `src/<moved>.ts`
  的测试全数 ENOENT——annotationInflightGauge(pythonReturnTypeInference)、
  pythonParserWorkerGauge / vsixSmokeWiring(pythonParserWorkerHost)、
  rstPythonR2bDecisionDoc(pythonParserWorkerHost)、vsixPackaging(数组断言
  `src/pythonParser.ts`→`src/backend/pythonParser.ts`,worker 入口仍留 src/)、
  perfCallChainDoc(2026-baseline.md 引用锚 3 处)、
  receiverNoneAsyncSharedParse 文件 :105、pythonReturnTypeInferenceGapArms
  (注释);docs/perf/2026-baseline.md 2 处引用锚同步(pythonClassIndex
  :657/:1384→backend/,行号不变,perfCallChainDoc CITATION 正则天然兼容)。
  ② **vi.importActual 字符串参数**:`vi.importActual<...>('../src/pythonParser')`
  的路径是运行时串不是 import 语句,类型参数改了、串没改 → 运行时
  Cannot find module;重基脚本补该形态(并一并覆盖 vi.mock/vi.doMock/
  vi.importMock/importOriginal)。
- 修后 9 失败文件 89/89 绿;全量门禁见提交前记录。
- 全量 vitest 8387 过 / 3 失败=既有负载抖动族(hoverDeadlineContext 时间预算、
  processTopologyPerf Rust RPC 5s 超时、typeStorageColdBuildPhased 深组件链),
  隔离复跑 3 文件 21/21 绿;demo 25 RC=0;docs:build RC=0。
- **提交 80d9e743**(2026-11-09 推 main):127 文件 275+/224-,并发会话面
  (Cargo.lock/crates/**/configDerive/kbeModuleIndex/pythonStubExport/
  serverConfigResolve 及对应 4 tests/_tmp_verify/wt/)零牵连零提交——4+4
  排除件 diff 核验无任何批次 5 重基内容,src 侧 14 个未具名改动件逐一核验
  纯 import 行改动。
