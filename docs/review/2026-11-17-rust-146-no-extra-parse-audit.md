# RUST-146 审计:Outline / breadcrumbs / folding / linked editing 不触发另一次完整 parse

日期:2026-11-17
性质:约束合规审计(约束项,非迁移项)——逐面核实零重 parse 契约现状,零代码缺口,零改动结案。

## 逐面核实

### 1. Outline / breadcrumbs(def 文件)

- 消费面:`KBEngineDocumentSymbolProvider`(src/languageProviders/references.ts:339,IDE-NAV-005),注册于 defDocumentSelector(src/activate/languageServices.ts:726)。breadcrumbs 是 VSCode 对 documentSymbol 面的 UI 呈现,同一 face。
- parse 链:`parseDefAst`(src/languageProviders/shared.ts:307)→ `getOrParseDocumentSync(document, parse, 'def-ast')`(src/backend/documentStore.ts:263)。版本键控共享缓存:同版本命中直接返回缓存 AST,与诊断/hover/definition 共用同一份解析产物;版本未变时 Outline 连续触发零重 parse。
- 决策核归属:已在 RUST-139 批 1 收编 Rust(golden `crates/kode-server/tests/golden/document-symbols-parity.json` + TS 镜像 `tests/kodeDocumentSymbolsParity.test.ts` 四 fixture 语料逐符号深等)。
- 无版本替身(部分测试场景)逐次现解析——documentStore.ts:270 显式分支,行为与旧价一致,不涉生产契约。

### 2. Outline / breadcrumbs(python 文件)

本扩展零注册:全仓 grep 无 python DocumentSymbolProvider。Python Outline/breadcrumbs 由外部语言服务(Pylance 等)供给,属 RUST-148 冲突矩阵裁定域,不在本行范围。

### 3. Folding

零自定义 FoldingRangeProvider(全仓 grep 零命中)。VSCode 内建缩进折叠,宿主自带,不经本扩展任何 parse 面。

### 4. Linked editing

零 LinkedEditingRangeProvider(全仓 grep 零命中)。零 parse 面;未提供即零成本。

### 5. 相邻面:工作区符号(Ctrl+T,IDE-NAV-006)

`KBEngineWorkspaceSymbolProvider`(references.ts:387)→ `searchDefSymbolsByPrefix` 只读内存索引,查询面不触发全仓扫描(docstring 在案声明+实现一致)。

## 结论

约束四要素(Outline/breadcrumbs/folding/linked editing)现状全部满足「不触发另一次完整 parse」:def 面走版本化共享缓存且决策核已 Rust parity;folding/linked editing 零 provider 零面;python 面属外域。零代码改动,审计结案。

## 门禁

纯审计零代码改动,无新门禁义务;当日既有门禁基线见 RUST-145 批 1 注(vitest 860 文件 10397+8skip EXIT=0 / xvfb demo 25 RC=0 / clippy 0 / lint 0 / tsc 0)。
