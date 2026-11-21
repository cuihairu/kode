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

---

# 批 5:嵌套属性符号面(kode-parser PropertyDef 扩展 + workspace_symbols 递归)

2026-11-21。承接批 2 登记的「嵌套属性符号面(parser `PropertyDef` 无
children/arrayElement)」,本批把 TS `parseProperties`/`pushProperty` 的
递归语义落到 Rust 两侧。

## 交付面

- **kode-parser model.rs**:`PropertyDef` 加 `children: Vec<PropertyDef>`
  (嵌套 `<Properties>` 子属性,FIXED_DICT 子项,TS `DefinitionProperty.children`
  同构)与 `array_element: Option<Box<PropertyDef>>`(ARRAY `<of>` 合成
  `value` 元素:名恒 `value`,`typeName=<of>` 文本,`line=父属性行`,旗标/
  持久/detailLevel/databaseLength 继承父,default/identifier/sensitive 清空,
  `arrayElement` 不再下钻,`children` 取 `<Type>` 内嵌 `<Properties>`)。
  新增 `extract_properties_list` helper;多 `<Properties>` 段并列逐段追加
  (初版整段覆盖吞前段——真实回归,depGraph parity 场景 A 抓到,语料单段
  自洽盲区)。
- **workspace_symbols.rs**:`push_property_hits` 递归(`self → children`
  声明序 → `arrayElement`);顶层 first-wins **整树吞并**(败者子树不产
  符号,TS `effectivePropertyMap` 首条遮蔽同构),递归层无去重;`fullPath`
  仅作遍历线索(命中符号名 = 叶名,落点 = 声明 def,行 = 叶声明行)。
  `PropertyHitContext` 收敛四个恒定参数(clippy 8/7 → 5)。
- **golden** `workspace-symbols-parity.json` 重生成:53→54 符号 / 81→83
  探针 / 317→335 命中 / 全集 108→114(`+6 value` = 语料三 ARRAY-of 源
  × 2 root;`value` 行 = 父行,与 TS arrayElement 口径逐点相等)。
- **TS 镜像** `kodeWorkspaceSymbolsParity.test.ts`:`propertiesOf` 改递归
  (children/arrayElement 同构),`pushFoldHits` 顶层键改 `fullPath::flags`。

## 新钉

- workspace_symbols 2 例:`nested_property_symbols_recurse_in_push_order`
  (FIXED_DICT 子属性 + arrayElement + 元素子属性落点/行号)、
  `losing_property_subtree_is_wholly_discarded`(own cfg 压接口 cfg,败者
  depth 整树吞并不产符号)。
- kode-parser/tests/nested_properties.rs 6 例:多段追加 / 嵌套子属性 /
  arrayElement 合成继承 / 空 `<of>` 不合成 / `<Type>/<Properties>` 内嵌
  子属性 / 标量零嵌套。

## prove-red 四靶

1. 删 children 递归 → nested 钉 + losing 钉双红(width/height/pos 缺失)。
2. 删 arrayElement 递归 → nested 钉红(value/pos 缺失)。
3. 败者仍递归 → losing 钉红(接口 depth 虚报)。
4. 多段覆盖复现 → parser multi 钉红(left `["rival"]` vs `["pets","rival"]`)。

## 坑账

- **`out.properties = ...` 整段覆盖吞前段**:初版把 `for ... push` 改写成
  赋值 helper,depGraph parity 场景 A(每属性一段的合成形态)当场红——
  语料单 `<Properties>` 自洽,合成 fixture 才是盲区。判例:改写为 helper
  必须先确认原语义(追加 vs 覆盖)。
- **workspace_symbols 命中序是全局排序,不是递归序**:递归序在
  (rootName, symbolName, line) 排序后不可见,断言须以同键排序后集合
  比对(递归序本身由 TS 对拍 golden 钉)。
- **前缀过滤会吃掉子符号**:`"cfg"` 前缀下子符号 `width` 不在结果里,
  整树断言必须用空前缀 + root 过滤。

## 门禁

- clippy 0;rustfmt 本批文件净(crate 整体非规范漂移 = 预存,禁全包 fmt);
- tsc 0;eslint 本批 0;
- 全量 vitest 红 = 2 真实回归(depGraphParity / rstR2IndexInventory)已修 +
  余负载抖动族(隔离复跑绿,含 kodeCoreE2E respawn 墙钟 20s);
