> 2026-11-13 刷新（HR-PR-01 重执行）：本审计锚定 HEAD `6934c63a`（main）。2026-11-11 审计（SHA `36052c47`）就此作废——热更面已从 ~5 个模块长到 30+（状态机、回执、重试、通道、UI 簇）。接收侧实现记录（demo 回环 + Python 3.7.3 xreload）：[demo-hot-reload 设计](../../design/demo-hot-reload.md)。

# 热更新 — 现状实现审计（HR-PR-01）

- 锚定审计 SHA：`6934c63abd9b21afaff51a135d69535ea167f069`（分支 `main`）。
- 范围：HR-AUDIT-001..012，账本 `todo.md`「Kode 2.0 — Rust Core 高性能重构账本」§19.2（原 docs/kode2/KODE_2_COMPLETE_TODO.md 已合并删除）。
- 红线遵守：Watch/Hash/成功确认度一律给出有证据的事实或 `unknown`；下文任何一句都不超出代码实际所做。
- 端点/参数长期契约（2026-11-06 用户令）：快速请求示例 query 与 body 双载 `module_name=<module>`；全仓拼写门禁照旧（`tests/hotfixSpellingGate.test.ts`）。
- 本 PR 不改任何行为。纯审计。

## 1. 事实表（逐一对照上方 SHA 的源码核实）

### HR-AUDIT-001 — 锚点：package.json / README / docs

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 命令 | 12 条 `kbengine.hotReload.*`：`tempEdit.run`、`showLog`、`toggle`、`showBatchSummary`、`retryFailed`、`showRevisionEvidence`、`filterByState`、`showFileState`、`configureChannel`、`switchChannel`、`confirmDefBaseline`、`materializeGlobs`；另有 legacy `kbengine.httpRequests.run` / `kbengine.httpRequest.run` | `package.json:846-968`（hotReload 块）、`:1042-1045`（mcp toggle，非热更）；注册点见 §4 表（`src/activate/hotReload.ts`） |
| 激活事件 | 12 条热更命令全部有对应 `onCommand:` 事件（程序化交叉核对：零缺失） | `package.json:36-37,161-176` |
| 键位绑定 | 热更未注册任何键位 | `package.json` keybindings（仅 telnet） |
| 视图 | 无热更 TreeView/webview。状态以别的面呈现：全局 FileDecorationProvider + CodeLens + OUTPUT 台账 | `src/activate/hotReload.ts:582,592`；`src/hotReloadStatus.ts:21` |
| 配置：`kbengine.hotReload.*` | `enabled=true`（默认开）、`actionName=""`、`globs=null`（未设 → 从 `kbengine.assetsRoot` 派生，`src/hotReload.ts:83-95`）、`debounceMs=500`、`tempEdit.enabled=false`、`tempEdit.actionName=""`、`tempEdit.autoRestore=true`、`tempEdit.scriptRoot=""` | `package.json:2058-2098` |
| 配置：通道/档案 | 无 `kbengine.hotReload.channel` 配置键——通道住在部署档案存储（`workspaceState`）里，经 `configureChannel`/`switchChannel` 呈现 | `src/projectProfiles.ts:31,170`；`src/backend/hotReloadChannelConfig.ts:349-425` |
| 配置：`kbengine.httpRequests` | 数组；默认 = 一条**禁用**的示例 `POST http://127.0.0.1:8090/hotfix?module_name=${module}`，body `module_name=${module}` | `src/backend/httpRequests.ts:53-61`（`BUILTIN_HTTP_REQUEST_EXAMPLE`） |
| README/docs | README(.zh)/`docs/guide/configuration.md`/features 文档覆盖快速请求 + 零配置自动热更 + 端点形状 | 锚定 SHA 下的各文件 |

### HR-AUDIT-002 — 模块清单（注册入口）

