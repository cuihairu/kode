# KB-GC-001 验收证据:guiconsole console 链期一(实时日志 tail + 组件状态面板)

- 日期:2026-11-07;设计依据 `docs/design/kbengine-guiconsole-integration.md`(源码取证完成,引擎树 `/home/cui/workspaces/kbengine` @ `3082ab5`);环境与命令链同 `IDE-LIV-003.md`(imac 192.168.5.117 WSL2 Ubuntu 24.04 真引擎 + 运行机 192.168.5.188 扩展宿主,跨机广播发现 `KODE_LIV_DISCOVERY_HOST=255.255.255.255`)
- 实现面:3 命令 + 6 配置键 + 协议常量/帧构造/解析 + 共享发现 hub + 日志 tail 控制器 + 组件状态面板(全量明细见下)

## 1. 实现面(文件:行)

| 面 | 位置 | 内容 |
| --- | --- | --- |
| 协议常量 | `src/kbengineProtocol.ts:67-71` | `LOGGER_APP_ACTIVE_TICK_MSG_ID=701` / `LOGGER_REGISTER_LOG_WATCHER_MSG_ID=702` / `LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID=703` / `CONSOLE_LOG_MSG_ID=65501` / `KBELOG_TYPES_MASK=0x7ff` |
| 级别位映射 | `src/kbengineProtocol.ts:74-90` | `KBELOG_LEVEL_BITS`(debug_helper.h:35-44/55-68)与 `kbelogLevelBit()` |
| 702 请求帧 | `src/kbengineProtocol.ts:1028` | `buildLogWatcherRequestBody`——线序照写侧 guiconsole `LogWindow.cpp:376-433`,组件类型 **int32**(bundle.h:227-231),XML 声明的 UINT8_ARRAY 与真实写侧不符(设计文档 §1.4 解码陷阱) |
| 701 心跳帧 | `src/kbengineProtocol.ts:1059` | `buildAppActiveTickBody`(xml `Logger::onAppActiveTick:701`) |
| 65501 收包 | `src/kbengineProtocol.ts:1071` | `parseConsoleLogBody`——u32 长度 BLOB 载荷,截断头返回 null 不编造文本 |
| 日志流解析 | `src/kbengineProtocol.ts:1104` | `parseLogStream`——logger.cpp:265-280 格式,级别/组件/时间戳/多行 traceback |
| 审计锁 | `src/watcherProtocolAudit.ts:85-135` | `CONSOLE_PROTOCOL_AUDIT_VERSION`(@3082ab5)+`CONSOLE_PROTOCOL_AUDIT`(701/702/703/65501 逐条引据,生产常量与本表咬合,漂移即红) |
| 共享发现 hub | `src/kbengineConsoleHub.ts:40` | `ConsoleHub`——machined UDP 发现轮询 + 组件台账;两面板共一 hub 不建两套链(设计文档 §4);machined 不可达如实记账不硬试 |
| 日志 tail 控制器 | `src/consoleLogTail.ts:129` | `ConsoleLogTailController`——702 注册 → 65501 长连推流进 Output;断线指数退避(1s 起翻倍封顶 30s);703 注销 + 心跳 tick |
| tail 行格式 | `src/consoleLogTail.ts:80` | `formatTailLine`——`时间戳 [级别] 组件实例: 消息`(真机推流行结构化形状) |
| 错误行跳转解析辅助 | `src/consoleLogTail.ts:100` | `buildTailCodeActions`——IDE-LIV-007 同源 `resolveExceptionSource` 落点解析(纯函数,单测覆盖;**生产 UI 跳转入口本轮未注册**:Output 通道非文档,CodeActionProvider 无挂载面,跳转面整体按「未测/未装配」记账) |
| 组件状态面板 | `src/componentStatusPanel.ts:92` | `ComponentStatusTreeProvider`——异常态红色 ThemeIcon(errorForeground)+进程消失墓碑行 |
| 面板阈值 | `src/componentStatusPanel.ts:26/48` | `resolveThresholds` / `describeComponentRow`——cpu/mem 阈值、state 非运行态、usedmem 字节换算 |
| 扩展装配 | `src/extension.ts:4557-4625` | hub 启动 + tail 控制器(配置开关即时生效)+ 组件面板 provider + 3 命令(`consoleLogTail.show/toggle`、`consoleComponentPanel.refresh`) |
| 命令注册 | `package.json` | `onCommand:kbengine.consoleLogTail.show/toggle`、`onCommand:kbengine.consoleComponentPanel.refresh`、`onView:kbengine.componentStatus`;视图 `kbengine.componentStatus`;3 命令 title;6 配置键(`consoleLogTail.enabled`/`console.discoveryHost`/`consoleLogTail.components`/`componentStatusPanel.refreshSeconds`/`componentStatusPanel.cpuThresholdPercent`/`componentStatusPanel.memThresholdMb`) |

## 2. 协议引据

