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
| 触发核心 | `src/hotReload.ts`（1118 行） | 设置读取、watch 计划、两级触发链（HR-PR-04 接线，:825-859）：进料级保存流水线 `HotReloadSavePipeline`（:840-858，每文件尾窗去抖/max-delay 封顶/去重指纹/版本号）+ 合并窗 `HotReloadTrigger`（:224-265，`pending()` :255）；发射路径编排：def 门（:786-818）→ 通道发送（:570）→ actionName 快速动作（:618）→ 默认热修 POST（:436-455）；watcher 挂载/重建（:976-1062）；配置变更重建（:1064-1074） |
| 激活接线 | `src/activate/hotReload.ts`（742 行），自 `src/extension.ts:1360-1367` 进入 | 台账 + 版本追踪 + 状态控制器实例化（:91-133），def 门共享实例（:246-250），全部 12 条命令注册，装饰/lens provider 注册（:574-615） |
| 发送簇 | `src/backend/hotReloadDefaultHotfix.ts`、`hotReloadChannelConfig.ts`（679 行）、`hotReloadChannelSend.ts`、`hotReloadTransport.ts`（739 行）、`hotReloadDelivery.ts` | 通道配置面板 + 快速切换灯；带回执切换的批式通道发送；传输抽象（http / kbengine-official）；投递分类器 |
| 回执簇 | `src/backend/hotReloadReceipt.ts`、`hotReloadAppliedCheck.ts`、`hotReloadRetry.ts`（65 行）、`hotReloadRetryCommand.ts`（361 行）、`hotReloadRevisionEvidence.ts` + `Command.ts`、`hotReloadTargetState.ts`（401 行）、`hotReloadBatchSummary.ts` + `Command.ts` | accepted 回执解析器；applied 摘要双证据 + 10 秒沉降；重试规划 + 单目标重发命令；三类修订证据；双维度投递台账 + HOT-VER 版本册；按目标聚合 |
| 状态/UI 簇 | `src/backend/hotReloadFileState.ts`（368 行）、`hotReloadFileStateFilter.ts`、`hotReloadFileVersion.ts`（303 行）、`src/hotReloadStatus.ts`（476 行）、`src/hotReloadToggle.ts`、`src/hotReloadFileDecorations.ts`、`src/hotReloadFileStateLens.ts`、`src/backend/hotReloadNotice.ts`、`src/backend/hotReloadGlobsMaterialize.ts`、`src/backend/hotReloadTempEdit.ts`、`src/backend/hotReloadDefGate.ts`、`hotReloadDefHash.ts`、`hotReloadDefStructure.ts` | 生命周期状态机；关注过滤/详情命令；按文件版本册；发送状态灯；开关；文件装饰；CodeLens；首跑通知；globs 物化；临时编辑热更；def 结构门；def 哈希三路径；def 结构分类器 |
| Legacy 快速请求 | `src/backend/httpRequests.ts`、`src/backend/httpRequestService.ts`、`src/quickActions.ts`、`src/quickActionConfig.ts`、`src/quickActionTree.ts`、`src/variableSubstitution.ts`、`src/backend/debugJsonSchema.ts`、`src/debugConfigBootstrap.ts` | 语义不变；已迁至 `src/backend/`（SRC-001）；HTTP 注册现位 `src/activate/views.ts:233-303`（调用点 `src/extension.ts:1276-1277`） |
| 接收侧（仓内，非扩展） | `templates/demo-game/scripts/common/KodeHotReload.py`（352 行）+ `xreload.py`（214 行，Python 3.7.3），镜像于 `tests/fixtures/kbengine-demo-assets/`；`scripts/hot-reload-receiver/referenceReceiver.mjs` | demo 回环桥：127.0.0.1 上 HTTP `/hotfix` `/reload` `/status`，端口 8090 base / 8091 cell；xreload = Guido van Rossum 算法适配 3.7.3；摘要校验 + applied 回执 |

### HR-AUDIT-003 — 发送路径端到端链（现行发射路径）