| 簇 | 模块 | 职责 |
| --- | --- | --- |
| 触发核心 | `src/hotReload.ts`（1062 行） | 设置读取、watch 计划、全局去抖（`HotReloadTrigger` :220）、发射路径编排：def 门（:777-809）→ 通道发送（:561）→ actionName 快速动作（:609）→ 默认热修 POST（:427-446）；watcher 挂载/重建（:928-1008）；配置变更重建（:1010-1020） |
| 激活接线 | `src/activate/hotReload.ts`（742 行），自 `src/extension.ts:1360-1367` 进入 | 台账 + 版本追踪 + 状态控制器实例化（:91-133），def 门共享实例（:246-250），全部 12 条命令注册，装饰/lens provider 注册（:574-615） |
| 发送簇 | `src/backend/hotReloadDefaultHotfix.ts`、`hotReloadChannelConfig.ts`（679 行）、`hotReloadChannelSend.ts`、`hotReloadTransport.ts`（739 行）、`hotReloadDelivery.ts` | 通道配置面板 + 快速切换灯；带回执切换的批式通道发送；传输抽象（http / kbengine-official）；投递分类器 |
| 回执簇 | `src/backend/hotReloadReceipt.ts`、`hotReloadAppliedCheck.ts`、`hotReloadRetry.ts`（65 行）、`hotReloadRetryCommand.ts`（361 行）、`hotReloadRevisionEvidence.ts` + `Command.ts`、`hotReloadTargetState.ts`（401 行）、`hotReloadBatchSummary.ts` + `Command.ts` | accepted 回执解析器；applied 摘要双证据 + 10 秒沉降；重试规划 + 单目标重发命令；三类修订证据；双维度投递台账 + HOT-VER 版本册；按目标聚合 |
| 状态/UI 簇 | `src/backend/hotReloadFileState.ts`（368 行）、`hotReloadFileStateFilter.ts`、`hotReloadFileVersion.ts`（303 行）、`src/hotReloadStatus.ts`（476 行）、`src/hotReloadToggle.ts`、`src/hotReloadFileDecorations.ts`、`src/hotReloadFileStateLens.ts`、`src/backend/hotReloadNotice.ts`、`src/backend/hotReloadGlobsMaterialize.ts`、`src/backend/hotReloadTempEdit.ts`、`src/backend/hotReloadDefGate.ts`、`hotReloadDefHash.ts`、`hotReloadDefStructure.ts` | 生命周期状态机；关注过滤/详情命令；按文件版本册；发送状态灯；开关；文件装饰；CodeLens；首跑通知；globs 物化；临时编辑热更；def 结构门；def 哈希三路径；def 结构分类器 |
| Legacy 快速请求 | `src/backend/httpRequests.ts`、`src/backend/httpRequestService.ts`、`src/quickActions.ts`、`src/quickActionConfig.ts`、`src/quickActionTree.ts`、`src/variableSubstitution.ts`、`src/backend/debugJsonSchema.ts`、`src/debugConfigBootstrap.ts` | 语义不变；已迁至 `src/backend/`（SRC-001）；HTTP 注册现位 `src/activate/views.ts:233-303`（调用点 `src/extension.ts:1276-1277`） |
| 接收侧（仓内，非扩展） | `templates/demo-game/scripts/common/KodeHotReload.py`（352 行）+ `xreload.py`（214 行，Python 3.7.3），镜像于 `tests/fixtures/kbengine-demo-assets/`；`scripts/hot-reload-receiver/referenceReceiver.mjs` | demo 回环桥：127.0.0.1 上 HTTP `/hotfix` `/reload` `/status`，端口 8090 base / 8091 cell；xreload = Guido van Rossum 算法适配 3.7.3；摘要校验 + applied 回执 |

### HR-AUDIT-003 — 发送路径端到端链（现行发射路径）

