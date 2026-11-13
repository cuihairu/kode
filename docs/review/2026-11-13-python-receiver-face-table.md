# 深审-3 收口:PYTHON_RECEIVER_SECTIONS 逐面语义表

**日期**:2026-11-13
**条目**:`todo.md` 深审项「将 `PYTHON_RECEIVER_SECTIONS` 改为按 caller face/entity owner 的逐面语义表(`src/backend/pythonLanguageUtils.ts:66`)—— 消除与 `bind_self_role` 的矛盾和跨实体误对账。」

## 1. 问题(侦察实证)

- 旧表 `receiver → def 段` 无条件映射,不知道调用面。引擎九面属性表(`refs.rs bind_self_role`,SCRIPT_GET_DECLARE 构造点逐个核)裁:baseapp 有 `.cell`/`.client`(baseapp/entity.cpp:750/:800)、cellapp 有 `.base`/`.client`(:391/:573,.client 是 CLIENT_VIA_BASE)、client 有 `.base`/`.cell`(client_lib/entity.cpp:104/:115);同面无此属性(base.base/cell.cell/client.client,自身即该面;client 面同名 `.clientapp` 是应用对象)。
- 后果一(Rust↔TS 矛盾):Rust `bind_self_role` 对非法 face·attr 组合返回 None(不猜),TS 三条诊断 lane(receiver-none/段错配/RPC 实参数)却把 `cellapp 上的 self.cell.foo()` 当合法派发去对账 CellMethods——AttributeError 引用被报「可能为 None」/「段错配」/「实参数不符」。
- 后果二(误对账):roleMisuse lint 明确不接管多段访问(`self.cell.X` 归 receiver/段 lane 管),receiver lane 却不裁合法性 → 该引用在任何 lane 都得不到正确处置。

## 2. 改动面

| 文件 | 改动 |
|---|---|
| `src/backend/pythonLanguageUtils.ts` | 新 `PythonCallerFace`(base/cell/client,目录域同名,值由调用方换算,不引 entityMapping 依赖)+ `PYTHON_RECEIVER_FACES` 九面表(面上无此属性 → null)+ `pythonReceiverSectionFor(face, receiver)`(面未知保旧口径);`PythonReceiverCall` 增可选 `callerFace`;`findPythonReceiverCalls(text, face?)`/`getPythonReceiverCallAtPosition(line, char, face?)`/`findPythonReceiverCallArguments(text, face?)` 盖章:面上无效引用不进发现面(position 面 → null)。不传 face 的既有调用面(导航 hover/F12/CodeLens/inlay)零行为变化 |
| `src/backend/receiverNoneDiagnostics.ts` | 同步/异步两入口 `pythonScriptDomain(filePath)` 换算调用面,发现面过滤 + 别名收集(`collectAliasUseCalls`/`buildEvalContextFromParsed` 穿 face)同闸——别名源头 `x = self.cell` 在无效面即 AttributeError,使用点不进诊断面 |
| `src/backend/rpcArgCountDiagnostics.ts` | 两入口第三参 face;`expectedSection` 改用 `call.section`(发现面带段,单源) |
| `src/backend/receiverNoneRust.ts` | `callerFace` 下发 RPC(`$/kode/lint/analyzeReceiverNone` params),廉价预检同口径 |
| `crates/kode-server/src/receiver_none.rs` | `ReceiverNoneParams.caller_face`(serde camelCase)+ `receiver_not_on_face`(九面表,与 bind_self_role 同源)+ 判定循环头滤除(guard 扫描与段对账都不适用;别名使用点同闸);测试构造补字段 |
| `src/activate/diagnostics.ts` | rpcArgCount 臂传 `pythonScriptDomain(document.uri.fsPath)` |
| 测试 | pythonReceiverSection.test.ts +1 describe(九面矩阵/sectionFor 口径/发现面过滤/无面旧口径/position 面闸 5 例);receiverNoneDiagnostics.test.ts +1 describe(cellapp/baseapp/client 面/面未知旧口径/段错配同闸/别名同闸 6 例);rpcArgCountDiagnostics.test.ts +1 describe(面滤/面上有效照报/无面旧口径 3 例);receiver_none.rs +1(face 闸 5 臂);receiverNoneRustParity.test.ts 真二进制对拍 harness 两侧同喂 face(mock-vs-wire:自构 params 须镜像生产装配面)+ wire 契约钉 2 臂 |
| fixture | tests/covDiagnosticsFindings.test.ts `self.base.reqPos(1)` → `self.cell.cellMove(1,2)`(scripts/base 文件里 self.base 是 AttributeError 引用,新闸正确滤除——真回归抓到的旧口径误报样本,fixture 改面对齐;AVATAR_DEF 补 CellMethods cellMove 1 Arg) |

## 3. 门禁与 prove-red

- prove-red 三发(快照后拍):M1 九面表 cell.cell 翻合法 → 8 红;M2 发现面滤除改回落旧表 → 6 红;M3 Rust 循环头闸抹除 → face_invalid_receiver_is_filtered_not_diagnosed 1 红;恢复 diff 字节一致。
- 门禁:cargo test kode-server 429(+1)/kode-python 297 全过 0 败;clippy 0;tsc 0;eslint 0(修 2 处未用导入);vitest 748 文件 9187+8skip RC=0;xvfb demo 25 RC=0。
- 真回归(非变异)两起,都是闸生效的活证据:①covDiagnosticsFindings fixture 在 scripts/base 文件里用 self.base(旧口径误报「可能为 None」,新闸滤除后主集合 3→2);②receiverNoneRustParity TS 侧滤除后与旧二进制漂移,真因=harness 自构 params 未带 callerFace(整面回退纪律的对拍面),补齐后两侧深等。

## 4. 已知边界

- 导航/展示面(hover/F12/CodeLens/inlay)不传 face,零行为变化——它们是辅助面不是断言面;断言面(诊断)必须诚实。
- pythonScriptDomain 按 path.sep 段匹配 base/cell/client/bots,非标准布局 → 面未知 → 保旧口径(未知不裁,不引入新误报)。
- 面上无效引用现在三条 lane 都不报(诚实未知);专门的「角色错用(多段)」诊断面不在本条目范围(roleMisuse lint 边界注释已声明多段归 receiver lane)。
