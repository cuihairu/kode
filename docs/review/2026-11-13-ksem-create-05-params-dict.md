# KSEM-CREATE-05 检查初始化参数字典

**日期**:2026-11-13
**条目**:`todo.md` KSEM-CREATE-05 [P2]「检查初始化参数字典。验收:已知实体字段做类型校验;源码核实 params 自定义键、Cell 数据和普通属性路径后再定缺键/多键规则。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 已知实体字段做类型校验 | 字面量值家族 vs 字段 SemType 家族对拍:`check_value` → Ok / Suspicious(提示级)/ Unknown。相容矩阵:数值互认(Int vs FLOAT ok,bool 是 int 子类)、文本、Seq vs Array、Tuple vs VECTOR(引擎 VECTOR 以 tuple 传)、Mapping vs FIXED_DICT(形态级);Union 任一成员相容即 Ok;Nullable 接受 None;ENTITYCALL 接受 None(RPC-01 真值);Set 无引擎 datatype → Suspicious |
| 源码核实 params 自定义键 | **不报错**:createNamespace 对 def 未声明键走 `PyObject_SetAttr` 动态造实例属性(entity_macro.h:486-502),引擎不拦——`UndeclaredDynamicAttr` 提示级(EXTRA_KEYS_RULE 钉死文案) |
| Cell 数据路径 | 特殊键 `"cellData"`:值必须 dict 合并进 cellData(:417-432),非 dict 字面量 → `CellDataDict{Some(false)}` **确定错误面**(引擎 ERROR「cellData is not a dict」:426-428);cell 段属性经 cellData dict 通道(:470-485)→ `CellDataPath` |
| 普通属性路径 | def 声明属性 HasAttr 臂直接 setattr(:442-468)→ `PropertyPath` |
| 再定缺键规则 | **不报**:属性先经 `initProperty` 落 `newDefaultVal()` 默认值(entity_macro.h:1614-1623),params 缺键即用默认,引擎**无必填概念**(MISSING_KEYS_RULE 钉死;时序:baseapp.cpp:1406/:1885/:2401/:4250 先 initProperty 后 initializeEntity=createNamespace+initializeScript) |
| 再定多键规则 | 不报错(提示级,见自定义键) |
| (纪律)目录未就绪 | `fields=None` → `IndexMissing`——**绝不判「def 未声明」**(验收红线,与 CREATE-02/RPC-09 同纪律;`missing_catalog_never_reports_undeclared` 钉死) |
| 动态形态 | 动态键 → `KeyFinding::Dynamic` 不对拍;动态值 → `ValueCheck::Unknown` 不判;特殊键动态值 → `is_dict_literal: None` 不判 |

## 2. 引擎真值(逐行核过 ../kbengine,要点)

- 创建时序:实体创建先 `initProperty`(每 def 属性 setattr 默认值,entity_macro.h:1574-1623)后 `initializeEntity(pyDict)` = `createNamespace(params)` + `initializeScript`(:362-366;调用点 baseapp.cpp:1406/:1885/:2401/:4250);
- `createNamespace` 键处理三路(entity_macro.h:391-508):(1) 特殊键 cellData 必须 dict 合并,否则 ERROR 并从 params 删除(:417-432);(2) 实例已有属性(HasAttr :442-468)——组件属性 dict 走 updateFromDict,否则 setattr;cellData 已含键写 cellData dict(:470-485);(3) 其余键——组件属性 dict 值 skip(:496-499),否则 `PyObject_SetAttr` 动态造属性(:501);
- **创建面无类型校验**:createNamespace 原样 setattr,不查 def 类型;类型纪律在同步流(cellapp 端 datatype)与结构化 datatype——故本批对拍定位为**静态纪律提示级,非引擎错误预测**(Suspicious 文案自持);
- 附带发现(登记不展开):HasAttr 臂按「实例已有属性」判——params 键命中**方法名/内建名**同样会被 setattr 覆盖(:442-468),非 def 属性也可被命中;消费面如需「覆盖风险」提示需要类全属性表,本批目录只给 def 字段,记录为边界。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/create_params.rs` | 新模块:`ParamEntry`(Named/DynamicKey)+ `ValueArg`/`ParamLiteral` 八形态 + `FieldChannel` 两通道 + `ParamFields` 目录 trait + `ValueCheck`/`KeyCheck`/`KeyFinding` 三层结论 + `check_params` 逐键分诊(特殊键先判不依赖目录)+ `MISSING_KEYS_RULE`/`EXTRA_KEYS_RULE` 源码钉死文案;家族对拍 `literal_family`/`builtin_family`/`field_family`(递归 Alias/Range/Nullable,Union 特判);测试 13 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod create_params` 注册 + 模块文档 CREATE-05 条目 |

## 4. 测试纠偏(prove-red 基建)

1. 变异 1 首发把 `let Some(catalog) = fields else` 换成 `let catalog = fields`——编译失败(Option 上无 field_of),换语义等价变异(目录缺失臂改判 UndeclaredDynamicAttr)后咬合;
2. 变异锚点 `check: KeyCheck::IndexMissing,` 实现与测试各一处(count=2)assert 拒动——首次出现替换(实现位在前)。

## 5. 诚实边界

- 家族对拍是**形态级**:Array 元素型、FIXED_DICT 嵌套键面、VECTOR 分量数不展开(需要值内字面量结构,归消费批次);
- Range 边界(min/max)不在字面量对拍内(值域判定归既有 Range 面);
- cellData 特殊键的**嵌套键**对拍(cellData dict 内部键须是 cell 段属性)不做——需第二通道目录,记录为后续消费面;
- HasAttr 臂的「方法名/内建名覆盖」风险面见 §2 附带发现,本批不产提示;
- `params` 非 dict 形态(baseapp ERROR「args is not a dict」entity_macro.h:396-400)是调用点位数/形态闸,归 CREATE-01 guards,不在本批。

## 6. 证据

- `cargo test -p kode-server --lib semantics::create_params` 13/13(相容/不相容/数值互认/cellData 通道/特殊键三态/自定义键提示级/目录缺失红线/动态键值/Nullable+Union+ENTITYCALL None 面/形态级容器四例/规则常量锚定);
- **prove-red = 变异三发全咬合**:(1) 目录缺失判「def 未声明」→ 1 例红(红线);(2) cellData 非 dict 不判 → 1 例红;(3) 家族对拍硬判 Ok → 3 例红;恢复 13/13 且 diff 字节一致;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 396 含新 13);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
