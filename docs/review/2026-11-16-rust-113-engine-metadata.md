# RUST-113 验收:引擎关键 API/回调/内建对象/常量 版本化 metadata layer

日期:2026-11-16。验收对象:todo.md RUST-113(旧 SEM-011)「引擎关键 API、回调、内建对象、常量作为版本化 metadata layer,外部版本可覆盖」。

## 1. 判据词 → 实现面映射(crates/kode-server/src/semantics/engine_meta.rs,KSEM-EMETA 纯库面)

| 判据词 | 实现面 | 语义 |
|---|---|---|
| 引擎关键 API | `MetaCategory::Api`(seed 13 条:time/createEntity 族 7 条/executeRawDatabaseCommand/quantumPassedPercent/reloadScript/setSpaceData/getSpaceData) | KBEngine 模块级方法,逐条进程面(baseapp/cellapp)+ 引擎出处文件:行 |
| 回调 | `MetaCategory::Callback`(seed 6 条:onClientEnabled/onTimer/onDestroy/onGetCell/onLoseCell/onInit) | 引擎调用点锚(C++ 调用侧非声明侧) |
| 内建对象 | `MetaCategory::BuiltinObject`(seed 9 条:KBEngine.Entity/Proxy/Space/EntityComponent/GlobalDataClient/EntityCall + Math.Vector2/3/4) | 脚本类安装锚(installScript);`Math.Vector*` 空 faces = 全进程共有 |
| 常量 | `MetaCategory::Constant`(seed 1 条:KBEngine.component) | `PyModule_AddStringConstant`(script.cpp:248,每进程注册) |
| 版本化 metadata layer | `EngineMetaLayer{seed, overrides}` + `resolve(category, name, version)` | 版本串 = 项目声明口径(TS `kbengine.engineVersion`,Rust 侧不猜默认);**版本匹配 = 精确字符串**,不做 semver 推测(PRESETS 归一化属 TS 消费面) |
| 外部版本可覆盖 | `add_override(OverrideSet{versions, entries})` | 版本域精确匹配,空 versions = 全版本;**后登记者优先**;被覆盖 seed/更早 override 进 `shadowed` 事实(不删除),provenance(`Origin::Seed`/`Origin::ExternalOverride`)逐条携带;override 可新增 seed 查无的 fork 专有条目 |

## 2. 关键语义保证(诚实边界)

- **seed 表 = 代表性登记非全量**:锚点全部实证本地引擎树 2.5.10(kbe/src/lib/common/kbeversion.h);完整成员普查归 pyi 静态模板车道(docs/design/kbengine-pyi-compiled-module-plan.md,定稿=typings 静态模板)。测试钉表数 29(漂移即钉);
- **未声明版本不猜**:版本域 override 一律不生效(只有全版本集生效);`entries(None)` 不含 override 专有键;
- **查无 = None 绝不硬造**(含 `KBEngine.ENTITYCALL_TYPE_CELL` 反例——ENTITYCALL_TYPE 是内部枚举 common.h:283-292,本 lineage 不作为 Python 常量暴露,实证无注册点);
- 版本域 override 缺失语义:某条 seed 在新版本被移除的建模 = override 用空条目覆盖?——本面不支持空条目,移除声明属 RUST-117 capability profile 差异行为面,不越界;
- 与 RUST-117 边界:本面只做「按版本供给引擎事实」,差异行为建模(capability profile)归 RUST-117 另面;
- 无 RPC、无 TS 消费,消费接线属各域账行。

## 3. 引擎真源锚点(2026-11-16 实证,/home/cui/workspaces/kbengine)

- baseapp `installPyModules`:Entity/Proxy/Space/EntityComponent/GlobalDataClient installScript(baseapp.cpp:407-411)+ app flags `PyModule_AddIntConstant` 循环(:421-425,flag 名表 createAppFlagsMaps 定义未检出故不入表)+ APPEND 方法族(:430-439);
- cellapp `installPyModules`(cellapp.cpp:151 起):Entity/Space/EntityComponent/GlobalDataClient(:153-156)+ time/createEntity/executeRawDatabaseCommand/reloadScript/文件描述符族/spaceData 族(:173-184)——**createEntity 双面、reloadScript cellapp 专有**实证;
- `Math.Vector2/3/4`:pyscript/math.cpp:17/19/21,宿主模块名 `Math`(script.cpp:291);
- `KBEngine.component`:pyscript/script.cpp:248;
- 回调调用点:onClientEnabled proxy.cpp:174,178 / onTimer cellapp/entity.cpp:4358 / onDestroy baseapp/entity.cpp:169 + cellapp/entity.cpp:211 / onGetCell :1032 / onLoseCell :1065 / onInit baseapp.cpp:3701 + cellapp/initprogress_handler.cpp:138;
- EntityCall 类:entity_call.cpp:34-35(EntityCallAbstract 脚本类型构造锚)。

## 4. 测试与 prove-red

- 9 例内嵌单元:seed 四类锚点钉(表数 29)/ 版本域 override 胜出+shadowed 记录+异版本 seed 胜 / 无关版本 override 忽略 / 全版本 override 三版本通吃 / 未声明版本不猜 / override 新增 fork 专有键 / 查无 None(含 ENTITYCALL_TYPE 反例+表数钉)/ 后登记者优先(三重 shadowed 序)/ 全表审计键序+provenance+未声明版本不入 override 专有键;
- prove-red 三靶(cp 备份 + python3 变异 + cmp 字节还原):① 版本匹配失效(所有 override 一律适用)→ 4 例红;② provenance 丢失(override 胜出仍标 Seed)→ 4 例红;③ 查无硬造(miss 返回首条 seed)→ 6 例红。

## 5. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test 六 crate 1380 绿(engine_meta 9)/ rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 842 文件 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 6. 结论

判据词全落:四类引擎事实 seed 表(逐条进程面+出处文件:行)、版本化解析(精确串匹配不猜)、外部版本覆盖(后登记者优先+shadowed 事实+provenance)。整行 `[x]` 勾账。