- parser fixtures_golden 逐字节不变(7 字段序列化,嵌套面不进 golden)。

## 余界

entities.xml 异名 root 与接口条目元素形态留接线批。

## 批 6:接口条目元素形态(2026-11-21)

批 5 余界两子项裁定:

### 子项 1:entities.xml 异名 root —— 假证(零代码改动)

批 2/批 5 的「TS rootName 来自 entities.xml 实体名」是**伪前提**。生产
TS `parseDefFile` 的 rootName 恒为 `path.basename(defFile, '.def')`——def
文件基名,与 entities.xml 元素名无关,三处同源:
`entityMapping.ts:520`(`parseDefFile(path.basename(defFile.fsPath,'.def'),...)`)、
`:1252`、`:3030`。Rust/mirror 已同口径(def basename),故**异名 root 不是
缺口**,不实现 entities.xml 基 root(那会引入与生产不一致的第三种口径)。
本子项以假证登记收口。

### 子项 2:接口条目元素形态 —— 真实缺陷,本批修复

引擎 `loadInterfaces(entitydef.cpp:561-585)` 的接口名 = 条目首个非注释子
节点的 getKey:文本形态取 trim 文本、**元素形态取元素名**;且引擎 tinyxml
`Blank()` 分支丢弃元素间纯空白(tinyxmlparser.cpp:1204-1213)。生产 TS
`getReferenceTargetName(defRenamer.ts:673)` 同口径(跳过空文本子节点)。

缺陷:parser `find` 谓词修前只跳过 `Comment`,元素形态
`<interface>\n  <GadgetIface/>\n</interface>` 的首个子节点是换行缩进空白
文本 → 取到空串 → **条目整体丢失**(接口不折入)。

修复(两处,行为保持):

- `crates/kode-parser/src/model.rs`:`find` 谓词跳过空文本
  (`!decoded.trim().is_empty()`)与注释;元素形态取首元素标签名。
- `tests/kodeWorkspaceSymbolsParity.test.ts`:`interfacesOf` 从
  `getDirectChildElementsByName(node,'interface')` 文本形态专取改为
  生产对齐——`INTERFACE_WRAPPER_NAMES` 四名
  {interface,Interface,type,Type} 过滤 + `referenceTargetName`
  (首非注释非空子节点:文本取文本、元素取标签名)。

语料自洽盲区:四语料 `<interface>` 条目全为文本形态(逐语料 grep 实证),
且 entities.xml 元素名恒=def 基名——故两处修复都是行为保持,golden
逐字节不变。盲区由合成钉补齐:

- **Rust 钉** `element_child_interface_entry_folds_interface_symbols`:
  `build()` 语料加 `ElemIface.def`(元素形态接口 + own `gadgetOwn`)+
  `interfaces/GadgetIface.def`(独有 `gadgetOnly`);断言 gadgetOnly 经元素
  形态条目折入 + 文本形态 ROLE 臂不回归。
- **TS 合成钉** `RUST-139 批 6:接口条目元素形态(合成语料内联钉)`:
  hand-constructed CorpusFile 三件(entities.xml + ElemIface.def +
  GadgetIface.def),镜像 engine 复算,gadgetOnly 落接口 def。

prove-red:model.rs 谓词临时还原(只跳注释)→ Rust 钉红(gadgetOnly 缺失,
left=[ElemIface.def] only),cp 还原复绿。TS 侧镜像钉修前
`getElementText` 取空白文本 → 空串 → 条目丢失,修复后取元素名,红绿同构。

`roots_are_entity_defs_only` 精确 root 表同步补 `ElemIface`(新 root)。

## 批 6 门禁

- `cargo test -p kode-server --lib workspace_symbols` 11/11(新钉 + 既有
  全绿);`cargo test -p kode-parser` 0(编译净);
- rustfmt 本批两文件净(`cargo fmt -p kode-parser -p kode-server`,不触
  kode-mcp 预存漂移);
- golden `workspace-symbols-parity.json` 重生成 `cmp` **逐字节不变**;
- vitest `tests/kodeWorkspaceSymbolsParity.test.ts` 5/5(4 对拍 + 1 合成钉);
- tsc 0;eslint 本批文件 0。

## 结案

RUST-139 全部子项收口(批 1–6),todo.md 整行勾销。
