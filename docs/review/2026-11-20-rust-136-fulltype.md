# RUST-136 增量②:hover fullType 完整类型面(2026-11-20)

任务:RUST-136 增量②——types.xml FIXED_DICT 字段名/ARRAY 元素经根内声明表递归展开为可读全文,进 hover 签名数据面。批1(comment/facets)之后的第二个缺口收口;todo 注册原文:「完整类型(types.xml FIXED_DICT 字段名需 kode_parser TypeDecl 模型扩展)」。版本面缺口不在本批(引擎版本供给链归 RUST-113 域接线)。

## 模型扩展(kode-parser)

- `TypeDecl` 增 `fields: Vec<TypeField{name, directive, of_ref}>`:FD 分支逐 `Properties` 子收名 + `<Type>` 指引首 token + `<of>` 元素文本(与 field_refs 同源;仅有 Type 子的属性入册;属性式条目回落口径与既有一致)。
- `PropertyDef` 增 `of_ref: Option<String>`:属性 `<Type>` 的 `<of>` 元素文本(ARRAY 属性)。
- 两字段均**不进 parser golden**(directive 先例):dump_types/dump 属性面零改动,def-parity/kode-types/kode-mcp 既有 golden 不动。

## hover 面(kode-server)

- `HoverSignature` 新键 `fullType`(serde camelCase,恒在键;`type` 键之后)。
- 声明表 `root_types_table`:根内(KBUG-ROOT path_roots 归属)types.xml 按路径字典序(BTreeMap 键序)同名**首见**;悬停项可能被同根更早声明遮蔽——对拍两侧同表同判据。
- 展开算法(递归深度护栏 `FULL_TYPE_MAX_DEPTH=3`,≥3 按原文 token;防环/防爆炸):
  - FD → `FIXED_DICT { 名: 展示, … }`(逗号+空格分隔;字段 ARRAY 带 of → `ARRAY<of 展开>`,无 of → `ARRAY`;其余 token 递归展开);
  - ARRAY → `ARRAY<元素展开>`(element_ref 缺席 → 原 token);
  - 内建/表缺席/空 FD → 原 token。
- 两消费面:
  - **def 属性**:token=ARRAY 走 `<of>` 元素展开(起算深度 1,内层 FD 在深度 2 展开——比 token 直展开浅一层,两镜像同判据);其余 token 深度 0 直展开。展开=原文(内建/缺席/ARRAY 无 of)→ null;ARRAY 带 of 恒有展开(`ARRAY<of>` 即使 of 不可解析也比裸 `ARRAY` 多信息)。
  - **types.xml 声明本体**:声明名深度 0 展开;展开=声明名(builtin 条目)→ null。
- markdown 渲染:`**Full Type**` 行(属性面紧随 `**Type**`;types.xml 面紧随 `**TypeKind**`)。注:属性面此前与 TS getSymbolHover 逐字节同的口径仅覆盖 Type→Flags→… 六行序,本行是 Rust 侧增面(TS 生产 hover 未跟;对拍面=golden 数据面,非 markdown)。

## 对拍与 golden

- TS 镜像(tests/kodeHoverParity.test.ts 内复算,不 import 生产 parseTypesXml):`buildTypeTables` 全量语料**一次建表**传入 `computeHovers`(逐文件重算调用传子集语料——若在函数内建表会丢同根其余 types.xml 声明,与引擎整表口径漂移);`expandTypeToken`/`fullTypeOfProperty` 与 Rust 同算法同常数。
- golden 再生:`cargo run -p kode-server --bin dump-hover-golden -- . > crates/kode-server/tests/golden/hover-parity.json`;30 文件/107 悬停数不变,6 条 fullType 非空:
  - demo `Avatar.def :: skillSlots → ARRAY<FIXED_DICT { slot_list: ARRAY<UINT32>, count: UINT32 }>`
  - demo `components/Inventory.def :: items → ARRAY<ITEM_ID>`
  - demo `types.xml :: SKILL_SLOT / POSITION → FIXED_DICT {…}`、`ITEM_IDS → ARRAY<ITEM_ID>`
  - parity-project `Avatar.def :: bag → ARRAY<UINT32>`
- 门禁:eslint(src+测试件)/tsc -p .//tsc mocha/全量 vitest 11251 绿/cargo test 四 crate(parser/server/mcp/types)140 测试二进制绿/clippy -D warnings 绿/rustfmt(本批文件)净。

## prove-red(两咬)

- 咬 A(Rust 侧牙):`root_types_table` 置空表 → golden 再生 → parity 红(skillSlots golden=`ARRAY<SKILL_SLOT>` 裸展开 vs 镜像=`ARRAY<FIXED_DICT {…}>`)。复原后 golden 与正确版**字节同一**(cmp 验证)。
- 咬 B(TS 镜像牙):`expandTypeToken` 恒返原 token → parity 红(同一 skillSlots 条目反向失配)。复原后 4/4 绿。

## 坑与判例

- **深度起算错位**:属性 ARRAY<of> 起算深度 1,内层 FD 在深度 2 展开(比声明面浅一层)——单测期望字符串先两次按「深度 0 全展开」手写而红,以实现+镜像一致口径修正(算法先钉死,期望跟着算法走,两侧同判据)。
- R2 字段清单门(rstR2IndexInventory):model.rs 加字段=红,同笔把 of_ref/fields 入册 docs/review/2026-10-29-r2-index-inventory.md(该门的设计意图即「API 漂移同笔改清单」)。
- 下游 TypeDecl/PropertyDef 构造点全在 #[cfg(test)](kode-mcp semantic_model ×2/kode-server semantics types·rpcargs·snapshot·cell),`fields: vec![]`/`of_ref: None` 机械补齐,非测试面零改动。
