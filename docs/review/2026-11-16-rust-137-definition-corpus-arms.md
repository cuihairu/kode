# RUST-137 第一增量:Definition 语料面四臂 + gate 对齐

日期:2026-11-16
账本:todo.md RUST-137(旧 LSP-004「Definition / Declaration /
TypeDefinition:`.def` ↔ `types.xml` ↔ `.py` ↔ 引擎源码」)。
本批交付 def/types.xml 语料落点四臂,Rust 与 TS 生产链 gate 对齐;
`.py` 落点、implementedBy 符号行、引擎源码落点留续批(见诚实边界)。
产品面事实:TS 只注册 DefinitionProvider(config/def/def+语料/python 四路,
activate/languageServices.ts),无独立 Declaration/TypeDefinition provider
——账本三方法名按产品现实收敛为 definition 单方法全链。

## 落地面(kode-server definition.rs)

1. **`<Arg>` 取值词 → 语料内同名实体 def 首行**:光标在
   `<Arg> MailBox </Arg>` 的 MailBox 上 → `def_candidates(root)` 同根
   定域唯一候选 → def 首行;歧义/无候选 → null(不硬猜)。
2. **`<Interfaces>` 段内词 → `<defs_root>/interfaces/<word>.def` 首行**:
   段内任一后代元素跨度(含起止标签)触发;fs 存在性检查语料化为
   corpus_defs 判定(TS interfacesRoot = entityDefsRoot/interfaces 单规则
   同构)。TS layout 的 interfacesRoot/componentsRoot 恒 =
   entityDefsRoot 子目录,Rust 侧新 `entity_defs_root` 折算
   (`{entities_dir}/entity_defs` 且语料有其下 def 才算)。
3. **`<Type>`/`<of>` 取值词回落补全**:types 声明未命中时回落
   component → entity(`category_def_landing`:先
   components/<word>.def,语料无再 def_candidates 唯一候选)——对齐
   TS findTypeValueDefinitionReference 的 components→entity 顺序。
4. **types.xml `<Type>` 取值词**:嵌套 FIXED_DICT 字段值词 → 本文件
   顶层声明行(findTypeValueDefinitionInTypesXml 触发面;该 TS 分支
   不经 findDefinitionReferenceInDef,故无 gate,声明词臂同函数)。

**gate 对齐**:TS findDefinitionReferenceInDef 顶部
looksLikeEntityName(!builtin && /^[A-Z][A-Za-z0-9_]*$/)统一拒
Parent/Type/Arg/Interfaces 四臂;Rust 同口径 `looks_like_entity_name`,
既有 Parent/Type 臂补挂(小写词 TS 生产 null,Rust 曾单侧落点,本批
收回)。builtin 防御双层:gate + 各臂内 is_builtin_type。

## golden schema 变更 + 探针修复

探针从 (line, word) 升为 GoldenProbe{line, character, word}(排序
(line, character, word) 全序 + dedup;GoldenDefinition 增 character 键
)——char=0 的旧探针使位置判定臂在 golden 语境从不触发。新探针:

- 全树 `<Type>`/`<of>`/`<Arg>` 取值词首词列(value_token_probe);
- `<Interfaces>` 段内元素的**内容首词**(生产触发面);
- types.xml 全树 `<Type>` 取值词首词列。

**探针 bug(本批抓出并修)**:Interfaces 探针初版取元素名@`<` 列
(word=`interface`),被 gate 拒 → 该臂 golden 不可见(58 条时零
Interfaces 条目),且杀臂变异不翻红——与「靶 B(Arg)不翻红」同族
掩蔽。修为取值词后 golden +3(Avatar.def:4 'ROLE' →
interfaces/ROLE.def;TrainingAvatar/TrainingMonster 'TRAINING_ACTOR'
→ interfaces/TRAINING_ACTOR.def),总 54 → 61(+7:Type/of 4 +
Interfaces 3),零移除。

## 行为冗余发现(非缺陷,如实登记)

category_def_landing 的 components 半边在现语料/测试上被 entity 半边
完全覆盖:def_by_name 注册全语料 def(含 components/interfaces 目录),
同名唯一候选两分支同落点——「禁用 components 半边」变异 golden 无
diff。保留(语义分层正确、语料扩充后可分化),prove-red 换靶。

## 对拍与测试

- golden `definition-parity.json` 再生成(30 files/61 definitions);
  `definition_golden_matches_regenerated_dump` 绿;TS
  `kodeDefinitionParity.test.ts` 独立复算 61 条深等(含 character,
  ExpectedDefinition 增键;列算术逐位一致:Rust content_span(byte)→
  byte_offset_to_position(UTF-16),TS contentStart(JS UTF-16 索引)→
  offsetToPos(surrogate 记 2))。
- definition_units +11 钉:Arg 命中/gate builtin null/无语料 null/
  歧义 null/Interfaces 命中/缺接口 null/Type 回落 component/Type 回落
  entity/小写 gate null/types 嵌套取值落本文件声明/types 回落
  component/implementedBy 词 null 能力边界。34/34 绿。

## prove-red 六靶(cp 备份 + python 变异 + cmp 字节还原,全闭环)

①Rust type_value_landing 恒 None → golden 红;②Rust
interfaces_segment_landing 恒 None → golden 红(探针修复前此靶亦不
翻红——探针 bug 即掩蔽源);③Rust arg_value_landing 恒 None →
units Arg 钉红(golden 语料无 Arg 落点,见下);④Rust gate 恒 true →
units 小写钉红(builtin 另有臂内 is_builtin_type 双层);⑤TS mirror
typeValueLanding 恒 null → parity 红;⑥TS mirror Interfaces 臂恒
null → parity 红。还原后全绿。

## 诚实边界

- **golden 语料无 Arg 落点**:四语料全部 `<Arg>` 取值为 builtin
  (UINT32/UINT16/UINT8/FLOAT/STRING/VECTOR3/ENTITY_ID)或非 def 名
  (ITEM_ID)→ Arg 臂在 golden 语境恒 null(0 条目),闭环在 units
  级(靶③)。扩语料会扰动共享 golden(hover/def 多条),不为此批动。
- **`.py` 落点未做**:def 属性/方法 → .py 类/方法(Products 面、
  方法实现行)留批 2。
- **implementedBy 符号行落点未做**:types.xml implementedBy 词 →
  .py 类声明行留批 2(本批 implementedBy 词 gate 拒,能力边界钉)。
- **引擎源码落点未做**:kbe 桩/引擎 C++ 符号不在语料域,维持现状。
- components 半边冗余(见上)。

## 门禁

clippy --workspace --all-targets -D warnings = 0;cargo test --workspace
RC=0(167 suites,definition_units 34/definition_golden 2);pnpm lint
0;pnpm compile 0;vitest 全量 845 文件 10348 + 8 skipped RC=0(含
kodeDefinitionParity 3 例);xvfb-run -a npm run test:demo:editor RC=0。
