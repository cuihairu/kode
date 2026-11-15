# RUST-108 验收:.def 方法元数据(参数/返回类型/分面/调用权限)

日期:2026-11-16。验收对象:todo.md RUST-108(旧 SEM-006)「`.def` 方法参数、返回类型、Cell/Base/Client methods、Property flags 与调用权限元数据」。

## 1. 判据词 → 实现面映射

| 判据词 | 实现面 | 语义 |
|---|---|---|
| Cell/Base/Client methods | kode-parser `DefFile.base/cell/client_methods`(既有)+ kode-types `methods.rs` `MethodMeta{entity, facet, name, ...}` 注册表 | 三段逐方法登记,段序 = def 文件段序(稳定);出处携带灌入上下文(root/version,provenance 同口径)+ 声明 site(name_span + 1 基行) |
| 方法参数 | `MethodMeta.args: Vec<MethodArg{text, type_refs}>` | parser 新字段 `arg_type_refs`(逐 `<Arg>`,collect_type_refs 同口径:ARRAY/FIXED_DICT 指令剥离 + `<of>` 文本);**引擎 RPC 参数无具名,如实不造参数名**;指令独占 Arg 产空 ref(元素类型不在标量文本内,如实);`args` 原文口径不变(parity 面零扰动) |
| 返回类型 | parser `MethodDef.return_type: Option<String>` + `MethodMeta.return_type` | def `<ReturnType>` 直文本声明(TS definitionSemantics `getScalarChildValue` 同口径;canonical_tag 归一识别 `Returntype` 等遗留拼写);缺/空 = None 如实。def 格式无返回值网络序列化,该声明供 inlay/导航消费,Python 推导居 RUST-PRECISION 面(localReturnType/returnAnnotations 已落),两者互补不混流 |
| Property flags | kode-parser `PropertyDef.flags/flags_raw`(既有,规范化 token 顺序保留) | 已由 parser 承载、defAnalyzer/CELL-08 各面消费,方法模块不重复建模(methods.rs 模块doc 显式登记) |
| 调用权限元数据 | `MethodMeta.exposed` + 分面 + `exposed_methods(entity)` 查询面 | `Exposed` truthy + 分面是权限事实:Base/Cell 分面 Exposed = 客户端可调(引擎 exposedMethods);Client 分面 = 服务端→客户端方向,不因无 Exposed 而缺席——事实记录在 IR,解释居消费面(模块doc 显式) |

## 2. 关键语义保证

- **两新 parser 字段不进 parser golden**(TypeDecl.directive 先例):parity JSON(`{name,args,exposed,line}`)与 TS kodeParserParity 复算面零扰动——fixtures_golden 全绿即证;`args` 原文口径逐字节不变;
- **注册时机**:add_def 灌入时 `record_methods` 登记;同名实体重复 add_def 整体跳过(节点 first-write-wins 同口径)→ 无重复方法条目(测试钉);
- **与既有面并存**:同一图上 RUST-104-W 节点形态、RUST-105 出处锁步、RUST-108 方法面互不干扰(共存测试钉);
- **消费面零破**:kode-server 全量 979 绿。

## 3. 锁步与测试

- **R2 索引清单同笔锁步**:MethodDef 字段变化触发 `tests/rstR2IndexInventory.test.ts` 逐名对账红(字段清单漂移=红,设计如此)——`docs/review/2026-10-29-r2-index-inventory.md` §2 行与 §4 缺失面行同笔改为七字段事实(仍无消息编号/段落外信息),4/4 绿;
- 新测试:kode-parser `tests/method_meta_units.rs` 4 例(return_type 提取/缺·空 None/遗留拼写/逐 Arg refs 三形态)+ kode-types `tests/methods_units.rs` 4 例(分面注册+元数据透传+出处/exposed 跨分面枚举/重复实体不重复/三面共存);
- prove-red 三靶(cp 备份 + cmp 字节还原):① 撤 record_methods 调用 → methods_units 4 例全红;② 撤 returntype 臂 → return_type 提取钉红;③ exposed 提取翻转 → exposed 枚举钉红。

## 4. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test:kode-types 34 绿(30+4)、kode-parser 130 绿(126+4,golden 零扰动)、kode-server 979 绿、其余三 crate 203 绿 / rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 10332+8skip 全绿(含锁步修复后)/ xvfb demo 25 RC=0。

## 5. 结论

判据词全落:方法参数(原文+类型引用)、返回类型(声明直文本,诚实缺省)、三段分面(注册序稳定+出处)、Property flags(既有承载显式登记)、调用权限(Exposed+分面事实面)。整行 `[x]` 勾账。
