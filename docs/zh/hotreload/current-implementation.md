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

## 16. HR-PR-04 revision 消费增量（2026-11-13,stale 应答闸落地）

- 发送时点版本快照:`runFire` 经新核心自省口 `revisionOf` 捕获每个发出文件的流水线版本号(canonical 路径为键,未定稿=0)。快照锚定发送时点的流水线实例(`pipelineAtFire`)——`apply()` 重建后新实例版本簿重置,在途响应只对它所属代的版本负责。
- 末版本必被请求:再定稿必再进合并窗再 fire——链路既有性质,本批以测试钉死(两次定稿→两次请求)。
- 旧响应绝不冒充新版本成功:响应落地时,版本已越过发送版本的文件(`isStaleResponse` 真)如实注解。default-hotfix 与通道面上「响应过期」审计日志(每次响应至多一条,点名文件);动作响应路径额外把 stale 注解追加进该代 attempt 绑定的 `sent-unverified` 台账记录——`accepted`/`applied` 不动(发送内容的事实记录,锚定发送时点冻结基准,不冒充),新代记录绝不背旧响应的注解。
- 测试:`tests/hotReloadSavePipeline.test.ts` revisionOf 钉;`tests/hotReloadRevisionGate.test.ts` 4 例装配钉(再请求链/仅旧响应上日志/新响应不上日志/通道面上日志且台账最新代不被污染);`tests/hotReloadResponseReceiptWiring.test.ts` 台账注解绑定(挂起响应动作:stale 注解落滞代记录,下一代记录干净)。
- prove-red:中和 stale 判定后三面转红(两条日志面+台账注解)。
- HR-WATCH-011 与 HR-PR-04 随本增量收官。

## 17. HR-WATCH-008 接线增量（2026-11-13,投递失败撤回指纹落地）

- `forgetSent` 至此才被真装配调用——本增量之前核心方法零调用点,一次投递失败会在生产路径永久跳过同内容变更。撤回助手(`forgetSentFailed`)与 stale 闸同层驻留 fire 作用域,每条投递面如实撤回:
  - 默认热更:`result.ok === false` 与拒绝分支撤整批触发文件(一动作一果)。
  - 脚本/命令动作:`recordOutcomes` 在 `failed` 时于落账前撤整批(撤回不依赖台账装配是否在场)。
  - 通道:逐文件精确——只有最新回执为 `failed` 的文件撤指纹(`sent-unverified`/`accepted`/`applied` 回执不撤,已送达文件的去重不受影响);整批异常时无回执或回执 failed 的文件一律撤(未确认送达即允许重发)。
  - 动作响应路径:`handleResponse` 对 `recordHttpDelivery` 判为非 2xx(`failed`)的文件撤指纹。
- 成功代际绝不撤——成功/去重钉证明成功发送后同内容再定稿仍被去重。
- 测试:`tests/hotReloadForgetSentWiring.test.ts` 3 钉(失败后同内容照发/成功后去重仍有效/通道混批只重发失败文件)。注入读面的引导走异步定稿路径(合并窗空转,`onEmit` 补排窗——每次 fire `tick(2) → flush → tick(1) → flush`)。
- prove-red:中和四处 `pipeline?.forgetSent(file)` 调用面后,失败钉与通道钉转红;成功/去重钉按构造保持绿。
- HR-WATCH-008 随本增量收官:指纹分离(交发送面那一刻记,如实失败撤回)端到端落地,台账内容事实记录仍是独立账本(同内容重发推进流水线版本号;台账记录锚定各自代际不变)。
## 18. HR-PR-08 接线增量（2026-11-13,发送 provider 注册表进真装配）

- provider 注册表随本增量进入真装配:装配时创建,随复合 disposable 释放清册(不半态)。注册时机=装配时;解析序=注入序先到先应答——经新 `hotReloadProviders` 注入面传入的 fork 专属实现排在内置实现之前,fork 通道优先于通用面。
- fork 侧具体实现为真:`createHttpHotfixSendProvider` 委托既有 `sendDefaultHotfix` 核(请求构造/双名解析/逐文件执行/结果映射全复用,零第二套发送语义),`defaultHotfix` 面在即注册,以 `kbengine.http-hotfix` 应答。
- 新配置键 `kbengine.hotReload.sendViaProviders`(默认 `false`):开启后,无动作名自动发送先问注册表(profile 由 `buildEngineProfile` 组装,engineVersion 如实 `null`——本链尚未接版本探测);无人应答回落既有默认热更面。关闭=面不进链,行为与既有完全一致。重复 id/apiVersion 不符的注册如实拒并上日志,绝不静默替换。
- provider 结果逐字映射既有面:ok → `sent-unverified`+审计行 `provider:<id>`;失败/抛错 → `failed`+HR-WATCH-008 指纹撤回(provider 失败后同内容照发)+审计行+状态,同步抛错在 promise 边界收口(不在事件边界裸抛)。
- 测试:`tests/hotReloadProviderAssembly.test.ts` 6 钉(canSend 如实/transport-faithful 请求形状/先到先应答序/重复 id 拒/apiVersion 拒/dispose 清册);`tests/hotReloadProviderWiring.test.ts` 8 例装配钉(键开→provider 接单默认 transport 不动/失败撤指纹再接单/抛错如实 failed/键关→面不进链/fork 不应答→内置按注册序接单/内置经注册表 transport-faithfully 接单/重复 id 先者胜+拒上日志/apiVersion 不符绝不收编)。容忍读取闸新增布尔键循环;manifest 默认锁钉 `false`。
- prove-red:中和 provider 臂咨询面后键开钉转红(provider 不接单,默认面走)。


## 19. HR-HASH-007/008 接线增量（2026-11-13,def 指纹 Inspector + 保存触发三路判定上线）

- 新命令 `kbengine.def.fingerprintInspector`(要求活动编辑器为 `.def`):计算当前快照——sha256 文件哈希(`hashDefContent`)、结构语义指纹(`semanticFingerprintReport`,规格 `def-structural-fp/1`)、字节数、计算耗时——与会话台账的上次快照并排展示,给出三路判定(file/semantic/applied),附算法档案(`resolveFingerprintProfile`,无摘要协商时如实「未协商」)、插件 API 版本、读面来源(document=打开缓冲区字节复用/disk=磁盘补载)、哈希值复制按钮。面板=普通 `createWebviewPanel`,与既有面板同模式,不新造框架。
- 保存触发三路判定(HR-HASH-008):每个 `.def` 保存事件 → 快照 → 台账比对 → 「KBEngine Def 分析」通道一行结论(与 MD5 核查同通道,有意合并)。首见只存底(`def 指纹首见(只存底)`),绝不伪造变更结论;后续保存按 file/semantic/applied 三面带原因上报。
- VFS 字节复用(HR-HASH-002):读面走 `readSharedFileSnapshot`(打开缓冲区优先),未保存编辑参与指纹,UI 显示绝不为此单独重读磁盘;来源标签随面板与台账同走。
- applied 维度诚实边界:def 文件没有逐文件运行时回执(回执注册表只收热更 `.py` 面),三路判定的 applied 面如实 `unknown` 并点名原因,绝不用客户端 sha256 顶替。工作区闭包 MD5+SDK 盖章保持另账(`kbengine.def.checkEngineMd5`);跑过时面板如实转显最近结果并标注「另账」。
- 测试:`tests/hotReloadDefFingerprintLedger.test.ts`(纯核台账/三路组装钉)+ `tests/defFingerprintInspector.test.ts`(deps 注入编排:快照生产/首见只存底/变更·无变更判定/通道行/保存过滤/不可读如实/HTML 面)。prove-red:中和台账比对面后变更判定钉转红。


## 20. HR-PR-06 接线增量（2026-11-13,热更历史 UI 上线）