1. 触发（HR-PR-04 接线后两级）：FileSystemWatcher 事件 → `scheduleHot`（`src/hotReload.ts:1032-1038`）→ 进料级 `HotReloadSavePipeline.offer`（每文件尾窗去抖，同文件连发归并；`pipeline.offer` :287 起）+ 合并窗重排（`trigger.schedule` :1037）→ 定稿汇入 `pendingOut`（:832）→ 合并窗 fire（:834-841）→ `runFire`（:429）。
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
| `src/hotReload.ts:976-994`（`attachWatcher` :976-994） | 逐显式 glob / `**/*` bypass 面 / 派生双职（`assetsRoot/**/*.py`） | 热更：change/create/delete → `scheduleHot`（:1032-1038）→ 进料级流水线 offer + 合并窗重排 → 门 → 发送 | `enabled` 前不挂（启动 `apply()` :1092）；配置变更全量重建（:1064-1074，签名 `watchSignatureOf` :939-947）；复合 dispose :1075-1090 |
| bypass 合并器 | `**/*` 非 py 面 | 30ms 共享文件事件合并 → 状态/版本簿记（`createSharedFileEventMerger`，`src/backend/sharedFileEvents.ts:47,91`） | 同一复合体 |
| `src/extension.ts:491` | `**/*.{py,def,xml}` | python 类索引失效 | 不变 |
| 其余 watcher | 与 2026-11-11 审计一致（config 视图、资产再生、stubs、CodeLens、mapping、workspace 索引、debug config） | — | — |

事实：触发在 HR-PR-04 接线（2026-11-13）后是**两级链**——进料级 `HotReloadSavePipeline`（每文件尾窗去抖、max-delay 封顶、去重指纹/版本号册；稳定窗/语法闸未注入=如实不做）、合并窗 `HotReloadTrigger`（:224，def 闸「整批拦下」契约依赖同批共见，逐文件直发会让混批里的 py 绕过闸）；逐文件智能仍在版本册（`hotReloadFileVersion.ts:154`）与状态机（`hotReloadFileState.ts:159`），均由 watcher 事件供料。保存事件：现存 4 处 `onDidSaveTextDocument` 注册（`src/globalDataIndex.ts:233`、`src/extension.ts:568`、`src/activate/hotReload.ts:603`——仅装饰/lens 刷新、不发送、`src/activate/diagnostics.ts:562`）；**无一触发发送**；`onWillSaveTextDocument`：零。

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

## 6. HR-PR-04 增量（2026-11-13,保存事件流水线纯核）

