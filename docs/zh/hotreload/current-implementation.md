# 热更新 — 现状实现审计（HR-PR-01）

- 固定审计 SHA：`36052c47cb26290b6829632c6c3ca31341161c96`（分支 `v0.2`）。
- 范围：HR-AUDIT-001..012，书 `docs/kode2/KODE_2_COMPLETE_TODO.md` §19.2。
- 红线遵守：Watch/Hash/成功确认的实现程度一律按有据事实或 `unknown` 上报。
- 2026-11-06 用户令取代旧口径：示例端点/参数全仓修正为 `POST http://127.0.0.1:8090/hotfix?module_name=<module>`，query 与 body 各带一份 `module_name=<module>`（两种读参口径的服务端都拿得到；同值重复无害）；审计 SHA 记录的旧错误拼写不再被任何位置携带，并有全仓 grep 门禁拦截。
- 本 PR 不改行为。仅审计。

## 1. 事实表（对照上述 SHA 的源码核验）

### HR-AUDIT-001 — 锚点：package.json / README / 旧文档

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 命令 | `kbengine.httpRequests.run`（合并清单 QuickPick）、`kbengine.httpRequest.run`（具名，需 `args.name`） | `package.json` contributes.commands；`src/extension.ts:1135,1163` |
| 键位 | 两个 HTTP 命令均未注册键位（每条只有展示用 `keybinding` 字符串；真实绑定需在 VS Code 键位 UI 手工配置） | `package.json` keybindings（仅 telnet）；`src/httpRequests.ts:36-41` |
| 视图 | 无热更新视图。`kbengine.quickActions` TreeView 把 HTTP 请求条目列为可运行节点 | `package.json` contributes.views；`src/quickActions.ts:507` |
| 配置：`kbengine.httpRequests` | 数组；默认 = 一条**禁用**示例 `{"name":"热更新(示例)","url":"http://127.0.0.1:8090/hotfix?module_name=${module}","method":"POST","body":"module_name=${module}"}`（2026-11-06 更新） | `package.json` configuration default；`src/httpRequests.ts` `BUILTIN_HTTP_REQUEST_EXAMPLE`（测试锁同步） |
| 配置：`kbengine.hotReload.*` | `enabled=true`（2026-11-06 起默认开）、`actionName=""`（= 发默认热更请求）、`globs=["**/*.py"]`、`debounceMs=500` | `package.json`；`src/hotReload.ts` `readHotReloadSettings` |
| README/文档 | `README.md`、`README.zh.md`、`docs/guide/configuration.md`（HTTP 快捷请求节）、`docs/zh/guide/configuration.md`、`docs/features.md` 均记载设置清单、`${module}` 包边界语义与默认端点形态 `curl -X POST 'http://127.0.0.1:8090/hotfix?module_name=entities.fight.FightAI' -d 'module_name=entities.fight.FightAI'`（`module_name` query 与 body 双带）（2026-11-06 更新） | 固定 SHA 处文件 |
| 旧差距台账 | `docs/reference-feature-gap.md` G5 声称"自动热更新已实现（批 136）"——该说法只覆盖 **watch→触发 quick action**，不含 §19 状态/确认模型 | `docs/reference-feature-gap.md:40,55` |

### HR-AUDIT-002 — rg 全扫：实现与注册的全部入口

扫过：`httpRequests|reload|hotfix|hotReload|watch|\.def|digest|md5|sha256|hash`，范围 `src/`、`package.json`、README、`docs/`、`tests/`（排除 node_modules）。