- 新侧栏视图 `kbengine.hotReloadHistory`(package.json 声明在「快速执行」与「服务器」之间,`%kbengine.view.hotReloadHistory%`):投递台账(`HotReloadTargetStateStore`)是事实源——新 `onRecord` 依赖把每次发送/回执升级/注解写回即时投影进 `HotReloadHistoryCore`,历史绝不重读过期快照。行键=「目标键/文件#代际」(`buildHotReloadTargetKeyId`+文件名+attempt):同一次执行的回执升级幂等原位替换,新代际=新行。
- 状态三态如实映射:台账 `accepted`(回执中段,未核验)呈现为「已发送(未确认)」,绝不拔高成「已应用」;`applied`/`failed` 逐字透传并带错误摘要。
- 树面(HR-UI-002/010/014):根三组——最近更新(最新在前,页大小封顶)、按文件、按目标——键组下再套行,同路径不同目标天然分行。行标题=`buildHistoryEntryLabel`(fullModule,HR-MOD-011),description=状态·目标,tooltip=双名+file+target+时间+requestId。台账事件重渲染走合并窗节流(缺省 500 ms,HR-UI-007);无 `createTreeView` 的受限宿主退化为 `registerTreeDataProvider`(与既有侧栏视图同契约)。
- 新命令:`kbengine.hotReload.historySearch`(树面 fullModule 子串过滤,大小写不敏,留空清除,取消不动)与 `kbengine.hotReload.historyPanel`(普通 `createWebviewPanel`,不新造框架):页头=监听模式/目标/显示 N/M 行(未配置如实占位 `(未配置)`/`(默认)`),过滤表单(模块子串/目标 id/状态),最新在前表格,行=fullModule(双名不同时并列 `发送: requestModule`,HR-UI-006)+file+target+状态+时间+requestId(HR-HTTP-014 展示面)+错误摘要,「加载更多」逐页增量拉满为止(HR-UI-007);可见行超虚拟滚动阈值(200,即缺省容量调高后才触发)时,表格只渲染视口窗口行(computeVirtualScrollWindow),顶/底 spacer 把滚动条撑到内容总高,webview 在滚动时用同公式的 JS 镜像重渲窗口行——不走全量重渲往返,滚动位置不重置。
- feed 独立(HR-UI-012):面板关闭不停任何服务——只清面板引用;feed 与树照常入账,重开面板见全量历史。全部句柄进 `context.subscriptions`;dispose 清节流 pending 钟,拆除后不再 fire。
- 持久化(HR-MOD-014):`persist` 注入面,装配侧以 `context.workspaceState` 适配、键 `kbengine.hotReload.history`——每次投影落全量行,启动回载,形状不符的条目如实丢弃(绝不硬造成行)。无 `workspaceState` 的宿主(测试替身)经可选链如实退化为不持久化——激活绝不因缺面而崩。
- 启动视图契约保持:新 id 进 `KBENGINE_SIDEBAR_VIEW_IDS`(占位先行注册,装配时真 provider 接管),占位契约闸保持 13 视图 × 2 登记。
- 测试:`tests/hotReloadHistoryView.test.ts` 16 钉——翻译钉(同执行 requestId 稳定/三态如实/双名透传)、树登记+三组、最新在前与标题/description/tooltip、按文件/按目标键组与同路径异目标分行、节流合并+dispose 清钟、搜索命令三态、面板页头/行/双名/过滤/分页/关面板不停 feed、持久化回载+脏数据丢弃+状态键契约、三态状态类名纯渲染钉。prove-red:中和台账→历史投影面后 10 钉转红。


## 21. HR-MOD-008 暴露面增量（2026-11-13,根下单层回退键上线）

- 新用户可见配置键 `kbengine.hotReload.allowRootLevelStem`(布尔,默认 `false`):脚本资源根直接包含 `scripts/Foo.py` 时,双名称解析默认仍判不支持(reason `root-level`,书 §19.1)——本键只是把纯核既有的 `allowRootLevelStem` 开关(HR-PR-02,c120287c 交付)暴露进发送路径。关闭(默认)=零配置行为不变,与点火注记要求一致。
- 发送路径接线:`DefaultHotfixDeps` 增 `allowRootLevelStem`;`resolveDefaultHotfixModule` 把它透传进 `resolveModuleDualName`——键开后根直下文件解析裸短名(`Foo` = `fullModule` = `requestModule`),不再回落包边界扫描;扫描在 scripts 目录带 `__init__.py` 时可能收进多余的 `scripts.` 段(服务端收得下却永远重载不到,正是本键要解的错误形态)。
- 两个发送面都认它:无动作名自动发送经新 `resolveAllowRootLevelStem` 注入逐次读取(生产读 `readHotReloadSettings`——同一容忍面,配置写坏回落关);provider 注册表内置 `kbengine.http-hotfix` 在装配时捕获。
- 配置面四件套:package.json 键+NLS markdownDescription(双语言,默认值节+配置指南深链)、`readHotReloadSettings` 容忍布尔读取(非布尔→`false`)、features.md Settings 行(en+zh)、configuration.md 指南行(en+zh)。
- 测试:默认热更钉(默认→包探针命中 scripts 目录时回落 `module_name=scripts.Foo`;键开→query 与 body 双带裸名 `Foo`)、provider 接线两态钉(同一装配,只差配置:未配→`scripts.Lone`,开启→`Lone`——证明配置真经设置读取面流进发送)、设置容忍布尔循环+`true` 直通、manifest 默认锁 `false`。本块不做 sed prove-red:两态装配钉按构造自证(关=旧形态,开=新形态,同一 harness)。


## 22. HR-MOD-013 用户可见面增量（2026-11-13,请求预览+旧模板迁移命令上线）

- 新命令 `kbengine.httpRequest.preview`:对活动文件展示「将会发出什么」——全部 kbengine.httpRequests 配置条目(停用条目也列出并带原因,绝不静默丢弃)加零配置默认热更面——只构造不发送。每行带模板替换后的方法/URL/请求头/请求体与三个模块名并列(fullModule/requestModule 双名+legacy `${module}` 语义值),双名与 legacy 的差异逐请求可见。输出进既有「KBEngine HTTP 快捷请求」通道;HR-MOD-008 `allowRootLevelStem` 在默认面行与真实发送逐字同口径。
- 新命令 `kbengine.httpRequests.migrateLegacyModule`:对仍用旧 `${module}` 占位的已保存 URL 模板做兼容迁移(HR-AUDIT-004 刻意保留其默认语义——迁移是显式选择,绝不自动)。扫描**原始**已存条目(分析面刻意绕开解析器规范化——写回就不可能静默把别的条目补默认),逐条列出逐字段出现次数(url/请求体/请求头值);写入前要求显式选条目+显式二次确认,任意一步取消都不改任何配置。
- 不静默篡改是结构性的:纯核零配置写入面;改写只动确认条目的模板字符串(`${module}` → `${fullModule}`),其余条目逐字保留(拼接数组里同一引用,未知自定义字段原样),确认两次后才经 `ConfigurationTarget.Workspace` 整体写回。未配置 `kbengine.hotReload.tempEdit.scriptRoot` 时拒绝迁移并点名原因(`${fullModule}` 会展开空串——先配脚本资源根),绝不给一个自己知道会断链的改写建议。
- 注册位于 `activateHttpRequestViews`,与既有 HTTP 快捷请求命令同侧;严格命令奇偶闸(每声明 id 必注册,每注册 id 必声明)覆盖装配面,NLS 标题双语言齐。
- 测试:`tests/hotReloadRequestPreview.test.ts` 7 钉——预览行(替换后形状/三名字并列/停用条目带原因列出)、空文件如实、未配 scriptRoot 双名如实空串而 legacy 值照常、HR-MOD-008 开关进默认面预览、原始条目分析逐字段计数、无占位/未配置如实、改写其余字段逐字保留、拼接保留兄弟条目同一引用。prove-red:迁移改写中和为 no-op 后改写钉转红;默认面开关硬写 `false` 后 HR-MOD-008 预览钉转红——逆向 sed 恢复,7/7 绿。


## 23. HR-EXT-001 版本化生命周期契约（2026-11-22,RUST-405,生命周期插槽）

- `HotReloadProvider` 面在既有发送面(canSend/send)之外加四个**可选**生命周期插槽:`resolveModule`(文件→模块身份)、`prepareRequest`(目标+身份→请求)、`interpretResponse`(发送结果→七类分类解释)、`queryAppliedRevision`(已应用版本查询)。可选=缺省槽回落(组合既有核),增量前实现(只有 canSend/send)形状不变——向后兼容,`apiVersion` 不递增(与 HR-HTTP-002 增量字段同纪律,绝不因加可选成员升版本)。
- 缺省槽 `createDefaultHotReloadLifecycleSlots` 组合既有核,不自创解析、不自创错误分类:`resolveModule` 委托 `resolveHotReloadModuleIdentity`(scriptRoots/allowRootLevelStem 装配面默认,逐调用可覆盖,不跨调用粘滞);`prepareRequest` 透传既有发送请求形状(files=[fileUri]、moduleIdentities=[requestModule]、可选 revision/correlationId 如实不带,不冒充空);`interpretResponse` 委托 `classifyHotReloadErrorReason`(七类,ok 透传);`queryAppliedRevision`=如实 `null`(未接线,绝不编造运行时版本)。
- 注册表 `HotReloadProviderRegistry.resolveLifecycle(profile)`:按 profile 选发送 provider(同 resolveSendProvider:第一个 canSend 应答者胜),再把 provider 自带的四个插槽与缺省槽合成——实现自带槽优先,缺槽回落缺省,返回 `{provider, slots}` 非半态。无人应答/null profile=如实 `null`(不回落默认,同发送面口径)。
- 测试:`tests/hotReloadPluginApi.test.ts` 7 钉——缺省槽 resolveModule 唯一根命中返回身份(双名)、无根候选诚实 no-root(不猜不回落)、prepareRequest 形状(逐项透传/缺省 revision/correlationId 如实不带)、interpretResponse 七类(HTTP 500→apply-failed、未知 detail→unknown、ok 透传)、queryAppliedRevision 未接线=如实 null、registry.resolveLifecycle 自定义槽优先+缺槽回落缺省、纯发送 provider 缺槽全回落+无人应答/null profile=如实 null。prove-red:中和 queryAppliedRevision 为伪造引擎版本+prepareRequest 丢 moduleIdentities 后 3 钉转红(含缺槽回落钉),逆向恢复 16/16 绿。