1. 触发：FileSystemWatcher 事件 → `pendingTriggers`（`src/hotReload.ts:417`）→ 单一全局去抖（默认 500ms，`HotReloadTrigger` :220-251）。
2. 门：纯 Python 批同步放行（:779-782）；含 `.def` 的批走结构门（`gateDefChanges` :777-809 → `hotReloadDefGate.check` :107-166）。结构差异 → **拦截**：标 `RESTART_REQUIRED`（:784），审计行 `拦截:需重启`（:792），基线不前滚（:805 仅放行时执行）。
3. 派发（首中即用）：部署通道 → `sendFilesViaReloadChannel`（`src/hotReload.ts:561`；传输在 `src/activate/hotReload.ts:340-361` 解析，默认通道 `targetId='default'` 在 :347）；否则 `actionName` 快速动作（:609-756）；否则默认热修 POST（`runDefaultHotfix` :427-446）。
4. 通道发送序列（`hotReloadChannelSend.ts:68-328`）：先记 generation 再进传输（:74-93）→ 逐文件冻结 sha256 摘要（:95-116）→ 按根分组（:117-123）→ 发送 → 回执解析（`parseReloadHttpReceipts` :163-253）→ 台账切换 `applied`/`accepted`/`failed`/`sent-unverified`（:219-306）→ applied 沉降窗以发送起点锚定（:172-197）。
5. 回执升级阶梯：传输 2xx 仅 `sent-unverified`（`hotReloadDelivery.ts:24-35`；非 2xx = `failed` :34）；`status:"accepted"` + 文件回声 → `accepted`（`hotReloadReceipt.ts:25-52`）；`status:"applied"` + 文件回声 + `digest` == 冻结 sha256 → `applied`（`hotReloadAppliedCheck.ts:43-96`）；沉降 10 秒（`HOT_RELOAD_APPLIED_SETTLE_MS` :21）后收 `unconfirmed-timeout`，绝不伪造终态（:105-119）。
6. 失败处理：重试命令重进同一门 + 通道/回执流（`hotReloadRetryCommand.ts:101-303`，`source:'retry'` :136-147）。

### HR-AUDIT-004 — 模块身份与模板变量（双名模型）

- **双名解析器** `resolveModuleDualName`（`src/backend/hotReloadTempEdit.ts:61-102`）：KBEngine 进程角色目录 `base|cell|client|bots`（:58-59）从模块段**剥除**（:94）——baseapp 把 `scripts/base` 装载为进程根，`sys.modules` 无 `base.` 前缀（理由 :50-57；即 2026-11-12 「已发送未应用」bug）。返回 `fullModule`（:97）+ `requestModule`（最后一段真实模块目录 + 文件干，:98）。
- **legacy 解析器** `resolvePythonModulePath`（`src/backend/httpRequests.ts:130-156`）：`__init__.py` 包界逐级上溯，**在角色目录处断链**（:150-152）；`resolveDefaultHotfixModule` 回退（`hotReloadDefaultHotfix.ts:44-53`）与 legacy `${module}` 使用。
- 默认热修模块选择：给 `scriptRoot` 走双名，否则 legacy 上溯（`hotReloadDefaultHotfix.ts:44-53`）。
- `__init__.py` 除双名路径的拒绝分支（:82）外无特判；大小写保留；`.pyi`/`.pyc` 不匹配（`$` 锚）。
- 变量清单：自定义 `${module}`/`${moduleBasename}`/`${filename}`/`${line}`/`${sel}`（settings 路径）+ 官方 VS Code 家族（`variableSubstitution.ts`）+ 通道占位符 `${files}`（JSON 数组）、`${fileList}`、`${targetId}`（`hotReloadTransport.ts:89-92`）。取值仍不做 URL 编码。
- 派生 `package` 字段不再把无点模块报成自己的包（`src/backend/fileChangeMeta.ts:381-385`）。

### HR-AUDIT-005 — Watcher：创建、用途、生命周期

| 位置 | 模式 | 用途 | 生命周期 |
| --- | --- | --- | --- |
| `src/hotReload.ts:935`（`attachWatcher` :928-946） | 逐显式 glob / `**/*` bypass 面 / 派生双职（`assetsRoot/**/*.py`） | 热更：change/create/delete → `pendingTriggers` → 全局去抖 → 门 → 发送 | `enabled` 前不挂（启动 `apply()` :1035）；配置变更全量重建（:1010-1020，签名 :883-890）；复合 dispose :1021-1034 |
| bypass 合并器 | `**/*` 非 py 面 | 30ms 共享文件事件合并 → 状态/版本簿记（`createSharedFileEventMerger`，`src/backend/sharedFileEvents.ts:47,91`） | 同一复合体 |
| `src/extension.ts:491` | `**/*.{py,def,xml}` | python 类索引失效 | 不变 |
| 其余 watcher | 与 2026-11-11 审计一致（config 视图、资产再生、stubs、CodeLens、mapping、workspace 索引、debug config） | — | — |

