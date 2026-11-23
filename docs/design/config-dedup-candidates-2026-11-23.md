# 配置项精简候选清单（2026-11-23 巡检单产出；A/B 组已按用户令执行）

> 分析口径：kode 全量配置（package.json contributes.configuration 九块）逐项对照
> 引擎真实读取面——`/home/cui/workspaces/kbengine/kbe/res/server/kbengine_defaults.xml` 与
> 引擎源码实读。证据行号均为实测（引擎树 = kbengine 工作区 HEAD）。
>
> **执行记录（2026-11-23，用户令「都精简掉，还有从文档中删除对应的配置项」）**：A/B 组 4 项
> 全部从 package.json 移除（声明配置 177 → 173），两份 package.nls 同步删 4 条描述；
> docs/guide/configuration.md、features.md、logging.md、commands.md 双语同步退役
> （features.md 配置表按既有 `(removed)`/`(已删)` 行式记录）。**读取面零改动**：四处
> `config.get()` 读取保留为隐藏覆盖（未声明键仍可经 settings.json 覆盖，既有用户值继续
> 生效）。唯一 src 改动 = 配置可视化空态文案不再把 `kbengine.binPath` 称作设置
> （webviewStrings.ts `emptyNoConfig` 改指 `kbengine.assetsRoot` / `kbengine.engineRoot`）。

## A. 可删——kode 硬编码默认值在引擎侧不存在，真源在引擎配置树或引擎固定布局

| 配置项 | 现默认 | 引擎依据 | 处置（已执行） |
| --- | --- | --- | --- |
| `kbengine.loggerPort` | `20022` | 20022 在引擎树全零命中（`kbe/res/` + `kbe/src/` grep 零）。引擎 logger 的日志监听端口**启动时才分配**（logger `main.cpp:66-67` 传 `0, 0`，defaults 的 logger 块无 `externalTcpPorts`）；初版清单写的「真源 = `logger.telnet_service.port`（34000）」**是错的**——telnet 是调试通道，不是日志监听端口。 | **删声明**：默认 20022 保留在读取侧（`loggingWiring.ts`），隐藏覆盖仍生效；真实 logger 寻址走 machined 发现（console 链） |
| `kbengine.binPath` | `${workspaceFolder}/kbe/bin/server` | 二进制路径是引擎**固定相对布局**：demo 启动脚本 `start_server.sh:19` 硬编码 `KBE_BIN_PATH="$KBE_ROOT/kbe/bin/server/"`。kode 解析链（`serverManager.getBinPath`）已有 profile `engineRoot` 推导（`engineRoot + kbe/bin/server`）与自动发现（CFG-01 三分支）。 | **删声明**：解析链不变（profile 推导 → 隐藏覆盖 → 默认/自动发现），零 src 改动 |

## B. 可推导——默认值应为引擎配置树的镜像，配置降级为显式覆盖

| 配置项 | 现默认 | 引擎依据 | 处置（已执行） |
| --- | --- | --- | --- |
| `kbengine.console.discoveryHost` | `127.0.0.1` | console 链的 machined **UDP 发现广播目标**，与 `<interfaces><host>` 无关（初版清单写「推导自 interfaces.host」**语义错了**——interfaces 是接口组件地址，machined 发现是另一条 UDP 面）。同机直查是设计缺省，跨机=交出整个集群控制面（发现应答对 CONSOLE_TYPE 请求绕过 uid 过滤，machine.cpp:168-175）。 | **删声明**：默认 127.0.0.1 保留（`activate/console.ts` 读取侧），隐藏值保留作跨机逃生口——无引擎侧真源可推导 |
| `kbengine.engineVersion` | `"3.7.3"` | 已有自动检测（`detectEngineVersionMarker`）+ 向导预设（projectWizard 写入）；引擎源码无版本宏可钉（`KBE_VERSION` 零命中）。 | **删声明**：读取链不变（`engineVersion.ts`），隐藏覆盖仍作门控；向导/一键建议照常写该键（写未声明键合法） |

## C. 已执行先例（同批口径）

| 配置项 | 引擎依据 | 状态 |
| --- | --- | --- |
| `kbengine.entityDefsPath` / `kbengine.entitiesXmlPath` | 引擎只读 `{scripts}/entities.xml` 与 `entity_defs/`（entitydef.cpp:176-177；resmgr.cpp:489-499 单一 scripts 目录，引擎无备用扫描位） | 已从 package.json 移除；读取面连根退役（布局由 `definitionWorkspace.ts` 按 `{assetsRoot}/scripts` 计算）；配套测试恢复实测 5 红后随批删除 |

## D. 判定为独立必需（保留，列共性口径不逐项展开）

- **kode 自有功能面**（引擎不读、无引擎对应物）：诊断/CodeLens/hover/inlay/semanticTokens/domainMarkers 全族、`componentStatusPanel.*`、`maxLogEntries`、`jumpLog`、`webviewConsoleLogs`、`metrics.fileReadDetail`、`runtimeQuery.*`、`index.scanExcludeGlobs`、`types.aliasDiscovery`、`configData.*`（demo 脚本无 config 目录约定，`scripts/common/*.py` 零命中——纯工作区启发式）、`consoleLogTail.components`。
- **Rust 桥自持**：`core.backend` / `core.serverPath` / `core.shadow.timeoutMs`（kode 进程间面，与引擎配置无关）。
- **用户意图面**（值即意图，不可推导）：`autoStart`（引擎进程集合固定——`start_server.sh:31-33` 起 baseappmgr/baseapp；起哪几个是用户选择）、`logAutoConnect`、`clone.*`、`debug.*`（remoteTargets/attachTimeoutMs/autoDebugpy）、`python.interpreterPath` / `python.venvDirectories` / `python.stubDir`、`infer.pyreflyPath`、`assetsRoot`（kode 对引擎 res 的句柄，引擎侧由 KBE_RES_PATH 环境承担）。
- **查证后无引擎对应物**（保留）：`db.tablePrefix`（本 fork defaults 无 `table_prefix` 键，databaseInterfaces 块仅 `databaseName :357`）、`infer.pythonVersion`（引擎工具脚本无 3.7 钉，`gen*.py` 零命中）。

## 执行面（本批已收口）

1. A/B 组落地走既有五处对账闸（configMarkdownDescription 测试 + docs/guide/configuration.md 双语表）——同步门对 4 键零硬编码引用，声明删除即绿。
2. 初版清单的「迁移期先派生优先、配置兜底再删键」两步走**简化为一步**：profile `engineRoot` 推导在 `getBinPath` 链里本就先于配置读，派生已先行，删声明即达终态。
