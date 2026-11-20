# RUST-139 批 3:textDocument/documentSymbol LSP 接线(决策核 → 服务面)

日期:2026-11-20
todo.md 行:`RUST-139(旧 LSP-006) DocumentSymbol / WorkspaceSymbol 提供快速搜索与稳定排序。`
本批边界:**DocumentSymbol 面从决策核接到 LSP 服务面 + TS provider 切流**。批 1(7947d7dc `document_symbols.rs` 纯库 + golden)与批 2(cf17b4af WorkspaceSymbol 决策核)之上的接线批:本面此前零 TS 调用方,`KBEngineDocumentSymbolProvider` 全程 TS 自算。本批零改决策核(纯函数签名/语义不动),只加服务端分派臂 + TS 桥 + provider 切流。`textDocument/workspaceSymbol` 接线与嵌套属性符号面仍留批 4+。

## 服务端臂(`crates/kode-server/src/server.rs`)

顶层 `handle_request_inner` 新增 `textDocument/documentSymbol` 分派(与 `textDocument/definition`、`textDocument/diagnostic` 同形:参数反序列化失败 → `-32602`;未打开/解析无根 → 成功响应体 `null`,LSP 允许,不报错不阻塞):

```
initialize 协商 → capabilities.document_symbol_provider = true
→ CanonicalUri::parse → root_for → DocumentKey → drain_index_for_request
→ open_buffer(未打开 → null)→ crate::document_symbols::document_symbols(&text)
→ Some(symbols) → 序列化数组 / None → null
```

`DocumentSymbolParams`(`kode-protocol`,仅 `text_document` 文档身份)进三锁链:Rust DTO → `dump-protocol-schema` bin stdout → `protocol.schema.json` → `pnpm gen:protocol` → `src/generated/protocolTypes.ts`(`tests/protocolSchema.test.ts` 字节对账);协议契约测试 `tests/protocolContract.test.ts` 对**真二进制**观测的 capability 键集合加入 `documentSymbolProvider`,并钉其为 `true`。

**诚实边界(写进 arm 文档注释与桥注释)**:本面只出段符号树。进程段面包屑合成根(跨文件对端跳)是 TS provider 投影层职责——Rust 恒不含合成根,provider 侧保留面包屑装配,只把「段符号来源」换成 Rust 面。

## TS 桥(`src/backend/kodeCoreShadowFaces.ts`)

`serveDocumentSymbolsFromRust(document, isCancelled?)`:服务轨道(`gate.serveFromRust()`)+ `.def` 文档门 → 先 `mirrorDocument`(未保存修订以编辑器内容为准,与其余四 serving 面同账本)→ `serveInRust('textDocument/documentSymbol', {textDocument:{uri}})`,整链路走 `awaitWithInteractiveBudget`(2000ms 交互预算 + 50ms 取消探测)。应答**整面校验**:非数组或任一层条目畸形(name/detail 非串、kind 越出 `Struct|Class|Field|Method`、range/selectionRange 缺位、children 非数组或递归层畸形)→ `null`,不做部分采用;调用方回 TS 既有实现。

## provider 切流(`src/languageProviders/references.ts`)

`KBEngineDocumentSymbolProvider.provideDocumentSymbols`:

- 原 TS 段符号循环提取为 `tsSectionSymbols(document, ast.root)`(行为不变,`DefSectionSymbols` 视图);
- 分支顶 Rust-first:`rustSections = await serveDocumentSymbolsFromRust(...)`;
- 命中 → `rustSectionSymbols`(kind 字符串 → `vscode.SymbolKind` 投影 + 区间逐面透传 + children 递归),未命中/失败 → `tsSectionSymbols`;
- 其后面包屑装配、`methodSections`(Class 容器推导方法段)两段消费方不变。

**判例(本批新增门禁红脸)**:`SYMBOL_KIND_BY_NAME` 初版做成**模块级查表常量**(`Struct: vscode.SymbolKind.Struct, …`),模块作用域即触碰 `vscode` API → `tests/bundleLoadSmoke.test.ts` 真装载 bundle 时 `TypeError: Cannot read properties of undefined (reading 'Struct')`。该套件正是为「UMD 运行时 require 泄漏」设的门:模块求值期不得触碰注入的 `vscode`。改为惰性 `symbolKindByName(kind)` 函数(switch 体内才取 `vscode.*`)后复绿。**判例:provider 里的 vscode 数值映射表必须惰性求值,不得模块级查表。**

