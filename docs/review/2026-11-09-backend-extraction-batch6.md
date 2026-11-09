# TS 后端独立目录抽取 · 批次 6(诊断分析族)2026-11-09

续批次 1-5,同式推进。

## 范围(16 件,`git mv` 至 src/backend/)

behaviorLints / receiverNoneDiagnostics / roleMisuseDiagnostics /
readOnlyWriteDiagnostics / rpcArgCountDiagnostics / postDestroyDiagnostics /
selfAttributeFlowTypes / selfAttributeNoneDiagnostics /
selfPropertyTypeInference / fixedDictMutationDiagnostics /
propertyDirectionDiagnostics / propertyInitOrderLens / spaceNavDiagnostics /
timerCleanupDiagnostics / destroyedEntityCaptureDiagnostics /
configContractDiagnostics

选族依据:零 `from 'vscode'` 的诊断/lint 分析引擎(共 ~4.4k 行)。
**留 src/ 的诊断邻接件**:trapDiagnosticsWiring(发布装配)、typeInlayHints、
hoverMarkdown、propertyCodeLens(装配与呈现);languageProviders 桶保持。

## 改动面

- import 重基 117 处,UNRESOLVED 恰为既有 13 假阳性零新增;family 内互引
  (selfAttributeNoneDiagnostics→selfAttributeFlowTypes)落位后天然兄弟解析,
  出向 backend 六件(pythonLexicalMask/pythonParser/pythonParserWorkerHost/
  pythonLanguageUtils/entityBuiltinProperties/defAnalyzer)经规则 (c) 收敛为
  兄弟引用,出向 src 留守六件(behaviorKnowledge/definitionWorkspace/
  entityMapping/nlsRuntime/pythonTypeStubs/propertyCodeLens)经规则 (a) 改 `../`。
- 反向面核验:backend 既有 46 件零 family 引用(无跨批次组合修正)。
- **重基脚本 MOVED 集改动态化**:由 `ls src/backend/*.ts` 现场推导(此前手工
  维护单批集合,跨批次规则 (c) 依赖人肉补齐),后续批次免维护。
- lintRuleRegistry source 路径 19 处 → `src/backend/<name>.ts`(含复合串
  `fixedDictMutationDiagnostics.ts(发布 src/trapDiagnosticsWiring.ts)` 的
  前缀,trapDiagnosticsWiring 留守不改)。
- 活文档路径对账 44 处:features.md en+zh 各 22。todo.md/completed-history/
  intranet-env-audit(2026-11-06 日期件)/2026-10-30-todo-audit.csv 依既有
  口径不动(完成条目=历史证据锚,批次 1-5 先例;测试零校验面)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量门禁见提交前记录。
