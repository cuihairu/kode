# KSEM-STRUCT-01 统一现有类型图与 wire schema（保真盘点 + 统一适配方案）

**日期**：2026-11-13
**条目**：`todo.md` KSEM-STRUCT-01 [P1]「统一现有类型图与 wire schema。验收：盘点字段名/数组元素/声明序保真差异，形成统一适配方案；不得用丢失字段名的扁平引用图代替布局。」
**口径**：本条 = 盘点 + 方案（纯文档批，零行为变更）；落地在 STRUCT-02..05/08 各批逐面执行。

## 1. 引擎真源（types.xml wire 布局）

KBEngine `datatypes.cpp` 口径（fixture 注释引证，`tests/fixtures/kbengine-demo-assets/scripts/entity_defs/types.xml`）：

- **FIXED_DICT**：条目标签=类型名；`<Properties>` 子元素=字段——**元素标签名=字段名=序列化键**；每个字段的 `<Type>` 子元素=类型文本（标量名/自定义类型名/内联 ARRAY 文本+`<of>` 子元素=元素型，`FixedArrayType::initialize` 从 Type 节点找 `<of>`）；**字段声明序=wire 布局序**；`<implementedBy>`=序列化实现对象（`MODULE.Symbol`）。
- **ARRAY**（顶层声明）：`<of>` 与文本指引同级=元素型；属性式 `type="ARRAY" of="X"`（kode 两侧已对齐，PR-012 门 §1.3-①）。
- 实证形状（SKILL_SLOT）：`slot_list` 字段=`ARRAY<UINT32>`（内联），`count` 字段=`UINT32`（标量）；POSITION=`x/y/z` 三 FLOAT。

## 2. 现有面盘点（五层）

| 层 | 字段名 | 内联数组形状 | 声明序 | 消费者 |
|---|---|---|---|---|
| TS `parseTypesXml`（compositionRoots.ts:137）→ `TypeDeclaration.fieldRefs: string[]` | **丢**（只收 Type 文本 token+`<of>` 文本，compositionRoots.ts:153-162） | 元素 ref 在、**ARRAY 形状丢**（slot_list 与 count 都记 `UINT32`） | 保 ✓ | `deriveCompositionRoots`→`resolveFieldClassSymbols`（implementedBy 符号展开，只需引用名，不需要字段名）——全仓唯一消费者 |
| TS `CustomTypeInfo.properties`（definitionWorkspace `getTypesXmlCustomTypeInfos`，:53-63） | **在**（`CustomTypePropertyInfo.name`） | **保**（`typeStructure` 结构树，2026-10-29 用户报 pyi `List[Any]` 后补的内联 `ARRAY<of>X</of>` 解析） | 保 ✓ | pythonTypeStubs（kbe_types 桩生成+`resolveFixedDictMember` 字段读/字典方法面）、entityTypeStubs、semanticIndex、behaviorLints |
| Rust `kode-parser` `TypeDecl.field_refs`（model.rs:603-609，注释明示「与 TS parseTypesXml 同口径」） | **丢** | 同 TS 低保真口径（`collect_type_refs` model.rs:331-349：文本 token+`<of>` 文本，形状不记） | 保 ✓ | kode-types 图构建、golden `fieldTypes` |
| Rust `kode-types` `TypeGraph::FixedDict{field_refs}`（graph.rs:31） | **丢** | 同上 | 保 ✓ | 图边解析（按类型名）、golden |
| Rust `semantics::SemType::from_type_graph`（semantics/types.rs:134-139） | **伪造**（`FieldDef.name`=类型文本：POSITION 变 `{FLOAT:FLOAT,FLOAT:FLOAT,FLOAT:FLOAT}`，x/y/z 不可辨） | 元素 ref 解析为标量型（无 Array 包裹） | 保 ✓ | 当前无 RPC 消费（KSEM-BAS `QueryRequest::TypeAt` 面待接线） |

辅助面：C-23 lint 的 `fixedDictRootPropertyNames`（behaviorLints.ts:104）覆盖的是 **def 直声明 FIXED_DICT 属性**的属性名，不是 types.xml 自定义类型字段名——不同面，不冲突；`databaseSchemaTypeStorage.topLevelKeys` 同为 def 属性名面。

## 3. 保真差异结论