| 模块 | 角色 |
| --- | --- |
| `src/httpRequests.ts` | 纯逻辑：条目解析、自定义模板变量、`${module}` 解析器、请求组装 |
| `src/httpRequestService.ts` | 设置链执行器：node http/https 传输、OUTPUT 面板流水、错误弹窗 |
| `src/quickActions.ts` | 第二个 HTTP 执行器（`fetchHttp`/`terminalHttp`），服务 `.kbengine/debug.json` 动作；分发 `@http:debug|settings:<idx>`；curl 命令构造器（仅测试引用） |
| `src/quickActionConfig.ts` | debug.json/httpRequests 解析；`resolveActionVariables`（官方变量表，未解析即抛错） |
| `src/quickActionTree.ts` | quick action + HTTP 请求的 TreeView 节点 |
| `src/variableSubstitution.ts` | VS Code 官方变量族（单一真源） |
| `src/hotReload.ts` | 自动热更新：配置门控、逐 glob `FileSystemWatcher`、全局去抖、按名执行 quick action |
| `src/debugJsonSchema.ts` | `.kbengine/debug.json` 的 schema，含 `httpRequests` 与 quick action `type:"http"` |
| `src/debugConfigBootstrap.ts` | 生成带注释 `http` 热更动作示例的 `.kbengine/debug.json` 模板（`http://127.0.0.1:8090/hotfix?module_name=${module}`、POST、body `module_name=${module}` — 2026-11-06 对齐，参数双带） |
| 注册 | `src/extension.ts:1113-1180`（通道 + 服务 + 2 命令）、`:1591-1592`（设置条目注入 QuickActionManager）、`:1624-1626`（`setupHotReload` → `quickActionManager.runByName(name, {suppressConfirm:true})`） |
| 引擎侧元数据 | `src/kbengineMetadata.ts:114-116` 记载 `KBEngine.reloadScript(fullReload)`（仅 baseapp/cellapp）——hover/snippet 面，不涉 HTTP |

### HR-AUDIT-003 — Quick Request 端到端追踪（设置链）

1. 用户：`kbengine.httpRequests.run` → 合并条目（debug.json + 设置，按来源注记）QuickPick，或带 `args.name` 的 `kbengine.httpRequest.run`。
2. 解析：`parseHttpRequestEntries`（`src/httpRequests.ts:62`）——坏条目原样跳过、method 大写、headers 仅字符串。
3. 变量：`buildTemplateVars(editorContext, isPackageDir)` + `buildOfficialVariableContext` → `buildHttpRequest` 单遍替换（自定义占位先、官方表后，未知保留字面量）。
4. 传输：`defaultTransport`（`src/httpRequestService.ts:47-123`）——`URL` 解析守卫、仅 http/https、`req.setTimeout` 10s 销毁请求、接收窗口上限 `RESPONSE_PREVIEW_LIMIT*4` 字节（16 KiB）。
5. 输出：通道 `KBEngine HTTP 快捷请求` —— `▶ [name] METHOD URL`，随后 `✓ <status> · <ms>` + body 预览（4000 字符，截断标记），或 `✗ …` + 错误弹窗。`result.ok` 对服务端返回的**任何**状态码都为 true（含非 2xx）；状态语义不做分类。
6. 覆盖的失败形态：URL 不可解析、协议不支持、超时、socket/DNS 错误（全部 resolve，从不 reject）。

debug.json quick action 链路有分叉：`runHttpRequestFrom` 只解析**官方变量**（未解析 → 抛错），随后 `terminalHttp` → `fetchHttp` → 结果按 `http:<name>` 组件写入 LogHub，2xx 为 info 否则 error。

### HR-AUDIT-004 — `${module}` 精确逻辑与全部模板变量

`resolvePythonModulePath`（`src/httpRequests.ts:122-141`）：

- 拆 POSIX 规范化路径；stem = 文件名经正则 `/\.py$/i` 去掉尾部 `.py`（大小写不敏感；`.PY` 会被剥离；`.pyi`/`.pyc` 因 `$` 锚点**不会**命中）。
- 从文件目录向上行走；目录只有当注入探针报告其含 `__init__.py` 时才算包段；首个非包目录停止行走。盘符段不可能是包。
- KBEngine 角色目录（`base/`、`cell/`）无 `__init__.py` → 模块名 = 裸文件 stem。真实包（`entities/`、`fight/` 各含 `__init__.py`）→ `entities.fight.FightAI`。
- 未注入探针 → 模块 = 仅文件 stem。
- 全程保留大小写。`__init__.py` 的 stem 是 `__init__`——**不存在任何特判**。

全部变量清单：

