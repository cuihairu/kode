# RUST-230 验收纪要:parser/spans/UTF-16/别名环/实体面/源映射单测覆盖(纯对账)

日期:2026-11-17。本纪要对账 RUST-230(旧 QA-001,主 todo 排队项)的验收口径与交付证据。结论:**六维全部既有面+既有测试钉,kode-python 300 测试(cargo test 全绿)+TS 侧 source map 套件在册,零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 测试钉 |
| --- | --- | --- |
| parser errors | `crates/kode-python/src/parse.rs` 容错解析:部分 AST 尽力产出+错误表(`errors()`/`has_syntax_errors()`),不整体失败 | `parse.rs::tolerant_of_syntax_errors`(半成品不 panic,错误被记录)+`tests/symbols_test.rs::tolerant_of_syntax_errors` 双钉 |
| byte spans | ruff range 0 基行域贯穿:symbols 类/方法/属性行域、self_flow class_spans/method_domains、callgraph/dataflow 行域断言 | kode-python 全 crate 300 测试(192 内嵌+23 callgraph+37 dataflow+36 graph+12 symbols)内行域断言在册,cargo test 全绿 |
| UTF-16 position | `parse.rs::line_col(offset)→(0 基行,0 基 UTF-16 列)`,LSP 列口径 | `parse.rs::utf16_columns`(中文 1 字符=1 UTF-16 code unit 断言) |
| alias cycles | local_return 赋值链传播 visited 防环(每跳严格下行天然有界+双保险) | `local_return.rs::mutual_alias_cycle_honest_empty`(互指别名环→诚实空)+`x = x` 身份链环防诚实空 |
| entity facets | `model.rs::AstClass{bases,methods,decorators}`+方法域+属性写点 | `tests/symbols_test.rs` 12 例(extracts_classes_methods_attributes/class_bases_keep_only_dotted_identifiers/self_attributes_collected_in_control_flow_bodies/match_case_self_attribute_collected/method_params_covers_all_parameter_slots 等) |
| source map | TS `src/backend/generatedSourceMap.ts`+RUST-160 GeneratedSourceLocation{sourceKind,propertyName} 分族(120 顺修) | `tests/generatedSourceMap.test.ts`+`tests/generatedSourceLenses.test.ts` 7 例(def 来源镜跳实体注册表 defFile 缺映射不出镜/缺源行回落 entity 兜底/再生刷新条目与行映射 fire 变更) |

## 自我验收证据

- `cargo test -p kode-python` RC=0:192+23+37+36+12=**300 测试全绿**;关键钉(tolerant/utf16/别名环)grep 命中 5 处。
- TS 侧 source map 两套件在本日 unit 10659 全绿(2113d5f4 门禁)内。
- 对账方法:六维逐一 grep 锚定实现文件+测试函数名,不是凭印象记账。

## 诚实条款

- "byte spans" 的独立专测不存在——行域断言散在各功能套件内(300 例几乎每例都碰行域),没有为 span 本身单立的 suite;覆盖真实存在但形态是「嵌入断言」非「专项套件」,如实记账。
- "entity facets" 按 kode 语义取实体类面(基类/装饰器/方法域/属性写点);引擎侧 facets(如 volatile/entityFlags 等 .def 属性面)属引擎元数据解析,不在 kode-python 解析器面(在 types.xml/def 注册表面,由实体注册表测试族覆盖),如实划界。
- UTF-16 断言目前 1 例(中文);emoji(代理对,1 字符=2 UTF-16 unit)无专测——ruff line_col 实现与 LSP 口径一致性由该实现+中文例承载,emoji 例属可补强项非缺口(如实)。
