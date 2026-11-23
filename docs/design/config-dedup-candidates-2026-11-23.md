# 配置项精简候选清单（2026-11-23 巡检单产出，待逐项拍板）

> 分析口径：kode 全量 177 项配置（package.json contributes.configuration 九块）逐项对照
> 引擎真实读取面——`/home/cui/workspaces/kbengine/kbe/res/server/kbengine_defaults.xml` 与
> BigWorld-Engine-14.4.1 源码实读。本清单**只做分析，不改 package.json**；每项处置等用户
> 逐项拍板后才执行。证据行号均为实测（引擎树 = kbengine 工作区 HEAD）。

## A. 可删——kode 硬编码默认值在引擎侧不存在，真源在引擎配置树或引擎固定布局

| 配置项 | 现默认 | 为什么可推导（推导式 + 引擎依据） | 建议 |
| --- | --- | --- | --- |
| `kbengine.loggerPort` | `20022` | 20022 在引擎树全零命中（`kbe/res/` + `kbe/src/` grep 零）。真源 = `logger.telnet_service.port`（kbengine_defaults.xml:929，值 34000，密码同块 :930）。kode 已有 `derive.telnet` 逐组件端点派生链（src/configDerive.ts:86-94），logger 端点已在派生面。 | **删**：`loggingWiring.ts:65` 改读 `derive.telnet` 的 logger 端点（engineVersionDetect 同法），缺省回落现值仅作过渡 |
| `kbengine.binPath` | `${workspaceFolder}/kbe/bin/server` | 二进制路径是引擎**固定相对布局**：demo 启动脚本 `start_server.sh:19` 硬编码 `KBE_BIN_PATH="$KBE_ROOT/kbe/bin/server/"`。kode 已能解析引擎根（`findEngineRoot` / engineRootAutoFill）。 | **删**：派生式 `engineRoot + "kbe/bin/server"`；找不到引擎根时如实空值（与扫描根同口径） |

## B. 可推导——默认值应为引擎配置树的镜像，配置降级为显式覆盖

| 配置项 | 现默认 | 为什么可推导（推导式 + 引擎依据） | 建议 |
| --- | --- | --- | --- |
| `kbengine.console.discoveryHost` | `127.0.0.1` | 引擎真源 = `<interfaces><host>localhost</host>`（kbengine_defaults.xml:244，同块 port_min :245 / port_max :246）；demo 布局 interfaces 即发现入口。 | **推导**：缺省读引擎配置树 `interfaces.host`；显式设置仍生效（覆盖语义） |
| `kbengine.engineVersion` | `"3.7.3"` | 已有自动检测（`detectEngineVersionMarker`）+ 向导预设（projectWizard.ts:276-285）；引擎源码无版本宏可钉（`KBE_VERSION` 零命中）。 | **降级为覆盖**：默认取自动检测值，显式配置只作覆盖（弱候选，可暂不动） |

## C. 已执行先例（本批口径，不再列为待办）

| 配置项 | 引擎依据 | 状态 |
| --- | --- | --- |
| `kbengine.entityDefsPath` / `kbengine.entitiesXmlPath` | 引擎只读 `{scripts}/entities.xml` 与 `{scripts}/entity_defs/`（entitydef.cpp:176-177；resmgr.cpp:489-499 单一 scripts 目录，引擎无备用扫描位） | 已从 package.json 移除（grep 零命中）；配套两枚测试（pathTemplateEquivalence / extensionDefPathInvalidation）随批删除——实测恢复后 5 红，证实两键已从读取面退役 |

## D. 判定为独立必需（保留，列共性口径不逐项展开）

- **kode 自有功能面**（引擎不读、无引擎对应物）：诊断/CodeLens/hover/inlay/semanticTokens/domainMarkers 全族、`componentStatusPanel.*`、`maxLogEntries`、`jumpLog`、`webviewConsoleLogs`、`metrics.fileReadDetail`、`runtimeQuery.*`、`index.scanExcludeGlobs`、`types.aliasDiscovery`、`configData.*`（demo 脚本无 config 目录约定，`scripts/common/*.py` 零命中——纯工作区启发式）、`consoleLogTail.components`。
- **Rust 桥自持**：`core.backend` / `core.serverPath` / `core.shadow.timeoutMs`（kode 进程间面，与引擎配置无关）。
- **用户意图面**（值即意图，不可推导）：`autoStart`（引擎进程集合固定——`start_server.sh:31-33` 起 baseappmgr/baseapp；起哪几个是用户选择）、`logAutoConnect`、`clone.*`、`debug.*`（remoteTargets/attachTimeoutMs/autoDebugpy）、`python.interpreterPath` / `python.venvDirectories` / `python.stubDir`、`infer.pyreflyPath`、`binPath` 之外的 assetsRoot（kode 对引擎 res 的句柄，引擎侧由 KBE_RES_PATH 环境承担）。
- **查证后无引擎对应物**（保留）：`db.tablePrefix`（本 fork defaults 无 `table_prefix` 键，databaseInterfaces 块仅 `databaseName :357`）、`infer.pythonVersion`（引擎工具脚本无 3.7 钉，`gen*.py` 零命中）。

## 执行面（拍板后）

1. A/B 组每项落地时走既有五处对账闸（configMarkdownDescription 测试 + docs/guide/configuration.md 双语表）。
2. A 组删除属破坏性面：迁移期先「派生优先、配置兜底」一版，再删键（与 entityDefsPath 退役同法）。
