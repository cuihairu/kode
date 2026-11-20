# RUST-143 批 3:textDocument/codeAction LSP 接线(四族装配面 → 服务面)

日期:2026-11-20
todo.md 行:`RUST-143 CodeAction 包含创建缺失定义、修复参数类型、定位冲突、调整 include/registry`(批 3 = 装配面 LSP 服务接线 + TS provider 切流)
本批边界:**四个 CodeAction provider 的装配决策(修参数类型/创建缺失定义/receiver-none 守卫双动作/FIXED_DICT 整体重赋)接到 LSP 服务面 + TS 薄壳切流**。批 2(`code_action_assembly.rs` 四族装配纯库 + golden)之上的接线批。**MethodImplementationProvider 留 TS**(IDE-NAV-014 空方法生成走 EntityMappingManager 异步运行时索引,无 Rust 决策输入,不硬塞);**registered 近拼宇宙(getKnownTypeContext)与 parity 目标 python 快照(readSharedFileSnapshot)是 TS 装配入参**,经 RPC 参数传入,服务端不自己长这两个宇宙;**vscode.CodeAction/WorkspaceEdit 构造与 l10n 标题插值归 TS 薄壳**。

## 服务端臂(`crates/kode-server/src/server.rs`)

顶层 `handle_request_inner` 新增 `textDocument/codeAction` 分派;参数反序列化败 → `-32602`;未开档 → 成功响应体 `null`。

```
initialize 协商 → capabilities.code_action_provider = true
codeAction:  family ∈ {typeReplacement, parityMethod, receiverNone, fixedDict}
           → 单族装配(决策核四 assemble 直用,零改)
           → ActionFace 描述符数组
unknown family → -32602(枚举入参诚实拒绝,不静默空数组)
```

- 诊断入参 `CodeActionDiagnostic { code, range, relatedFile, relatedMessage }`(camelCase),TS 侧由 vscode.Diagnostic 投影;`registered: Vec<String>`(typeReplacement 近拼宇宙)/`snapshotText: Option<String>`(parity 目标 python 文本)按族消费,其余族忽略;
- **titleParams 按族定序**(本批关键设计):`ActionFace` 增列 `title_params: Vec<String>`——typeReplacement=`[候选名]`;parityMethod=`[方法名, 目标文件, 1 基展示行(字符串化)]`;receiverNone=`[receiver]`;fixedDict=`[]`。TS l10n 薄壳**按族选模板、按位插值**,不让 en 插值标题绕过未来 zh bundle(Rust 面的 `title` 字段仅作诊断参考,生产标题由 TS 重组);
- EditFace 三态不变(replaceRange/insertLine/replaceLines,serde tag=type + camelCase;replaceLines 的换行烘焙语义承批 2)。

协议三锁链:`CodeActionParams`/`CodeActionDiagnostic` 进 kode-protocol → dump bin 根字段 → schema → `pnpm gen:protocol`;`code_action_provider` 进 `ServerCapabilities`;`tests/protocolContract.test.ts` 对真二进制观测的 capability 键集加入 `codeActionProvider` 并钉 `true`。

## TS 桥(`src/backend/kodeCoreShadowFaces.ts`)

- `serveCodeActionsFromRust(document, {family, range, diagnostics, registered, snapshotText}, isCancelled?)`:**族×文档类门**——typeReplacement/parityMethod 只在 .def 文档放行,receiverNone/fixedDict 只在 .py 文档放行,未知族拒绝(不猜);
- 回包整面校验 `isCodeActionFace`:kind/title 字符串 + EditFace 三态逐键(file/range/newText/line/text/startLine/endLine)+ diagnosticStartLine 数字 + titleParams 字符串数组,任一畸形 → `null` 不部分采用;
- 输入面 `CodeActionDiagnosticParam` 是**已投影形状**(relatedFile/relatedMessage 直给),vscode.Diagnostic → 入参的投影(`diagnosticParamOf`,provider 侧)与桥解耦。

## provider 切流(`src/languageProviders/codeAction.ts`)

四 provider 一律 Rust-first(四族各一次请求,镜像 TS 侧四 provider 结构):

