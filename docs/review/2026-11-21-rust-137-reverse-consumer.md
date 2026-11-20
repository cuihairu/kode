# RUST-137 批 4:types.xml 声明词反边(声明 → 语料首个消费站点)

日期:2026-11-21
todo.md 行:`RUST-137(旧 LSP-004)Definition / Declaration / TypeDefinition:.def ↔ types.xml ↔ .py ↔ 引擎源码。`
本批边界:**`.def` ↔ `types.xml` 双向的回程**。正向(def 取值词 → types.xml 声明行)
2026-11-16 1ab8239c 已落;本批补反向(types.xml 声明词不再自跳,落语料内首个
`.def` 消费站点)。wire 形状零变化:仍单落点应答。

## 产品面裁定

| 面 | 裁定 | 理由 |
| --- | --- | --- |
| types.xml 声明词(词 + 行命中声明) | 落**语料内首个消费站点**(Type/Arg/of 值使用面),无消费回落本文件声明行(原自跳) | 声明词自跳零信息(`goto definition` 落回自己);todo 字面「↔」要求双向。消费站点按路径序首命中;同文件内引用位不选(types.xml 内部 `<of>` 引用自己文件的别名,落回同文件无导航价值) |
| 消费站点来源 | `semantic_reference_locations` 同源扫描(RUST-138 面),取首条跨文件位点 | 语义面同口径:跨 root 同名异声明 Shadow/Dangling 已剔除,不重复装一套定域规则;`include_declaration=false` |
| 落点列 | 消费站点 = 值词首列(Rust 语义面原样);回落臂 = 声明行行首 | 与 RUST-138 references 应答同形 |

**wire 面不变**:types.xml 声明词此前应答本文件声明行(单落点),本批应答消费
站点(仍单落点)。TS 命中臂(`serveDefinitionFromRust`)与 parity 镜像同步;
语料无消费时 Rust 命中回落臂,TS 链照旧不走。

## golden 探针升格(批 1 判例复用)

批 1 判例:位置判定型面在 golden 语境必须真正触发,否则杀臂变异不翻红。
types 声明词探针原 `character: 0` 落在 `<` 上,语义面符号解析不出,只走回落
臂 —— 反边臂 golden 不可见。本批 dump 探针升格**词首列**(行内首个 `<` 含自身
的 UTF-16 列,与 Rust `len_utf16` 累加同算术),TS parity 镜像同升
(`declarationNameCharacter`)。升格后 demo types.xml 五声明词全部真触发:

- `ITEM_ID`(8:2)→ `components/Inventory.def` 11:9(`<of> ITEM_ID </of>`;
  同文件 20 行 `<Arg> ITEM_ID` 位次之不选,types.xml:50 同文件 `<of>` 不选)
- `SKILL_SLOT`(14:2)→ `Avatar.def` 41:9(`<of> SKILL_SLOT </of>`)
- `ITEM_DESC` / `POSITION` / `ITEM_IDS`(语料无跨文件消费)→ 回落声明行
  (原自跳行为);parity 语料 `JSONDATA` / `PARITY_ID` 同回落

definitionCount 31 条不变(探针列升格不改落点集,仅两类落点列值变化;
批 1 的 61 是探针总数,落点 31)。

## 测试

- Rust `definition_units.rs` 36 例:`types_declaration_word_lands_on_line_start`
  改记回落臂口径;新增 `types_declaration_word_lands_on_first_consuming_def_site`
  (probe (1,2) → Avatar.def:4:10)与 `types_declaration_word_picks_first_def_in_path_order`
  (Mob.def 与 Avatar.def 同消费 → 路径序 Avatar.def 胜)。prove-red:反边臂
  变异恒假(cp+python 变异+cmp 字节还原)→ 恰两新例红(34/2),还原复绿
  36/36+golden 2/2。
- golden 锁:tests/definition_golden.rs 2 例绿(regen 后)。
- TS parity 镜像 tests/kodeDefinitionParity.test.ts:`firstConsumingSite`
  (corpus 数组序 = 路径字典序;def/types 两 kind 的 Type/Arg/of 值词;同根定域;
  本文件跳过;文件内先序首词位)+ `declarationNameCharacter`;3 例绿。
- E2E 真二进制 tests/kodeRustFirstDefinitionE2E.test.ts +3 例(⑤⑥⑦):
  `ITEM_ID` → Inventory.def `<of>` 行、`SKILL_SLOT` → Avatar.def `<of>` 行、
  `ITEM_DESC` 无消费回落声明行 —— 7/7 绿,prove 生产链(gate → mirror → Rust
  抢答)端到端出消费站点。

## 门禁

改动面 cargo test -p kode-server 全套件 0 failed(lib 843 / definition_units 36 /
definition_golden 2 / 其余集成套件全绿);`cargo clippy -p kode-server
--all-targets -- -D warnings` 0;vitest 全量**串行轮** exit 0(955 文件
11525 passed + 8 skipped,含 parity 3 例与 E2E 7 例);eslint 0;tsc main +
mocha 两配置 0。全量绿后单 commit 推 lane/kode3-lsp-wiring,main 不动。

判例补:一轮 vitest 全量曾 2 例假红 —— 该轮与 prove-red 的 cargo 重链并发,
RustFirst E2E 真 binary spawn 撞上 `target/debug/kode-server` 重链窗口;
排空并发后串行复跑全绿,**并发 cargo rebuild 与 vitest 全量不可同跑**
(coverage-98 ETXTBSY 判例同族,假红归因以串行轮为准)。
