# KSEM-RPC-01 角色化引用类型

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-01 [P1]「构建角色化引用类型。验收:引入 EntityCall<实体,角色> 与本地 Entity 区分;原生 ENTITYCALL 接受 None/实体的规则按源码保留,具体类未知时不猜。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 引入 EntityCall<实体,角色> 与本地 Entity 区分 | `semantics::refs::EntityRef` 三形态:`Local{class}`(同进程实体对象,引擎 API+全 def 方法面)/`Remote{class, call}`(远程句柄=componentID+实体 id+调用类型,仅可调 def 声明方法)/`None`(引擎交出的确定 None:未绑定面、ENTITYCALL 字段默认值);七种调用类型 `CallType`(common.h:283-291)+ `target_facet`(via 只描述传输路径,方法表按目标面查,entity_call.cpp:85-115) |
| 原生 ENTITYCALL 接受 None/实体的规则按源码保留 | `entity_call_field_accepts(ScriptValue)` 按 `datatype.cpp:1484-1505` EntityCallType::isSameType:EntityCall 实例/None/实际 Entity 实例三者接受,其余 OUT_TYPE_ERROR;默认值 None(parseDefaultStr `:1506-1508` Py_RETURN_NONE);测试 4 形态正反钉 |
| 具体类未知时不猜 | `class: Option<String>` 全程保持:面跳同模块构造新 EntityCall(`entity_call.cpp:166` 同 pScriptModule_)→ class 原样保留;未知(None)保持 None,display 以 `?` 诚实标注(`EntityCall<?@client>`),测试钉「绝不伪造具体实体类」;def 的 ENTITYCALL 字段类型本身不指定 Avatar 等具体实体(设计 §2)→ 该面 class=None |

## 2. 引擎真值(逐行核过 ../kbengine@工作区)

- `lib/entitydef/entity_call.h:15`:EntityCall 携带 (componentID, entity id, call type),不保活、无失效通知;
- `lib/common/common.h:283-291`:七种 ENTITYCALL_TYPE;`:321` TO_NAME_TABLE(CELL_VIA_BASE→"cell"、BASE_VIA_CELL→"base"、CLIENT_VIA_*→"client");`:333` EX 表仅显示面;
- `lib/entitydef/entity_call.cpp:82-123` onScriptGetAttribute:按调用类型查**目标面**方法表;client/bots 组件侧非 Exposed 方法回落普通属性臂(`:120`);组件槽另查 findComponentPropertyDescription;`:136` 自名闸(strcmp TO_NAME_TABLE[type_]);`:144-156` 面跳三分支(cell/base/client);`:166` 服务端 new EntityCall 同模块;`:171` client/bots 侧 Py_INCREF(this) 原样返回;`:177` 全部落空回落属性错误尾;
- `lib/entitydef/datatype.cpp:1484-1508`:EntityCallType::isSameType + parseDefaultStr;
- 迁移面(baseapp `:1635` 只原地改写自身 cellEntityCall_,外部持有副本不更新)已由 knowledge/entity-migration-and-cross-process-references.md §规则2 记录,本模块注释引用不重复建模。

## 3. 面跳全矩阵(7×3,测试钉死)

自名闸挡同面空转(cell.cell/base.base/client.client,含 VIA 变体的 TO 名面);去直连:CELL_VIA_BASE 取 .base → 直连 BASE、BASE_VIA_CELL 取 .cell → 直连 CELL;CLIENT 句柄取面走默认臂(cell→CELL_VIA_BASE、base→BASE_VIA_CELL);CLIENT_VIA_* 复用同分支;CELL_VIA_BASE 取 .client / BASE_VIA_CELL 取 .client 无源码规则(client 分支只认 BASE/CELL,mbtype=-1 回落属性错误)→ None 不猜。

## 4. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/refs.rs` | 新模块:CallType(target_facet/table_name/hop)+ ScriptValue + EntityRef(Local/Remote/None + hop_attr/display)+ entity_call_field_accepts;测试 7 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod refs` 注册 + 模块列表条目(RPC-02 self 绑定/RPC-04 落点边界声明) |

## 5. 诚实边界

- **self 角色引用逐面绑定不在本批**(self.base 在 baseapp 是否存在、None 时机等)= RPC-02 验收「逐条查引擎」;本批只定引用类型代数,Local 的 `.cell/.base/.client` 读不发生 EntityCall 面跳(测试钉);
- **方法落点/组件槽落点不在本批**(onScriptGetAttribute 的方法表命中→RemoteEntityMethod、组件→EntityComponentCall)= RPC-04;本批建模值形态,不建可调实体解析;
- client/bots 组件侧面跳原样返回自身句柄(`:171`)对引用模型等价于不变——注释记录,不另立形态;
- 传输层真值(componentID/addr)不入模型:静态语义只需要(类,调用类型)二元组,句柄地址是运行实例面。

## 6. 证据

- `cargo test -p kode-server --lib semantics::refs` 7/7(目标面 7 型/TO 表 7 位/21 组合全矩阵/class 保留+未知不猜/Local·None 不面跳/接受规则 4 形态/display 含 ? 标注);
- prove-red 不适用:纯新增模块零行为改动(无既有面可红);矩阵真值=逐分支手推 entity_call.cpp:136-168 后成表,非测试反推;
- 门禁:clippy -p kode-server/-p kode-python 0;cargo test 双 crate 全绿(kode-server lib 244 含新 7);tsc 0;eslint 0;vitest 747 文件 9163+8skip;xvfb demo 25 RC=0。