## 24. HR-EXT-002 版本化指纹契约（2026-11-22,RUST-406,compare/fetchEngineDigest 可选槽）

- `FingerprintProvider` 面在既有计算面(fileHash/semanticFingerprint/negotiateDigest/profileLabel)之外加两个**可选**槽:`compare`(三路对拍)与 `fetchEngineDigest`(引擎 Digest 获取)。可选=缺省槽回落既有核/如实 not-wired,增量前实现(只有原四方法)形状不变——向后兼容,`apiVersion` 不递增(与 HR-HTTP-002/HR-EXT-001 增量字段同纪律)。
- 缺省槽 `defaultHotReloadFingerprintProvider`: `compare` 委托既有 `compareFingerprints` 核(文件/语义/已应用三路判定,不自创对拍逻辑);`fetchEngineDigest`=纯核零 IO 如实 not-wired `null`(绝不编造引擎摘要)。真实引擎摘要获取与 tier/verified/compatible 可信度结论在装配面 RUST-404 `defMd5Check`(那里引擎证据是 IO 面);本面只声明「取摘要」边界,不重复声明可信度——可信度抽象既有(RUST-404),不建平行面。
- 算法版本声明=既有 `apiVersion`('1',FingerprintProvider 钉接口形状);可信度声明=既有 RUST-404 `EngineDigestCompatibility`(tier/verified/compatible),两处都非本批新增,只在账。
- 测试:`tests/hotReloadPluginApi.test.ts` 4 钉(缺省槽 compare 委托三路对拍:变化/一致如实;同值 unchanged+未协商算法=applied unknown+点名原因不跨类比;fetchEngineDigest 纯核零 IO=not-wired null;可选槽可缺省=不含两槽的纯计算形态仍合规+apiVersion=1)。prove-red:中和 compare 恒 unchanged+fetchEngineDigest 伪造摘要后 3 钉转红(含委托/not-wired 钉),逆向恢复 20/20 绿;消费者门=pluginApi+providerAssembly+providerWiring+fingerprintCompare 4 文件 48 例绿;tsc -p ./ 与 eslint src 双绿。


## 25. HR-EXT-003 资格判定规则（2026-11-22,RUST-407,auto/manual/restart 保守序）

- 新版本化扩展面 `HotReloadEligibilityRule`(plugin-api 核内):按 engine profile、root、文件类型、上下文四要素判定 `auto`(可自动发送)/`manual`(人工确认)/`restart`(需重启)。fork/第三方引擎=换 rule 实现整面接管分类;缺省规则只做保守组合判定,不自创结构分析。
- 缺省规则 `createDefaultHotReloadEligibilityRule` 保守序:①restart 最强——`context.structuralReasons` 非空(既有 RUST-397 def 结构闸 verdict 的产物,规则**只消费闸结论不重算结构**)即判 restart,优先于一切;②auto 须四要素齐备——`.py` 文件+root 已配+引擎版本已知(`EngineProfile.engineVersion !== null`)+触发源 `watcher-auto` 且非用户显式动作,任何一缺=manual(绝不自动发未知引擎/未知根/非 py/人工链);③其余=manual(安全缺省)。
- 与既有面不重复:pipeline 的 `SavePipelineEmitMode='auto'|'preview-release'` 是发送管线的出口判定,def 闸 `restart_required` 是结构分析;本规则是**资格分类的扩展面**(fork 接管点),组合消费两者的结论,不建平行判定逻辑。
- 测试:`tests/hotReloadPluginApi.test.ts` 4 钉——restart 最强(结构 reasons 非空即使 auto 要素全齐)、auto 四要素齐备、任何一要素缺=保守 manual(root null/引擎版本 null/非 py/command 触发/userInitiated/全缺)、fork 可换 rule 整面接管+apiVersion 钉 1。prove-red:中和结构闸消费支路(false)+判 auto 分支(恒 true)后 2 钉转红(restart 钉+保守 manual 钉),逆向恢复 24/24 绿;消费者门=pluginApi+providerAssembly+providerWiring+fingerprintCompare+defGate+fileState 6 文件 109 例绿;tsc -p ./ 与 eslint src 双绿。

## 26. HR-EXT-004 权限声明（2026-11-22,RUST-408,workspace/network/exec 最小权限）

- plugin-api 核内新版本化声明面:`HotReloadProviderPermission = 'workspace' | 'network' | 'exec'`,配 `HotReloadProvider.permissions?`(可选)。第三方 provider **必须声明**所需能力,宿主据此判定能否挂到能力面。可选=最小权限声明面:未声明者不获任何敏感面授权(增量可选槽纪律,`apiVersion` 不递增,同 HR-EXT-001/002)。
- 缺省策略 `createDefaultHotReloadPermissionPolicy`(`kbengine.default-permission`),面→可满足声明集:`send` 必声明 `network`;`fetch-digest` 声明 `workspace` **或** `network` 任一即可(取摘要走文件读或走引擎查询,两条通道皆可);`read-workspace` 必声明 `workspace`;`spawn-process` 必声明 `exec`。`check` 取缺失最少的声明集,给 `granted`/`missing`/点名 provider id 的 `reason`;未声明者对四面一律 `granted=false` 且缺失点名——绝不静默放行。
- 跨面不挪用权限(`network` 不覆盖 `read-workspace`);fork=换整个 `HotReloadPermissionPolicy` 整面接管判定(同 HR-EXT-003 rule 的接管形状)。
- 分层不重复:本面只声明**能力**、答「该 provider 能否挂到此面」;宿主在挂载期显式调用策略,`HotReloadProviderRegistry.resolve*` 保持无权限假设,增量前未声明 permissions 的 provider 照旧解析(策略判定是宿主侧的独立闸)。运行时目的地控制仍归 HR-HTTP-001 端点策略(RUST-420,loopback 白名单)与工作区信任闸(RUST-422)——互补,非平行检查。
- 内置 `createHttpHotfixSendProvider`(`kbengine.http-hotfix`)同样声明 `['workspace', 'network']`——它 POST 联网+`${module}` 回落面包边界探针读工作区;不做特权豁免,只是以身作则证明声明。
- 测试:`tests/hotReloadPluginApi.test.ts` 9 钉——未声明者四面一律拒且缺失点名、声明 network/workspace/exec 各自授权对应面、fetch-digest 两可(任一通道合格/皆缺拒)、跨面不挪用、重复/空声明处理、`acceptableDeclarations` 表+apiVersion 钉 1、fork 换策略整面接管、向后兼容(无 permissions 的 provider 仍类型合规+仍注册+仍解析——权限面不改解析序)、内置 provider 四面对账(send/read-workspace/fetch-digest 过,spawn-process 因未声明 exec 拒)。prove-red:强制放行(`if (true)`)后 6 钉转红,逆向恢复 33/33 绿;消费者门=pluginApi+providerAssembly+providerWiring+fingerprintCompare 4 文件 61 例绿;tsc -p ./ 与 eslint 双绿。

## 27. HR-EXT-005 隔离 Worker 贡献面（2026-11-22,RUST-409,预算化派发+背压有界）

- plugin-api 核内新版本化贡献面:`HotReloadWorkerAdapter`——Python 插件/fork 把 **eligibility** 和/或 **response** adapter 跑在隔离 Worker(独立线程/进程,不占 extension host 主线程)。本核只定义协议与预算;真实 worker 线程装配由接线批注入 `dispatch`。
- 版本化消息协议:`HotReloadWorkerTask`(`kind`+`input`,eligibility 用 `HotReloadEligibilityInput`/response 用 `HotReloadProviderInterpretInput`,可选 `correlationId`)→`HotReloadWorkerResult`(`ok=true` 带判定/解释产物,`ok=false` 带 worker 自身错误);`HotReloadWorkerOutcome` 如实三态:`resolved`/`timed-out`/`rejected`。
- **hot path 不允许无界阻塞**——两道界:①`dispatchWorkerWithBudget` 把 worker 与 `budgetMs` 计时器赛跑,绝不等过预算;预算后仍慢=报告 `timed-out`,其迟回结果被丢弃(槽位按预算释放,挂死的 worker 占不住容量、也堵不住保存事件管线)。②`createHotReloadWorkerHost` 施 `maxInFlight` 背压:在途达上限=新任务 `rejected` `worker backpressure`,不无界排队。`dispose` 后新派发一律拒。
- 按 kind 选 adapter 首见胜;未贡献该 kind 的 adapter=`rejected` `no adapter contributes <kind>`——宿主绝不静默回落,worker 面只在真有人贡献时用(否则走宿主既有面)。
- 超时保守产物:eligibility→`WORKER_TIMEOUT_ELIGIBILITY_FALLBACK = 'manual'`(同 HR-EXT-003 保守序——慢 worker 绝不升级为 auto);response 超时=与既有 HR-EXT-001 缺省 `interpretResponse`(七类核)组合,不新造错误枚举。
- 测试:`tests/hotReloadPluginApi.test.ts` 7 钉——预算内 resolved/派发拒绝带 worker 错误、timed-out 不等慢 worker(耗时 < worker 自身延迟)、预算释放槽位后新派发照常、no-adapter 拒(kind 不匹配+空宿主两臂)、背压在 `maxInFlight`、`declaredTimeoutMs` 覆盖宿主缺省预算、dispose+apiVersion 钉 1+eligibility 超时产物 manual。prove-red:把 `budgetMs` 计时器换成 100000ms 后 3 钉转红(全部 timed-out 钉),逆向恢复 40/40 绿;消费者门=pluginApi+providerAssembly+providerWiring+fingerprintCompare 4 文件 68 例绿;tsc -p ./ 与 eslint 双绿。