事实：触发**仍是单一全局去抖**——逐文件信息在 `pendingTriggers` 积累、整体清空（:420-421）；逐文件智能活在版本册（`hotReloadFileVersion.ts:154`）与状态机（`hotReloadFileState.ts:159`），均由 watcher 事件供料。保存事件：现存 4 处 `onDidSaveTextDocument` 注册（`src/globalDataIndex.ts:233`、`src/extension.ts:568`、`src/activate/hotReload.ts:603`——仅装饰/lens 刷新、不发送、`src/activate/diagnostics.ts:562`）；**无一触发发送**；`onWillSaveTextDocument`：零。

### HR-AUDIT-006 — HTTP 能力清单（不重造轮子）

| 能力 | legacy 快速请求服务（`httpRequestService.ts`） | 通道传输（`hotReloadTransport.ts`） | 默认热修 |
| --- | --- | --- | --- |
| 方法 | 任意，默认 GET | 模板方法原样 | 固定 POST |
| 头 | 发送（settings 条目） | 替换后发送；默认通道自动 `Content-Type` | form-urlencoded |
| 体 | 模板化 | JSON 对象自动增附 `targetId`（:306-321）+ `sender_digests`（:326-353） | `module_name=<module>` |
| 超时 | 固定 10s（`DEFAULT_HTTP_TIMEOUT_MS`，`httpRequestService.ts:22`） | 同一执行器 | 同 |
| 探测 | 无 | GET 空体探测（:263-287） | 无 |
| 响应 | 2xx/否则归为 `ok`（任意状态码） | 回执协议；非 2xx = 逐文件 `failed`（:373-380）；非 JSON = `sent`（「无协议回执,不 claim applied」，:171-177） | 200-299 ok，否则失败 |
| 重试 | 无 | 无（仅显式重试命令） | 无 |
| 取消 | 无 | 无 | 无 |
| SecretStorage | 零使用（不变） | 无 | 无 |

### HR-AUDIT-007 — 状态 / 历史 / UI 面

- 状态灯：共 8 盏，全 Right——100 服务器计数、99 telnet、**98 热更发送状态**（`src/hotReloadStatus.ts:168`；7 态 :40-70：关/就绪/就绪(未监视)/发送中/已发送(未确认)/已应用/失败 + HOT-VER 版本后缀 `v3`/`v2→v3` :421-422）、97 解释器、**96 热更通道**（`hotReloadChannelConfig.ts:434`；`默认(http)` 标签，探测失败变红）、95 控制台尾随、94 Kode 核心、93 MCP 开关。
- 文件装饰：全局 provider（`src/activate/hotReload.ts:582`），5 种装饰态——DIRTY/D 橙、SENT/S 蓝、APPLIED/A 绿、FAILED/F 红、RESTART_REQUIRED/R 紫（`src/backend/hotReloadFileState.ts:358-368`），按文件最劣胜出。
- CodeLens 于 `**/*.{py,def}`：文件顶部状态行（状态 | 基线 hash12 | 最近时间 | 原因）（`src/hotReloadFileStateLens.ts:32-45`）。
- 命令：filterByState（DIRTY ∪ SENT 报告）、showFileState（逐文件详情）、showBatchSummary（按目标最劣胜出，`hotReloadBatchSummary.ts:45-50`）、retryFailed、showRevisionEvidence（fileHash/semanticHash/engineDigest）、confirmDefBaseline（清 R 标）、toggle、switchChannel、configureChannel、materializeGlobs、tempEdit.run、showLog。
- 历史：**无 webview/TreeView 历史存储**——OUTPUT 通道 `KBEngine 热更新` 只追加台账 + 版本台账倾倒是唯一历史。
- 通知：首跑通知（每工作区一次，`hotReloadNotice.ts`），按钮 Open logs / Turn off now；每次发送的错误通知。

### HR-AUDIT-008 — `.def` Hash / Digest 现状

