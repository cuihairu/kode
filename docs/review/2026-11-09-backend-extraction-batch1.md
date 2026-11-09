# TS 后端独立目录抽取 · 批次 1(def 分析族)2026-11-09

用户令:TS 后端不删除,以独立目录 `src/backend/` 抽出与 Rust 对照;分族分批;改全部 import(无 re-export 壳)。本批为第 1 批。

## 范围(13 件,`git mv` 至 src/backend/)

defParser / defRenamer / defAnalyzer / entityBuiltinProperties / defChain /
defMethodConsistency / defCallChainViewLogic / entitiesXmlAnalysis /
defParserWorkerHost / defReferenceGraph / defPythonParity / defMd5Rust / schemaWarmup

选族依据:这 13 件构成无环子图,不依赖 mixed 集(definitionWorkspace / entityMapping /
entityMappingHelpers / defSymbolReferences / defMd5Check / languageProviders/shared 等,
含环,留待 SRC-012 拆分后再挪:defCallChain、definitionSemantics、definitionWorkspaceXml)。

## 改动面

- import 重基 171 处(~60 文件,src+tests 全量):规则 = 失效相对说明符一律重解析;
  老槽位 `src/<Moved>.ts` → `src/backend/<Moved>.ts`,被挪文件内原对 src/ 的相对引用
  重算自 `src/backend/`。无 `.ts` 后缀(仓内零 `.ts` 扩展导入,tsconfig 未开
  allowImportingTsExtensions)。
- `defParserWorkerHost.ts`:`__dirname` 耦合修正——编译产物落 `out/backend/`,worker
  bundle 仍在 `out/defParserWorker.js`(package.json esbuild 入口 `src/defParserWorker.ts`
  红线不动),两处 `path.join(__dirname, 'defParserWorker.js')` 改 `..` 一层。
  tests/defParserWorkerHost.test.ts 用 `existsProbe`(endsWith 断言)不受影响。
- **tests/lintRuleRegistry.test.ts 真回归修复**:src 扫描原为 `readdirSync(srcDir)` 非递归,
  `duplicate-entity-name`(KBE-DEF-009)随搬移进入 src/backend/entitiesXmlAnalysis.ts 后
  扫不到 → 红。改递归收集 src 下全部 .ts(排除注册表自身)。
- scripts 锁步:`parser-head2head-ts.mjs` 真实 import 改 `../src/backend/defParser`;
  `gen-parser-h2h-corpus.mjs` 注释路径同步。vsix-assets/verify-pure-ts-vsix 引用的是
  `out/*.js` bundle 面,不受影响。
- 活文档路径对账 70 处(features / architecture.current-state / source-analysis /
  hotreload.current-implementation / knowledge.def-flags / design.def-formatter-evaluation
  / design.def-pyi-stubs,以上 en+zh + migration-inventory.csv):
  `src/<Moved>.ts` → `src/backend/<Moved>.ts`。行号锚不受影响(全部搬移文件行数不变,
  仅 import 说明符文本变)。历史快照(review/*、kode2/pr-*、perf 报告、审计快照)按纪
  保留旧路径。

## 验收

- `pnpm lint` 0 / `pnpm compile`(tsc)0 / 全量 vitest 逐文件隔离 694 文件
  (lintRuleRegistry 6/6 修复后绿;debugConfigAttach 23/23 隔离绿,全量跑时失败为
  共享机负载抖动——真 `ps` 族,当时 load 41-54,复跑绿)。
- 已知边界:entities/types 解析入口 compositionRoots.parseEntityNames/parseTypesXml
  不在挪移集;bundle 入口三线(src/extension.ts、src/pythonParserWorker.ts、
  src/defParserWorker.ts)未动。

## 后续批次(未做)

database 族 / config 族 / Python 族 / clone 族 / messageTable+client_sdk+flagDomains
生成族 / Rust 桥封装,每批同式:搬移 + import 重基 + 锚点锁步 + 全门禁 + push。
mixed 集拆分(SRC-012)后再挪 defCallChain / definitionSemantics / definitionWorkspaceXml。