## 28. HR-EXT-006 模板=runtime adapter 实现（2026-11-22,RUST-410,用户可替换,Rust Core 不写死 reload URL）

- HTTP 请求模板现在是**参数化的 runtime adapter 实现**而非写死常量:`buildDefaultHotfixRequest(filePath, deps, moduleIdentity?, entry = BUILTIN_HTTP_REQUEST_EXAMPLE)` 把模板作为第四参,`DefaultHotfixSendDeps.template?` 透传进 `sendDefaultHotfix`。用户自己的 `HttpRequestEntry`(`kbengine.httpRequests` 形态:url/method/headers/body)就是一份可替换实现——`reload` URL 只活在模板里(TS 侧单一真源),Rust Core 永不写死。
- 新工厂 `createTemplateHotfixSendProvider(entry, deps)` 从任意模板构建 `HotReloadProvider`;内置 `createHttpHotfixSendProvider(deps)` 现在是该工厂的薄封装(规范 id `kbengine.http-hotfix`+展示名)——内置只是内置示例模板的 adapter,不是特殊通道。用户模板可整体替换(注册序=应答序,先注册的 fork 侧模板先应答)。
- 权限:模板 adapter 与内置同声明 `['workspace', network]`(可能探包目录补 `${module}` + 联网发送)——无特权豁免,同 HR-EXT-004 纪律。
- Rust Core 保证:`crates/` 是索引/语义/DB 面,不做热更 HTTP。由 `tests/rustCoreReloadUrlGuard.test.ts` 钉死:遍历 `crates/**/src/**/*.rs` 断言 `8090`/`hotfix` 字面量零命中——谁把 reload URL 写进 Rust 此门红。
- 测试:`tests/hotReloadProviderAssembly.test.ts` 4 钉——用户模板 adapter 整条模板进请求(url `http://engine.internal:9990/reload?mod=${module}` 替换/`PUT` 方法/头值 token 替换/体替换)非内置形态、缺省路径仍是内置 `127.0.0.1:8090/hotfix?module_name=` 形态、模板 adapter 声明 workspace+network 且 id 按模板名生成+无 transport 如实不接单、用户模板可替换内置(先注册先应答,仅内置=解析内置 id);另 `tests/rustCoreReloadUrlGuard.test.ts` 1 钉(Rust 树 8090/hotfix 字面量零命中)。prove-red:把 `buildDefaultHotfixRequest` 强制回落内置常量后用户模板钉转红,逆向恢复 29/29 绿;消费者门=pluginApi+providerAssembly+defaultHotfix+rustCoreReloadUrlGuard+providerWiring 5 文件 79 例绿;tsc -p ./ 与 eslint 双绿。

## 29. HR-EXT-007 provider SDK 示例（2026-11-22,RUST-411,stub+mock HTTP,集成与权限用例）

- 新示例模块 `src/backend/hotReloadProviderExamples.ts`:第三方写 `HotReloadProvider` 的两条最短路径,纯逻辑零 vscode——示例即代码,也是集成测试对象。
- **stub provider** `createStubHotReloadProvider()`:零 IO 记录型——`canSend` 恒 true(能应答占位,不分派 profile),每次 send 把原始请求逐字记进 `calls`,回 `{ok:true, detail:''}`,不联网不读盘不起进程;**零权限声明**(最小权限:不使用任何能力),故缺省策略对敏感面一律拒且点名缺失。
- **mock HTTP provider** `createMockHttpHotfixProvider(options?)`:同一 `createTemplateHotfixSendProvider` 工厂(HR-EXT-006)+ 脚本化 `HttpTransport`——send 走完整 `sendDefaultHotfix → executeHttpRequest → transport` 链,transport 记录每条出口请求(url/method/headers/body)并回放脚本 `HttpExecutionResult`(越界调用回退 `defaultResponse`,缺省 200 ok);`entry`/`sendDeps` 对应 `HttpRequestEntry`/`DefaultHotfixSendDeps`,可端到端演练用户模板(HR-EXT-006);mock 声明 `['workspace','network']`——与内置 HTTP provider 同契约,无特权豁免。
- 分层非一道闸:`registry.resolve*` 不含权限假设(注册序=应答序),权限判定是宿主挂载期另一道显式闸。示例分别钉两半——stub 照常解析并发送,而 `policy.check(stub,'send')` granted=false(missing network)、`policy.check(mock,'send')` granted=true;解析序≠授权。
- 测试:tests/hotReloadProviderExamples.test.ts 10 钉——stub 逐字记账+canSend 恒真+宿主注册表集成;mock 缺省模板展开 8090/hotfix 形态、用户模板整条进请求(PUT engine.internal:9990/reload、头 token、body)、脚本 ECONNREFUSED 与 HTTP 500 均进 ok=false 且 detail 点名、宿主集成产出一条结构化 outcome 且回执关联 id;权限用例钉 stub send/spawn 一律拒且点名缺失、mock send 授而 spawn 拒(缺 exec)、permissions 等于 [workspace,network]、解析/权限分层(stub 能解析但不获授权)。prove-red:中和 mock 权限声明后 2 钉转红(授予+声明契约),逆向恢复 10/10 绿;消费者门=examples+providerAssembly+pluginApi 3 文件绿;tsc -p ./ 与 eslint 双绿。

## 30. HR-EXT-008 调度隔离+provider 影响基准（2026-11-22,RUST-412,provider 不进语言服务调用图）

- **命题**:新增 hot-reload provider 不得拖累 hover/definition 尾延迟。provider 派发面(`resolveSendProvider`/`HotReloadProviderHost`)只活在保存事件管线(`src/hotReload.ts`)与后端装配层(`src/backend/*`),零进入语言服务调用图。
- **结构钉** `tests/hotReloadProviderSchedulingIsolation.test.ts`(3 钉,扫 `src/` 下生产 .ts):①语言服务模块(`languageProviders` 桶+hover/definition 入口+`languageService*` 激活面)零引用派发 token;②四个 hover/definition 入口(`languageProviders/hover.ts`、`pythonDefinition.ts`、`navigation.ts`、`languageProviders.ts`)零导入 provider 面(`hotReloadPluginApi`/`hotReloadProviderAssembly`/`hotReloadProviderExamples`);③派发 token 生产调用点只在 `src/hotReload.ts` 与 `src/backend/*`——别处即红。prove-red:向 `hover.ts` 注入 `resolveSendProvider` 注释后 ①③ 两钉转红;恢复 3/3 绿。
- **实证臂** `tests/perf/hotReloadProviderImpact.bench.ts`(bench lane,`vitest.bench.config.ts`,与主 unit 门无交集):同一批真实盘上脚本(gen-perf-assets `large`)+ 同一份实时索引,warm 尾延迟(p50/p95/p99/max)覆盖悬停(`KBEngineHoverProvider.provideHover`,coldHover 测量面)与定义(`PythonClassIndex.resolveSelfMethodCandidates`,unblockedDefinition 语义核——避开 Rust-first RPC 面对真实二进制的依赖),两臂对照——**H0** 无 provider host(基线)vs **HN** 20 个计数 adapter 注册进活跃 `HotReloadProviderHost`。结构断言:整轮测量派发计数恒 0(宿主就绪但从不被语言服务调用);墙钟只记录不进断言(阈值化属 RUST-414 批)。
- 记录运行(`docs/perf/hot-reload-provider-impact-run.txt`,追加制,`KODE_HPI_OUT` 可覆盖;旋钮 `KODE_HPI_FILES/WARM/ADAPTERS`):files=400 warm=40 adapters=20——H0 悬停 p50=0.97ms/p95=5.83ms vs HN p50=1.03ms/p95=2.23ms;H0 定义 p50=0.69ms/p95=9.09ms vs HN p50=0.97ms/p95=4.99ms。两臂落同一噪声带(HN 尾部反而略低——注册 20 个 provider 对 hover/definition 路径零增加),与结构钉一致。

## 31. HR-UI-013 面板无障碍/主题完整性（2026-11-22,RUST-384 批B+批C）