- `hashDefContent`（`src/backend/hotReloadDefHash.ts:39-43`）：原始 UTF-8 + byteLength 的 sha256；边界声明「仅本地对账」。**未接线进任何门——生产调用方为零（仅测试）。**
- 活的门是**结构的、不是内容哈希**：`classifyDefChange`（`hotReloadDefStructure.ts:186`）指纹化 Properties `{Type,Flags,Persistent,Utype}`（:109-119）、方法 Arg 签名（:120-129）、Parent/Interfaces/Components（:130-153）；注释/空白/顺序/描述非结构（:5-11）；解析失败 = 保守判结构（:189-195）。
- 引擎摘要：`negotiateEngineDigest`（:172）——仅当递交 32 字符引擎格式 MD5 才 `md5`（客户端侧在 Rust 计算，`computeDefMd5InRust`，消费方 `src/defMd5Check.ts:213,225`，命令 `kbengine.def.checkEngineMd5`，判定 `match|mismatch|unverifiable`）；`compareEngineDigest`（:203-217）**永久拒比**（两分支均 `comparable: false`）——原文 sha256 与引擎复合 MD5 永不交叉比较。
- 修订证据（`hotReloadRevisionEvidence.ts`）：三类 `fileHash`（本地 sha256）/ `semanticHash`（结构指纹哈希，`hotReloadDefStructure.ts:165`）/ `engineDigest`（仅从响应解析，:85-108）；跨类比较一律 `incomparable`（:52-60）。
- 引擎 API 元数据：`KBEngine.reloadScript(fullReload)`（baseapp/cellapp）仍是唯一引擎侧热更面；`reloadEntityDef()`/`isReload()` 已按不存在撤回。

### HR-AUDIT-009 — 服务端协议证据

- **HTTP 回执契约（现已端到端实现）**：请求 = 通道体 JSON 对象（自动 `targetId` + `sender_digests`）；响应 = JSON（数组或对象），逐项 `file`（原样回声，必需）、`status` ∈ `accepted|applied|failed`（+`reason`）、可选 `targetId`（不匹配 → 拒收）、`digest`（applied 要求与冻结 sha256 相等）、`note`、`revision`（仅数字）。非 JSON → 全 `sent`。（`hotReloadTransport.ts:163-253`）
- **官方通道回声契约**：telnet 控制台 exec 脚本带唯一标记 `KODE_RELOAD_<uuid>:`；载荷 `{files,targetId,sender_digests}`；引擎装有 `KodeHotReload` 时优先（`hotReloadTransport.ts:558-561`），回执经打印标记行返回，重走同一 HTTP 回执解析器（:582-590）；无观察者：Traceback → `failed`，否则 `sent`（「引擎无回执协议」）。
- demo 接收器：`templates/demo-game/scripts/common/KodeHotReload.py`——HTTP 回环 `/hotfix` `/reload` `/status`，端口 8090 base / 8091 cell（env 可覆盖），校验 `sender_digests`，计算 sha256，回 `applied`，cell 文件 base→cell 下传；`xreload.py` = Guido van Rossum xreload 的 Python 3.7.3 适配。
- applied-revision 可查询性：**仍未实现**——无轮询/校验请求；`revision` 仅从回执解析（信息性）。
- 目标进程识别：`targetId` 是通道附挂的标签（内建通道为 `'default'`，实例化通道另给），不是服务端发现的进程身份——真实部署如何映射：`unknown`。

### HR-AUDIT-010 — 真实工程测试记录

- **外部真实引擎/HTTP 服务：本环境仍未测过**（与 2026-11-11 一致）。
- 现在比脚本化传输多出的东西：demo 回环桥（Python）+ pytest 套件 `tests/python/test_xreload_py37.py`（220 行，CPython 3.7.3 + 更新版）、`test_demo_hot_reload.py`、`test_demo_official_reload.py`；TS 接收端往返 harness（`tests/hotReloadReceiverRoundtrip.test.ts`，helpers/hotReloadReceiverHarness）覆盖 200-but-unapplied / 摘要不匹配 / 过期 generation / 非 JSON / 非 2xx / targetId 不匹配各类；~49 个热更测试文件 ≈560 例。
- HR-AUDIT-010 余项（真实网络静默、真实模块名冲突、生产服务原始响应捕获）：阻塞于活的服务实例。

