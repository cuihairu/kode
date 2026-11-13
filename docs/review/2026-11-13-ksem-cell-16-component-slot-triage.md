# KSEM-CELL-16 组件槽继承合并与缺失分诊

**日期**:2026-11-13
**条目**:`todo.md` 深审项「显式区分组件槽宿主缺失与结构缺失分诊(`crates/kode-server/src/semantics/rules.rs:64`)—— 防声明未就绪被误报为方向不可达。」(KODE-PERF 审计 2026-11-11 深审-4 后续)

## 1. 问题两面(侦察实证)

**面一·快照来源缺口(根因)**:快照构建器的组件槽只并自身 def(旧码 `for c in &own.components` 单源直推)。引擎真值(entitydef.cpp,逐行核过工作区引擎树):

- `entitydef.cpp:343-372` loadDefInfo 序:loadAllDefDescriptions(自身)→ loadInterfaces(:351,每个接口 xml 内 loadComponents :616-618,**同一 pScriptModule**)→ 自身 loadComponents(:363)→ loadParentClass(:372 → :915 递归 loadDefInfo,同模块);
- `scriptdef_module.cpp:1069-1074` addComponentDescription = map 直接赋值 `componentDescr_[compName] = compDescription` → **同名后装覆盖**(装载序里链上最深祖先胜出);findComponentDescription :1078 按名查。

即:父实体/接口声明的组件槽在引擎里完全合法,旧快照却看不见 → rpc 结构守卫把合法派发误报「组件槽未声明 → 方向不可达」。

**面二·分诊红线**:组件合并来源面有缺口(缺父/缺接口/环/溢出)时,合并结果不完整,「全链无此槽」证不出来 —— 不完整 ≠ 结构缺失,只能报声明未就绪。旧码槽缺失一律 DirectionUnreachable,越过了六态模型的「绝不判确定缺失」红线。

## 2. 改动面

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/snapshot.rs` | 组件槽按引擎序合并:[own.interfaces 解析](ReferenceKind::Interface) → own → 父链(parent_chain[1..],own_kind);同名槽 `comp_winner` map 后写覆盖(引擎 addComponentDescription 语义),**平槽面保持声明序**(槽名首次出现位;cell.rs 键宇宙契约 `component_slots`/`component_cells` 同序对应,值换序会位移消费面);同名多来源记冲突 `component-defined-in-multiple-sources`(与属性/方法同款);`missing-component-type` 逐来源登记——被覆盖的槽引擎照样装属性(entitydef.cpp:742 addComponentProperty),不因覆盖免检;胜者 view.file = 胜出来源 `<名>.def`。已知模型缺口:父实体的接口不展开(parent.interfaces 未解析,与属性/方法来源口径一致),注释内注明 |
| `crates/kode-server/src/semantics/rules.rs` | 槽缺失臂分诊:扫描宿主 `issues` 的 `fact.value` 前缀(`missing-parent:`/`missing-interface:`/`inheritance-cycle`/`inheritance-chain-overflow`/`interface-cycle-or-duplicate`),任一命中 → `NotReady`(来源不完整不判结构缺失);链完整 → `DirectionUnreachable`(理由更新为「宿主 def 全链无此槽」)。模块头两处文档同步 |
| 测试 | snapshot.rs +4:`components_merge_parent_chain_and_interfaces`(父/接口槽可见)/`component_same_name_deepest_ancestor_wins_with_conflict`(链上最深祖先胜 + 冲突 candidates [Mixin, Avatar, Monster])/`own_slot_beats_interface_declaration`(引擎序接口先装自身覆盖)/`overwritten_slot_still_records_missing_type`(覆盖槽免检否决);rules.rs +1:`component_slot_absent_with_chain_gaps_is_not_ready`(缺父/环 → NotReady;干净链 → DirectionUnreachable 由既有例钉) |

## 3. 引擎忠实度备注

- 实现序 [C.ifaces → C.own → P.own → GP…] vs 引擎 [C.ifaces → C.own → P.ifaces → P.own → GP…]:因父接口不展开,链内同名覆盖的胜者两序一致(都是最深祖先);接口 vs 链上声明相遇时,引擎 P 阶段(链)晚于 C 阶段(接口)→ 链胜,实现 comp_sources 序(接口在前、链在后)同结论;
- 平槽面声明序:引擎侧 componentDescr_ 是有序 map(字母序),但 kode 的 cell/跳转消费面契约是**声明序**(cell.rs:261),故取「首次出现位 + 引擎覆盖值」——自身声明槽(绝大多数场景)位次与旧码逐字节一致,不位移既有消费面。

## 4. prove-red(两发,测试先落、快照后拍)

| 变异 | 红面 | 恢复 |
|---|---|---|
| M1:comp_sources 削为 own 单源(伪装旧码) | `component_same_name_deepest_ancestor_wins_with_conflict` + `components_merge_parent_chain_and_interfaces` 2 红 | cp /tmp 快照,diff 字节一致 |
| M2:rules.rs 槽缺失臂回退无条件 DirectionUnreachable(伪装旧码) | `component_slot_absent_with_chain_gaps_is_not_ready` 1 红 | 同上 |

首轮真红(非变异):BTreeMap 键序曾把平槽面 Alphabet 化,击中 cell.rs 既有例 `component_type_missing_or_untyped_no_fields_fabricated`(断言 index 1 组件类型 None,值序翻转后取到有类型槽)——正是消费面序契约的活证据,即改 `comp_order` 首现位方案,该例恢复绿,未改一行既有测试。

## 5. 门禁

- `cargo test -p kode-server`:428 过 0 败(lib,+5);
- `cargo test -p kode-python`:297 过 0 败;
- `cargo clippy -p kode-server -p kode-python --all-targets -- -D warnings`:0;
- TS 侧门禁(compile/lint/unit/demo)与本批改动面无关(Rust 纯库面,无 RPC/无 TS 消费),仍按惯例跑全量,见 todo 勾行记录。
