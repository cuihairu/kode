# TS 后端独立目录抽取 · 批次 29(lens/摘要五件)2026-11-10

续批次 1-28,同式推进。

## 范围(5 件,`git mv` 至 src/backend/)

dependencyGraph(166)/ pyreflyInfer(152)/ reproductionSummary(171)/
propertyCodeLens(114)/ rpcCodeLens(91)

选族依据:零 `from 'vscode'` 的依赖图/pyrefly 推断/现场复现摘要/属性与
RPC code lens 面(共 ~694 行)。**留 src/**:entityMapping/inferPipeline/
typeInlayHints/defCallChainProvider/languageProviders(callHierarchy/
codeLens)/activate/utilityCommands(经 `../backend/` 回引);backend
组合面 pythonClassIndex→dependencyGraph、propertyDirectionDiagnostics→
propertyCodeLens 兄弟化。lintRuleRegistry source 串零涉及
(批 26/30 各 1 处与本批无关)。

## 改动面与锚点事故(本批事故入账)

- import 重基 20 处,UNRESOLVED 恰为既有 13 假阳性零新增;features.md
  en+zh 各 10 对账。
- **锚点读取面 grep 漏 `fs.promises.readFile`:首跑全量 3 红**
  (cacheCapacityGauge/pythonParserWorkerGauge/annotationBuildWorkload
  三测试以 `fs.promises.readFile('src/reproductionSummary.ts')` 源锁,
  rebase 脚本按设计只重基 import/require/vi.mock 形,读取串全手动面;
  此前锚点预检只 grep readFileSync/readRepo/join(__dirname)。
  修复:3 测试路径改 `src/backend/`。**连带补账**:全局字符串字面量
  扫描(全 moved 集)另揪出批次 14 漏对账的活文档锚——
  docs/design/hot-reload-design.md 与 hotReloadVersionDocs.test 断言
  双改 `src/backend/sharedFileEvents.ts`;修复后隔离 4 文件 27 测试绿。
- **方法学补丁入 memory:锚点读取面 grep 必须含 fs.promises.readFile
  族 + 全 moved 集字符串字面量扫描**,单名 grep 不再放行。

## 验收

- 修复后 `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过
  零抖动 693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 28 文件(含 features en+zh + design doc),违禁项
  检查 0。
- **提交 4fb59fca**(2026-11-10 推 main)。
