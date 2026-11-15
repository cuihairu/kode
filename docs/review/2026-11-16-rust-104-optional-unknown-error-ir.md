# RUST-104-W 验收:类型 IR Optional/Unknown/Error 节点形态补齐

日期:2026-11-16。验收对象:todo.md RUST-104-W「Optional/Unknown 节点补齐至原条目完整 IR(现 TypeNode 四类节点+六边,Optional 留后续);验收口径=IR 覆盖原条目全部节点形态」。原条目 RUST-104(已勾基础版):`类型 IR:Builtin、Alias、Array、FixedDict、UserType、EntityRef、Component、Optional/Unknown/Error(以真实 KBEngine 支持语义落地)`。

## 1. 设计判据:引擎真源优先,不发明引擎没有的形态

引擎真源实测(/home/cui/workspaces/kbengine/kbe/src/lib/entitydef/):

- **引擎零 OPTIONAL 类型概念**:entitydef 全域无 Optional 类型节点;官方 types.md 的 "(Optional implementation)" 指 `implementedBy` 属性可缺席——缺席 = 字典内存表示,自定义类仅接管序列化。→ **Optional 不发明节点**(会歪曲引擎),落为显式槽位面;
- **ARRAY 缺 `<of>` = abort**(datatype.cpp:1665 `not found "of"`)→ IR 的 `Option` 槽承接容错半成品输入,但标注为引擎拒收;
- **别名目标未注册 = loadTypes 整体失败 abort**(datatypes.cpp:170-177 `can't fount type {} by alias[{}]`);
- **FIXED_DICT 缺 Properties = abort**(datatype.cpp:2053);**键引用未注册类型 = abort**(datatype.cpp:2153 `key[N] did not find type[X]`);
- **`_` 前缀名禁用**(datatypes.cpp:43-50 validTypeName,:124-127 abort);
- **def 属性未知类型 = DataType is NULL**(property.cpp:70)。

## 2. 实现面(crates/kode-types/src/graph.rs)

| 原条目形态 | IR 落地面 |
|---|---|
| Builtin | 引用终点(既有,无节点;`is_known_terminal`) |
| Alias / Array / FixedDict / UserType | 四类节点(既有,不动) |
| EntityRef / Component | 边种(既有,EdgeKind::TypeRef/ComponentOf) |
| **Unknown** | `TypeNode::Unknown{name}` 变体 + `materialize_unknown()` **opt-in** 物化(构建器永不自动调用,first-write-wins 与链求值语义零改动)+ `unknown_terminals()` 悬挂引用枚举(字母序去重) |
| **Error** | `TypeNode::Error{name, reason}` 变体 + `TypeErrorReason` 五变体(每变体括注引擎锚)+ `push_error_node()` opt-in + `engine_conformance_reports()` 纯查询面 |
| **Optional** | `OptionalSlot` 两义枚举 + `optional_faces()` 槽位面:`FixedDictImplementedBy`(implementedBy 缺席 = 引擎可选,官方 types.md)/ `ArrayElement`(`<of>` 缺席 = 引擎拒收,datatype.cpp:1665) |

关键语义保证:

- **known_terminal 变体感知**:物化的 Unknown/Error 节点虽入 `by_name`,但不算「已知终点」——否则 `resolve_alias_chain` 会把未注册/拒收形态判成 Resolved(撒谎);物化前后链求值结果一致(仍 `ChainStatus::Unknown`);
- **classify 不变口径**:Unknown/Error 节点分类仍 `TypeClass::Unknown`(引擎拒收 = 该名在运行引擎中不存在,不是可用类型类);`TypeClass` 枚举零改动;
- **构建器零自动物化**:add_types/add_def/add_alias 产物与改前逐字节同形——既有 11 钉测试(含 `array_without_of_element_keeps_node_without_element_edge` 容错钉、`alias_with_empty_target_stops_walking_and_stays_resolved` 空指向钉)全部原样保持;
- **消费面编译强制补臂**:`SemType::resolve`(semantics/types.rs)四臂无 catch-all → 新变体使编译破 → 补两臂,均诚实降级 `SemType::Unknown` 带因(`unknown-terminal:{name}` / `engine-rejected:{name}`),不冒充可用类。

## 3. 诚实边界

- `engine_conformance_reports` 只报图内数据可证的四类(`_` 前缀 / 空指向别名 / ARRAY 缺 `<of>` / FD 键类型引用未注册);**FIXED_DICT 缺 Properties(datatype.cpp:2053)与「Properties 存在但为空」在图内同形(均 = field_refs 空),不可区分 → 不谎报**,该理由仅供直接构造标注;
- FD 键名在 IR 中已折平(wire_codec 同口径),`FixedDictKeyUnknownType` 只报类型引用名,不虚构键名;
- 符合性/Optional/悬挂枚举全是**纯查询面**:不改构建语义、不改链求值、不改任何 RPC 输出(无消费接线——查询面待各域接线,与 KSEM-BAS 同口径如实登记)。

## 4. 测试与 prove-red

- kode-types `tests/types_units.rs` 11 钉原样 + 7 新:`unknown_and_error_nodes_are_opt_in_and_classified_unknown` / `materialize_unknown_refuses_known_names` / `materialized_unknown_is_not_a_known_chain_terminal` / `unknown_terminals_enumerate_dangling_edge_targets` / `optional_faces_mark_none_slots_with_engine_truth` / `engine_conformance_reports_enumerate_rejected_shapes` / `ir_covers_all_node_forms_of_original_entry`(验收口径钉:六变体 + 六边种同图齐备);
- semantics/types.rs +1:物化/拒收节点经桥解析诚实 Unknown 带因;
- prove-red 三靶(cp 备份 + cmp 字节还原):① known_terminal 撤变体感知 → 链求值钉红;② 撤 ArrayMissingOf 检测臂 → 符合性钉红;③ 撤 FixedDict None 槽臂 → optional_faces 钉红。三靶全红后还原。

## 5. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test:kode-types 24 绿(18 units + golden 面)、kode-server 全量 979 绿、其余四 crate 329 绿(首轮 executor span_table 一例负载抖动复跑消失,该文件为并发会话在途件与本批零依赖路径)/ rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 10332+8skip 全绿(首轮 1 例负载抖动复跑消失)/ xvfb demo 25 RC=0。

## 6. 结论

验收口径达成:IR 覆盖原条目全部节点形态(Builtin=引用终点、Alias/Array/FixedDict/UserType=节点、EntityRef/Component=边种、Unknown/Error=显式节点变体 opt-in、Optional=槽位面两义标注),全部「以真实 KBEngine 支持语义落地」(引擎锚逐一括注,引擎没有的形态不发明)。整行 `[x]` 勾账。
