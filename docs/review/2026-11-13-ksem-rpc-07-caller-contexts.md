# KSEM-RPC-07 校验特殊 caller 规则

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-07 [P1]「校验特殊 caller 规则。验收:核实 EXPOSED_AND_CALLER_CHECK 的不同调用上下文,分别处理传输参数和实现参数,避免额外 caller 导致数量误报。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 核实 EXPOSED_AND_CALLER_CHECK 的不同调用上下文 | 引擎源码逐行核(见 §2):暴露类型三态(NO_EXPOSED/EXPOSED/EXPOSED_AND_CALLER_CHECK,method.h:27-37);注入唯一语境 = cellapp 进程 × cell 段 × exposed(三重条件,method.cpp:83/:165/:185);baseapp/client 进程恒 offset=0(baseapp/entity.cpp:981 置的是**接收者自身 id** 非 caller;cellapp/entity.cpp:1025 置 **srcEntityID** 才是 caller 来源);启动对账与 Def.CallerID 注解两条登记路径语境不同(entitydef.cpp:1872-1877 vs py_entitydef.cpp:2384-2409) |
| 分别处理传输参数和实现参数 | `AritySide::{Transmission, Implementation}` 双侧显式取数入口 `expected_arity(check, side)`:传输/Python 调用点**恒 = def 声明位**(callerID 不上流——addToStream 按 offset 跳过首位只打包声明位 method.cpp:165-171;调用方脚本永不传 callerID);实现侧 = 注入成立时声明位+1(callerID 由 createFromStream 从 `EntityDef::context().currEntityID` 注入元组首位,method.cpp:175-192),其余 = 声明位 |
| 避免额外 caller 导致数量误报 | 误报两向防线钉进模型:调用点数量**不按实现位比**(callerID 引擎注入非调用方所传);实现侧数量**不按声明位比**(注入成立时恰多一参)。`expected_arity` 按侧各给各的数,共用一个数必出一向误报(测试 `injected_impl_arity_side_is_only_implementation`/`transmission_side_never_includes_caller` 钉死);错误面(`CountMismatch`)**不产「期望数」**(Implementation 侧返 None),不再造数助长误报 |

## 2. 引擎真值(逐行核过 ../kbengine)

- **暴露类型三态**(method.h:27-37):NO_EXPOSED=0 / EXPOSED=1「脚本方法可以不加调用者参数」/ EXPOSED_AND_CALLER_CHECK=2「脚本方法第一个参数为调用者 ID,提供脚本检查调用者合法性」;`setExposed` 粘滞——一旦 caller-check 不可降级(method.cpp:41-48);
- **注入三重条件**:`isExposed() == EXPOSED_AND_CALLER_CHECK && g_componentType == CELLAPP_TYPE && isCell()`(method.cpp:83 checkArgs / :165 addToStream / :185 createFromStream 三处同条件)——**唯一语境 = cellapp 进程的 cell 段 exposed 方法**;传输上流按 offset 跳过首位只带声明位(:165-171);接收端注入 `PyLong_FromLong(currEntityID)` 到元组首位(:185-192,KBE_ASSERT currEntityID>0);checkArgs 校验首位必须 `PyLong_Check`(整数实体 ID,:100-105);
- **两进程上下文对比**:cellapp `onRemoteMethodCall` 置 `currEntityID = srcEntityID`(消息头里的**调用者**实体 ID,cellapp/entity.cpp:1025);baseapp 同名路径置 `currEntityID = this->id()`(**接收者自身**,baseapp/entity.cpp:981)且 offset=0 → **baseapp 暴露方法实现恒收声明位数,无 callerID**;client 进程 currEntityID 语境只服务属性流/实体创建(client_lib/entity.cpp:263/clientobjectbase.cpp:319),无注入;
- **启动对账**(entitydef.cpp:1840-1892):def 声明位数 vs 实现检查 `fullargspec` 参数位数(减 self);**exposed 且实现恰多一参 → 升级 caller-check**(:1872-1877,只查 `isExposed()` **不查段**——base/client 段也会被升级标记);其余不合 → ERROR「parameter is incorrect」def 载入失败(:1879-1885);**cell 段 exposed 而未带 callerID → 启动 WARNING 劝告** `def {name}(self, callerID, ...)` 并给 `if callerID == self.id` 惯例(:1886-1892)——劝告非错误;
- **静默升级陷阱**(本批钉死的第一项发现):base/client 段 exposed 实现恰+1 → 启动被升级为 caller-check 标记**无任何报错**,但注入三重条件含 `CELLAPP && isCell()` 永不满足 → 每次调用 TypeError,引擎尾部才提示「try adding callerEntityID: def func(msg): => def func(callerEntityID, msg)」(method.cpp:246-253)——静态模型按 `MismatchReason::CallerNeverInjected` 出真缺陷,不按「启动放过」放行;
- **非 exposed 实现+1** → 升级分支要求 `isExposed()` 不满足 → 启动 ERROR(:1879)——`MismatchReason::StartupRejected`;
- **Def.CallerID 注解登记路径**(py_entitydef.cpp:2381-2417,语境不同处):`Def.CallerID` 注解参必须**首位**(:2404-2412 非首位 ERROR)、必须已 exposed(:2389-2394)、必须 CELLAPP 组件(:2396-2402「only the cell method supports this parameter」);`argIdx=1` 从传输参数里跳过它(:2419 起)——与启动对账的「按数量推断」不同,此路径按注解显式登记;
- **判定不按名**:启动升级纯按参数位数判(先于任何名字检查),hint 文案里 `callerEntityID` 只是示例名——模型 `first_param` 仅作报告数据,不参与分类(测试钉)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/callers.rs` | 新模块:`CallerFacts`(def 侧 facet/exposed/声明位 + 可选实现侧 `ImplArity{params, first_param}`)+ `CallerCheck` 四态(CallerInjected/Exact{advisory}/ImplUnknown/CountMismatch)+ `MismatchReason` 两态(StartupRejected=启动即拒/CallerNeverInjected=静默升级但运行时必错)+ `AritySide` 双侧 + `check_caller_contract`(判定次序逐条对齐引擎行为)+ `expected_arity`(按侧取数,错误面不产数);测试 12 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod callers` 注册 + 模块文档 RPC-07 条目 |