## Rust 钉(`crates/kode-server/tests/document_symbol_dispatch.rs`,9 例)

走 definition_dispatch 同构模板(真实 `handle_request` 全链,非纯函数):initialize 宣告 `document_symbol_provider:true` / initialize 前发本面被拒 / 已开档 → 段符号真值(Avatar def:Properties 容器 range `{1,1}→{6,13}` + selectionRange `{1,1}→{1,13}`、hp Field、onCellCreate Method、成员 `children:[]` 不下钻)/ **meta-only def(Parent·Interfaces·Components)→ `[]` 而非 null(空档语义与「不可用」区分)**/ 未开档 → null / 不可解析文本 → null / 参数畸形 → `-32602` / didChange 后新段即出 / didClose 后回 null。

## TS 钉(`tests/kodeDocumentSymbolsRust.test.ts`,7 例)

①桥契约:ok 路径先镜像再请求、载荷只含 `textDocument.uri`、面原样透传;无门/非服务轨道/python 文档 → null 且**零请求**;应答畸形六臂(kind 越界 `Namespace`/`Event`、range 缺位、children 非数组、递归层 kind 越界、外层包 `{symbols}`)→ 整面作废;取消位先置 → 零请求。
②provider 切流:golden 真值面(`document-symbols-parity.json` 前 3 非空语料文件,读真盘文本同输入)→ 段符号逐点深等 Rust 面;故意漂移的合法面(`RUST_ONLY_MARKER` 子符号)原样出镜 = **证明不是 TS 兜底自算**;Rust 失败(`serveError`)→ 与无门基线同树。

## prove-red

- **TS 接线面**(钉真消费):`rustSections` 强制 `null` → `Rust 面被真消费:故意漂移的合法面原样出镜` 红(`expected [ 'hp' ] to include 'RUST_ONLY_MARKER'`),cp 还原复绿;
- **provider 侧 vscode 查表**:模块级 `SYMBOL_KIND_BY_NAME` → `bundleLoadSmoke` 红(见上判例),改惰性后复绿;
- Rust 分派臂/能力声明/golden 三面的钉由本批 9 例 dispatch 钉与既有 golden 重生成比对覆盖(golden 22 files/104 symbols 逐字节不变,`kodeDocumentSymbolsParity` 3 例照绿)。

## 门禁

- `cargo test -p kode-protocol -p kode-server`:108 suite 全 ok,1482 tests(含新增 document_symbol_dispatch 9 例);
- `cargo clippy -p kode-protocol -p kode-server --all-targets -- -D warnings`:0;
- rustfmt:**仅本批文件**(`rustfmt --check --edition 2021` 净)。`server.rs` 存在他批遗留漂移(std import 序 + root_lifecycle 分派臂/`drain_index_for_request`/hover·completion 表达式布局),`rustfmt` 整文件跑会带出 86 行无关重排 → **不回灌**(禁全包 fmt 红线),改以「scratch 副本 fmt 后与工作树 diff」验认:本批新增行零出现在分歧中;
- `npx tsc -p ./`:0;`eslint` 本批文件:0(`src/inferPipeline.ts`、`aliasAssist.ts` 两条既有红属他席 infer 车道,未触碰);
- vitest 定向(7 文件 43 例含 bundleLoadSmoke/protocolSchema/protocolContract/两套 document-symbols 镜像/defDocumentSymbols/defReferences)全绿;
- vitest 全量:950 文件 / 11392 passed / 7 failed。7 条失败**已用 HEAD 净检出对照复现完全相同**(detached worktree 跑同 4 文件 = 同 7 例,涉 `kbengine.infer.*` 配置契约、Pyrefly 文档、`InferredMirrorTypeInlayHints`、工作区 watcher 门控),属他席在途面,本批零引入;
- 本批**零发布动作**:无版本号 bump、无 tag、无 Release。

## 余账(批 4+)

- `textDocument/workspaceSymbol` LSP 接线(批 2 决策核 `workspace_symbols_by_prefix` 就绪,TS 薄壳待切;排序域=路径序归一);
- 嵌套属性符号面(kode-parser `PropertyDef` 顶层模型无 children/arrayElement,归 parser 模型扩展批);
- RUST-138 批 3:`semantic_reference_locations` 切换是**产品面**(语法同名引用是否进结果集),按任务令不擅自切,先接 `position face` 那一半;
- RUST-140/141/143/258 其余面接线。