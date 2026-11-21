# RUST-141 批 2:textDocument/rename + prepareRename LSP 接线(def 重命名面 → 服务面)

日期:2026-11-20
todo.md 行:`RUST-141 def rename(NAV-008/009/010, AUD-061/AUD-027)`(批 2 = rename/prepareRename LSP 服务面接线)
本批边界:**def 面(符号解析/同文件冲突/闭包占名预检/目标+后代编辑复算)接到 LSP 服务面 + TS provider 切流**。批 1(`def_rename.rs` 纯库 + golden)之上的接线批。**python self 访问/receiver 调用改写(entityMapping 车道)与全部漂移守卫(NAV-010 手势账、AUD-027 四道复核)留在 TS 侧**——那是运行时索引面,不在 Rust 决策核内。

## 服务端臂(`crates/kode-server/src/server.rs`)

顶层 `handle_request_inner` 新增 `textDocument/prepareRename` 与 `textDocument/rename` 两分派;`request_document_text` 助手(documentSymbol/references 臂的 open_buffer 前奏收敛复用)。参数反序列化败 → `-32602`;未开档/光标不在可重命名符号 → 成功响应体 `null`(LSP 允许)。

```
initialize 协商 → capabilities.rename_provider = true
prepareRename: offset 换算 → resolve_rename_symbol_at_offset
             → {range:(start,end), placeholder} | null
rename:       resolve → find_def_rename_conflict(NAV-008,行 1 基)
            → find_def_rename_conflict_in_closure(AUD-061,祖先+后代闭包)
            → 双冲突皆空才 compute_def_rename_edits(AUD-046)
            → {conflict, closureConflict, fileEdits} 三键
```

**三键面协议(本批关键设计)**:冲突位**不阻塞应答**——`conflict`/`closureConflict` 与 `fileEdits` 同帧返回,由调用方决定抛错文案与时机。这把用户可读文案串留在 TS 侧(l10n 边界),Rust 只出结构化判据;`fileEdits` 仅在双冲突皆空时非空(编辑语义不与冲突语义混帧)。

- 编辑位为 LSP `(line,character)` 区间,各行按**文件自身文本**换算(`utf16_offset_to_position`,0 基行;目标文件按 open buffer 文本,后代文件按其各自文本——TS `getLineCharacterAtOffset(fileEdit.text, …)` 同构,不许借目标文档行表);
- 冲突面 `DefRenameConflict { surface, name, line(1 基), filePath:Option }` serde camelCase 直出(`filePath` → LSP 面 string|null);
- prepareRename 面 `{range, placeholder}`,range = 符号名跨度(开/闭标签 name 区间,非整个标签);
- **诚实边界(arm 文档注释)**:闭包预检与后代发现走盘上语料(`find_entity_defs_root_from_file` 向上走查 entities.xml + 递归列 def,决策核既有行为);跨文件文本先查服务端已同步文档(open buffer 优先,与 TS `readSharedFileSnapshot` 同语义)再落盘读。

协议三锁链:`PrepareRenameParams`/`RenameParams`/`ReferenceParams` 进 kode-protocol → dump bin 根字段 → schema → `pnpm gen:protocol`;`rename_provider` 进 `ServerCapabilities`;`tests/protocolContract.test.ts` 对真二进制观测的 capability 键集加入 `renameProvider` 并钉 `true`(20/20 绿,含真 spawn)。

## TS 桥(`src/backend/kodeCoreShadowFaces.ts`)

- `servePrepareRenameFromRust(document, position, isCancelled?)`:def 文档门 → mirror → `textDocument/prepareRename`;`null` 合法透传(= 光标不在符号上),其余形状由 `isLspPrepareRenameFace` 整面校验;
- `serveRenameFromRust(document, position, newName, isCancelled?)`:def 文档门 → mirror → `textDocument/rename`;三键面逐键校验(冲突面 surface/name/line/filePath 形状、fileEdits 每条 filePath:string + edits:区间数组),任一畸形 → `null` 不部分采用。

## provider 切流(`src/languageProviders/rename.ts`)