注:批B 的 ZH 文档节此前未落(主文档只在 EN §33 记),本节把批B+批C 一起对账;批C 载体 feat commit 438de4e7。

- **批B(已落,EN §33)**:两热更面板文案走既有 webviewStrings 表(`strings(locale).hotReloadSettings/hotReloadHistory`,en/zh 全量同形,纯渲染面注入 t/lang,渲染纯函数不依赖 vscode),宿主面(树三组/定位命令标题/搜索 prompt/通知)走 l10nText(bundle.l10n.{en,zh-cn}.json 786 键 parity);主题面既有 `var(--vscode-*)` 令牌。
- **批C(本节载体 438de4e7)在批B 基础上补无障碍完整性与主题硬化**:
  - 主题硬化:面板 `body` 补 `background: var(--vscode-editor-background)`,加 `:focus-visible` 焦点环(2px `var(--vscode-focusBorder, #3794ff)`),不引固定 Dark+ 调色板(仍全走 `--vscode-*` 令牌);
  - screen reader:实时队列包稳定 live 区(`#queue-region` role=status aria-live=polite,label=queueRegionLabel,`queueChanged` 只换内层行、live 区本身不重建,屏幕阅读器可听到队列变化);过滤表单 role=search(label=filterGroupLabel),五控件各配 sr-only 关联标签(文本=列标签),虚拟/非虚拟双表 aria-label(tableLabel);
  - 键盘:apply 改 type=submit,脚本挂 form submit 处理器(`event.preventDefault()` 后应用)——任一过滤控件回车即应用;clear/加载更多保持 type=button;
  - zh 文案残差修复:批B 留下 zh 表 `defaultTarget='(default)'` 英文占位(页头 `headerTargetDefault` 本已是「(默认)」),批C 改 `'(默认)'`;两键仍分开(页头/行格),只修 zh 拼写;另加三个 a11y 标签键(queueRegionLabel/filterGroupLabel/tableLabel)zh/en 同形。
- 测试:`tests/hotReloadHistoryI18nA11y.test.ts` 11 例(纯渲染两态:主题令牌+不引固定 Dark+ 调色板/队列 live 区 zh/en/页头 live 区/表单 role=search+五 sr-only 标签+.sr-only CSS/双表 aria-label 含虚拟分支(行数超 `VIRTUAL_SCROLL_THRESHOLD`)/submit/clear/more 钮型+form submit 处理器/zh「(默认)」vs en「(default)」行格/三新键 zh/en 同形/`<html lang>` 按 locale);`tests/hotReloadHistoryView.test.ts` 面板钉更新:zh 目标格现「(默认)」(原「(default)」)。
- 残差不变(同 EN §33):en locale 下错误类别下拉与 errorSummary 列仍中文(纯核 `HOT_RELOAD_ERROR_REASON_LABELS`,label 穿线是独立架构改动,诚实不装已做)。

## 32. HR-EXT-008 provider 派发调度隔离（2026-11-23,RUST-412,§30 命题的时序面）

承接 §30(结构面:派发面零进入语言服务调用图)。§30 钉的是**闲置** provider host——它不会被 hover/definition 调到;§30 的基准(H0 vs HN)宿主全程从不 fire,故量不到另一面:**热更真派发那一跳的派发工作,原先跑在合并窗 fire 回调的同步段里**,与同事件循环上的 hover/definition 抢时间。本节收口该残差。

- **收口点**:键开(`sendViaProviders`)时,fire 回调原先**同步**解析注册表——逐个跑每个已注册 provider 的 `canSend`,而那是第三方同步代码。这份工作占住 fire 回调的同步段,把同批登记的语言服务侧定时回调(hover 预算、索引泵)垫高。现把解析与「无人应答回落默认热更」整段挪进微任务,fire 回调即回,同批兄弟定时回调先于派发工作执行。
- **机制(单点收编,不造轮子)**:fire 回调 `actionName.length === 0` 分支的键开路径把 `resolveSendProvider` + `runViaProvider` / `runDefaultHotfix` 包进 `Promise.resolve().then(...)`,与同文件既有信道发送、provider `send` 的延跳惯用法一致。键关路径逐字保留同步 `runDefaultHotfix()`:零配置用户零延迟变化。结果映射(sent-unverified + `provider:<id>` 审计行、failed/throw + HR-WATCH-008 指纹撤回)、单弹通知、`updateStatus` 批/流水线门控全在未改动的 `runViaProvider` / `runDefaultHotfix` 体内,`status.setSending` 仍同步。
- **微任务窗为何安全**:微任务在当前宏任务返回后、任何新定时器/事件前清空;`latestBatch` 只在 `runFire` 内同步前进,`pipeline` 只在 apply/rebuild 变——两者都不可能插进该窗口,`batch === latestBatch && pipeline === pipelineAtFire` 双等门控不可被破。
- **基准** `tests/perf/providerIsolation.bench.ts`(bench lane,输出 `docs/perf/provider-isolation-run.txt` 追加制):P1 fire 切片在 0 vs 24 个 provider 下持平(p50 0.15ms vs 0.14ms,4800 次 `canSend` 全部记账在微任务——fire 同步段零次);P1b **同批兄弟定时回调**不被垫高(p50 0.14ms ≡ 0.14ms)——这正是 todo 命题的机制面(hover 预算/索引泵定时器即同批兄弟回调);P2/P3 记录端到端 hover 与 `.def`→py definition 尾延迟(两臂均 200/200 命中),诚实 `ISOL-NOTE`:残余 N24−N0 ≈ +4.8ms 是派发微任务与 hover 续延同队列交错(受 provider 数×spin 有界),非同步切片阻塞。
- **测试钉** `tests/hotReloadProviderWiring.test.ts` 增四钉:双 provider fire(fire 同步段零 `canSend` 零 `send`,微任务后两次 `canSend` + 一次 `send` 全发生)、五 provider 风暴(遍历成本全在微任务,每 fire 恰一次接单)、键开全不应答(内置 `kbengine.http-hotfix` 兜底同样只在微任务后接单——同步段零默认 transport)、键关(fire tick 后无 flush 即已调 transport,证明同步路径未动)。既有钉全部只在 `flush()` 后断言,多一跳微任务不破任何既有用例。
- **无新配置键**:`sendViaProviders` 未变,manifest/NLS/设置面板面零触碰,docsCommands 配置门不因本增量触发。

## 33. 按 target / engine profile / 文件类型 / 触发方式的安全与功能完成矩阵(2026-11-23,RUST-430)

RUST-430(HR-QA-018)要求**按四个维度逐项签收**安全与功能完成矩阵。§2(RUST-431)把同一份证据按**区域**汇总;本节沿任务点名的四个维度重切。状态图例:

- **签收** — 本仓库内的行为钉或结构钉断言了该格,附锚点。
- **真机待验** — 无法只凭本仓库验证(活 SSH 会话、活引擎、活网络、真工作区信任对话框)。这是 RUST-430 的残差;任何 `真机待验` 格都未声称已签收。
- **unknown** — 两面都无证据;故意不签(§2 审计本就记为 unknown)。

### 33.1 target 维度

| 格 | 状态 | 锚点 |
| --- | --- | --- |
| loopback 字面量(127.0.0.0/8、`::1`、`::ffff:127.x`、`localhost`/`*.localhost`),零 DNS | 签收 | `tests/httpEndpointPolicy.test.ts:14,21,28` — host 字面量分类 |
| 非 loopback,未授权 | 签收 | `:98` — 阻止,消息点名设置键 |
| 非 loopback,已授权 | 签收 | `:106` — 逐次放行 + 每次落安全警告 |
| 云元数据端点(SSRF 经典目标) | 签收 | `:114` — 阻止 |
| 非 loopback 发送:工作区信任闸在前 | 签收 | `tests/httpRequestService.test.ts:568`(RUST-422)未信任即拦;`:643`(RUST-420)默认只放行 loopback |
| `localhost` 解析在扩展宿主进程所在机器 | 签收 | `:619`(RUST-423) |
| 跨 target 回执回显(`targetId`) | 签收 | `tests/hotReloadReceiptProtocolFixture.test.ts:149` — targetId 逐字回显,数组逐条 |
| 跨 target / 跨根台账行 | 签收 | `tests/hotReloadHistoryView.test.ts:276` — 同路径不同 target/根分行(HR-UI-010/014) |
| 远程 SSH / DevContainer `fsPath` target | 真机待验 | 解析面已钉 `tests/hotReloadModuleIdentity.test.ts:227`(fsPath 唯一解析);真实远程会话上的实际发送不在本仓库 |
| WSL UNC / Windows 反斜杠形态 | 签收 | `:247` |
| Telnet 探测/会话 target | 签收 | `tests/telnetService.test.ts:644,655,699` — 未信任工作区不发探测包、灯面 closed;信任在执行时刻读,恢复信任后下一轮恢复 open |

### 33.2 engine profile 维度