- `src/backend/hotReloadSavePipeline.ts` —— 纯核,零 IO 零 `vscode` 导入(时钟、定时器、快照读、语法检查全部注入;与 `kode-vfs` VFS-001、`hotReloadModuleIdentity` 同边界)。装配面(vscode 事件绑定、配置面、默认开关)不在本核。
- 每文件去抖(尾窗)+ 全局 max-delay 封顶(HR-WATCH-006):再发事件**重排**去抖窗(真尾窗,不是固定前置窗),且排窗预算以 `maxDelayMs` 为上限,save storm 至多推迟到 max-delay,绝不无限推迟;封顶截断如实记 `max-delay-capped` 因。封顶在**排窗时**生效而非到期时补判——尾窗公式已把 timer 限制在 `first + maxDelay`,到期补判不可达。首窗同样封顶(`min(debounceMs, maxDelayMs)`),故 `maxDelay < debounce` 时窗即封顶。
- 事件源归并(HR-WATCH-003/009):同 canonical URI + 同 pending 归并为一条 `FileChanged{uri,revision,diskHash,source,time}` 并记合并原因;`disk-save-overlap` 只在 save→disk-change 方向记录(一次写盘同时触发两类事件),代表源取最新一次。
- 写入稳定(HR-WATCH-007):两拍快照哈希一致才发;探测次数有界(`maxStabilityProbes`),超限如实发末拍快照并记 `unstable-after-N-probes`。读不到/已删除如实丢弃并记诊断,不猜。`settling` 守卫阻止同一 URI 在异步两拍等待期间并行起第二个定稿。
- 波次归集:同一去抖窗内定稿的文件合成一批发出(波次冲口 `batchFlushMs`)。没有波次的话每次定稿只传 1 个事件,HR-WATCH-016 的批量阈值**永远无法触发**——原批处理路径是死代码。
- 去重键(HR-WATCH-010):canonical URI + targetId + 内容哈希,复用 HR-PR-02 的 `canonicalizeScriptFilePath`(`file://` 与裸路径同归一条)。
- 版本守卫(HR-WATCH-011):`revision` 只在**实际发出的新内容版本**递增——去重与语法拦截不占号。若在 offer 时占号,同内容在途响应会被 `isStaleResponse(sent, current)` 误判 stale。
- 投递指纹与去重指纹分离(HR-WATCH-008):指纹在批次交给发送面的那一刻记(`emitBatch` / `releasePreview` 内),因为本核不知投递成败;投递失败由装配调 `forgetSent(file)` 撤回,同内容不会被一次失败永久跳过。
- 语法闸(HR-WATCH-012)注入式,不通过出 `blocked` 且不发送半成品。每次定稿只检查一次(初版调了两遍,已改)。
- HR-WATCH-014 `dispose` 一并清空 pending/波次/预览滞留,并停止受理新事件。HR-WATCH-016 超阈值批次只预览、显式放行才发;滞留期间新批次并入同一滞留批次。HR-WATCH-017 诊断事件:`trigger` / `filtered` / `debounced` / `deduped` / `blocked` / `scheduled` / `preview` / `flushed`。
- `isWatchableScriptFile`(HR-WATCH-004)纯词法过滤:扩展名(缺省 `.py`,大小写不敏感)、显式根集合按严格前缀+整段边界匹配(`/ws/scripts` 不认领 `/ws/scripts2`)、默认排除目录(`.git`、`.venv`、`venv`、`node_modules`、`__pycache__`、`.kbengine`、`.mypy_cache`、`.pytest_cache`、`.ruff_cache`)与调用方追加项取并集、备份/临时文件名(`.swp` / `.swo` / `.bak` / `.tmp` / 尾 `~` / `#名#`)。
- 装配接线(2026-11-13 已落):save 侧与 disk 侧均已汇入两级触发链(见 §12/§13)——进料级 `HotReloadSavePipeline`(每文件尾窗去抖/max-delay 封顶/去重指纹/版本号)+合并窗 `HotReloadTrigger`(def 闸整批契约);测试替身时钟 handle 撞号(`handles.size` 作 id)在重接中暴露并对齐真 setTimeout 单调语义(20 个测试文件统一修正)。余下暂缓:模式选择配置面(稳定窗/语法闸/波次归集窗/批量预览阈的配置键与注入面)随配置面子批——现注入面缺省=稳定窗/语法闸不做、0 冲口定稿即汇合并池,与既有全局去抖时序同感。
- 测试:`tests/hotReloadSavePipeline.test.ts` 31 例,时钟与定时器全虚拟(内存 timer 队列,`advance()` 按到期序冲)。prove-red 三轮:去掉 max-delay 封顶 → save storm 用例转红;关掉预览阈值判断 → 3 个预览用例转红;让 `forgetSent` 空转 → HR-WATCH-008 用例转红。

## 7. HR-PR-05 增量（2026-11-13,磁盘监视装配核）

- `src/backend/hotReloadDiskWatch.ts` —— 装配核,零 `vscode` 导入:FileSystemWatcher 以 `DiskWatcherFactory` 注入(真接线适配 `vscode.createFileSystemWatcher`;测试用内存 watcher 总线),与保存流水线纯核同边界。
- HR-WATCH-004 watcher 面:`watchRoots` 每个规范化根派生一条递归 glob(根下全部 `.py`;`deriveWatchGlob` 供适配面复用),根外事件天然到不了控制器。排除目录由过滤层拦下并记 `filtered` 诊断;备份名在 watcher glob 层就到不了(`.py` glob 不会送达 `.bak` 名——测试实测),`isWatchableScriptFile` 保留作更宽事件源的深层防御。
- HR-WATCH-015 基线闸:`arm()` 之前到达的磁盘事件一律丢弃并记 `dropped-before-arm` 诊断——激活期先建 watcher 后 arm,启动绝不把既有文件当变更。`rebuild` 保持 `armed`:重建 watcher 不重开基线窗(真 watcher 重建不补发既有文件;重开反而制造启动全仓发送风险)。
- HR-WATCH-003:change/create 事件经滤波后以 `disk-change` offer,先规范化——与发送面同键,`file://` 与 UNC `//wsl$` 形态与裸路径同归一条。delete 事件不进管线(只记 `delete-ignored` 诊断):已删除文件由流水线稳定等待如实丢弃。save 与 disk 重叠经真流水线归并为单事件并记 `disk-save-overlap` 因,不双发。
- Git 批量变更(切分支/checkout 爆发)由流水线三层兜住,且经真 HR-PR-04 核全链验证:30 文件爆发归集单波次一批(不放大);还原同字节即去重(checkout 未变内容不重发);超预览阈值的爆发只滞留预览、显式放行才发(HR-WATCH-016 兜底)。
- HR-WATCH-005 控制器面:`dispose` 全 dispose 每个 watcher 且后续一切调用拒收(含 `watchRoots` / `arm` / `rebuild`);`rebuild(roots)` 全 dispose 旧 watcher 按新根重建,`armed` 保持。
- 记一个 JSDoc 坑:块注释里写 `/**/*.py` 字面量会自我截断(内含 `*/`),症状是 TS1109 级联解析错——注释一律用文字描述 glob,字面量只留在字符串字面量里。
- 装配接线(2026-11-13 已落,save+disk 双侧):watcher 事件(save 形态)与磁盘事件(`disk-change` 形态,经真 `vscode.createFileSystemWatcher` 适配汇入)都已喂进两级触发链(见 §6/§12/§13)。§6 所记 HR-WATCH-001 冲突已按 2026-11-06 用户令解决;模式选择配置面 2026-11-13 已落(见 §14)。
- 测试:`tests/hotReloadDiskWatch.test.ts` 16 例——内存 watcher 总线 + 虚拟时钟,驱动真保存流水线全链。prove-red 两轮:拆掉基线闸 → HR-WATCH-015 用例转红;旁路过滤层 → filtered 诊断用例转红。门禁:lint 0 / tsc 0 / unit 754 文件 9286 例 / xvfb demo 25 RC=0。

