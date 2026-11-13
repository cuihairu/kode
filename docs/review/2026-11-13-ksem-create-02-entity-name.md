# KSEM-CREATE-02 解析字面量实体名

**日期**:2026-11-13
**条目**:`todo.md` KSEM-CREATE-02 [P2]「解析字面量实体名。验收:补全/跳转实体名字并检验所需脚本部件;动态名称保持候选或未知。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 补全实体名字 | `NameArg::PartialPrefix(前缀)` → `Candidates{names}`(目录前缀匹配,排序输出;空集仍不是 Missing——前缀只是不完整信息) |
| 跳转实体名字 | `NameArg::Literal` → `Resolved{name, ..}`——名字落定后由消费方映射 def 文件(本模块持语义判定不持文件句柄,目录实现方可带文件位) |
| 检验所需脚本部件 | `Resolved{missing_facets, engine_gated}`:按创建族给所需 def 段(`required_facets`)——cell 族(CellEntity/CellEntityInNewSpace/cellapp 本地)要求 cell 段,baseapp 创建族要求 base 段;缺段分两档:**引擎硬闸**(InNewSpace 的 hasCell,baseapp.cpp:2523-2529 ERROR+静默 None)与**结构缺**(直连 createCellEntity 本调用点无 hasCell 闸 baseapp.cpp:3119-3145;baseapp 族/cellapp 本地引擎均不设硬闸)——engine_gated 非空可报确定错误,其余措辞自持 |
| 动态名称保持候选或未知 | `NameArg::Dynamic` → `Unknown`(动态判定**不依赖目录**,目录缺失不改变结论——判定次序前置);`PartialPrefix` → `Candidates`(候选) |
| (红线承袭)索引缺失显式说明 | 目录未就绪 → `IndexMissing`——**绝不判 Missing**(Literal 在无目录时拿不到「实体不存在」结论;PartialPrefix 在无目录时拿不到「无候选」结论,与 RPC-09 零影响红线同族) |

## 2. 引擎真值(逐行核过 ../kbengine)

- `createCellEntityInNewSpace`:**hasCell 硬闸**——`!pScriptModule->hasCell()` → ERROR 日志 + 静默返回 None(baseapp.cpp:2523-2529);
- `createCellEntity`(直连路径):本调用点只查「已有 cell」幂等 guard,**无 hasCell 闸**(baseapp.cpp:3119-3145)——cell 段缺失是结构判而非引擎拒;
- baseapp 创建族(Local/Remote/Anywhere/FromDbid ×2)建 base 实体,base 段结构必需,引擎不设硬闸;cellapp 本地 `createEntity` 建 cell 实体,cell 段结构必需,引擎不设硬闸(cellapp.cpp:472-530 只查 space 存在/关机);
- `kind==Local` 双义(挂载面 baseapp/cellapp):API 名相同、所需段不同——`is_cellapp_local` 显式分流,不让一处口径吃两面。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/entity_name.rs` | 新模块:`NameArg` 三形态(Literal/PartialPrefix/Dynamic)+ `EntityCatalog` 目录 trait(消费方从 def 索引实现;库面不持索引)+ `NameCheck` 五态(Resolved{missing_facets, engine_gated}/Missing/Candidates/Unknown/IndexMissing)+ `check_entity_name`(动态先判→目录闸→字面量解析/前缀候选)+ `required_facets`/`required_facets_cellapp_local`;测试 11 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod entity_name` 注册 + 模块文档 CREATE-02 条目 |

## 4. 测试纠偏(实现对、测试期望错)

1. `dynamic_and_partial_not_affected_by_catalog_presence`:初版把目录闸放在 match 之前——动态名被判成 IndexMissing;动态名不依赖目录,前置分流后 Dynamic 恒 Unknown(**测试抓出实现次序错,实现改**);

## 5. 诚实边界

- `EntityCatalog` 由消费方实现(快照/工程折叠面);目录覆盖不全时 `facets_of` 返回 None 会误判 Missing——消费方实现目录时应只登记**已解析**的实体集并用「目录就绪」位控制传 None/Some(库面契约:传 None = 索引未就绪,传 Some = 索引就绪且内容可信);
- 前缀候选不做模糊匹配(纯 starts_with),编辑距离/拼音类候选归消费批次;
- def 存在但 Python 脚本文件缺失(parts 的另一面)不在本批——`facets_of` 只答 def 段,脚本文件存在性归消费批次接线;
- `Resolved` 不携带跳转文件位:跳转是消费面动作,目录 trait 刻意只答段集(保持库面与索引实现解耦)。

## 6. 证据

- `cargo test -p kode-server --lib semantics::entity_name` 11/11(全段齐解析/InNewSpace 缺 cell 硬闸/直连缺 cell 结构缺/baseapp 族缺 base 结构缺/cellapp 本地双义分流/空 def 双向缺/字面量未知 Missing/无目录红线/动态 Unknown 不受目录影响/前缀候选排序+空集非 Missing/动态前置);
- **prove-red = 变异三发全咬合**:(1) 目录缺失当空目录(误判 Missing)→ 1 例红;(2) 抹 InNewSpace 硬闸标记 → 1 例红;(3) 动态名硬判 Missing → 2 例红;恢复 11/11;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 361 含新 11);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