## 4. 测试纠偏

1. `non_exposed_plus_one_is_startup_rejected`:初版实现对**所有** +1 非(cell∧exposed)情形一律 `CallerNeverInjected`——引擎升级分支要求 `isExposed()`(entitydef.cpp:1872-1877),非 exposed +1 落 ERROR「parameter is incorrect」应为 `StartupRejected`(**实现错测试对**,分流补 exposed 三叉);
2. `first_param_name_does_not_gate_classification`:初版断言两不同首参名的结论全等——`first_param` 按设计随结论带出作报告数据,全等断言前提错;改为断言分类不变(`matches!` CallerInjected),名字只不参与门控(**测试错实现对**)。

## 5. 诚实边界

- 引擎内部分发语境(cellapp 收到远端调用时 checkArgs 期望声明位+1 且校验首位 PyLong,method.cpp:83-105)是**引擎内部合同**,Python 源码调用点永不涉及——本批 `AritySide::Transmission` 只覆盖脚本源码调用点与传输上流位,不把引擎内部元组形状暴露给调用点校验;
- `fullargspec` 位数对 `*args`/`**kwargs`/默认参的实现侧形态未细分(引擎按 argspec `args` 数组长度算,py_entitydef/检查路径不展开 vararg)——实现位数由消费方从 AST 事实转述,变长形态归消费批次;
- `Def.CallerID` 注解路径是 defs 由 Python 注解生成的登记面(kode 静态分析场景主要走 def 文件),本批只记录其语境规则(首位/exposed/仅 cellapp),不解析 Python 端注解;
- 粘滞降级(method.cpp:41-48)是引擎内部登记次序行为,静态单一结论面不涉及;
- RPC-05 的 Exposed 闸(client 面可达性)与 RPC-06 的逐位类型检查照旧独立;本批只裁「实现位 vs 声明位 vs 调用点位」的数量合同,不重复类型面。

## 6. 证据

- `cargo test -p kode-server --lib semantics::callers` 12/12(注入唯一语境+双侧取数差一/传输侧永不带 caller/cell exposed 精确位劝告/base·client 无劝告/双段 +1 静默升级陷阱/非 exposed +1 启动拒/±其它值启动拒/实现未知传输契约独立/零参劝告/非 exposed 精确位普通派发/首参名不参与分类);
- **prove-red = 变异三发全咬合**:(1) 抹注入三重条件分流(+1 一律当注入成立)→ 2 例红;(2) 传输侧被 caller 污染(注入成立时传输位+1)→ 3 例红;(3) 抹 cell 段劝告 → 2 例红;恢复 12/12;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 313 含新 12);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
