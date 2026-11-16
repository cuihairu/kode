# RUST-139 批 1:DocumentSymbol 语料面下沉 Rust(验收纪实)

日期:2026-11-16
todo.md 行 400:`RUST-139(旧 LSP-006)DocumentSymbol / WorkspaceSymbol 提供快速搜索与稳定排序。`
本批边界:**DocumentSymbol(IDE-NAV-005)纯 def 解析面**。WorkspaceSymbol(IDE-NAV-006)依赖 entityMapping 运行时语义索引(ResolvedDefinitionSemantics 继承链/组件 rebase),留批 2。

## 架构

- 新模块 `crates/kode-server/src/document_symbols.rs`:纯函数 `document_symbols(text) -> Option<Vec<DocumentSymbolFace>>`(零引擎状态——单文档面,无需 HoverEngine 语料视图)。
- 语义钉(TS KBEngineDocumentSymbolProvider 逐点同构):
  - `to_section_name` 8 规范段名精确匹配(大小写敏感,小写变体不算)→ 按 DEF_SYMBOL_SECTIONS 只出 Properties/BaseMethods/CellMethods/ClientMethods;Parent/Interfaces/Components/Volatile 与未知段不进 Outline;
  - 段符号 kind = Properties→Struct / 方法段→Class;段内**直接**元素子节点 = Field/Method;成员不再下钻(TS `new vscode.DocumentSymbol` 默认 `children=[]`,方法内 `<Arg>` 等不产生符号);
  - range = 元素全跨度(开标签头 → 闭合标签尾;自闭合到开标签尾,`ElementData.open_span/close_span/self_closing` 直取);selectionRange = 开标签整体跨度(恒 ⊆ range);detail 恒空串;序 = 文档序;空段照出(段符号无条件 push);解析无根 → None;
  - 位置换算复用 definition.rs `byte_offset_to_position`(0 基行 + UTF-16 列,VS Code positionAt 同语义)。
- golden:`crates/kode-server/tests/golden/document-symbols-parity.json`(22 def files / 104 symbols,含空段与四段全形态),生成器 `dump-document-symbols-golden` bin;只收 def 文件(TS provider 只注册 defDocumentSelector)。

## TS 镜像

`tests/kodeDocumentSymbolsParity.test.ts`:自足复算(不 import 生产模块),逐文件逐符号深等对拍同一 golden。3 例:语料同集(def 文件序)/逐文件 deep-equal + symbolCount 合计钉/护栏(kind 与段归属一致 + 成员 children 恒空 + selectionRange ⊆ range + detail 空串)。

## prove-red(双端四靶)

- Rust T1:段过滤闸死(`is_symbol_section` 恒 true)→ `section_filter_and_kinds` 红 + golden 重生成红;
- Rust T2:kind 对调(Properties↔方法段)→ 单元红;
- TS MUT1:golden 段 kind 翻转 → deep-equal + 护栏双红;
- TS MUT2:镜像成员递归下钻(children 非 [])→ deep-equal 红;
- 全部 cp 还原 + cmp 字节一致 → 复绿(unit 6/6,golden 2/2,镜像 3/3)。

## 单元钉(6 例,合成文本)

section_filter_and_kinds / member_children_always_empty(Arg 不下钻)/ ranges_full_vs_selection_and_self_closing(解析器真值锚定:`</Properties>` 13 字符终位、自闭合=开标签尾)/ detail_empty_and_empty_section_kept / no_root_returns_none / text_children_are_not_symbols(只元素子节点)。

## 过程坑(纪实)

- golden 尾字节双换行:dump 函数误加 `push('\n')` 而 bin 的 `println!()` 已补一换行 → committed=JSON+`\n\n`,trim 后与函数输出差 1 字节;diff_at 定位失真(zip 无分歧 → `unwrap_or(0)` 报"偏移 0"),真差异在尾字节。修正 = 对齐 references 惯例(函数返纯 JSON,换行只由 bin 加)。
- 磁盘满(100%)打断编译两次:rustc-LLVM IO failure;清 `target/debug/deps` 内 >2 天陈旧 hash 副本(kode_server 迭代累计 69G)+ incremental 后恢复。

## 诚实边界

- `textDocumentDocumentSymbol` / `workspace/symbol` LSP 接线本批未做(同 references 批 1 口径:server.rs/rpc.rs 有并发在途变更,只落纯库,生产服务面仍是 TS);
- WorkspaceSymbol 全面(ResolvedDefinitionSemantics 索引复算 + 前缀查询 + rootName·section 容器名)留批 2;todo 行不勾,只补批 1 进度注。

## 门禁(2026-11-16)

- cargo test -p kode-server 全量:1107 ok / 0 failed,RC=0
- cargo clippy -p kode-server --all-targets -- -D warnings:0
- pnpm lint 0 / pnpm compile 0
- pnpm test:unit:848 文件 10363 过 + 8 skip(较上批 +1 文件 +3 例 = 本镜像)
- xvfb-run -a npm run test:demo:editor:25 passing RC=0
- 提交前 lib.rs diff-vs-HEAD 逐块核对 = 仅本批 hunks