### HR-AUDIT-011 — 保留 / 包裹 / 替换矩阵（刷新）

| 既有模块 | 裁定 | 理由 |
| --- | --- | --- |
| legacy 快速请求入口解析 + 模板（`backend/httpRequests.ts`） | **保留** | 通用 Quick Requests 不得回退；legacy `${module}` 兼容照旧 |
| `backend/httpRequestService.ts` 传输 | **保留** | 现兼通道传输执行器；单一接缝 `ReloadHttpRunner` |
| `hotReloadTransport.ts` 通道抽象 | **保留** | HR-HTTP 适配器接缝本体（http + kbengine-official） |
| `hotReload.ts` 全局去抖 watcher | **渐进替换**（HR-WATCH 逐文件管道仍欠） | 逐文件去重/语法门/稳定等待未建 |
| `resolvePythonModulePath` | **保留为 legacy** | 双名 `resolveModuleDualName` 是热更面；两者都剥角色目录 |
| 状态机 / 回执 / 重试 / 证据 / UI 簇 | **保留** | 已实现 HR-STATE/HR-UI/HR-HTTP 的很大部分 |
| `hashDefContent` | **待决**（接线或删除） | sha256 面在，生产调用方为零 |
| `buildCurlCommand`（`src/quickActions.ts:205`） | **保留或删除** | 仍仅测试使用 |
| demo 接收器 `KodeHotReload.py`/`xreload.py` | **保留**（模板作用域） | 参考接收器，不作为引擎代码随发 |

### HR-AUDIT-012 — 复用模块路径与归属

| 复用目标 | 精确路径 | 关键导出 | 归属 |
| --- | --- | --- | --- |
| 触发/去抖/门编排 | `src/hotReload.ts` | `setupHotReload`、`readHotReloadSettings`、`planHotReloadWatch`、`HotReloadTrigger` | cuihairu |
| 激活接线 + 命令 | `src/activate/hotReload.ts` | `activateHotReload` | cuihairu |
| 通道传输 | `src/backend/hotReloadTransport.ts` | `ReloadTransport`、`HttpReloadTransport`、`KbengineOfficialTransport`、`resolveReloadTransport`、`parseReloadHttpReceipts`、`createDefaultHotReloadChannel` | cuihairu |
| 台账 + 版本 | `src/backend/hotReloadTargetState.ts` | `HotReloadTargetStateStore`、`HotReloadDeliveryRecord` | cuihairu |
| 回执链 | `src/backend/hotReloadDelivery.ts` / `hotReloadReceipt.ts` / `hotReloadAppliedCheck.ts` | `classifyHttpDelivery`、`parseHotReloadAcceptedReceipt`、`verifyAppliedReceipt`、`settleAppliedStatus` | cuihairu |
| def 门/哈希 | `src/backend/hotReloadDefGate.ts` / `hotReloadDefStructure.ts` / `hotReloadDefHash.ts` | `createDefStructuralGate`、`classifyDefChange`、`hashDefContent`、`negotiateEngineDigest` | cuihairu |
| 模块身份 | `src/backend/hotReloadTempEdit.ts` / `backend/httpRequests.ts` | `resolveModuleDualName`、`resolvePythonModulePath`、`PYTHON_PROCESS_ROLE_DIRS` | cuihairu |
| UI 面 | `src/hotReloadStatus.ts`、`hotReloadFileDecorations.ts`、`hotReloadFileStateLens.ts` | `HotReloadStatusController`、`HotReloadFileDecorationProvider`、`HotReloadFileStateCodeLensProvider` | cuihairu |
| legacy 快速请求 | `src/backend/httpRequests.ts` / `httpRequestService.ts` / `src/variableSubstitution.ts` | `parseHttpRequestEntries`、`buildHttpRequest`、`HttpRequestService`、`resolveVariableExpression` | cuihairu |

## 2. 已实现 vs 缺失 vs unknown（汇总矩阵）

