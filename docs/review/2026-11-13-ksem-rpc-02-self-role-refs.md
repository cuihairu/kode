# KSEM-RPC-02 解析 self 角色引用

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-02 [P1]「解析 self 角色引用。验收:绑定 self.base/cell/client 及已证明的转发链;实际支持的链形态逐条查引擎。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 绑定 self.base/cell/client | `refs::bind_self_role(face, attr, class)`:逐面逐属性按引擎 getter 表(SCRIPT_GET_DECLARE)绑定 → `SelfRoleBinding{reference: Remote{class, call}, none_possible, note}`;面无此属性 → None 不猜(base.base/cell.cell/client.client 同面无此属性,自身即该面;client 面同名为 `.clientapp`=客户端应用对象,非角色引用);非角色属性名(方法/组件槽/内建)→ None 归各自批次 |
| 已证明的转发链 | 链 = self 绑定(构造点)+ RPC-01 面跳(entity_call.cpp:136-168)复合,测试逐条钉:cellapp `self.client.base` → BASE_VIA_CELL、cellapp `self.client.cell` → CELL_VIA_BASE(同句柄 `.client` 自名闸拒)、baseapp `self.cell.client` → CLIENT_VIA_CELL、baseapp `self.client.cell` → CELL_VIA_BASE、baseapp `self.cell.cell` → 自名闸 None |
| 实际支持的链形态逐条查引擎 | getter 表三文件逐行核:baseapp/entity.cpp:36-37、cellapp/entity.cpp:74-75、lib/client_lib/entity.cpp:41-43;构造点逐个核(见 §2);cellapp self.client 调用类型是**本批核心陷阱**:CLIENT_VIA_BASE 而非直连 CLIENT |

## 2. 引擎真值(逐行核过 ../kbengine)

- **base 面**(baseapp/entity.cpp):getter `.cell`=:750(destroyed 读 AssertionError :752)、`.client`=:800(同守卫 :802);`.cell`=CELL(:1028 onGetCell 构造,:1059 onLoseCell 释放回 NULL);`.client`=CLIENT(proxy.cpp:411 onGiveClientTo 构造,**仅 Proxy 系实体**——baseapp/entity.cpp:157 注「有 clientEntityCall_ 必定是 proxy」);无 `.base`;
- **cell 面**(cellapp/entity.cpp):getter `.base`=:391(无 destroyed 守卫)、`.client`=:573(同);`.base`=BASE(:4105 构造,无 base 部件实体 → NULL);`.client`=**CLIENT_VIA_BASE**——onGetWitness 经 `PyObject_GetAttrString(baseEntityCall(), "client")` 构造(:2104-2110;客户端连在 baseapp,cellapp 侧调用必经 base 路由),断连清 NULL(:2211);无 `.cell`;
- **client 面**(lib/client_lib/entity.cpp):getter `.base`=:104、`.cell`=:115(均无 destroyed 守卫);构造 clientobjectbase.cpp:787=BASE、:860/:903=CELL(直连类型);无 `.client`;
- **None 时机统一**:全部角色 getter 对 NULL → S_Return(Py None)——绑定存在≠当前已绑定(KSEM-CELL-11 同口径);baseapp 两 getter 另有 destroyed→AssertionError,cell/client 面 getter 无此守卫(逐面差异,note 记录)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/refs.rs` | +`ScriptFace`/`SelfRoleBinding`/`bind_self_role`(九面属性全表,note 带构造点行号);+测试 5 例(九绑定表/非角色属性不猜/none_possible 全真+note 非空/五条已证明链+两条自名闸拒/class 未知保持) |
| `crates/kode-server/src/semantics/mod.rs` | refs 条目更新为 RPC-01/RPC-02 双批次边界 |

## 4. 诚实边界

- 绑定只回答「该面该属性**是否存在及调用类型**」:Proxy 系才有的 `.client` 在非 Proxy 脚本上的**实际可用性**是实体类级事实(需知道类是否继承 Proxy),本批以 note 记录不裁剪绑定——不引入「按类猜是否 Proxy」的启发;
- 转发链复合只到两跳演示(绑定+一次面跳);更长链(hop 后再 hop)由 RPC-01 hop 矩阵传递保证,不再逐条钉(组合爆炸,源码同一规则);
- 组件槽上的角色引用(`self.weapon.base` 形态)归 RPC-04 组件槽落点;
- client/bots 组件侧 EntityCall 面跳返回自身句柄(entity_call.cpp:171)已在 RPC-01 注记,不另立形态。

## 5. 证据

- `cargo test -p kode-server --lib semantics::refs` 12/12(RPC-01 七例+RPC-02 五例);
- **prove-red=变异**:把 (Cell,"client") 臂 ClientViaBase→Client(直连 CLIENT 的天真假设)→ 2 例红(table_pinned/chains+class_preserved),恢复 12/12——陷阱钉死可咬合;
- 测试纠偏一处:初版链测试误写「cellapp self.client.cell 自名闸拒」——TO_NAME_TABLE[CLIENT_VIA_BASE]="client" 不挡 `.cell`,引擎构造 CELL_VIA_BASE;实现(矩阵)对,测试期望错,按源码改正并留注释;
- 门禁:与 RPC-03 同树合并收口(别名传播接续同文件,合并提交;单独勾两行)——clippy -p kode-server 0;cargo test 49 套件全绿;tsc 0;eslint 0;vitest 747 文件 9163+8skip;xvfb demo 25 RC=0(demo 首跑遇无关 workspace C++ 构建满载 load 94-131 抖动红,负载回落复跑绿)。