## 8. HR-PR-06 增量（2026-11-13,ui-status 审计 + 历史库纯核）

- 先说审计结论:HR-UI 簇相当一部分已有 live 面且有测试钉——七态状态机(`src/hotReloadStatus.ts`,含 `watch-off` 按 §11.1 双原因如实分注)、文件装饰+定点 CodeLens(`hotReloadFileDecorations.ts` / `hotReloadFileStateLens.ts`)、可信回执语义(`setApplied` 仅回执核验后;2xx 无业务回执走 `setSentUnverified`)、重试族(`hotReloadRetry` 纯核+命令+通道+def 闸,四个钉文件)。凭此证据勾掉账本 HR-UI-001/003/009。
- 真正缺的是历史:全仓此前无任何历史存储。新纯核 `src/backend/hotReloadHistoryCore.ts` —— 零 `vscode` 导入,容量语义注入,与流水线/磁盘监视核同边界。
- 行形状(HR-UI-002/006/HR-MOD-014):每行同存 `fullModule` 与 `requestModule`,外加 `fileUri` / `targetId` / `time` / `requestId` / `status` / `errorSummary` —— 用户看到的名称与请求携带的名称永不混用。`buildHistoryEntryLabel` 标题取 `fullModule`(缺失如实回落);`buildHistoryEntryTooltipLines` 投影 requestModule(仅双名不同时)/file/target/time(ISO)/requestId/status/error。
- 行身份:`requestId`(HR-HTTP-014 每次执行生成)。同 id 重记录=原位幂等替换,不重复成行,顺序不动;同文件不同 target 保持两行(HR-UI-010/014),`targetId` 是行身份的一部分。
- 可信回执同口径(HR-UI-009):状态迁移单向 `sent-unverified → applied | failed`;终态拒一切迁移、同态重写也拒,各自如实返回 `false` 不静默装成功;被淘汰/不存在的 id 同样如实 `false`。
- 过滤(HR-UI-010):全条件 AND——`fullModuleContains`(大小写不敏子串)/`targetId`/`fileUri`/`status`/含边界时间范围。
- 高频合并+有界内存(HR-UI-007):`coalesceHistoryUpdates` 同 requestId 窗内多条合并取末态(跨窗不合并;不同 requestId 各自独立);`page(offset, pageSize)` 返回 `{items, total, hasMore}`,越界如实空页;缺省容量 200,淘汰最旧。
- 树视图分组(HR-UI-002):`groupByFile` / `groupByTarget` 组键按首次出现序、组内最新在前(喂 `newestFirst()`)。
- 装配接线刻意暂缓:TreeView/面板/搜索框注册、配置面(HR-UI-005)、i18n+无障碍渲染(HR-UI-011)、生命周期绑定(HR-UI-012)、点击动作(HR-UI-008 定位/开日志)随接线批。
- 测试:`tests/hotReloadHistoryCore.test.ts` 16 例。prove-red 三轮:放开终态迁移 → 迁移守卫用例转红;去掉大小写不敏 → 子串用例转红;拆掉合并窗 → 合并用例转红。门禁:lint 0 / tsc 0 / unit 756 文件 9302 例 / xvfb demo 25 RC=0。

