# TS 后端独立目录抽取 · 批次 22(definitionSemantics 单件)2026-11-10

续批次 1-21,同式推进。

## 范围(1 件,`git mv` 至 src/backend/)

definitionSemantics(1015 行)

选族依据:零 `from 'vscode'` 的 def 语义分析核心;入向后其三个 backend
依赖(defParser/defRenamer/pathIdentity)收敛为兄弟引用,definitionWorkspace
与 sharedFileSnapshot(留守混合件)改 `../`。**留 src/**:12 个 importer
(entityFlowGraph/dependencyGraph/entityFlowWebView/explorerProviders(±Model)/
extension/entityMapping(±Helpers)+4 个 backend 件
(messageTable±Engine/Entity/semanticIndex) 兄弟化)。

## 改动面

- import 重基 34 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- 零静态锚、零动态拼路径读(预检:definitionSemantics*.test 的
  path.join 全是 tmpdir 夹具面)、零 ANCHORS/零 baseline 引用、
  features.md 零引用。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;docs:build RC=0。
- **demo 首跑 1 红(demoNavigation:91 混入诊断期望 3 实得空,伴
  onWillSave 1750ms 中止)=宿主慢载抖动**:当时 load average 78
  (并发会话 rust 构建打满);复跑 25/25 RC=0 证环境性,非回归。
- 暂存精确清单 25 文件,违禁项检查 0。
- **提交 56975282**(2026-11-10 推 main)。