| 面 | 已实现（证据见上） | 缺失 / unknown |
| --- | --- | --- |
| 手动 HTTP 快速请求 | 是（settings + debug.json 双路，不变） | 逐条目超时、重试、密钥 |
| 模板变量含 `${module}` | 是 + 双名模型（角色目录剥除） | URL 编码；legacy 快速请求的 `${targetId}` |
| Watch → 触发 | 是（glob 显式/派生/bypass；默认自动开） | 逐文件去抖去重、语法门、稳定等待、保存触发 |
| def 结构门 | 是（发送拦截 + RESTART_REQUIRED + 确认命令） | — |
| `.def` 文件哈希 | sha256 面存在（`hashDefContent`） | **未接线进任何门** |
| 语义指纹 | 结构指纹哈希（作修订证据） | 证据展示之外未接线 |
| 引擎摘要 | md5 协商桩 + `defMd5Check` 命令比对 | 与真实引擎的算法协商：`unknown`；交叉比较永久拒比 |
| 成功确认 | accepted 回执 + applied 摘要双证据 + 10 秒沉降 + 最劣胜出聚合 | applied-revision 轮询：无；真实引擎语义：`unknown` |
| 状态/UI | 2 盏灯、5 态装饰、CodeLens、批摘要、证据/重试/状态命令、首跑通知 | 历史 webview/TreeView：无；applied 时间线视图：无 |
| 重试 | 显式命令、单遍、过门、通道重入 | 无自动退避/次数上限 |
| 接收侧 | demo 回环桥 + xreload（py3.7.3）+ 参考接收器 + 回执协议 | 生产级外部接收器：`unknown` |
| 已知缺陷（本审计记录，不在此修） | — | 首跑通知「打开日志」点击比较硬编码 `'打开日志'` 对 `l10nText('Open logs')`——非 zh locale 下按钮打不开日志通道（`src/hotReload.ts:1046` vs `src/backend/hotReloadNotice.ts:39`） |

## 3. 与 2026-11-11 相比的事实/unknown 结转

上次审计以来由实现解决的：状态/历史面（§19.6/§19.7 不再是空地——灯/装饰/lens/台账已存在）、成功确认模型（accepted/applied 契约 + 沉降）、def 结构门、双名模块身份、带默认值的通道模型。仍 `unknown`：生产（非 demo）服务的响应契约、引擎 Digest 算法、applied-revision 查询、目标进程身份映射、全部真实网络行为（HR-AUDIT-010）。

## 4. HR-PR-02 增量（2026-11-13,模块身份纯面）

本块落地(纯逻辑 + 模板层;无新增用户可见发送路径):

- `src/backend/hotReloadModuleIdentity.ts` —— `HotReloadModuleIdentity` 九字段 DTO(HR-MOD-001)+ `resolveHotReloadModuleIdentity` 纯解析器(HR-MOD-002:根候选选择 → 委托 `resolveModuleDualName` → 诊断;零 IO、零 vscode 导入)+ `canonicalizeScriptFilePath` 词法规范化(HR-MOD-009:`file://` 剥 scheme + 有守卫的 percent 解码、反斜杠转正斜杠、UNC `//` 保留、重复斜杠折叠、`.`/`..` 词法消解、盘符大写、大小写保留;符号链接与 fs 级大小写语义属 IO 专项,明确不在纯面内,与 kode-vfs VFS-001 同边界)。
- 核心 `resolveModuleDualName`(成功形状不变,toEqual 钉住)现给每个 unsupported 返回带机器可读 `reason` 码(HR-MOD-002 诊断映射单源),并接受显式 `allowRootLevelStem`(HR-MOD-008 single-level fallback;默认仍拒)。
- 模板层(HR-MOD-012):`buildTemplateVars`/`applyTemplate`/`applyTemplateWithContext` 增 `${reloadModule}`/`${fullModule}`/`${fileName}`/`${relativePath}`/`${workspaceRoot}`/`${targetId}`。双名仅在配置 `kbengine.hotReload.tempEdit.scriptRoot` 后解析,否则如实空串——legacy `${module}` 保持 `__init__.py` 包边界扫描语义不动(兼容决策记录于 `buildTemplateVars`;照旧不做 URL 编码,全仓契约)。
- 测试:`tests/hotReloadModuleIdentity.test.ts`(书 §19.1 四示例,含 879f47d5 引擎实证偏差 `base/Avatar.py → Avatar`;规范化;多根唯一/根外/歧义列全候选;相邻目录假包含;override 合法/非法;根下单层默认拒 + 显式 fallback;`%20` 解码出空白短名拒、点短名拒、Unicode 短名合法;诊断码透传)+ `tests/hotReloadTempEdit.test.ts` 核心 reason/开关例 + `tests/httpRequests.test.ts` 模板形状钉。