## 9. HR-PR-07 增量（2026-11-13,def-fingerprint 审计 + 三路比对纯核）

- 先审计:三层 Hash 已全在 live 且有钉——`hashDefContent`(原始字节 sha256)/`structuralFingerprintHash`(规范化结构指纹)/`negotiateEngineDigest`(md5=C-18 规范推导,或如实 `unknown`),且 `hotReloadRevisionEvidence` 对三类各自点名来源、拒跨类比较。凭证据勾 HR-HASH-001/003/004/005(004 走「如实标注」臂,003 缺的规范版本由本批补)。
- 新纯核 `src/backend/hotReloadFingerprintCompare.ts`:
  - HR-HASH-008 `compareFingerprints` —— 三路独立结论:`fileChanged` 只比 fileHash 对,`semanticChanged` 只比语义指纹对,`appliedConsistency` 要三环齐(引擎算法已协商+引擎回执 Digest+本地按同算法重算)才给 consistent/different;缺任一环如实 `unknown` 并点名原因。跨类比对(客户端 sha256 vs 引擎复合 MD5)绝不执行——继承 `compareEngineDigest` 的纪律。
  - HR-HASH-006 `resolveFingerprintProfile` —— 协商出算法 label=算法名;协商不出如实标 `not available`,绝不猜。
- 新测试抓住真缺陷:`compareSameKind` 把空串判放在 null 判之前,语义指纹为 null(def 解析失败)时直接 `TypeError: Cannot read properties of null` 崩溃。修复=null 判序先于 length 取值。
- `hotReloadDefStructure.ts` 加性扩展:`DEF_FINGERPRINT_SPEC_VERSION`(`'def-structural-fp/1'`,指纹值按版本走、跨版本不可比)与 `semanticFingerprintReport`(specVersion+`scope: 'file-only-semantic'`+note 点名依赖核验义务;解析失败 `hash: null` 如实不造)。消费方(`hotReloadDefGate`、`hotReloadRevisionEvidenceCommand`)只读,不受影响。
- 装配接线暂缓:HR-HASH-002(变更时 VFS 字节复用)/006 profile 消费面/007 完整 Hash Inspector UI/008 修改触发与结论呈现——随接线批;009 差异分类细化另账。
- 测试:`tests/hotReloadFingerprintCompare.test.ts` 11 例+`hotReloadDefStructure.test.ts` 新增 2 例。prove-red 两轮:拆协商闸 → applied unknown 用例红;改 scope 标注 → 报告用例红(null 判序缺陷修复前被 null 用例天然红=TypeError 抓获)。门禁:lint 0 / tsc 0 / unit 757 文件 9323 例 / xvfb demo 25 RC=0。

## 10. HR-PR-08 增量（2026-11-13,版本化插件 API 纯核）

- 新纯核 `src/backend/hotReloadPluginApi.ts` —— 零 `vscode`,`HOT_RELOAD_PLUGIN_API_VERSION = '1'` 钉接口形状;不兼容变更递增大版本,消费方可按版本拒绝旧实现而非静默误读。
- `FingerprintProvider` 及默认实现:纯委托既有已证核(`hashDefContent` / `semanticFingerprintReport` / `negotiateEngineDigest` / `resolveFingerprintProfile`)——不自创哈希、不替引擎猜算法(HR-HASH-005/006 纪律原样继承)。fork/版本差异靠换 provider 实现解决,默认实现绝不冒充。
- `HotReloadProvider` 发送插槽:`canSend(profile)` 按 engine profile 分派;`send` transport-faithful(结果透传不解释)。默认注册表不带任何发送 provider——resolve 返回 null 是如实态。
- `EngineProfile` 版本化:`engineVersion: null` 即未知如实(engineVersionDetect 同口径,绝不编造);`buildEngineProfile` 纯(探测值与协商输入由调用方给,本核零 IO)。
- `HotReloadProviderRegistry` 如实规则:重复 id 与 apiVersion 不符的注册带原因拒绝(绝不静默替换、绝不静默收编);`resolveSendProvider` 第一个 canSend 应答者胜,无人应答返回 `null` 不回落默认——热更是写引擎内存的动作,静默回落=拿默认实现冒充用户环境。
- 装配接线暂缓:真实扩展宿主装配(注册时机/生命周期)与 fork 侧具体 provider 实现随接线批。
- 测试:`tests/hotReloadPluginApi.test.ts` 9 例。prove-red 三轮:允许重复 id 覆盖 → 重复用例红;无人应答回落第一个注册者 → 如实 null 用例红;拆版本闸 → 版本不符用例红。门禁:lint 0 / tsc 0 / unit 758 文件 9332 例 / xvfb demo 25 RC=0。