- **prepareRename**:手势重置(同步,先于任何 await)→ Rust-first → face 的 range/placeholder 直投影(`vscode.Range` 直接按 face 行列构造,不借 TS 行表)→ null 回 TS `resolveRenameSymbolAtOffset` 既有路径。方法从同步改 async(vscode `ProviderResult` 允许 thenable;既有两处测试补 `await`)。
- **provideRenameEdits**:Rust-first → `conflict` 有值抛 NAV-008 文案(串与 TS 回退臂逐字同)→ `closureConflict` 有值抛 AUD-061 文案(带 filePath basename)→ 双空则按 face 逐文件装配 `WorkspaceEdit`(rust 位已是行/列,无需行表换算)。**python 改写尾(`applyPythonRewrite` 私有方法,rust 臂与 TS 回退臂共用)**:NAV-010 手势输入记账 → entityMapping self 访问/receiver 调用追加编辑 → AUD-027 四道复核(取消/目标版本/依赖 def/python 源漂移)原样保留。
- TS 回退臂(非 .def 门/无门/应答畸形/serve 抛错):findDefRenameConflict → findDefRenameConflictInClosure → computeDefRenameEdits → 行表换算装配,原路径零改。

## 集成门禁(`crates/kode-server/tests/rename_dispatch.rs`,11 用例)

initialize 广播 renameProvider;prepareRename 命中(区间+占位名)/不命中(null);rename 未初始化拒;目标+后代双文件编辑(Parent Hero 闭包,按路径升序,开/闭标签名跨度);同文件冲突面(Properties,1 基行,fileEdits 空);闭包冲突面(filePath=Monster.def);**open-buffer 优先于盘读**(Monster.def overlay 多一行注释,编辑位按 overlay 行换算);未开档 null;两臂非法参数 -32602。

## 判例账(本批三判)

1. **并行测试共享临时目录**:首版 `make_workspace()` 用 `process::id()` 后缀,同进程并行测试共享一目录——一例的 `cleanup_workspace` 删掉另一例正在走查的盘面,症状=后代文件静默消失(不是发现逻辑坏)。加 AtomicU32 序号各用独立目录。
2. **属性判重按域位相交**:闭包冲突 fixture 首版 vigor 无 `<Flags>` → 域位空集恒不相交 → 恒 null(与 in-file 冲突不同,in-file `find_def_rename_conflict` 对同面占名无条件报)。引擎判重矩阵(defAnalyzer/scriptdef_module.cpp 同语义)在 closure 预检走 `member_conflicts` 域位相交;fixture 补 `<Flags> BASE </Flags>` 双侧才红转绿。
3. **光标/行号手工数错两回**:`<` 字符占一列(名字跨度从 `<` 后起)、Monster.def 的 `<Parent>` 行计入行号——两次红都是期望值算错而实际值正确。锚定法:先打印实际编辑位再对期望,勿心算。

## prove-red(接线钉非空)

- 变异①:prepareRename 臂不消费 Rust 面(placeholder/坐标替换死值)→ 「Rust 面命中 → prepareRename 出 Rust 候选」红;
- 变异②:rename 臂编辑位不消费 face 行列 → 「WorkspaceEdit 按 face 装配」红;
- 变异③:桥校验放宽(三键面不验形状)→ 「应答畸形 → 整面作废」红。
三变异各自独立红、还原后 11/11 绿。

## 门禁基线

- `cargo test -p kode-server` 全套件绿(rename_dispatch 11/11);`cargo clippy -p kode-server/-protocol --all-targets -D warnings` 0;
- rustfmt:本批新增函数/臂 standalone 格式化零 diff;server.rs/def_rename.rs 既有漂移(~86 行)未触碰(禁全包 fmt 红线);
- `tsc --noEmit`(主工程 + tsconfig.mocha)0;eslint 改动文件 0;
- vitest 全量 11425 绿,7 红与本批前 detached-HEAD 基线逐一相同(configMarkdownDescription×3/docsCommands/extensionWorkspaceGate×2/cancellationTokenBatch3,均为 infer.enabled·stubCopy·watcher 既有债);
- protocolSchema + protocolContract(真二进制)20/20 绿。

## 结案(2026-11-21)

RUST-141 收口:批 1 def 重命名四纯面(2026-11-16)+批 2 集成批
(2026-11-20 rename_dispatch 11/11,prepareRename/provider 切流/闭包冲突/
open-buffer 优先)全部完成;rename 全工作区可编辑范围分析 + 同名符号冲突
面无剩余实现工作。余两项均为诚实边界:

- **python self 访问改写面**:`applyPythonRewrite`(NAV-010 手势输入记账 +
  entityMapping self 访问/receiver 调用追加编辑 + AUD-027 四道复核)在 TS
  已是生产路径,rust 臂与 TS 回退臂共用同一私有方法;非欠账。
- **preview 合成面**:rename preview 合成(VS Code WorkspaceEdit 已提供原生
  预览)未见需求方,不改不装(如实登记)。

复验:rename_dispatch 11/11 全绿,零代码改动(仅结案注记)。todo.md
RUST-141 整行勾销。