| 格 | 状态 | 锚点 |
| --- | --- | --- |
| `apiVersion` 钉死 `"1"`;默认 provider 声明同版本 | 签收 | `tests/hotReloadPluginApi.test.ts:33` |
| 默认指纹 provider 委托既有核 | 签收 | `:40,47` — fileHash sha256+字节数;语义指纹结构式 |
| 注册表:重复 id 拒且原实现不被替换 | 签收 | `:87` |
| `apiVersion` 不符拒 | 签收 | `:97` |
| `resolve`:首个 `canSend` 应答者胜;无人应答 → `null`,不回落 | 签收 | `:104` |
| null / 版本不符 profile → resolve `null` | 签收 | `:124` |
| 引擎版本未知 → profile `null`,不编造 | 签收 | `:66` |
| `queryAppliedRevision` 未接线 → 如实 `null` | 签收 | `:205` |
| 崩溃隔离:`canSend` 抛错跳过 + 上报 + 继续问下一家 | 签收 | `tests/hotReloadPluginLoad.test.ts:141,170,183` |
| 崩溃隔离:`send` 抛错误进 reject 分支,核心继续 | 签收 | `:202` |
| 0 / 5 / 20 插件:首应答者胜,成本 = 位置 | 签收 | `:71,77,97,112` |
| 真实引擎 profile 协商(`negotiateDigest`、applied-revision) | 真机待验 | md5 桩 + `defMd5Check` 对比已在;与活引擎的算法约定为 `unknown`(§2 记录) |

### 33.3 文件类型维度

| 格 | 状态 | 锚点 |
| --- | --- | --- |
| `.py` 非结构编辑照常 reload | 签收 | `tests/hotReloadSavePipeline.test.ts:168,240`(HR-WATCH-006/003/009 事件源归并) |
| `.def` 非结构(注释 / 换行) | 签收 | `tests/hotReloadDefFingerprintDimensions.test.ts:72,95`(fileHash 变、语义指纹不变);`tests/hotReloadDefGateWiring.test.ts:220`(重启基线后照发) |
| `.def` 结构性(Type / Parent / Persistent) | 签收 | `tests/hotReloadDefFingerprintDimensions.test.ts:113`(两路都变);`tests/hotReloadDefGateWiring.test.ts:151,321,340`(不发 reload、重启警告、审计行) |
| 被拦批次不前滚基线 | 签收 | `tests/hotReloadDefGateBatchSnapshot.test.ts:39,63,69` — 令牌只认领自己那一批 |
| 纯 Python 批不经 def 闸 | 签收 | `tests/hotReloadDefGateWiring.test.ts:243` |
| 混批(py + 结构性 def) | 签收 | `:251` — 整批拦下,py 也不发 |
| def 内容不可读 → 保守不发 | 签收 | `:267,294` |
| 指纹与路径无关(维度①) | 签收 | `tests/hotReloadDefFingerprintDimensions.test.ts:48` |
| `types.xml` 变化不改 `.def` 自身指纹 | 签收 | `:164` |
| `types.xml` 符号导航 | 签收 | `tests/batch129TypesXmlSymbolNavigation.test.ts:216,247` — implementedBy 引用按文件路径+符号匹配 |
| 引擎 Digest 交叉对比 | unknown | md5 桩 + 命令已在;与真实引擎的约定为 `unknown`(§2) |

### 33.4 触发方式维度

| 格 | 状态 | 锚点 |
| --- | --- | --- |
| 缺省 `onSave`:不建磁盘面 | 签收 | `tests/hotReloadDiskWatchWiring.test.ts:142`(HR-WATCH-001 默认) |
| `onDiskChange`:配置变更即建面;切回 `onSave` 即拆 | 签收 | `:147` |
| 未保存的编辑不触发 | 签收 | `:187`(HR-WATCH-002) |
| 磁盘 + save 重叠:同文件单批不双发 | 签收 | `:236`(HR-WATCH-003) |
| delete 不进管线;记 delete-ignored 诊断 | 签收 | `:249` |
| 收窄 globs 不放大热更范围 | 签收 | `:262` |
| 配置关:重建拆磁盘面 | 签收 | `:276`(HR-WATCH-005) |
| dispose 全清:磁盘事件不再进链 | 签收 | `:298` |
| 工作区根变更按新根重建 | 签收 | `:308,341`(RUST-385) |
| 远程 URI(vs-remote 工作区)按 `fsPath` 派生根 | 签收 | `:214`(HR-WATCH-018) |
| 每文件去抖尾窗 + max-delay 封顶 | 签收 | `tests/hotReloadSavePipeline.test.ts:168` |
| 写入稳定:两拍一致才发 | 签收 | `:268`(HR-WATCH-007) |
| 去重(canonical URI + targetId + 内容哈希) | 签收 | `:326`(HR-WATCH-010) |
| 投递指纹生命周期:失败不永久跳过 | 签收 | `:379`(HR-WATCH-008) |
| 语法闸 拦 / 放行 / 关 | 签收 | `tests/hotReloadConfigFaces.test.ts:186,205,219`;`tests/hotReloadSavePipeline.test.ts:425`(HR-WATCH-012) |
| 稳定窗 关 / 开 | 签收 | `tests/hotReloadConfigFaces.test.ts:150,166`(HR-WATCH-007) |
| 波次归集(同窗多文件合成一批) | 签收 | `:234`(HR-WATCH-013);`tests/hotReloadSavePipeline.test.ts:498` |
| 批量预览阈值 + 显式放行命令 | 签收 | `tests/hotReloadConfigFaces.test.ts:248,266`(HR-WATCH-016) |
| 通知模式(silent / errors / summary) | 签收 | `:290,304,314,330,345`(RUST-386,HR-UI-013) |
| dispose 清空待提交队列 | 签收 | `tests/hotReloadSavePipeline.test.ts:536`(HR-WATCH-014) |
| 可监听文件词法过滤 | 签收 | `:582`(HR-WATCH-004) |
| 关 Watch 后手动快捷请求照发 | 签收 | `tests/httpRequestWiring.test.ts`(RUST-429 钉) |
| 手动发送面与热更配置零耦合 | 签收 | `tests/hotReloadWatchOffFallback.test.ts` |
| provider 派发调度隔离(fire 同步段零 `canSend`) | 签收 | `tests/hotReloadProviderWiring.test.ts:380,418,447,469`(RUST-412) |
| 活引擎上的真磁盘 watch 端到端 | 真机待验 | 单元钉注入 watch 适配器;源锁 `tests/hotReloadDiskWatchWiring.test.ts:348` 断言真 `vscode.createFileSystemWatcher` 适配器已接,但真磁盘时序不在门内 |

### 33.5 安全横切

| 格 | 状态 | 锚点 |
| --- | --- | --- |
| 端点策略按 host 字面量分类(不 DNS) | 签收 | `tests/httpEndpointPolicy.test.ts` |
| 密钥不泄出:history DTO 字段集 | 签收 | `tests/hotReloadSecretLeakGuard.test.ts:56,77` — 无 header/token 形状字段 |
| 密钥不泄出:UI tooltip 投影面 | 签收 | `:87,94,98,114,121` — 每行都来自安全字段前缀 |
| 密钥不泄出:输出服务层流水行(行为面) | 签收 | `tests/httpRequestService.test.ts:729`(RUST-421)— Authorization/X-Token 的**值与键名**都不出现在任何日志/错误行 |
| 密钥不泄出:trace 面 | 签收 | `tests/httpRequestService.test.ts` RUST-421 第三钉 — HTTP 路径零 `onTrace\|kodeCoreClient` |
| 传输错误五分类(不吞证据) | 签收 | `tests/hotReloadTransportErrors.test.ts:24,37,49,60,71,76`(RUST-419) |
| 部分节点成功:逐文件明细带分类 | 签收 | `:153` |
| 发送耗时落账(HR-STATE-007) | 签收 | `:195` |
| telnet 探测/会话信任闸 | 签收 | `tests/telnetService.test.ts:644,655,699`(RUST-422) |
| 关 Watch 手动回退:零热更配置读 | 签收 | `tests/hotReloadWatchOffFallback.test.ts` |
| 未信任的活 SSH / 活引擎环境行为 | 真机待验 | 闸在执行时刻读 `isWorkspaceTrusted`;本仓库以注入读取器钉闸,非真工作区信任对话框 |

**残差**:`真机待验` 各格恰好就是 HR-AUDIT-010 族(活网络、活引擎、活远程会话、真工作区信任对话框、真磁盘时序),也是 RUST-430 保持未勾的原因。`unknown` 各格保持不签,因为 §2 记其为 unknown,而库内证据未改变这一点。

## 34. HR-QA-016 watch/http 浸泡不变量(2026-11-22,RUST-428)