## 11. HR-PR-09 增量（2026-11-13,可靠性门禁套件 + 性能报告）

- 新组合门禁套件 `tests/hotReloadReliabilityGate.test.ts` —— 不新增生产代码;把已证纯核(`hotReloadSavePipeline`)在风暴/过期/断网/安全场景下组合钉死,虚拟时钟零 IO。四门+缩放 soak,7 例:
  - **风暴**(HR-WATCH-006/016):50 文件×4 连发=200 offer → 每文件恰一次发出、归并=4、总量不放大;5001 文件超 5000 阈 → 只预览滞留,`releasePreview` 一批放出。
  - **过期**(HR-WATCH-011):首笔在途期间新内容发出 → v1 响应晚到=stale,不得记成新版本成功。
  - **断网**(HR-WATCH-008):投递失败在异步发送结果回调里 `forgetSent` 撤回(装配真实时序——核心在 `onEmit` 返回后才 markSent,onEmit 内同步撤回会被覆盖;harness 如实建模回调时序)。恢复后同内容照发;断网风暴 20 文件批量失败全撤回、恢复一批全重发。
  - **安全**(HR-WATCH-012):风暴中语法坏内容一律拦截——不发送、不占版本号(恢复后从 revision 1 起)。
  - **缩放 soak**:1000 文件×10=10000 offer → 恰 1000 事件、每文件一次、结束 pending 清零。
- prove-red:拆除 harness 的 `forgetSent` 撤回 → 断网门两例恰红(指纹未撤→同内容判重→不重发),恢复复绿。撤回时序建模本身就是抓出的一处测试缺陷:onEmit 内同步撤回会被核心的 onEmit 后 markSent 覆盖——套件改为如实建模异步回调。
- 性能报告:`docs/perf/2026-11-13-hotreload-reliability-gate.md`(附 run 记录)。真时钟纯内存实测:10k offer → 1000 事件,offer 登记路径 37 ms,全链 157 ms;同内容第二波全量判重(带稳定窗口径新发 0)。如实边界:**24h 真 soak 未跑**(需装配面就绪,本车道口径=缩放 soak),**仅 Linux 实测**(套件零 IO 零 vscode,凡 vitest 可跑处即可复跑;不编造跨平台数字),不含端到端网络时延(归 HR-HTTP-017 真网套件)。
- 装配级(真 watcher→真发送链)的风暴/衰减验收随接线批(HR-PR-02..08 各行保持注记不勾)。

## 12. HR-PR-04 接线增量（2026-11-13，两级触发链上线）

- live 触发链重接为**两级形态**（`src/hotReload.ts` :825-859）：①进料级 `HotReloadSavePipeline`——每文件尾窗去抖（同文件连发归并）、全局 max-delay 封顶、去重指纹/版本号册内建；稳定窗与语法闸随注入面启用（本批未注入=如实不做）。②合并窗 `HotReloadTrigger`（既有全局去抖复用，新增 `pending()` :255）——把同窗定稿合成一批交给发送编排。
- **合并窗必须存在的原因**：def 结构闸「整批拦下」契约（`tests/hotReloadDefGateWiring.test.ts` 混批用例钉死）依赖同批共见——逐文件定稿直发会让混批里的 `.py` 绕过闸单独 reload，结构性 def 变更 + py 热更同落=引擎状态不一致。两级的同刻时序靠定时器插入序保证（offer 先排进料级、后排合并窗，同拍先定稿后合并）；真机 fire 时机保持「末次事件+窗」（emit 只在合并窗无在途计时才补排，`pending()` 查询），与旧全局去抖时序同感。
- 0 冲口（`batchFlushMs: 0`）= 定稿即汇入合并池，不起波次窗；波次归集/批量预览阈/预览放行为配置面子批预留（核心机制 HR-WATCH-013/016 在库已钉，`batchFlushMs=0` 语义有核心测试钉）。
- 测试替身时钟 handle 撞号修复：20 个测试文件的 `makeTimers` 用 `handles.size` 作定时器 id，clear+set 后撞号覆写另一计时器（真 `setTimeout` id 单调，替身语义缺陷）——统一改单调计数器 `nextHandle++`。装配在途计时计数 1→2（两级）为如实重钉（4 处 `toBe(1)`→`toBe(2)`、2 处 `tick()` 返回值），行为断言零改动。
- 门禁：eslint 0 / tsc 0 / unit 759 文件 9345+8skip RC=0（+1 核心钉：0 冲口定稿即发）/ xvfb demo 25 RC=0。余下暂缓：disk 侧 `vscode.createFileSystemWatcher` 真适配与 `extension.ts` 汇入（HR-PR-05 接线子批）、配置面（稳定窗/语法闸/波次窗/预览阈配置键）、`extension.ts` 侧 revision 消费（stale 应答闸）。（磁盘侧接线 2026-11-13 已落——见 §13；模式选择配置面同日落——见 §14。）

