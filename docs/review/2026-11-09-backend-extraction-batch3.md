# TS 后端独立目录抽取 · 批次 3(*Rust 桥封装族)2026-11-09

续批次 1/2,同式推进。

## 范围(5 件,`git mv` 至 src/backend/)

databaseSchemaRust / dependencyGraphRust / playerDataCloneRust /
processTopologyRust / pythonCallGraphRust

选族依据:五件均为 Rust RPC 桥封装(零 `from 'vscode'`),与批次 1 已挪的
defMd5Rust 同性质;importer(databaseSchema / playerDataCloneCommands /
processTopologyDiagnostics / activate/diagnostics / entityMappingHelpers /
entityCallGraphView / entityDependencyWebView / entityDependencyGraphView)
均非并发会话脏件。

## 改动面

- import 重基 48 处:src 侧 10 处(含 activate/diagnostics、多行 import 面
  由解析失败驱动捕获,如 dependencyGraphRust 的 `./definitionWorkspace`);
  tests 侧 13 文件 38 处 → `../src/backend/<name>`。
- **vi.mock 字符串重基 4 处(全量套件抓获的真实回归)**:`vi.mock('<spec>')`
  不是 import 语句,首轮重基未覆盖——mock 仍拦旧路径而 import 已指新路径,
  真模块被加载,cloneCommandsCoverage / playerDataCloneImportCommand /
  covDiagnosticsFindings 计 43 例红(covValidationG 的 defPythonParity mock
  同类滞留但恰无行为断言,一并修)。修后 6 文件隔离 137/137 绿。
  重基工具(vi.mock/vi.doMock 纳入解析失败驱动重基面)已补,幂等复核零滞留。
- 活文档路径对账 14 处(features en+zh):`src/<name>.ts` → `src/backend/<name>.ts`。
- 依赖面 kodeCoreShadowFaces / databaseSchemaCore / playerDataCloneWire /
  definitionWorkspace / scanRoots 均留 src/ 根(仅相对层级改写)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 修正后 exit 0
  (首轮 5 文件红:3 文件 vi.mock 回归属实 + debugConfigAttach /
  typeStorageColdBuildPhased 属已知负载敏感族,隔离绿)。
