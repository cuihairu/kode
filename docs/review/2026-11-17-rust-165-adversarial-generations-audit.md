# RUST-165 审计结案:import 循环、自定义 alias、容器递归、同名类、重名实体和重复 root 测试

日期:2026-11-17
性质:审计结案(基线零改动)——六类对抗面全部有专项测试钉,逐面矩阵如下。

## 测试矩阵

| 对抗面 | 既有钉 | 位置 |
|---|---|---|
| import 循环 | 别名环整链跳过+原因写明;FD 属性引用成环别名有损落 Any/FixedArray[Any] 不外抛;分件全被跳过时 content=null 不落文件其余照常 | tests/pythonTypeStubs.test.ts:326/:566/:594/:1059 |
| 自定义 alias | types.xml 先见保留/alias.xml 后到作废(addDataType 拒重复注册语义);别名解析链到底;跨分件引用 | tests/pythonTypeStubs.test.ts:517+alias 解析面 |
| 容器递归 | FIXED_DICT 逐层下钻到内建;FD 内联 ARRAY 元素递归引用成环别名→数组形状保留元素 Any;ARRAY 折叠 FixedArray[元素];GEN-DEF-1 守卫 | tests/pythonTypeStubs.test.ts:566/:594、tests/entityTypeStubs.test.ts(FixedArray[ITEM_INFO]/守卫) |
| 同名类 | 同名去重统一口径(KSEM-STRUCT-08);字段名优先于同名 dict 方法(读/调用都归字段) | tests/pythonTypeStubs.test.ts:517/:1213/:1220 |
| 重名实体 | entities.xml 重复登记诊断「实体 <Avatar> 重复登记」;跨文件同池同名 def/重复方法组件三重复面只报事实;同名实体二次生成逐项报错;两根同名实体两份 URI 不串根 | tests/covValidationG.test.ts:591、crates/kode-server/tests/diagnostics_units.rs:163/:186、tests/codeGeneratorArmSweep.test.ts:289、tests/databaseSchemaRootIdentity.test.ts |
| 重复 root | 多 root 按 DocumentKey.root 隔离:同名歧义(两根同落 UNROOTED)→ null 不硬选,跨根同名实体互不借用;root 增/删/嵌套回退/重生身份不复活全链;父链环检测+继承环终止成员面 | crates/kode-server/tests/root_scope_dispatch.rs、root_lifecycle.rs(root_added_updates_registry_and_isolates_same_name_entities 等)、kode-parser tests/parser_units.rs:346、completion_units.rs:356、dependency_graph_dispatch.rs:266/:398 |

## 结论

六类对抗面(import 循环/自定义 alias/容器递归/同名类/重名实体/重复 root)全部有专项测试覆盖,且环/重复/歧义处处按「只报事实不选 winner 不硬造」口径钉死。基线零改动。