## 13. HR-PR-05 接线增量（2026-11-13，磁盘侧进料上线）

- 磁盘侧进料已接线（`src/hotReload.ts` + `src/activate/hotReload.ts`）：装配注入真 `vscode.createFileSystemWatcher` 适配（`hotReloadDiskWatcherFactory`，薄 `DiskWatcherHandle` 包装，uri→fsPath）到 `setupHotReload` 新增的 `diskWatch` 选项。`setupHotReload` 每次 `apply()` 建 `HotReloadDiskWatchController`：每声明根一条 `根/**/*.py` watcher（HR-WATCH-004），change/create 规范化后以 `disk-change` 进同一两级触发链（同一进料流水线+合并窗），delete 不进管线（只记诊断），创建后立即 `arm()`——apply 块是同步的，真事件只能在后续宏任务到达，HR-WATCH-015 基线窗漏不进启动文件。不注入 `diskWatch` =原装配行为不变（全部既有测试不受影响）。
- 范围同界：磁盘面绝不比既有热更域更宽。装配内范围闸（`diskOfferInScope`）镜像同一 plan——派生模式=assetsRoot 前缀（两侧均规范化），显式模式=对 workspace 相对路径跑 `matchesHotReloadGlob`（与版本徽章同一匹配器，不造第二套 glob 语义）。域外磁盘事件在闸处丢弃、不记诊断：控制器自身过滤层已对扩展名/目录/备份名报 `filtered`，闸在其上（双重上报会双计数）。
- 生命周期（HR-WATCH-005）：控制器随每次 `apply()` 重建——配置/根/签名变更本就重跑 apply;旧控制器 dispose 全部 watcher,新控制器取当前 folder roots（`filterOptions.roots` 永不陈旧）。plan 关/错 → 旧控制器 dispose,不建新面。扩展释放随装配其余件一并清理。
- 诊断路由：生命周期类（`watch-created` / `dropped-before-arm` / `disposed`）进热更通道日志;`filtered` / `delete-ignored` 不逐事件 live 记录——git checkout 爆发数百条 delete 会淹没审计通道;其语义留在纯核测试里钉死。
- 重叠去重上线（HR-WATCH-003）：两面喂同一条流水线,编辑器保存同时以磁盘写形式浮现时归并为单条 pending（`disk-save-overlap`,单批）——手册的「两入口一流水线」模型。
- 测试:`tests/hotReloadDiskWatchWiring.test.ts` 8 例——不注入行为不变/按根 pattern+单批触发/save+disk 重叠单批/delete 忽略带诊断/显式收窄 globs 不放大/配置关拆面/context dispose 静默/真适配源锁。
- 仍暂缓:余下流水线配置键(稳定窗/语法闸/波次窗/预览阈注入)与 revision 消费(stale 应答闸)。(模式选择面 2026-11-13 同日落——见 §14。)

## 14. HR-WATCH-001/002 增量（2026-11-13,触发源模式配置面）