暂缓项与原因(账本行保持未勾,不写假完成):

- HR-MOD-006 完整 engine profile 根优先级:需要 engine-profile 配置面(kode2 §6);「不猜」的歧义拒绝本质已落解析器。
- HR-MOD-008 用户可见 `allowRootLevelStem` 配置键 + 发送路径接线:会改零配置默认热更行为;核心开关已落,暴露面暂缓。
- HR-MOD-010 请求线上的 root/target 上下文:接收端契约冻结待真实服务验证(HR-AUDIT-009);解析器侧 rootId + 歧义拒绝本质已落。
- HR-MOD-011 UI 显示 `fullModule`/`requestModule`:HR-UI 簇(HR-PR-06)。
- HR-MOD-013 旧配置迁移/预览 UX:用户可见命令暂缓;纯核心 + 模板双名面已存在。
- HR-MOD-014 台账/历史双名字段:历史形状扩展暂缓(HR-PR-06)。

## 5. HR-PR-03 增量（2026-11-13,通用请求执行器）

- `src/backend/httpRequestExecutor.ts` —— 单一执行路径(HR-HTTP-001):HTTP 快捷请求(`HttpRequestService.runEntry`)与默认热更(`sendDefaultHotfix`)现统一走 `executeHttpRequest` + 交换状态机(`idle→in-flight→settled` 单向,非法迁移带原因拒绝),不再各自带一套传输分支。通用 HTTP 语义不变:服务层仍按 `transportOk` = 传输面原始 `ok` 布尔分支,日志行、错误弹窗、布尔返回逐字一致。
- 结构化 outcome(HR-HTTP-010):`classifyExecution` 按传输事实映射六分类(`ok` / `non-2xx` / `timeout` / `network-error` / `invalid-url` / `unsupported-protocol`)+ 错误细类(`connection-refused` / `dns` / `connection-reset` / `timeout` / `invalid-url` / `unsupported-protocol` / `http-status` / `unknown`);推不出细类如实 `unknown`,不猜。回执解析(`parseReloadHttpReceipts`)在其上层,未改。
- 关联 id(HR-HTTP-014):每次执行生成 `crypto.randomUUID()`,贯穿 outcome(调用方可自带)。刻意不做请求头贯穿——那是线路字节变更,与「不做 URL 编码」同边界;线路贯穿待接收端契约解冻(HR-AUDIT-009)。
- Mock server e2e(HR-HTTP-017):`tests/httpRequestExecutorMockServer.test.ts` 用真 node 传输面打每例独立的临时服务(端口 0)——2xx JSON 回执→applied、2xx 非 JSON→`sent`(不 claim applied)、500→`non-2xx`、慢响应+短超时→`timeout`(服务端随后仍完成 200:本地超时绝不报成应用失败)、端口已关→`connection-refused`、响应中途摧毁 socket→`connection-reset`、chunked 拼接、重复请求(2 次命中,关联 id 各自独立)、URL 无法解析/协议不支持。
- 缺陷修复(由新 e2e 发现):默认传输在服务端响应中途中断时**永不结算**——node 在响应流上发 `aborted`,而 `req` 已随 socket 销毁,`req.on('error')` 与 socket 超时都无法解决该 promise,调用方永久挂起。旧注释声称由 `req.on('error')` 统一收口,实测不成立。现由 `res.on('aborted')` / `res.on('error')` 显式收口为失败(Promise 只认首次 resolve)。既有的服务层「不悬挂」测试仍绿,因为它注入的是假传输——mock-vs-wire 契约漂移。
