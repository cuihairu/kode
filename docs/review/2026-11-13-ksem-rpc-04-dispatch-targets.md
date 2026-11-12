# KSEM-RPC-04 解析 RPC 与组件落点

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-04 [P1]「解析 RPC 与组件落点。验收:只在对应 Methods 段及组件槽查找,提供 def 和 Python 实现两种跳转;歧义展示多候选。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 只在对应 Methods 段查找 | `dispatch::def_facet_candidates`:分面由接收者形态定——远程句柄=调用类型目标面(`call.target_facet()`,via 只描述传输路径,entity_call.cpp:82-123);本地引用=脚本面分面;命中的段之外**不跨段搜**(cell 段方法对 cell 句柄不可达 → Unknown 带因「cell Methods 段无 X(不可达)」) |
| 及组件槽查找 | `resolve_component_slot`:槽声明自宿主快照 `components` 找(槽缺失/类型未指定/组件无快照 → Unknown 逐因);远程宿主=EntityComponentCall 同七路 switch 查**组件自身 def 模块**对应面表(entity_component_call.cpp:64-110,无面跳无自名闸);本地真身=**plain Python 派发**(cellapp 真身臂空 else 直落 ScriptObject、baseapp 无条件直落)——def 分面不设闸,候选=组件 Python 类方法,def 同面声明缀附作 def 跳转 |
| 提供 def 和 Python 实现两种跳转 | `MethodCandidate` 双面:def 跳=`def_file`(MethodView.file 原样)+`def_line`;Python 跳=`py_file`(`scripts/<面>/<类名>.py`,类解析到才给,不造路径)+`py_line`(类在而方法缺失 → None,诚实不造行号) |
| 歧义展示多候选 | 同名方法多来源(自身+接口/父)快照已全列(snapshot.rs:217-231),候选逐来源展开各带各的双跳转,`Resolved(Vec)` 全列不任取;消费契约层面「不得任取」不变量与 RPC-03 Candidates 同纪律 |

## 2. 引擎真值(逐行核过 ../kbengine)

- `lib/entitydef/entity_call.cpp:82-123`:句柄方法表按调用类型目标面查;client/bots 组件侧非 Exposed 回落普通属性臂(:120);
- `lib/entitydef/entity_component_call.cpp:64-110`:`EntityComponentCall::onScriptGetAttribute` 同七路 switch(`type_` 自宿主句柄承袭),但查 `pComponentScriptDefModule()`——**组件自身 def 模块**;无自名闸、无面跳;未命中回落 `ScriptObject::onScriptGetAttribute`;
- `server/cellapp/entity_component.cpp:35-53`:本地组件读属性——ghost 宿主(!isReal)才查组件模块 `findCellMethodDescription` → RealEntityMethod(迁移期 RPC 回真身);真身臂**为空**,直落 ScriptObject = plain Python 属性派发;
- `server/baseapp/entity_component.cpp:31-35`:本地组件无条件直落 ScriptObject,无任何 def 特例;
- 结论:本地真身组件方法调用**不查 def 分面表**——def 段是文档面不是运行时闸;静态模型按真身路径建模(候选自 Python 类),ghost 增益路径列诚实边界(静态无法判真身/ghost,KSEM-CELL-11 同口径)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/dispatch.rs` | 新模块:`PyClassFacts`/`PyMethodFacts`/`PyClassResolver`(消费方从 `scripts/<面>/<类名>.py` 解析注入)+ `MethodCandidate`(双跳转)/`DispatchTarget`(Resolved 多候选 / Unknown 带因)+ `Receiver`(Role/ComponentSlot)+ `resolve_dispatch`(三引擎路径;本地组件 plain 派发、def 缀附);测试 11 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod dispatch` 注册 + 模块列表条目(RPC-04 边界) |

## 4. 诚实边界

- **本地组件 ghost 路径不在模型**(cellapp `!isReal` → 组件模块 cell 方法表 RPC):静态无法判真身/ghost(迁移期状态,KSEM-CELL-11 同口径「一次异步创建≠已持 Cell」),按真身 plain 派发建模,ghost 增益(cell 段 def 声明也 RPC 可达)由边界注记——消费面若需 ghost 面自行并入 cell 段候选;
- **Role 引用候选只出 def 段**(验收口径「只在对应 Methods 段查找」):Python 类里 def 未声明的方法不出候选(py 跳转只作 def 候选的实现面缀附);本地实体方法调用引擎侧实为 plain Python 派发(与本地组件同理),def 段是该面声明合同面——本地实体 plain 派发的 py-only 方法面若需要,属后续消费批次扩展,不在本批验收面;
- `PyClassFacts` 基类链展开归消费方(解析器给什么类就查什么类,MRO 归 Python 侧解析注入);
- 行号口径:PyMethodFacts 的 line/params 按消费方解析器原样透传,本模块不换算不伪造。

## 5. 证据

- `cargo test -p kode-server --lib semantics::dispatch` 11/11(目标面只查该段+双跳转/via 用目标面/本地按脚本面/类未知与 None 引用不猜/py 行号诚实缺/歧义双候选全列/组件远程查组件模块目标面/组件缺件四 Unknown/本地真身 plain 派发+py-only+def 缀附/baseapp 直落按 base 面/本地缺面缺类缺方法三 Unknown);
- **prove-red=变异三发,全数咬合**:(1) def 分面改三面并查 → 2 例红(only_target_facet/via_uses_target_facet);(2) 组件槽远程路径误读宿主快照 → 1 例红(component_remote_uses_component_module);(3) 本地组件误走 def 分面闸(抹 plain 派发真值)→ 3 例红(local_real_plain_python/base_face_fallthrough/missing_script_or_method);恢复 11/11;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 全部套件 0 失败(kode-server lib 269 含新 11);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0(unit 首跑遇无关 workspace 满载 load 74 抖动红 debugConfigAttach/typeStorageColdBuildPhased 两例,负载回落后全量复跑绿——满载抖动族同族)。
