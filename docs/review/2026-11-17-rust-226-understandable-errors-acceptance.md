# RUST-226 验收纪要:远端不可用/未安装 Core/协议不匹配/索引异常的可理解错误与修复操作

日期:2026-11-17。本纪要对账 RUST-226(旧 UI-009,主 todo 排队项)的验收口径与既有交付证据。结论:**四类异常均有可理解错误面与修复操作,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 异常类别 | 可理解错误面 | 修复操作 | 证据 |
| --- | --- | --- | --- |
| 远端不可用 | profileHealth `service-unavailable`(Core 服务探活失败,人话报因);serverManager 六类结局人话登记(started/already-running/dependency-failed/dependency-timeout/spawn-failed/not-found)+就绪放弃原因如实(timeout/cancelled 不误标 Running)+Error 五态;telnet 连接态机(closed/密码握手语义);kodeCoreGate「rust 服务不可用/失败(原因),回落 ts」通知 | profileHealth issue 自带 fix(kind:command/setting);AUD-038 失败目标登记供命令层选择重试 | `src/profileHealth.ts:121-128`;`src/serverManager.ts:148,171-172,233,311-312`;`src/backend/telnetClient.ts:6-10,163-164`;`src/backend/kodeCoreGate.ts:436,444` |
| 未安装 Core | profileHealth `engine-missing` 两类(缺引擎,IDE-PRJ-009 三态);kodeCoreGate「kbengine.core.serverPath 未配置,影子比对不可用」如实点名;二进制发现兜底(约定→记忆选择→唯一深扫描)失败原样返回不虚构 | fix 指向安装/配置命令与设置项;探测通过直接生效、用户显式配置保持权威 | `src/profileHealth.ts:86-97`;`src/backend/kodeCoreGate.ts:759`;`src/serverManager.ts:394-396,465` |
| 协议不匹配 | watcher 协议审计咬合(IDE-LIV-002):生产映射↔审计表逐条核对,缺键/多键/错号**逐条点名**(「X 请求号不符:生产 N vs 审计 M(引据源)」);console 链路同机制(KB-GC-001);compile worker 握手帧超时/回包不可解析=故障类显式标志,拆掉重建不串帧 | 审计表带引擎 repoUrl@commit 引据,漂移可定位到引擎版本;worker 故障惰性重建=自动修复路径 | `src/watcherProtocolAudit.ts:55-78,125`;`src/liveWatcherVerification.ts:61`;`src/backend/pythonExecService.ts:41,59-69` |
| 索引异常 | profileHealth `index-stalled`(RUST-187:IndexScheduler.getStatus 同源探针,failed>0 才报+三计数+顺序末位零打扰);语言服务灯失败态 `$(error)` 缀三计数+未知态不冒充(RUST-219 四态机) | fix=reloadWindow 入口(RUST-187);灯态自动随 onDidChangeActiveProfile/保存/根变化刷新 | `src/profileHealth.ts:133-140`(RUST-187 钉 `tests/indexStatusHealth.test.ts` 5 例);`src/backend/languageServiceStatus.ts`(RUST-219 钉 9 例) |

## 本批增量

- 零代码增量:四类异常的错误面与修复操作均有既有实现与钉(profileHealth/serverManager/watcherProtocolAudit/pythonExecService/kodeCoreGate 套件),再造属仪式性重复。

## 诚实条款

- Rust Core RPC **无显式协议版本握手**:initialize 握手携带根归属(KBUG-ROOT)但不带协议号对账;二进制不兼容表现为请求失败→「rust 服务失败(原因),回落 ts」通知+TS 兜底,而非启动期版本闸。协议号咬合机制只落在 watcher/console 引擎协议(IDE-LIV-002/KB-GC-001),如实区分。
- 「远端」在本产品语境=引擎进程(serverManager 管理的本地/远程组件)与 Core 服务两类,错误面按各自生命周期交付;无 SSH 远程开发场景专属错误面(未实现,不冒充)。
- telnet 密码错是引擎行为(静默重发/PASSWD 态停留),扩展侧如实呈现状态不伪造「密码错误」弹窗(引擎不发该信号)。