- 24h 浸泡的四项性质在 `tests/hotReloadSoak.test.ts`(9 钉)中被钉为**确定性不变量**(与负载无关、非墙钟):(1) **watcher 泄漏** — 对计数工厂跑 200 次 `rebuild` 循环:创建 ≡ 销毁 + 存活,存活数在循环中保持有界(== 根数),`dispose()` 后为 0(先销毁后重建成立,无累积);已销毁的控制器不再布防或重建 watcher。(2) **无界状态增长** — 投递台账按 `root×target×file` 键并替换,故 500 次写回同一文件只留 1 条记录,500 个不同文件留 500 条(线性于文件数而非操作数);历史按容量环有界(`≤ capacity`)且 requestId 幂等替换(500 条同 id 记录 → 1 行),另有 `pruneExpired` 年龄淘汰;版本簿按文件有界。(3) **连接泄漏** — HR-HTTP-006 keep-alive 池:对进程内 HTTP 服务器 300 次顺序真实 `defaultTransport` 发送复用单条连接(服务器 `connection` 计数保持 1),200 与非 2xx 路径皆是 — 无每请求新 socket、无累积。(4) **重试风暴** — `retryFailedHotReloadTargets` 每个失败目标每次调用恰好发送一次(2 失败 + 1 确认 → 2 次发送,无放大),已确认目标跳过,取消停止后续发送且不冒充已发送,第二遍只重发仍失败的目标(有界、无风暴)。
- 边界(诚实):**字面 24h 墙钟浸泡本批未跑** — 不变量正是 24h 浸泡应当观察到的性质,K 迭代等价证明无需依赖 24h 窗口或共享 runner 的负载(与 RUST-425 的算法性非墙钟调用同一纪律;真正过夜运行需专用低负载窗口)。keep-alive 池是单主机复用优化(按协议懒单例)— 跨主机 socket 增长由 agent 池面有界,超出单引擎浸泡范围。传输层 `ok` 标志意为"收到响应"(500 是 `ok:true status:500`;非 2xx 由投递层判 `failed`),如此记录使该臂读起来诚实。

## 35. HR-QA-017 关 Watch 降级 + 手动回退 + 状态保持(2026-11-23,RUST-429)

- watch 面只是**触发源**,绝不是手动发送路径的依赖 — 这个边界正是降级梯诚实的前提。`tests/hotReloadWatchFallback.test.ts`(5 钉)经真实配置往返驱动 `setupHotReload`:(1) **关闭拆除** — `enabled:false` 重新布防 `apply()`,它销毁每个存活 watcher(HR-WATCH-005),不建替代品,状态栏置于"关"面并输出"未开启"日志行;此后**已销毁**的 watcher 再触发不调度也不发送(自动源完全静默,而非仅仅无声)。(2) **可恢复** — 同一装配实例内翻回 `enabled:true` 重建**新** watcher(新对象身份),状态栏回"就绪",恢复的 watcher 上的一次变更重新调度并触发动作。(3) **无状态损坏** — 经 `targetState` 注入的投递台账存储(一次性创建于 `src/activate/hotReload.ts:120`)**不被** `apply()` 重建 — 关闭/开启循环保留循环前的记录,重启用后的发送落在**同一**存储实例,故降级梯不损失数据。(4)/(5) **手动快捷请求正交** — watch 关闭时,一个启用的设置 HTTP 请求仍被列出且仍可经 `QuickActionManager` 运行,手动面在 watch 开/关时逐项一致。
- 边界(诚实):手动/自动切分有**两个不同轴上的独立开关** — `kbengine.hotReload.enabled` 门控自动触发源,而每请求 `enabled` 标志过滤快捷动作*列表*(`src/quickActions.ts:573`)。关 watch 无法隐藏手动请求,禁用一个请求只把它从列表隐藏。`runByName('@http:settings:<i>')` 按索引读设置表,故直接寻址也能到达已禁用项;这是既有索引运行语义,在此如实记录而非标记为修复。既有的 `enabled:false` 启动与模式切换拆除臂(`tests/hotReloadAssetsRootWatch.test.ts`、`tests/hotReloadDiskWatchWiring.test.ts` HR-WATCH-005)在此不重跑;本 lane 增加单生命周期内的开→关→开往返、拆除后事件隔离、以及台账跨它的存活。

## 36. RUST-430 可执行夹具伴生(2026-11-23,RUST-430,EN §45 伴生)

- **EN §45(zh §33)的伴生而非替代**:EN §45(zh §33)是文档矩阵(70 格,手工锚定,4 格真机待验残差);本节(对应 EN §48)是同一任务的可执行切面 — 冻结夹具加防漂移门禁。两者承载同一诚实残差(活机器 / HR-AUDIT-010 族),在此记为 3 个显式越界缺口。

- 四维度在冻结矩阵夹具中**逐格签收**:`tests/fixtures/hot-reload-completion-matrix.json`(版本 1)声明维度取值集(`target` = default-action-name / http-quick-request / script-quick-action / profile-channel / provider-host;`engineProfile` = builtin-default / explicit-channel / provider-supplied;`fileType` = py / def / types-xml / config-file / non-py-bypass;`trigger` = watch-save / watch-disk-change / manual-quick-request / retry-failed / external-apply),19 个已签格、6 个横切安全不变量、3 个显式越界缺口(各带理由)。
- 门禁 `tests/hotReloadCompletionMatrix.test.ts`(5 钉)保持矩阵**不漂移**:每个声明的维度值必须被至少一个已签格引用(无人签的值变红);每格判定必须自洽 — `covered-test` 证据必须是*真实*测试文件、`covered-src` 必须是*真实* src 文件(不得凭记忆签收);每个越界缺口必须带理由;且一项安全性质由**门禁自身直接验证** — HTTP 发送链(`src/backend/httpRequestService.ts`、`src/backend/hotReloadTransport.ts`)不 import `child_process`,故未来发送路径出现 `spawn` 会变红而非静默通过。
- 边界(诚实):门禁钉的是**矩阵↔现实一致性**,不重跑各格子套件(各自独立 lane,引为证据)。`no-child-process` 验证器把 `hotReloadTransport` 的 `exec(...)` 文本当作终端命令回退*标签*,而非 `child_process` 调用 — 命令/脚本发送面刻意经托管进程面,且另受信任闸(RUST-422)。签收一个维度值需一个已签格或显式越界理由;新增维度值而无其一则门禁变红。

## 37. HR-DOD-001 双名发送面收口(2026-11-23,RUST-440,用户裁定:限定双名发送面收口)

- 书 §19.1 双名契约(`src/backend/hotReloadModuleIdentity.ts:31-34`)是 DOD-001 断言的不变量:`fullModule` = **UI 显示名**(`entities.fight.FightAI`)、`requestModule` = **实际线上名**(`fight.FightAI`)。本 lane 之前自动发送从不填充 `moduleIdentities` — `runViaProvider`(`src/hotReload.ts`)把裸 `{ targetId, files }` 交给 provider,故内建 HTTP provider 把**显示**名推到线上(`module_name=entities.fight.FightAI`),正是 DOD 指出的缺口。
- 收口把自动发送接进**生命周期槽**:发送路径现在调用 `resolveLifecycle(profile)`(provider + 组合槽,`src/backend/hotReloadPluginApi.ts:347`),每文件跑 `slots.resolveModule → slots.prepareRequest`,产出 `moduleIdentities=[requestModule]`(`hotReloadPluginApi.ts:238`)— 线上只承载短名,绝不承载显示名。`tests/hotReloadDodDualName.test.ts`(4 钉)端到端驱动书 §19.1 FightAI 场景:(1) **缝** — provider 请求携带 `moduleIdentities=['fight.FightAI']` 而非 `entities.fight.FightAI`;(2) **线上** — 经内建 provider 的 HTTP `module_name=fight.FightAI`,且即使遗留 `__init__.py` 包走查本会产出显示名,它也不出现在 URL;(3) **UI** — 同一解析器供历史流得 `{fullModule:'entities.fight.FightAI', requestModule:'fight.FightAI'}`,`buildHistoryEntryLabel` 按显示名作标题,而 tooltip 投影 `requestModule: fight.FightAI` 为已发送名;(4) **零配置零漂移** — 无脚本根时生命周期无法解析根,故 provider 请求保持改动前精确形状(`{ targetId, files }`,无 `moduleIdentities`),文件不被丢弃。
- 边界(诚实,按裁定):这收口**仅双名发送面**(`sendViaProviders` 路径)。零配置默认热修保持记录的遗留 `${module}` 语义(HR-AUDIT-004 / RUST-322 兼容裁定);生命周期无法解析的文件(无根 / 歧义 / 非 `py` / `__init__`)经空 `moduleIdentities` 条目回退到既有推导面(HR-HTTP-002"空 = 未给定"),故收口从不丢文件、从不改零配置行为。证红证据是修复前状态:臂(1)/(2)在 `module_name=entities.fight.FightAI`(显示名)上失败,生命周期接线后转绿。

## 38. HR-WATCH-014 停用时在途请求策略(2026-11-23,RUST-338,自然完成;EN §50)