| 变量 | 来源 | 语义 |
| --- | --- | --- |
| `${module}` | 自定义 | 包边界模块路径（如上） |
| `${moduleBasename}` | 自定义 | `${module}` 的最后一个 `.` 段 |
| `${filename}` | 自定义 | 含 `.py` 的文件名（批 153 由 `${file}` 改名） |
| `${line}` | 自定义 | 光标行，1 基 |
| `${sel}` | 自定义 | 选中文本 |
| 官方变量族 | `src/variableSubstitution.ts` | `${file}`=绝对路径、`${workspaceFolder}`、`${workspaceFolder:Name}`、`${fileBasename}`、`${fileBasenameNoExtension}`、`${fileDirname}`、`${fileExtname}`、`${relativeFile}`、`${relativeFileDirname}`、`${env:NAME}`、`${cwd}`、`${userHome}`、`${pathSeparator}` |
| 未知占位 | — | 保留字面量，从不清空；值**不做 URL 编码** |

debug.json quick action 变量：仅官方表，未解析即硬错误（与设置链失败语义不同——两条链路都已核验）。

### HR-AUDIT-005 — 文件 watcher：创建、用途、生命周期

| 位置 | 模式 | 用途 | 生命周期 |
| --- | --- | --- | --- |
| `src/hotReload.ts:162-193` | 按 `kbengine.hotReload.globs`（默认 `**/*.py`） | 热更新：3 通道事件（change/create/delete）→ 单一全局去抖触发 → 按名执行 quick action | 默认**关**（不建 watcher）；`onDidChangeConfiguration('kbengine')` 拆+重建；`context.subscriptions` 中一个 composite disposable 拆 watcher + 计时器 + 配置监听 |
| `src/extension.ts:491` | `**/*.{py,def,xml}` + 外部扫描根 | Python 类索引失效 | 经 `context.subscriptions` 数组释放 |
| `src/extension.ts:1395` | `**/kbengine*.xml` | 最终服务器配置视图刷新 | `context.subscriptions` |
| `src/extension.ts:1720` | `**/<managedDir>`、`**/<managedDir>/**` | `.kbengine` 资产再生 | 逐 watcher `context.subscriptions` |
| `src/pythonTypeStubs.ts:602` | `**/types.xml` | 桩重导出 | `context.subscriptions` |
| `src/languageProviders.ts:4321` | `**/*.def`、`**/types.xml`、`**/entities.xml` | CodeLens 失效 | provider 级，随订阅释放 |
| `src/entityMapping.ts:829,859,898` | def/xml 模式 | 实体映射缓存 | `context.subscriptions` |
| `src/workspaceIndex.ts:36` | `**/*.py` glob | 工作区 python 索引 | 显式 dispose |
| `src/debugConfig.ts:221` | 配置模式 | 调试配置再生 | `this.configWatcher` 释放 |

补充事实：**全仓无任何 `onDidSaveTextDocument`/`onWillSaveTextDocument` 使用**——保存触发重载不存在；`onDidChangeTextDocument` 仅一处（`src/extension.ts:662`，调用链视图刷新，非热更新）。热更新触发是**全局单一去抖**（非逐文件），不按文件去重、不哈希内容，无论哪个文件变更都执行所配置的 quick action。

### HR-AUDIT-006 — 既有 HTTP 能力盘点（避免重建）

| 能力 | 设置链（`HttpRequestService`） | debug.json 链（`fetchHttp`/`terminalHttp`） |
| --- | --- | --- |
| 方法 | 任意，大写，默认 GET | 任意，默认 GET |
| URL/headers/body | 模板化（自定义 + 官方变量）；headers 会发送 | 仅官方变量；**headers 解析后被丢弃——`HttpRunOptions` 无 `headers` 字段，`fetchHttp` 只传 `{method}`**（`src/quickActions.ts:75-79,217`） |
| 超时 | 固定 10s（`DEFAULT_HTTP_TIMEOUT_MS`），不可按条目配置 | 固定 10s（`QUICK_ACTION_TIMEOUT_MS`） |
| 响应上限 | 16 KiB 窗口 / 4000 字符预览 | 4000 字符窗口 |
| 重试 | 无 | 无 |
| 取消 | 无 | 无 |
| SecretStorage | **`src/` 零 `secrets`/SecretStorage 使用**（telnet 密码来自设置、仅走 socket、从不入日志——独立特性） | 无 |
| 代理/TLS 选项 | 无 | 无 |
| 并发 | 无上限，按次调用 | 无上限 |
| 输出 | 专用 OUTPUT 通道 + 错误弹窗 | LogHub 条目 + 错误弹窗 |
| 非 2xx 处理 | 以 `ok:true` + 状态码上报（不分类） | 按 2xx 定 info/error 日志级 |

