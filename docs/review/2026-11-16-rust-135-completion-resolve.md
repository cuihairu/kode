# RUST-135(旧 LSP-002)Completion resolve 延迟补详情 + snippet/sortText/filterText 收编

日期:2026-11-16
todo:todo.md RUST-135(旧 LSP-002)
提交:feat 见 todo.md 勾行 hash

## 设计定案

**结构化对拍面零变化**:CompletionItemFace/CompletionResponse 与 golden
completion-parity.json(862 items 严格 JSON.stringify 双向对拍)完全不动——
全部新能力下沉在 LSP 投影层(`to_lsp_items`)与新增 `completionItem/resolve`
处理器产出。golden 免重生成,TS parity 镜像免改。

### LSP 投影(`crates/kode-server/src/completion.rs`)

`to_lsp_items(response, root: RootId)`(仅 server.rs:739 一处调用):

- `sortText` = 零填充响应序 `format!("{:04}", seq)`(序锁:客户端有 sortText
  不按 label 重排,锁声明序/链序);`filterText` = label;
- snippet:仅 `context.kind ∈ {"self","module"}` 且 `item.kind ∈ {"method",
  "function"}` → `insertTextFormat=2` + `insertText = "name($0)"`;
- `data` = `resolve_data_face(...)`:按 context.kind × item.kind 判 source——
  entity→`{source:"entity",name,path}`;type→`{source:"type",name,typeKind}`;
  alias→`{source:"alias",name,target}`;module→`{source:"module",name,
  process,signature}`;property|method→`{source:"def",root(root u32),name,
  entity,facet,inheritedFrom,typeKind}`。

### resolve(`resolve_item`,lib.rs 导出)

按 `data` 复算文档面(类型/Flags/默认/签名/分面/来源 def 路径),零 IO、只碰
已入库语料视图;def 成员经 `corpus_def_for_entity` 定位(RUST-134 收编面),
继承成员用 `inheritedFrom` 定位祖先 def;归属歧义/语料缺位/载荷不可判 →
**输入原样返回**(不装空文档,LSP 允许)。文档面 `documentation={kind:
"markdown", value}`。

### 协议面

`CompletionOptions` 加 `resolve_provider: bool`(camelCase → resolveProvider,
initialize 能力广播);dispatch 臂 `completionItem/resolve`(params=None →
INVALID_PARAMS;cancellable 注册/检查同族)。

### TS 装配

- `kodeCoreShadowFaces.ts`:`LspCompletionReportFace` 加 sortText/filterText/
  insertText/insertTextFormat/data 字段;`LspCompletionResolveFace`;新增
  `serveCompletionResolveFromRust`(门无/轨道关/无 data → null;documentation
  非 string → null,诚实缺位不上抛);
- `completion.ts`:`rustResolveData = WeakMap<CompletionItem, {label,detail,
  data}>(进程内对象引用直存,不挂私有字段);`lspCompletionToVscode` 直设
  sortText/filterText,`insertTextFormat===2` → `new vscode.SnippetString`;
  `resolveCompletionItem`:WeakMap 命中(Rust 条目)→ serve 面 → documentation
  装 MarkdownString;未登记(TS 条目)原样返回零 Rust 调用;失败不抛;
- `languageServices.ts`:inline provider 对象加 `resolveCompletionItem` 委托;
- `tests/fake-vscode/core.ts`:加 `SnippetString` + CompletionItem
  sortText/filterText/insertText 字段(mocha 烟测同源,加法性)。

## 测试清单

Rust:completion_units.rs +6(lsp_projection_locks_order_and_emits_def_resolve_data
/lsp_projection_py_self_and_module_method_items_get_snippets/resolve_enriches_def
_property_and_inherited_member_documentation/resolve_enriches_method_signature_and
_facet_documentation/resolve_enriches_type_alias_entity_documentation/
resolve_without_usable_payload_echoes_input_unchanged);completion_dispatch.rs +3
(initialize_advertises_completion_resolve_provider/completion_resolve_roundtrip
_enriches_documentation/completion_resolve_without_payload_echoes_input)。

TS:protocolContract.test.ts 钉 resolveProvider=true;kodeCompletionServing
.test.ts +4(sortText/filterText/snippet 透传/resolve 补 documentation/TS 条目
零调用/失败原样返回);kodeCoreServingE2E.test.ts py self 用例内追加 resolve
往返(真二进制:hp 条目 → completionItem/resolve → documentation 含 `**hp**`/
`UINT32`/`entity_defs/Avatar.def`,sortText 序锁/data 真值)。

## prove-red(四靶,cp 备份+变异+cmp 字节还原)

1. **摘 server.rs dispatch resolve 臂**(match 串改死臂)→ dispatch 2 红 +
   E2E resolve 断言红;
2. **摘 to_lsp_items data 嵌入**(`data=Null`)→ units 5 红 + dispatch 1 红;
3. **摘 TS rustResolveData.set 登记** → serving 1 红;
4. **摘 lspCompletionToVscode sortText 映射** → serving 1 红。
四靶全红全还原,还原后 suites 全绿复跑确认。

## ANCHORS 锚点锁步

本批在 languageServices.ts(inline provider 对象 +5,位于 :128 打点之后)与
completion.ts(import +1/WeakMap 块 +9/lsp 面 +12/resolve 方法 +26)前部位移
→ perfCallChainDoc ANCHORS 表四点真位重探 204/277/344/745→209/282/349/750、
provideCompletionItems 1086→1134;docs/perf/2026-baseline.md 出处注记 +
mermaid 现势节点(:209/:282/:349/:750/:1134)同步锁步。

## 门禁

cargo clippy --workspace --all-targets -D warnings = 0;cargo test --workspace
RC=0;pnpm lint 0;pnpm compile 0;vitest 全量 10348 passed + 8 skipped RC=0
(首轮 1 红 = perfCallChainDoc ANCHORS 漂移闸,真位重探后全绿;非负载抖动);
xvfb-run -a npm run test:demo:editor 25 RC=0。

## 诚实边界

- TS 既有链条目 documentation 保持 provide 时 eager 装配(TS 链延迟化重构不在
  本批);TS 条目 resolveCompletionItem 原样返回、零 Rust 调用;
- resolve 失败/语料缺位不装空文档——输入原样返回(LSP 允许);
- type/alias 面文档不含来源路径(多 types.xml 合并,路径归属歧义,只述
  kind/指向);
- 结构化对拍面(golden completion-parity.json 862 items)零变化,本批不重生成;
- `serveCompletionResolveFromRust` 只认 documentation.value 为 string 的回执
  ——其余形态一律 null(诚实缺位),不构造伪文档。