- **KBEngineTypeCodeActionProvider**:registered 由 getKnownTypeContext 装配传入;face → `Replace with registered type {name}`(titleParams[0])+ replaceRange TextEdit;
- **KBEngineDefPythonParityCodeActionProvider**:**单快照契约**——过滤后全部诊断指向同一目标 python 文件才走 Rust(多目标文件逐诊断快照是 TS 逐例回退车道,防把 A 文件快照灌给 B 文件的插入点计算);snapshotText = readSharedFileSnapshot(打开缓冲区优先);face → `Generate method {name} → {file}:{line}`(三槽皆串)+ insertLine 跨文件插入;
- **KBEngineReceiverNoneGuardCodeActionProvider**:face → wrap(replaceLines)`Wrap with null guard (if self.{receiver}:)` + guard(insertLine)`Insert None guard (if not self.{receiver}: return)`,序=Rust 装配序(包裹式首选);
- **KBEngineFixedDictWholeReassignCodeActionProvider**:face → replaceLines + 固定标题(titleParams 空);
- **诊断配对 `pairedDiagnostics`**:face.diagnosticStartLine → 同行诊断桶**按面序 1:1 顺配,面多于诊断钳位复用首条**——receiver 族两面对同一诊断,不落空也不串行;
- 四方法改 async(vscode ProviderResult 允许),取消令牌入口先判 + 传入桥 + await 后复查;
- TS 回退臂(门关/族×文档类不匹配/应答畸形/serve 抛错)原路径零改。

既有测试补 `await`(provider 面 async 化):receiverNoneGuardQuickFix / kodeCodeActionAssemblyParity / behaviorKnowledgePipeline / defUnknownTypeQuickFix / cov-languageProviders。

## 集成门禁(`crates/kode-server/tests/code_action_dispatch.rs`,11 用例)

initialize 广播 codeActionProvider;typeReplacement 正臂(距离闸后单候选 + titleParams)+ 异码负臂;parityMethod 正臂(骨架插入文本含 def/raise/-> None + titleParams 三槽)+ 定位面缺失负臂;receiverNone 包裹式+早退式双动作(receiver 区间归属)+ 方法名 token 不相交负臂;fixedDict 三行习语;未知 family -32602;未开档 null;非法参数 -32602。

## 判例账(本批判例)

1. **titleParams 行号是字符串不是数字**:Vec<String> 序列化 `"9"` 而非 `9`,集成测试期望写 `9` → 红(left `"9"` right `9`)。按位插值协议里行号形态是字符串位,断言按 JSON 实际形态写。
2. **prove-red 扰动落空 = 坏样本没走到被钉守门臂**:畸形回包首版用单对象样本,而线面是数组——`!Array.isArray(result)` 在 face 校验**之前**就 null 掉,守门臂没被咬。prove-red 红不了先查样本路径是否真经过被钉判断(坏 face 必须裹在数组里)。
3. **桥输入面与 provider 投影面解耦**:桥契约测试直接喂 relatedInformation 形状 → 相关位全 null(桥消费的是已投影的 relatedFile/relatedMessage)。投影是 provider 的职责(`diagnosticParamOf`),桥不认 vscode 形状。

## prove-red(接线钉非空)

- 变异①:桥校验放宽(`isCodeActionEditFace(face.edit)` → `face.edit !== undefined`)→ 「应答畸形 → 整面作废」红;
- 变异②:标题插值错位(typeReplacement 取 titleParams[1])→ 「l10n 标题插值」红。
两变异各自独立红、还原后 12/12 绿。变异①首版红不了引出判例 2,补数组样本后闭环。

## 门禁基线

- `cargo test -p kode-server` 全套件绿(code_action_dispatch 11/11,code_action_assembly golden 3/3);`cargo clippy -p kode-server -p kode-protocol --all-targets -D warnings` 0;
- rustfmt 本批文件净(assembly/protocol/dump bin/server 0 diff;dispatch 新文件直接 rustfmt;server.rs 预存漂移红线——只 scratch 提取本批 hunks 验证);
- `tsc -p tsconfig.json --noEmit` 0;eslint 本批文件 0;
- vitest 全量 954 文件:**11437 passed + 8 skipped,仅 7 个已知基线失败**(configMarkdownDescription×3 / docsCommands×1 / cancellationTokenBatch3×1 / extensionWorkspaceGate×2,与本批改动面无交集,与批 2 同基线);新 kodeCodeActionRust 12/12;protocolContract(真二进制 spawn)绿;
- golden 重生成:code-action-assembly-parity.json +titleParams 列(20 行),3/3 对账绿;protocolTypes.ts/schema 重生成,protocolSchema 三级对账绿。

## 诚实边界(不勾主体外的面)

- MethodImplementationProvider(IDE-NAV-014)不接:EntityMappingManager 异步运行时索引无 Rust 决策输入;generate 空实现的 revalidate command 链留 TS;
- registered/snapshotText 宇宙归 TS 装配入参,Rust 服务端不建 types.xml/实体清单索引(那是 completion/快照服务面);
- l10n 标题模板与插值留 TS(zh bundle 不经 en 插值串);
- 诊断发布(diagnostics producer)与 code 路由不在本面——本批消费 context.diagnostics,不产诊断。