支持 headers 的 `buildCurlCommand` 帮助函数存在（`src/quickActions.ts:178`）但仅被测试引用——执行路径中的死代码。

### HR-AUDIT-007 — 热更新历史 / 状态栏 / 装饰 / 重试

- `src/` 无热更新历史存储、无请求时间线、任何位置都无失败重试。
- 状态栏：恰好两个——telnet（`src/extension.ts:1595`）与运行中服务器计数（`src/extension.ts:2742`）。无热更新状态项。
- TreeView：`kbengine.quickActions` 把 HTTP 条目列为静态可运行节点；无重载状态、无装饰。
- 通知：热更新路径只在出错时弹窗；不存在成功通知（无可静音之物）。
- 结论：HR-STATE（§19.6）与 HR-UI（§19.7）是**绿地**；可复用的只有触发管线和两个 HTTP 执行器。

### HR-AUDIT-008 — `.def` Hash / Digest 现状

- 全仓 `digest|md5|sha256|sha1|createHash|fingerprint` 扫描：唯一的密码学哈希是 `src/logHub.ts:101`（日志文本 sha256 去重指纹）。`src/defAnalyzer.ts`、`src/defParser.ts`、`src/semanticIndex.ts` **不含任何形式的哈希**。
- 三层模型（fileHash / semanticHash / engineDigest）：**均不存在**。无文件哈希、无语义指纹、无引擎 digest 代码。
- 仓内引擎侧证据：`KBENGINE_SOURCE_AUDIT_PLAN.md` §14（源码核验）确认 `KBEngine.reloadScript(fullReload)` 在 baseapp/cellapp 存在，且 `KBEngine.reloadEntityDef()`/`isReload()` 已被**撤回**为不存在的公开 API。本仓任何位置均无引擎 Digest 算法文档。

### HR-AUDIT-009 — 服务端协议证据

- 本仓不携带服务端实现。现行端点形态 = 2026-11-06 用户令所定：`POST http://127.0.0.1:8090/hotfix?module_name=<module>`，query 与 body 各带 `module_name=<module>`（README、docs/guide/configuration.md、内置示例、零配置自动热更发送方 `src/hotReloadDefaultHotfix.ts` 全部取自同一常量）。
- 参数命名：2026-11-06 经用户明令全仓修正；审计 SHA 记录的旧错误拼写不再被任何位置携带（grep 门禁 `tests/hotfixSpellingGate.test.ts`）。
- 响应 JSON 字段、目标进程识别、applied-revision 查询：**unknown —— 仓内无证据**。

### HR-AUDIT-010 — 真实项目测试记录

- **未执行**（本审计环境无可达引擎/HTTP 服务）。状态：`untested`。
- 既有自动化覆盖（仅脚本化传输，无真实服务器）：`tests/httpRequests.test.ts`、`tests/httpRequestService.test.ts`、`tests/httpRequestWiring.test.ts`、`tests/quickActionManager.test.ts`、`tests/hotReload.test.ts`、`tests/quickActionRunners.test.ts`。
- 所需夹具（HTTP 200 但业务失败、服务器静默、模块名冲突、原始响应）仍待按 HR-AUDIT-010 采集；阻塞于有活服务。

## 2. 事实 vs 未知 汇总

