# RUST-140 批 3:textDocument/signatureHelp LSP 接线(签名决策核 → 服务面)

日期:2026-11-20
todo.md 行:`RUST-140 （旧 LSP-007） SignatureHelp / parameter hints 使用类型 IR,不单独实现一套解析`(批 3 = signatureHelp 的 LSP 服务接线 + TS provider 切流)
本批边界:**签名帮助的调用点归属 + def 声明解析 + 签名组装接到 LSP 服务面 + TS 薄壳切流**。批 1(`python_call_at.rs` 调用点词法核)+ 批 2(`signature_help.rs` 签名决策核,`a0e92c7c`)之上的接线批。**决策核零改**;**组件槽展开(componentSlotName +30 分支)不属本面**——`componentSlotName` 是 entityMapping 属性身份面的组件槽展开,signature_help 候选面本批不含 `componentSlotName` 字段(批 2 已如实登记),该面留 TS 注册表车道;`MethodImplementationProvider` 不接(IDE-NAV-014,同 RUST-143 边界);**vscode.SignatureInformation/ParameterInformation/MarkdownString 构造归 TS 薄壳**。

## 服务端臂(`crates/kode-server/src/server.rs`)

顶层 `handle_request_inner` 新增 `textDocument/signatureHelp` 分派;参数反序列化败 → `-32602`;未开档/光标不在调用点/无匹配声明 → 成功响应体 `null`(LSP 允许,provider 出空)。

```
initialize 协商 → capabilities.signature_help_provider = true
signatureHelp: 位置行文本 → get_python_call_at_position(调用点归属,批 1 纯库)
              → HoverEngine::signature_help(owner 链闭包 + 接收者段硬闸,批 2 决策核)
              → clamp_active_parameter(activeArgument, 形参数)(零形参恒 0)
              → {"signature": SignatureHelpFace, "activeParameter": n}
```

- 应答 `signature` 面四件:`label`(`def onTalk(self, arg1: int, arg2: str)`)/`parameters`(逐形参标签)/`documentation`(三段拼接)/`definition{file, line(1 基), section, exposed}`;`activeParameter` 与 face 平级(位置相关,随光标移动变);
- 链 = 批 1 `get_python_call_at_position` 与批 2 `HoverEngine::signature_help` 直调,服务端不引新解析面;
- 诚实边界:`corpus_defs`/`entities_dirs` 依赖语料 ingest(与 hover 同一份 HoverEngine),本臂不另建索引。

协议三锁链:`SignatureHelpParams` 进 kode-protocol → dump bin 根字段 → `protocol.schema.json` → `src/generated/protocolTypes.ts`;`signature_help_provider` 进 `ServerCapabilities`;`tests/protocolContract.test.ts` 对真二进制观测的 capability 键集加入 `signatureHelpProvider` 并钉 `true`。

## TS 桥(`src/backend/kodeCoreShadowFaces.ts`)

- `serveSignatureHelpFromRust(document, position, isCancelled?)`:**文档类门**——只在 `.py` 文档放行(signatureHelp 的 TS provider 本来就 python 专属,非 .py 零请求);
- 先 `mirrorDocument` 再 `serveInRust('textDocument/signatureHelp', {textDocument, position})`,走既有 `awaitWithInteractiveBudget` 预算闸;
- 回包整面校验 `isSignatureHelpResultFace`:`signature` 四件逐键 + `definition` 四键 + `activeParameter` 非负整数,任一畸形 → `null` 不部分采用;应答 `null`(该位置无签名)透传为 `null`,由 provider 回 TS 链同判;
- 非服务轨道/未装配门/取消位先判 → `null` 零请求。

## provider 切流(`src/languageProviders/hover.ts`)

`KBEngineSignatureHelpProvider.provideSignatureHelp` Rust-first:python 文档 + manager 在场门后**先**请求 Rust 面;命中即薄壳直构 `vscode.SignatureHelp`(face.label → `SignatureInformation`,parameters 逐条 `ParameterInformation`,documentation 整串 `appendMarkdown`(Rust 拼接与 TS appendMarkdown 逐字节一致,已对拍),`activeParameter` 平级直取);Rust 面 null(无门/门关/取消/应答畸形/serve 抛错)→ 落回既有 `getPythonCallAtPosition` + `resolveMethodDefinition` 链,零行为回退。`raceWithBudget('signatureHelp:def-method')` 预算闸与无 manager 门原样保留在回退链上;**入口版本基线在任何 await 之前捕获**(方法首行 `const version = document.version`),Rust 命中臂与 TS 回退臂共用同一基线复查——见判例 6。

## 集成门禁(`crates/kode-server/tests/signature_help_dispatch.rs`,8 用例)

initialize 广播 `signatureHelpProvider`;正臂 CellMethods 双形参签名(label + parameters 逐条 + `definition.section/line` + documentation 接收者注记 + activeParameter 1);零形参臂(activeArgument 越界必须夹到 0,不报 1);接收者段硬闸(cell 脚本调 `self.base.onBaseOnly` → 段不符剔除 → null);未声明方法无跨 def 回退(非接口文件 → null);光标不在调用点 → null;未开档 → null;非法参数 → `-32602`。

`definition.line` 由 fixture 自推导(`def_line_of("<onTalk>")`),不硬编码行号,改 fixture 不漂。

## 判例账(本批判例)