- `kbengine.hotReload.triggerMode` 字符串枚举:`onSave`(默认)/`onDiskChange`。默认随手册(「onSave 默认推荐」)加 2026-11-06 常设令(零配置热更开、保存即自动发)。容忍式读取:枚举外写法一律回落 `onSave`——不猜半态。
- 语义:`onSave` =仅既有 watcher 面(写盘事件驱动热更;编辑器保存/自动保存即发)。`onDiskChange` =另建 HR-PR-05 磁盘面(按根原生 watcher、`disk-change` 源、arm 基线、范围闸)——即手册的重叠去重模型,两面喂同一条流水线。模式是 kbengine 域配置,配置变更即重跑 `apply()`:切过去建面、切回来拆面(双向接线钉)。
- 设置面:`package.json` 贡献(`markdownDescription`+逐选项 `markdownEnumDescriptions` 经 NLS,双语言文件)、features.md Settings 行(en+zh,对账闸)、configuration.md 指南行(en+zh)。默认值在配置描述测试中锁死。
- HR-WATCH-002 钉死:未保存的缓冲编辑不进链(document-change 事件不接线——只有 watcher 磁盘事件进),onSave 范围=配置 globs 域(显式 glob 保存面钉+§13 磁盘面范围闸测试)。
- 测试:`tests/hotReloadDiskWatchWiring.test.ts` +3 例(缺省模式不建磁盘面/切换建面拆面/未保存编辑不触发)、`tests/hotReload.test.ts` 读取面例(缺省、枚举容忍)、`tests/configMarkdownDescription.test.ts` 默认值锁。
- 仍暂缓:余下流水线配置键(稳定窗/语法闸/波次窗/预览阈注入面——HR-WATCH-007/012/013/016 接线)与 revision 消费(stale 应答闸)。

## 15. HR-PR-04 配置面增量（2026-11-13,流水线注入键落地）

- 四键全部默认关=现有时序逐字节不变,配置才变:`kbengine.hotReload.stabilityWindowMs`(`0`=不做稳定等待;`>0` 注入快照读面——稳定路径两拍探测)、`kbengine.hotReload.syntaxGate`(`false`=不注入检查器)、`kbengine.hotReload.batchFlushMs`(`0`=定稿即汇入合并池;`>0` 起波次窗,同窗定稿归集成批)、`kbengine.hotReload.batchPreviewThreshold`(`50` 同纯核缺省;`0`=一律滞留是合法值不是错误)。
- 真语法闸(HR-WATCH-012):`createPythonSyntaxGate`(装配核,零 vscode/child_process 导入)包 `runPythonCompile`——spawn 解释器跑 `compile(sys.stdin.read(), …)`(只编译不执行;内容走 stdin;stderr 末行作错误;5s 超时)。fail-open 策略:解释器解析不到/子进程故障/超时一律放行并至多记一次日志——绝不因检查器不可用拦热更;只有明确 `{ok:false}` 才拦。解释器随闸创建经 profile 解析器解析一次。
- 内容流接缝:内容原本只在稳定路径流动,`窗 0`+闸开=闸是死面。`due()` 现按「读面已注入**且**(窗>0 **或** 闸开)」进快照路径,窗 0 分支单拍直取即定稿——闸拿到内容,该路径的去重指纹也拿到真哈希。
- 预览滞留可见性+放行:流水线 `preview` 诊断面上热更通道日志(批量预览滞留);新命令 `kbengine.hotReload.releasePreview` 把滞留批经合并池整批一次发出,无滞留如实报空,命令注册在 composite 之前、随 composite 内部 dispose(恰一订阅契约不破)。
- 测试:`tests/hotReloadConfigFaces.test.ts`(9 例装配钉:键关→替身想进也不进/键开→面进/闸拦下零后续计时器/波次窗单批单发/超阈滞留→日志+命令放行/空放行如实/真读面文件缺失如实删失)、`tests/hotReloadSavePipeline.test.ts`(+4:窗 0 拦截、窗 0 放行带哈希去重、异步检查器拦截不占 revision、缺省无面钉;harness 面改 opt-in,旧无面路径逐字节不变)、`tests/hotReload.test.ts` 容忍式读取例。
- 文档对账:NLS 双语言(带配置指南链接)、features.md Settings 行 en+zh、configuration.md 指南行 en+zh、commands.md `kbengine.hotReload.releasePreview` 小节 en+zh、config-description 默认值锁。
- 仍暂缓:revision 消费面(stale 应答闸)、profile capabilities/路径 allow-deny 规则(HR-WATCH-013,HR-MOD-006 同因)、在途请求取消策略(HR-WATCH-014)。