1. **字段名**：TS 低保真面与 Rust 全链（parser→图→SemType）全丢；SemType 以类型文本伪造字段名（失真+同型字段不可辨）。TS 高保真面（`CustomTypeInfo`）是现存的唯一保真点。
2. **数组元素**：顶层 ARRAY 两侧保真 ✓；**字段内联 ARRAY 元素 ref 保、形状丢（两侧一致）**——该形状上 STRUCT-03 的下标面会把数组字段当标量（`slot_list[0]` 按标量 UINT32 推）。
3. **声明序**：全链保序 ✓（Vec/数组按 XML 文档序；wire 布局序=声明序）。
4. **跨侧一致性 ≠ 正确**：parity golden 锁的是低保真形状——**双侧一致的丢失**（SKILL_SLOT golden `fieldRefs:["UINT32","UINT32"]` 两字段同形不可辨）。parity 绿只证 TS≡Rust，不证 ≡引擎。
5. Range/组件槽/可空/联合：类型图无产生点（SemType 表达面已备），产生点=后续批（范围解析/组件槽/推导合流），不在本条范围。

## 4. 统一适配方案

**方向**：Rust 链补齐到引擎布局；TS 高保真面（`CustomTypeInfo`）作对拍参照；低保真面（`field_refs`/`fieldRefs`）保留给纯引用展开消费者（implementedBy 符号展开），不承载布局。

1. **kode-parser**：`TypeDecl` FixedDict 分支增 `fields: Vec<FieldDecl{ name, name_span, type_text, inline_of }> `（增量字段；`field_refs` 冻结旧口径保留，待消费面迁移后评估去留）；`dump_types`（json.rs）增 `fields` 键——`kodeParserParity.test.ts` TS 提取器与 `parityGolden` 同步，`dump-golden` 重生成 golden；
2. **kode-types**：`TypeGraph::FixedDict` 增并行 `fields`（存量 `field_refs` 不动）；边解析仍按类型名（fields 的 type 是名字，经 `by_name` 解析），字段名不进类型名空间；
3. **semantics/types.rs**：`from_type_graph` FixedDict 臂改用 fields——`FieldDef.name`=真名、`ty=resolve(type_text)`、`inline_of` 有值→`SemType::Array` 包裹；span 先 `None` 诚实（parser 侧 name_span 到图/查询面的传递在 STRUCT-02 接线时定）；新测试钉:POSITION 断言 x/y/z 三真名、SKILL_SLOT 断言 `slot_list=Array(Builtin(UINT32))`/`count=Builtin(UINT32)`；
4. **TS 对拍**：parity golden `fields` 与 `CustomTypeInfo` 抽样对拍（两侧独立解析同一 types.xml，字段名/序/内联形状逐项一致）——此闸 STRUCT-08 桩对齐复用；
5. **边界诚实**：字段名冲突（引擎行为落地批核源码定级）/空 `<Properties>`/`<Type>` 缺失→空 fields 或 Unknown reason，不造；多 token `<Type>` 文本（内联 ARRAY 指引+散字）按现有 token 过滤口径并记录;
6. **消费面**（STRUCT-02..05 落地批）：子键补全/跳转/读取类型/构造检查一律经 `semantics::query` 新 QueryRequest 变体，基于 `SemType::FixedDict{fields}` 真字段;wire 布局展示=fields 序。

**约束核对**：布局面由 `fields`（名+序+形状）承载——不以丢字段名的扁平引用图代替布局；`field_refs` 仅作为引用展开的存量通道。

> **2026-11-13（STRUCT-02 落地时的分侧处置，第 1-4 步的兑现归属）**：本条 §4 第 1-4 步是 **Rust 侧**补齐，其消费者是 STRUCT-04（缺键/多键/错型诊断）与 STRUCT-05（标量范围）——**诊断面**。而 STRUCT-02 要的是 IDE **交互面**（子键类型/补全/跳转），其数据源在 TS 高保真面 `CustomTypeInfo`（§2 第 2 行）已完备（字段名 + 内联 `ARRAY<of>` 形状 + 声明序俱在），不必等 Rust。故 STRUCT-02 先按 §2 第 2 行落地 TS 三面（`src/backend/fixedDictSubscript.ts` 纯核 + 补全/跳转/悬停三臂），Rust 第 1-4 步（含 parity golden 增 `fields` 键、`kodeParserParity` 同步、`dump-golden` 重生成）留给 STRUCT-04/05 批与 STRUCT-08 桩对齐一并兑现。分侧依据与引擎真源核（`FixedDict : script::Map` 无 `tp_getattro` 字段直通 → 引擎面=字符串下标+dict 方法）见 `docs/review/2026-11-13-ksem-struct-02-fixed-dict-subscript.md`。

## 5. 验收对账

- 盘点 ✓：§2 五层逐层保真差异（含行号证据）+ §3 四条结论；
- 统一适配方案 ✓：§4 六步（含 golden/对拍同步、边界诚实、消费面归属）。

## 6. 门禁

纯文档批：零代码变更（无门禁面）；文档对账=本文档 + `todo.md` 勾行。STRUCT-02 起每批按现行全门禁（lint/tsc/unit/cargo/clippy/对拍/dump-golden）执行。