- 请求号:`kbe/res/server/messages_fixed_defaults.xml <Logger::onAppActiveTick><id>701` / `<Logger::registerLogWatcher><id>702` / `<Logger::deregisterLogWatcher><id>703`(审计表 `src/watcherProtocolAudit.ts:108-122`)
- 回执号 `CONSOLE_LOG_MSGID 65501`:`kbe/src/lib/helper/console_helper.h:10`(代码强制号,不在 XML;设计文档 §1.3 合并两源)
- 702 写侧线序:`guiconsole LogWindow.cpp:376-433`(读侧 `logwatcher.cpp:37-70` 互逆);组件类型 int32 `bundle.h:227-231`
- 65501 推流点:`logwatcher.cpp:85-113`,push `:104-112`;日志源各组件 `Logger::writeLog`(704,`messages_fixed_defaults.xml:373-385`)
- 发现回包 Args25 负载快照:`machine.cpp:219-228`(pid/cpu/mem/usedmem/state 随发现回包自带——共享 hub 依据,设计文档 §4)
- KBELOG_TYPES 位并集 `0x7ff`:`debug_helper.h:46-47`;级别位 `debug_helper.h:35-44/55-68`

## 3. 真机证据

- **发现面**(live run `[GC-1]`):10 组件全发现(machine/logger/interfaces/dbmgr/baseappmgr/cellappmgr/baseapp/cellapp×2... 实际 10 行含 bots),machined=reachable,logger=logger 192.168.5.117:47667;每组件 pid/cpu/mem/usedmem/state/uid 逐字段落地
- **tail 面**(`[GC-2]`):controller state=connected,收到 70 行真引擎推流;**12/12 行**带 logstream 结构化形状(`时间戳 [级别] 组件实例: 消息`);真引擎行如 `Monster[2008].onMove: (57, None)`、`[demo-evidence] Avatar[13].reqAttack hit Monster[2006] dmg=15`(引擎实时运行产物,非伪造)
- **面板面**(`[GC-3]`):10 行渲染、0 异常标记(真机全部 normal,含 machine/bots 报 INIT state=0 的正常态——面板按 0=INIT/1=RUN 为常态口径,见配置说明)
- **UI 取证**(`[GC-4]`):生产扩展面 —— `kbengine.consoleLogTail.show` 打开真实 tail Output 通道、`kbengine.componentStatus.focus` 聚焦真实 componentStatus 侧栏视图;截图 `evidence/KB-GC-001-r1-output-tail.png`(Output 通道真引擎日志)、`evidence/KB-GC-001-r2-tail-stream.png`(推流行结构化)、`evidence/KB-GC-001-r3-component-status.png`(面板行 pid/cpu/mem)、`evidence/KB-GC-001-r4-panel-focused.png`(视图聚焦)
- 原始证据全文:`evidence/KB-GC-001-live-run.txt`(41 行)

## 4. 已知边界(如实记,不冒充已测)

- **错误行跳转面未测/未装配**:本轮真机推流无错误级行(ERROR/S_ERR/CRITICAL),`[GC-2] jump-face 未测` 如实记录;解析/落点面由单测覆盖(`consoleLogTail.test.ts buildTailCodeActions` 2 例 + `consoleProtocol.test.ts parseLogStream` 4 例),但生产 UI 跳转入口**本轮未注册**——`buildTailCodeActions` 仅被单测引用(Output 通道非文档,CodeActionProvider 无挂载面),跳转面整体记「未测/未装配」,待二期补
- **machined/logger 缺席面**:单测覆盖(hub `reports machined unreachable honestly`、tail `stays honest when machined is missing`/`waits without hard retrying when the logger component is absent`);真机未做缺席注入——如实呈现不硬试的语义由单测锁定
- **跨机安全边界**:链路默认 localhost-only(`kbengine.console.discoveryHost` 默认 127.0.0.1);跨机=交出整个集群控制面(发现应答对 CONSOLE_TYPE 请求绕过 uid 过滤,machine.cpp:168-175),须知情配置

## 命令链

- 单测:`PATH="/usr/bin:$PATH" npx vitest run tests/consoleProtocol.test.ts tests/consoleHub.test.ts tests/consoleLogTail.test.ts tests/componentStatusPanel.test.ts` → **4 文件 47 例全绿**(consoleProtocol 15 / consoleHub 9 / consoleLogTail 12 / componentStatusPanel 11)
- 真机套件:`node out/test/electron/runTest.js --live`(suite=live,`consoleLive.test.ts` 已入 live 套件 `src/test/electron/suite/index.ts:51`)→ **7 passing / 0 failing,EXIT=0**(运行观察值;`evidence/KB-GC-001-live-run.txt` 记录的是同一轮探针的 GC-1..GC-4 逐段原始输出——10 组件发现 / tail connected 70 行 / 12-12 结构化 / 面板 10 行 0 异常 + 截图定格,mocha 汇总行由探针进程 stdout 直接观察,未另行落文件)