- DOD-014 断言留了一个规范未钉的决策点:热更停用(两条路径——扩展 dispose,或书 §11.4 配置关 apply 重建)时,**已经在途**的请求(transport `send` 已发起、回执未结算)怎么办?策略按「收编残差」裁定(不建 abort 抽象):**自然完成**——停用清空待提交队列并停止受理新文件,但已发出的 transport 请求不打断;其回执照常落台账(UI 数据面),停用后零重新入队。
- 面级钉 = `tests/hotReloadSavePipeline.test.ts:536`(`HR-WATCH-014 dispose` describe):pending 清空、定时器清除、零发出,且 dispose 后 `offer` 不再受理。装配级钉 = `tests/hotReloadStopInflightWiring.test.ts`(2 钉,本批新),两条停用路径各一:(1) 装配 `dispose` —— 在途请求在停用后结算,`record.outcome === 'sent-unverified'` 落入目标态存储(回执不丢),随后同文件再变动零新发送(watcher 已断,`sendCalls` 恒 1);(2) 配置关(书 §11.4 apply 重建)—— 同断言走重建路径。策略本身钉在 dispose 处注释(`src/hotReload.ts:1958-1960`)。
- 边界(诚实):「旧代回执不冒当前」**不在本面重复钉** —— 由代际结算保证(`src/backend/hotReloadChannelSend.ts:177`),钉在 `tests/hotReloadAppliedVerifyWiring.test.ts:229`(IDE-AUD-005 F08);台账即 UI 数据面由 `tests/hotReloadHistoryView.test.ts` 钉。证据级别:臂(2)/(3)行为级(本批新钉),臂(1)/(4)既有钉。门禁 = 热更装配面 9 文件 179 例绿(`6f5c1a38`)。

## 39. HR-DOD-007 隔离收口(2026-11-23,RUST-446,纯验证闭合——零新代码;EN §51)

- DOD-007 断言四条不串性质:跨目标、多 root、远端 SSH 不串数据、不串状态、不误发 HTTP。四臂皆已由邻 lane 实现且测试钉死;本收口是**纯验证** —— 每臂在库重锚并按自身证据级别如实分级,不冒充全量端到端。
- 四臂:(1) **跨目标/多根状态** = HR-STATE-004 分区键(`rootId × targetId × file`)+ 每窗口 store 实例边界 —— `tests/hotReloadFileState.test.ts:289/:300/:318/:329`(同文件双 target 各自派生互不串;同 target 双根;无记录的 target 不继承他者的 applied 绿;切目标后新 target 以自己的基线判脏),台账键 = `buildHotReloadTargetKeyId({rootId,targetId})/file#n`(`tests/hotReloadHistoryView.test.ts:112/:281`)= **行为级**。(2) **多根** = `rootId` 入 DTO 且歧义根拒绝不猜:`tests/hotReloadModuleIdentity.test.ts:76/:94-99`(唯一命中即解析;零命中 out-of-root;嵌套多命中 `ambiguous` 列全候选根)+ fire 路径逐文件 `resolveRootId`(RUST-329 装配面钉)= **行为+结构级**。(3) **不误发 HTTP** = 四条 fire 闸(RUST-444)+ F4 回执目标核验整条拒绝 `targetId` 不匹配的回执(`tests/hotReloadChannelApplied.test.ts:170`、`tests/hotReloadTransport.test.ts:319/:368/:382`、`src/backend/hotReloadChannelSend.ts:240`)+ 修订闸(`tests/hotReloadRevisionGate.test.ts:248`)+ 装配单通道形态 —— `resolveChannelTransport` 只解出单一 `targetId`,不存在按目标路由的面可供误路由 = **行为+结构级**。(4) **远端 SSH** = 路径形态归一使远端键与本地键同口径:`tests/hotReloadModuleIdentity.test.ts:9-38`(fsPath 四形态)与 RUST-423 生产形态矩阵 `:226-258`(SSH / DevContainer / WSL UNC 各自唯一解析),bench 面键口径一致(`tests/perf/hotReloadScale.bench.ts:343-368` M5)= **结构级**。
- 边界(诚实):臂 (4) 只钉机制面 —— 远端 SSH/workspace 活会话端到端(活会话+远端 fs 延迟)不在本行验收口径,归 `RUST-413` 远端臂(在该行如实记,本行不冒充)。臂 (1) 为纯核进程内状态面;跨窗口隔离由 store 实例边界成立(台账与基线册皆每窗口纯内存件,`tests/hotReloadFileState.test.ts:311-315`)。lane 巡检异议(「save-pipeline 版本簿与 `fileChangeMeta` 缺 `rootId` 维」)已查并**判非缺口**:workspace 根是不相交目录树(同一绝对路径不可能属两根),归一化防同文件异形键,跨根同名模块歧义已在解析器拒绝(臂 2);隔离关键册(目标态/历史/revision 证据)皆 `(rootId, targetId)` 键(`src/backend/hotReloadRevisionEvidence.ts:135/:142`);`fileChangeMeta` 是内容缓存(哈希是路径事实非目标事实)—— 加维属设计变更不属隔离修复。门禁 = `hotReloadFileState + hotReloadModuleIdentity + hotReloadTransport + hotReloadChannelApplied + hotReloadDiskWatchWiring` 定向 165/165 绿(零新代码面,门禁 = 定向锚点集)。
## 40. HR-DOD-002 三触发面短名/全名一致性(2026-11-23,RUST-441;EN §52)

- 书 §19.1 双名称对(`fullModule` = 展示名,`requestModule` = 线上名)对**同一模块**必须在三个触发面上**完全一致**:手动命令(用户 HTTP 请求模板 `${reloadModule}`/`${fullModule}`,由 `buildTemplateVars` 产出,`src/backend/httpRequests.ts`)、onSave、onDiskChange。后两者共用同一条 fire 路径(`triggerMode` 只决定谁把事件送进来),所以对照面是手动对自动:自动面经 `resolveHotReloadModuleIdentity`(`sendViaProviders` 键开)与 `resolveDefaultHotfixModule`(键关)解析,两者都已带 `kbengine.hotReload.allowRootLevelStem`(HR-MOD-008)。
- 收口前的缺口=手动命令面**漏 HR-MOD-008**:`buildTemplateVars` 只把 `(filePath, scriptRoot)` 喂给 `resolveModuleDualName`,从不带 `allowRootLevelStem`。根下单层脚本(`scripts/Lone.py`)键开时自动面解出裸短名 `Lone`/`Lone`,手动命令面解出 `''`/`''`(未解析)——同一模块两个名字;请求预览面同缺(配置条目行与自己默认热更面行互不一致)。
- 收口把 `allowRootLevelStem` 经 `TemplateEditorContext` → `buildTemplateVars` → `resolveModuleDualName` 打通,并在每个产出点补上:`views.ts` 的 `getTemplateContext`(手动命令运行时)、`hotReloadRequestPreview.ts`(预览配置条目)、`hotReloadDefaultHotfix.ts`(默认热更模板的 `${fullModule}`/`${reloadModule}` 与 `${module}` 同参)。键关/缺省不变(`undefined !== true`),任何既有解析结果都不动。`tests/hotReloadDodDualNameConsistency.test.ts`(4 钉)驱动三面一致性:(1) 嵌套 FightAI — 手动变量 `{requestModule:'fight.FightAI', fullModule:'entities.fight.FightAI'}` 与自动生命周期身份、`resolveDefaultHotfixModule` 同值;(2) 根下单层+键开 — 手动变量与自动面全解 `Lone`/`Lone`(证红钉:修复前手动面返回 `''`/`''`);(3) 根下单层+键关 — 三面一致判未解析(手动空串,自动 `root-level` 码),一致回落 legacy `${module}` 包边界扫描;(4) 未配脚本根 — 手动与自动都无模块名(`''` / `no-root`),不混回落。
- 边界(诚实):本门断言的是跨面**名称解析一致性**;不改每面线上送哪个名(那是 DOD-001 的发送面,另行收口)。legacy `${module}` 包边界扫描回落(HR-AUDIT-004 / RUST-322 兼容裁定)保留,并断言跨面同为第三名,不与双名对混用。证红证据=修复前状态:臂(2)红于手动面解 `''` 而自动面解 `Lone`,打通该选项后转绿。

## 41. HR-QA-018 资格契约矩阵

§33 的签收矩阵是 RUST-430 的管辖记录。本节保留钉住资格规则本身的契约完备性工件:`tests/hotReloadEligibilityMatrix.test.ts`(3 钉,载体 ba7833d5)穷举 **480 格**——3 档案×2 根×4 文件形态×5 触发态×2 用户显式×2 结构态——逐格对照独立重导 oracle(restart⟺结构因非空且主导;auto⟺四要素齐备;否则 manual),断言不抛错/无第四结论,另 auto=恰 1 格、restart=恰半数格。`.def` 不被规则特判(def 闸供结构因,规则只消费不重算)。target 安全门覆盖(loopback 白名单/workspace trust/provider 权限/结构闸按 target)已折入 §33.1 与 §33.5;本节旧稿表格被该逐维度签收取代,不再复述。
