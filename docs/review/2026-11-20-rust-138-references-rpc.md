# RUST-138 批 3:textDocument/references LSP 接线(位置面 → 服务面)

日期:2026-11-20
todo.md 行:`RUST-138(旧 LSP-005) References:跨 root 实体/方法/组件/类型,区分语法同名和真实语义引用。`
本批边界:**位置面(position face)接到 LSP 服务面 + TS provider 两处切流**。批 1(8682caec 位置面纯库+golden)与批 2(c22feb18 语义分类面)之上的接线批。**语义分类切流(`semantic_reference_locations` 把 Shadow/Dangling 剔出结果集)是产品决策面,按任务令不擅自切**——本批切的是与 TS 现行为逐点同构的语法位置面(含同名站点,TS 同口径)。

## 服务端臂(`crates/kode-server/src/server.rs`)

顶层 `handle_request_inner` 新增 `textDocument/references` 分派(与 definition 同形):参数反序列化败 → `-32602`;未打开/未知符号/空结果 → 成功响应体 `null`(LSP 允许)。

```
initialize 协商 → capabilities.references_provider = true
→ CanonicalUri::parse → root_for → DocumentKey → drain_index_for_request
→ open_buffer(未打开 → null)
→ HoverEngine::references(&key, &text, line, character, context.includeDeclaration)
→ Some(locations) → 序列化数组 / None → null
```

`ReferenceParams { textDocument, position, context: ReferenceContext { includeDeclaration } }` 进三锁链(`context`/`includeDeclaration` 均 `serde(default)`:客户端可只送文档+位置,缺省 = 不含声明);`references_provider` 进 `ServerCapabilities`;`tests/protocolContract.test.ts` 对真二进制观测的 capability 键集加入 `referencesProvider` 并钉 `true`。

面语义(引擎零改,批 1 核直用):
- **def 面**(`provideDefSymbolReferences` 语料半边同构):光标在 Type/Arg/of 值→类型目标、Parent 值→实体目标、`<Interfaces>` 直挂 wrapper→接口目标;`includeDeclaration=true` 时前置声明位(types.xml 行首/实体 def 文件首行)+全语料站点位,dedup 键 decl=`file:line`、site=`file:line:start`(TS 同);**站点位=零宽区间** `(line,start)`(TS `new vscode.Position(site.line, site.start)` 同形);
- **types.xml 面**(`provideTypesXmlReferences` 同构):同根 types 已声明的自定义类型名→全语料引用位,**无声明位**(includeDeclaration 不生效,TS 同);
- 内建类型/容器字面/不可解析目标 → `null`(不虚构);
- **诚实边界(arm 文档注释)**:Properties/方法段的属性 self 访问与 Python 调用点面归 entityMapping 运行时索引(TS),Python 文档本面恒 null。

**语料依赖判例(本批新钉)**:Parent 目标解析靠 `entity_defs_root`,而 `defs_root` 的 entities 目录登记**只在 `entities.xml` 入库时发生**(`hover.rs:691`)——集成测试漏开 entities.xml 时 Parent 面 null 而 Type 面照绿(高度误导);首跑三例红全由此。语料四件套(def×2 + types.xml + **entities.xml**)缺一即漏面,测试注释内已写明注册条件。

## TS 桥(`src/backend/kodeCoreShadowFaces.ts`)

`serveReferencesFromRust(document, position, includeDeclaration, isCancelled?)`:服务轨道 + 语料文档门(def + 三类 XML;Python 零请求直通 TS)→ 先 `mirrorDocument` → `serveInRust('textDocument/references', {textDocument, position, context})`(2000ms 交互预算 + 50ms 取消探测)。应答整面校验:非数组或任一条目缺 string uri / LSP 区间 → `null`,不做部分采用。

## provider 切流(`src/languageProviders/references.ts`)

`KBEngineReferencesProvider.provideReferences` 两处消费点,均为「Rust 命中 → 直接返回;null → 回 TS 既有实现」:

- **types.xml 分支**(IDE-NAV-017):Rust-first → `provideTypesXmlReferences` 兜底;
- **def 语料分支**(IDE-NAV-018,`findDefSymbolInfo` 失败处):Rust-first → `provideDefSymbolReferences` 兜底。

Properties/方法段/python 数据字典/spaceData/cellData/self 属性访问各分支**原样不动**(entityMapping 运行时面不在 Rust 面)。`lspFaceToVscodeLocation`(navigation.ts,definition 面既有适配器)转 export 复用——uri 规范路径 → `vscode.Uri.file`,零宽区间原样投影。

## 钉子

**Rust**(`crates/kode-server/tests/reference_dispatch.rs`,12 例,走真 `handle_request` 全链):能力协商/initialize 前被拒/Parent 值 → 声明先行+站点(Monster.def 文件首零宽 + Avatar Parent 值位,站点恒零宽)/缺省 context ≡ 显式 false/自定义类型值 → 含 types.xml 声明位+def 站点位/types.xml 面 → 单站点无声明(显式 true 也不多出)/内建 UINT32 → null/不可解析 Parent → null/Python 文档 → null(诚实边界钉)/未开档 → null/参数畸形 → `-32602`/didClose 后回 null。

**TS**(`tests/kodeReferencesRust.test.ts`,8 例):桥契约(载荷带 `context.includeDeclaration` 且 true/false 分明;无门/非服务/python → null 零请求;畸形六臂整面作废;取消先置零请求);provider 切流(golden `references-parity.json` 前 3 个有站点 def 条目 + 1 个 types 条目,读真盘文本同输入,逐点深等 Rust 面,且 **entityMapping 运行时面零调用** = 真来自 Rust;故意漂移面 `RUST_ONLY_MARKER` 原样出镜;serveError → 回 TS 且与无门基线同树——基线用临时小工作区真算,非空结果深等,非 null≡null 空转)。

## prove-red

seam 旁路(`rustReferenceLocations` 强制 null)→ 三条 Rust 命中钉全红(golden def 面/types 面/漂移面),cp 还原复绿。能力声明/分派臂由 12 例 dispatch 钉与 protocolContract 真二进制键集钉覆盖;golden `references-parity.json` 逐字节不变(`kodeReferencesParity` 3 例照绿,位置面引擎零改的回归证据)。

## 门禁

- `cargo test -p kode-protocol -p kode-server`:109 suite 全 ok,1494 tests(含新增 reference_dispatch 12 例);clippy `-D warnings` 0;
- rustfmt 仅本批文件净(server.rs 以 scratch 副本 fmt 后 diff 验认:本批新增行零分歧,他批遗留漂移不回灌——禁全包 fmt);
- `tsc` 0;eslint 本批文件 0(`inferPipeline.ts`/`aliasAssist.ts` 两条既有红属他席车道);
- vitest 定向 13 文件 106 例全绿(references 全族 + protocol 双锁 + 属性/receiver/graph/dirty 面);全量 951 文件 / 11400 passed / 7 failed——7 条与 HEAD 净检出对照完全相同(他席 `kbengine.infer.*` 在途面,见 2026-11-20-rust-139 批 3 记录),本批零引入;
- 本批零发布动作:无版本号 bump、无 tag、无 Release。

## 余账(批 4+)

- `semantic_reference_locations` 产品拍板后:Shadow/Dangling 剔除切换(面已在 Rust,`serveReferencesFromRust` 换参即可);
- RUST-139 workspaceSymbol LSP 接线、RUST-140/141/143 各面接线、嵌套属性符号面(parser 模型扩展)。