1. **Rust `\` 行续符吞掉续行首部空白** → 正臂全空之谜:fixture `AVATAR_PY` 用 `"…\n\` + 续行缩进书写,`\<newline>` 会连续行首部的空格一并剥除,入库文本变成 `self.cell.onTalk(1, 2)`(缩进消失)→ `python_call_at` 走通用臂判非段接收者 → 段闸/本域匹配全落空,正臂恒 null 而**负臂全绿**(假绿)。python 缩进 fixture 一律 `concat!` 逐行拼,不用行续符。
2. **读实况别心算**:集成断言首版写 `arg2: string`,真值是 `arg2: str`(STRING 注解经 `resolve_annotation_direct` 解析为 `str`)。位置敏感/注解解析的期望值一律先跑一次读真实输出再钉。
3. **语料入库依赖 entities.xml**:`owner_chain_paths` 靠 `defs_root`(向上找含 `entities.xml` 的目录登记 `entities_dirs`)折算 `{entities_dir}/entity_defs`,而 `corpus_defs` 只在 didOpen → ingest 后入档。fixture 三档必须齐开(entities.xml + Avatar.def + 调用点 .py),缺一链断在 `defs_root`/`corpus_defs`,正臂空而负臂照常绿。
4. **`ServerState` 字段全 pub = 集成探针可白盒直取引擎**:`state.hover.borrow().signature_help(...)` 直接对拍,把「handler 路径」与「引擎状态」切开定位——本轮正是靠它一次辨清「引擎已有完整语料,空响应来自 handler 之前的一条早退臂」。
5. **探针不能用响应空判入库成败**:`hover(entities.xml)` = Null 只代表该文档无悬停内容面(`<root/>` 无属性),不代表 entities.xml 未入库;入库成败要用引擎白盒直取或语义面(如 definition/正臂)判定。

## prove-red(接线钉非空)

- 变异①(TS):桥回包校验放宽(`isSignatureHelpResultFace(result)` → `result !== undefined`)→ 「应答畸形 → 整面作废」10 例中唯一变红,其余 9 例不动;
- 变异②(Rust):dispatch arm 恒回 `null` → 两个正臂(label/parameters/activeParameter 双键)红,六个负臂不动。
两变异各自独立红、`cp` 字节还原后复绿(8/8 Rust + 10/10 TS)。

## 门禁基线

- `cargo test -p kode-server -p kode-protocol` 全套件 0 failed(signature_help_dispatch 8/8、code_action_dispatch 11/11 回归照绿);`cargo clippy -p kode-server -p kode-protocol --all-targets -- -D warnings` 0;
- rustfmt 本批文件净:新文件 `signature_help_dispatch.rs` 直接 rustfmt 净;`kode-protocol/src/lib.rs`、`dump-protocol-schema.rs` 整文件 rustfmt 0 diff;`server.rs` 在案预存漂移(HEAD 即 12 处 dirty)——按红线只 scratch 提取本批 hunks 验证(handler 块 0 diff,并把 params-match 对齐 `handle_prepare_rename` 既有惯式),**未动全包 fmt**;
- `tsc -p tsconfig.json --noEmit` 0;eslint 本批四文件 0;
- `tests/kodeSignatureHelpRust.test.ts` 10/10(桥契约 6 + provider 切流 4);`tests/protocolContract.test.ts` 10/10(真二进制 spawn,`signatureHelpProvider` 钉 true)。

## 诚实边界(不勾主体外的面)

- **组件槽展开(`componentSlotName` +30 分支)未完成**:signature_help 候选面本就无 `componentSlotName` 字段,组件槽展开归 entityMapping 属性身份车道(Rust 端 `entity_mapping`/TS 注册表面),本批如实登记为余量;
- **注册表快照链留 TS**:`resolveMethodDefinition` 走 entityMapping 运行时索引,provider 回退链原样保留(RUST-144 同边界),Rust 面不可用时行为与切流前逐字节一致;
- **MethodImplementationProvider 不接**(IDE-NAV-014 空方法生成,同 RUST-143 边界);
- **documentation 文案归 Rust 拼接**(与 TS appendMarkdown 逐字节一致),zh bundle 不经 en 插值串,故不需 TS l10n 重组;
- 活动形参标亮的**触发面**(括号/逗号触发、SignatureHelpTriggerKind)属 VSCode 请求侧行为,服务端只按位置回包,不在本面。

## 结案(2026-11-21)

RUST-140 收口:批 1 调用点词法面(2026-11-16 30e8d6c6)+批 2 决策核
(resolveMethodDefinition 同构下沉,2026-11-19)+批 3 LSP 接线/provider 切流
(2026-11-20 db5691e9)全部完成;本面(类型 IR 驱动的 SignatureHelp)无剩余
实现工作。剩余三项均为诚实边界,不属本面:

- **组件槽展开 componentSlotName +30 分支**:signature_help 候选面无
  `componentSlotName` 字段,归 entityMapping 属性身份车道(TS 既有 +30 分支
  保持,不经 Rust signature_help 面迁移);非本面交付。
- **注册表快照链留 TS**:`resolveMethodDefinition` 走 entityMapping 运行时
  索引,provider 回退链原样保留(RUST-144 同边界),Rust 面不可用时行为与
  切流前逐字节一致;设计如此,非缺口。
- **MethodImplementationProvider 不接**:IDE-NAV-014 已收口(todo 行已勾),
  空方法生成归该面,非本面。

复验:signature_help_dispatch 8/8 + kodeSignatureHelpRust 10/10 全绿,
零代码改动(仅结案注记)。todo.md RUST-140 整行勾销。
