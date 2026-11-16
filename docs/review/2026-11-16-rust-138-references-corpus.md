# RUST-138 批 1:References 语料面下沉 Rust(验收纪实)

日期:2026-11-16
todo.md 行 399:`RUST-138(旧 LSP-005)References:跨 root 实体/方法/组件/类型,区分语法同名和真实语义引用。`
本批边界:**References 语料面**(def 内类型名/实体名/接口名 + types.xml 符号的引用位扫描与声明落点)。entityMapping 运行时面(属性 self 访问、方法段实现、receiver 调用、python 键族)与 `textDocument/references` LSP 接线留批 2+。

## 架构

- 新模块 `crates/kode-server/src/references.rs`(~1130 行):复用 HoverEngine 语料视图,与 definition.rs 同构。
  - 入口 `references_at(key, text, line0, character, include_declaration)`;词在解析器内部自算(word_at_offset,ASCII \w,与 hover 的 Unicode 语义刻意不同——引用面按 TS wordAt 同构收窄)。
  - FileKind::Def → def_references;FileKind::Types → types_references(两者均忽略 includeDeclaration,与 TS 生产面一致);其余 None。
  - def 目标识别四臂(KR-AUD-77):①直挂 `<Interfaces>` 的四种 wrapper(interface/Interface/type/Type)值 → interface;②Type/Arg/of 值 → type;③Parent 值 → parent;④Interfaces 跨度 → interface。容器字面 ARRAY/FIXED_DICT 与空词拒。
  - types.xml 目标识别:顶层声明名(parent 链上一级 name == "root" 字面 && offset < content_span.start)+ Type/Arg/of 值内。
  - 引用扫描:Type 直挂文本(剔容器字面)+ Type 直挂 `of` 子 + Arg 直挂文本 + 游离 `of`(父非 Type);Parent 值;接口 wrapper 直挂 Interfaces 的值。token 定位 = 值区间空白切 token + indexOf 前进(idx==-1 或越 end 即断),站点 = (uri, line 0 基, start/end UTF-16)。
  - 声明落点语料化:custom type = 同根 types.xml 首见声明(path_root_of 过滤 + types_files 字典序)→ 行首;entity = `{entity_defs_root}/{name}.def` ∈ corpus → 文件头;interface = `{entity_defs_root}/interfaces/{name}.def` ∈ corpus → 文件头(缺失时接口站点照列、无声明位,与 TS 一致)。
  - dedup 键与 TS 同构:声明键 `uri:line`(无列),站点键 `uri:line:start`;includeDeclaration 且有声明时声明先行。
- HoverEngine 新增 `texts: BTreeMap<String,String>`(def/types 原文驻留):引用扫描需全文重扫,解析模型不含原文坐标。insert 在 BodyOnly 模型等价早退**之前**(模型同文本异——如注释增删——也必须刷新,引用位行号依赖原文);remove/invalidate_root 连带清除;跨模块经 `pub(crate) corpus_text/path_root_of` 访问器(definition.rs 四项可见性 pub(crate) 供复用)。
- golden:`crates/kode-server/tests/golden/references-parity.json`(30 files / 13 references),生成器 `dump-references-golden`(bin 同 dump-definition-golden 模式);探针集 = Parent/Type/of/Arg 值词(Parent 用值首 token 位)+ types.xml 顶层声明名(开标签名首)+ 全树 Type/of/Arg 值词;entities/alias 空占位。

## TS 镜像

`tests/kodeReferencesParity.test.ts`:自足复算(不 import 生产模块),用现有 defParser 原语逐文件逐引用位对拍同一 golden(与 kodeDefinitionParity 同构)。3 例:语料同集(文件序一致)/逐文件 deep-equal + referenceCount 合计钉/护栏(全部落点 uri ∈ 语料)。TS 侧 prove-red:golden 单点列位移 → deep-equal 红,还原 cmp 字节一致 → 复绿。

## prove-red(Rust 侧)

- T1:接口直挂闸死(`only_direct_interfaces_child` 改 false)→ interface_face 红(非直挂 wrapper 站点涌入)→ cp 还原 cmp 一致 → 12/12 复绿。
- T2:entity 站点序翻转(Parent/Type 收集对调)→ 首跑假绿(同文件两站点 URI 列表盲区)→ entity_face 断言强化为 (uri, line, character) 全三元 Vec 序钉 → 重做红 → 还原 cmp 一致 → 12/12 复绿。

## 单元钉(12 例,合成双根语料)

target_resolution_faces / type_face 同根声明 + 跨根站点 / builtin 无面 / 容器字面拒 / entity 面 Parent+Type 全三元序钉 / interface 面 wrapper 直挂 + 缺声明照列 / includeDeclaration=false / types.xml 面(含 of 引用)/ alias 无面 / token 重复定位 / BodyOnly 文本刷新 / remove 清 texts。

## 诚实边界

- `textDocument/references` LSP 接线**本批未做**:server.rs/rpc.rs 当前有并发会话在途变更,本批只落纯库(references.rs + 引擎 texts 驻留),生产服务面仍是 TS。批 2 接线时以本批 `references_at` 为 Rust 面。
- entityMapping 运行时引用面(属性/方法段/python 键族)批 2+,todo 行不勾,只补批 1 进度注。

## 门禁(2026-11-16)

- cargo test -p kode-server 全量绿(CARGO_RC=0,含 references_golden 2 例 + references 12 单元钉)
- cargo clippy -p kode-server --all-targets -- -D warnings:0
- pnpm lint 0 / pnpm compile 0
- pnpm test:unit:847 文件 10360 过 + 8 skip
- xvfb-run -a npm run test:demo:editor:25 passing RC=0
- vitest tests/kodeReferencesParity.test.ts:3/3
- 提交前 lib.rs/hover.rs/definition.rs diff-vs-HEAD 逐块核对 = 仅本批 hunks(semantics_golden 已在 HEAD,并发件零带入)
