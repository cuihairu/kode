# RUST-139 批 4:workspace/symbol LSP 接线(def 符号前缀检索面)

决策核批 2(cf17b4af `workspace_symbols.rs` + golden 第三面 `workspace-symbols-parity.json` 15 root/108 符号/317 命中,TS `kodeWorkspaceSymbolsParity` 双向对拍)已收口,本批只做**服务面**:LSP `workspace/symbol` 臂 + TS 薄桥 + provider 切流。诚实边界(批 2 登记,本批不改):rootName 取 def basename(语料与 entities.xml 实体名恒同,异名登记册场景归接线批按需扩)+ 嵌套属性符号面(kode-parser `PropertyDef` 无嵌套字段)。

## 服务端臂(`crates/kode-server/src/server.rs`)

- 分派 `"workspace/symbol" => handle_workspace_symbol`:LSP 规范方法名(todo/批 2 评审文档里的 `textDocument/workspaceSymbol` 是记法,实际 LSP 面是 `workspace/symbol`,VSCode Ctrl+T 亦发此名);
- `WorkspaceSymbolParams { query }` 解析失败(缺 query/query 非串)→ `-32602`;`capabilities.workspaceSymbolProvider = true`;
- 应答 `{ "symbols": [WorkspaceSymbolHit...] }`:命中面 `symbolName/kind("property"|"method")/section(仅 method 在场)/rootName/rootDefFile/defFile/line(1 基)`,决策核零改直调 `HoverEngine::workspace_symbols_by_prefix`;
- **判例核心**:`drain_index_for_global_request`(本批新增)——检索面不带文档键,无键可 freshen,只做有界追赶(`REQUEST_DRAIN_BUDGET`/`REQUEST_DRAIN_BUDGET_MS`)。缺这步时 didOpen 入库任务还在队列里,语料视图未就绪,检索面恒空集;`documentSymbol` 等按文档键刷新的臂不暴露此洞,因为它们的 `drain_index_for_request` 自带 pump。

## 协议三锁链

`WorkspaceSymbolParams` → `crates/kode-protocol/src/bin/dump-protocol-schema.rs`(root 字段 `workspace_symbol_params`)→ `protocol.schema.json` → `src/generated/protocolTypes.ts`;`protocolContract` 真 spawn 钉 capability 键集 + `workspaceSymbolProvider === true`。

## TS 桥(`src/backend/kodeCoreShadowFaces.ts`)

`serveWorkspaceSymbolsFromRust(query, isCancelled?)`:`{ query }` 载荷;回包 `{ symbols: [...] }` 逐键校验(`symbolName` 串 / `kind` 二值 / `section` null-or-串 / `rootName`·`rootDefFile`·`defFile` 串 / `line` 非负整数 ≥1),任一畸形 → 整面作废 null。检索面无文档上下文 → **零 mirrorDocument**(与 .py 面相反,门只判 serveFromRust)。空集 `{symbols:[]}` 是合法应答照返 `[]`(`[] ≠ 失败回退`)。

## provider 切流(`src/languageProviders/references.ts`)

`KBEngineWorkspaceSymbolProvider.provideWorkspaceSymbols` Rust-first:命中即薄壳直构 `vscode.SymbolInformation`(kind `property`→Field / `method`→Method,containerName = `rootName · section`(属性只 rootName),location 指向 def 声明行 `max(0, line-1)` 列 0);Rust 面不可用(无门/门关/取消/应答畸形/serve 抛错)→ 回 TS `searchDefSymbolsByPrefix` 既有链,零行为回退。**空集照用不回退**(避免用空 Rust 面把 TS 结果抹成空)。

## 集成门禁(`crates/kode-server/tests/workspace_symbol_dispatch.rs`,8 例)

能力协商;**初始化前 → SERVER_NOT_INITIALIZED**;前缀正臂(方法双 kind + 段注记 + 声明落点 + 行号自推导);属性臂(section 恒 null);**跨 def 父链折叠**(Hero 继承 Avatar 的 hp/onTalk → first-wins 不覆盖,落点指回声明档);大小写不敏感 + trim;未知前缀 → `{symbols:[]}` 空集非 null;空查询全集 6 条(`rootName/symbolName` 序);非法参数双例 → `-32602`。

## 判例账(本批)

1. **无文档键的臂必须有追赶腿**:首版漏 `drain_index_for_request`,四个正臂全空而三个负臂(空集/能力/非法参数)照绿——又是「负臂假绿」族。检索/健康类全局臂不能照抄文档臂的刷新(它们要 freshen 自键),单独拆 `drain_index_for_global_request` 只泵不 freshen。
2. **空集 vs null 必须分开钉**:空集是「答出来了」,null 是「没答」;桥把 `{symbols:[]}` 归入畸形会让空结果被静默换成 TS 链,正负臂都绿但语义已错。测试里单独立一条「空集照返 `[]` 且 manager 零请求」。
3. **rustfmt 只收本批 hunk**:`server.rs` HEAD 预存 13 处 dirty,本批以「脏块数 13→13、行号位移 +8」验证零新增(禁全包 fmt);新测试文件可直接 rustfmt 净。

## 门禁基线

- `cargo test -p kode-server --test workspace_symbol_dispatch` 8/8;`cargo test -p kode-server -p kode-protocol` 112 suites 0 failed;`clippy -D warnings` 0;
- rustfmt:新测试文件净 + `server.rs` 本批 hunks 零新增脏块;协议件整文件净;
- `tsc -p tsconfig.json --noEmit` 0;eslint 本批四文件 0;`tests/kodeWorkspaceSymbolsRust.test.ts` 12 例 + `protocolContract` 10 例 + `workspaceSymbols.test.ts` 全绿。

## 诚实边界

- **嵌套属性符号面**(parser `PropertyDef` 无嵌套字段,批 2 登记)不属本批,接线批只换服务面;
- **rootName = def basename**:与 entities.xml 实体名异名的登记册场景未建模(语料恒同);
- `limit`(LSP 可选分页参数)不入 Rust 面:结果集由决策核全量产出,截断归 TS 请求侧,服务端不猜分页口径;
- `defFile`/`rootDefFile` 走语料键(已打开档的 canonical 路径),未打开档不入语料 ⇒ 检索面依赖 didOpen 入库,与 documentSymbol 同源。