| 领域 | 已实现（证据见上） | 未知 / 未实现 |
| --- | --- | --- |
| 手动 HTTP 快捷请求（设置 + debug.json） | 是 | 逐条目超时、重试、密钥存储 |
| 模板变量含 `${module}` | 是（包边界扫描） | 无 `${reloadModule}`/`${fullModule}`/`${relativePath}`/`${targetId}` |
| Watch → 触发 quick action | 是（门控默认关、全局去抖） | 逐文件去重、哈希、语法闸、保存触发、根作用域、稳定等待 |
| 成功确认 | **无** —— `ok` 只表示传输有应答，不区分 2xx | accepted/applied 语义完全未知 |
| 重载状态/历史/UI | **无** | §19.6/§19.7 全部 |
| `.def` 文件/语义/引擎哈希 | **无** | 引擎 Digest 算法 |
| 服务端响应契约 | 仅请求形态（用户真实服务） | 响应字段、applied revision、目标/进程、服务端参数命名 |

## 3. 保留 / 包裹 / 替换矩阵（HR-AUDIT-011）

| 既有模块 | 判定 | 理由 / 目标 |
| --- | --- | --- |
| `src/httpRequests.ts` 条目解析 + 模板机械 | **保留**（通用 Quick Requests） | 通用特性不得回退（HR-HTTP-001）；`${module}` 在此审计，向新变量的映射归 HR-MOD-012 定 |
| `src/httpRequestService.ts` `HttpRequestService` + 传输 | **包裹** | 在 `HttpTransport` 接缝（本就可注入）后抽出可复用 `RequestExecutor`；热更新成为调用方 |
| `src/quickActions.ts` `fetchHttp`/`terminalHttp` | **包裹**（header 丢失另修） | 第二执行器；统一到单一执行器或保留为 debug.json 适配器 |
| `src/variableSubstitution.ts` | **保留** | 官方变量单一真源 |
| `src/quickActionConfig.ts` `resolveActionVariables` | quick action 侧**保留** | 未解析即抛错的语义是有意的 |
| `src/hotReload.ts` watcher + 去抖 | **替换**（渐进，HR-WATCH） | 全局去抖/逐 glob 模型被逐文件管线取代；保留门控默认关与配置重建的生命周期模式 |
| `resolvePythonModulePath` | 热更新路径由纯 `ModuleResolver` **替换**（HR-MOD-002） | 为旧 `${module}` 兼容保留 |
| quickActions TreeView HTTP 节点 | **保留** | 热更新 UI 是新面，不是这棵树的分叉 |
| `buildCurlCommand` | **保留或删除** | 当前仅测试引用 |

## 4. 复用模块路径与所有者（HR-AUDIT-012）

| 复用目标 | 精确路径 | 关键导出 | 所有者 |
| --- | --- | --- | --- |
| 条目解析 / 模板 | `src/httpRequests.ts` | `parseHttpRequestEntries`、`buildTemplateVars`、`applyTemplateWithContext`、`buildHttpRequest`、`resolvePythonModulePath`、`BUILTIN_HTTP_REQUEST_EXAMPLE` | cuihairu（git log 唯一作者） |
| HTTP 传输 / 执行 | `src/httpRequestService.ts` | `HttpRequestService`、`HttpTransport`、`defaultTransport`、`DEFAULT_HTTP_TIMEOUT_MS` | cuihairu |
| debug.json HTTP 路径 | `src/quickActions.ts` | `fetchHttp`、`terminalHttp`、`QuickActionManager.runHttpRequestFrom`、`runByName` | cuihairu |
| 官方变量表 | `src/variableSubstitution.ts` | `resolveVariableExpression`、`VariableContext` | cuihairu |
| Watcher 生命周期模式 | `src/hotReload.ts` | `setupHotReload`、`HotReloadTrigger`、`readHotReloadSettings` | cuihairu |
| 配置 schema 面 | `package.json`（`kbengine.httpRequests`、`kbengine.hotReload.*`）、`src/debugJsonSchema.ts` | — | cuihairu |
| 引擎侧 API 元数据 | `src/kbengineMetadata.ts`（`KBEngine.reloadScript`）、`KBENGINE_SOURCE_AUDIT_PLAN.md` §14 | — | cuihairu |

上表无源码证据的项一律记 `unknown`：服务端响应契约、引擎 Digest 算法、applied-revision 可查询性、服务端参数命名、全部真实项目行为（HR-AUDIT-010 未测试）。
