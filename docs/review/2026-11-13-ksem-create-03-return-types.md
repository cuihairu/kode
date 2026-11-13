# KSEM-CREATE-03 推导同步创建返回值

**日期**:2026-11-13
**条目**:`todo.md` KSEM-CREATE-03 [P2]「推导同步创建返回值。验收:按具体 API 赋予 Entity/EntityCall/可空/无返回类型;不将所有创建 API 视为返回本地对象。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 按具体 API 赋予 Entity | `call_value_of(side, api, 实体名字面量)` → `CallValue::LocalEntity(SemType::Entity(类名))`——**仅两个本地 createEntity**(baseapp/cellapp);类名按 entityType 字面量实参;动态名 → `Unknown` 带因(实体引用成立、类未知,不硬造类名) |
| EntityCall | `delivery_type_of` → `Delivery::EntityOrMailbox{entity, mailbox: Builtin("ENTITYCALL")}`——anywhere/remotely 族单参回调,本 app=实体对象、跨 app=BASE EntityCall 句柄,静态不定向 → **联合两态,消费面不任取**(baseapp.cpp:2798-2859 两分支) |
| 可空 | `Delivery::RefDbidWasActive{entity: Nullable(实体型), dbid: DBID, was_active: UINT8}`——FromDBID 三族查库失败回调收 None → Nullable 包实体型;实体化失败无通知(不闭合三态之一,不在此型,CREATE-01 已登记) |
| 无返回类型 | 七条异步 API(anywhere/remotely/FromDBID×3/createCellEntity 族×2)→ `CallValue::AsyncNone`——调用表达式求值为 None,消费面不应在其上做实体操作;本地两 API 无回调交付 → `Delivery::NoCallback`,cell 族经 `onGetCell` 无参浮出 → `OnGetCell` |
| 不将所有创建 API 视为返回本地对象(红线) | 双防线:(1) `async_apis_never_return_local_object` 逐条钉七异步 API = AsyncNone;(2) `audit_sync_local_only()` 结构性核对——契约表中同步返实体者必为 `CreateKind::Local`,非 Local 却 EntityDirect 即 Err(表自洽防线,防后续加 API 破红线) |
| (纪律)查无此 API 不猜 | side+name 不在 CREATE-01 契约表 → `None`(call_value_of 与 delivery_type_of 同口径);Base 面查 createEntity(不存在)→ None |

## 2. 引擎真值(逐行核过 ../kbengine,要点)

- 同步返实体仅两处:baseapp `createEntity` S_Return 直接回实体对象,失败走异常**非 None**(baseapp.cpp:977-980);cellapp `createEntity` 返回本地 Cell 实体且可能 isDestroyed=true 态(cellapp.cpp:521-529)——本批只赋型不展开销毁态;
- 异步族 S_Return 全部回 None(baseapp.cpp:1024/:1084/:1206 等)——「调用表达式无实体价值」是引擎形状,不是保守化简;
- anywhere/remotely 单参回调两分支:本 app 创建 → 实体对象;跨 app → BASE EntityCall 句柄(baseapp.cpp:2798-2859)——静态分析无法定向,联合是唯一诚实型;
- FromDBID 三参 "OKi"(baseapp.cpp:1375):实体引用|None、dbid、wasActive(int 0/1)——wasActive 语义(已活跃直回引用)归 CREATE-01 guards 登记,本批给型。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/create_return.rs` | 新模块:`CallValue` 两态(LocalEntity(SemType)/AsyncNone)+ `Delivery` 四态(NoCallback/OnGetCell/EntityOrMailbox/RefDbidWasActive)+ `call_value_of`(CREATE-01 `lookup` 驱动,字面量→Entity(类名)/动态→Unknown)+ `delivery_type_of`(CallbackShape 映射,三参型 Nullable+DBID+UINT8)+ `audit_sync_local_only` 全表自洽核对;测试 11 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod create_return` 注册 + 模块文档 CREATE-03 条目 |

## 4. 测试纠偏(prove-red 基建)

1. 变异恢复误用 `git checkout --`(文件尚 untracked 不归 git 管,恢复失败致变异叠加);改 `/tmp` 快照 cp 恢复,末尾 `diff` 断言字节一致——三发纪律的恢复环节从此不依赖 git 状态;
2. 变异 2 首发锚点 `mailbox: SemType::Builtin("ENTITYCALL"...)` 在实现与测试期望各出现一次(count=2)assert 拒动——换实现块多行唯一上下文(含 `entity_ty()` 行)后咬合。

## 5. 诚实边界

- `Entity(String)` 依赖调用点字面量折叠质量:动态名只有 `Unknown`,类不猜;跨变量别名传播归 expr/facts 既有面,本模块按入参形态赋型;
- cellapp 本地 `createEntity` 的 isDestroyed=true 态(同步返回但实体已销毁)未单独建型——消费方如需可在 LocalEntity 之上加态标注,本批不造;
- `mailbox/dbid/was_active` 用 `Builtin("ENTITYCALL"/"DBID"/"UINT8")` 标量记号:与 types.rs 既有 Builtin 通道一致,不新增变体;
- 交付面只给「回调收什么型」,回调**绑定**传播(CREATE-04)与实参字典校验(CREATE-05)不在本批。

## 6. 证据

- `cargo test -p kode-server --lib semantics::create_return` 11/11(字面量类名/动态 Unknown/cellapp 本地/七异步红线逐条/查无此 API 三面/anywhere 联合/DBID 三族 Nullable 三参/cell 族 OnGetCell/本地无回调/交付面查无/全表自洽);
- **prove-red = 变异三发全咬合**:(1) 异步 API 硬造 LocalEntity → 1 例红(async_apis_never_return_local_object);(2) 句柄面硬按实体类型抹联合 → 1 例红(anywhere_delivery_is_entity_or_mailbox_union);(3) 查无此 API 硬猜默认契约 → 1 例红(unknown_api_is_none_not_guessed);恢复 11/11 且 diff 断言与清洁快照字节一致;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 372 含新 11);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
