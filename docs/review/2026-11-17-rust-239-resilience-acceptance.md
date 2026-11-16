# RUST-239 验收纪要:Resilience(Core kill/client disconnect/损坏缓存/watcher flood/磁盘满/权限拒绝)(纯对账审计)

日期:2026-11-17。本纪要对账 RUST-239(旧 QA-010,主 todo 排队项)的验收口径与交付证据。**结论:六维全有既有面,零代码缺口,纯对账收口;磁盘满维以「错误如实传播」承载,无 ENOSPC 专测(诚实条款)。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| Core kill | kode-server 崩溃→在途请求 rejectAll(EXITED) 统一拒绝→消费面 null→TS 轨道;有界自动重启(10s 窗 3 次,超出 RESTART_GAVE_UP 放弃不无限循环);spawn 失败转 EXITED(stdin EPIPE 吞,CORE-015/016);spawn 冷却 30s 防风暴;RUST-008 版本门不一致杀进程保留可再 spawn | `src/backend/kodeCoreClient.ts:9-243`;RUST-009 轴2 审计(2026-11-15 三轴架构性 PASS) |
| client disconnect | 在途 rejectAll+waitFor 语义;交互面 2s 预算壳(awaitWithInteractiveBudget)超时/取消→null→TS,败方 promise 挂 catch 无未处理 rejection;webview 断连保持(telnet 面板断连不假死);hover 取消链(hoverCancelConverge e2e) | kodeCoreClient+RUST-009 轴2;`src/test/electron/suite/hoverCancelConverge.test.ts`/`telnetWebView.ts`;`tests/hoverGapArms.test.ts` 取消臂(当日绿) |
| 损坏缓存 | 内存缓存(解析/schema/返回注解)进程内无损坏面,清缓存命令语义=「加速层,下次查询重建」(RUST-221 modal 确认面);持久面损坏处理:projectProfiles 载荷校验+归一(基础四字段缺一=损坏整条跳过不炸);traceImport 配不上=会话损坏如实抛错不猜配对 | RUST-221(50a6e736);`src/projectProfiles.ts:46`+`src/backend/traceImport.ts:12,171` |
| watcher flood | stormRecovery e2e(IDE-ACC-006):输入风暴后诊断只剩最新版本、补全命中、宿主延迟与待处理量回落;fileChangeBypass 变更面节流;诊断调度器六件套(mock-vs-wire 判例) | `src/test/electron/suite/stormRecovery.test.ts`+`src/backend/fileChangeBypass.ts`+DiagnosticScheduler 家族 |
| 磁盘满 | 写失败=错误如实传播:writeFileAtomic 同目录 tmp+rename,故障注入钉(目标位被目录占住→错误面必含「rename」区分直写);clone import 预留 fail-closed;无 ENOSPC 专测(诚实条款) | RUST-163 原子写故障注入钉;`src/backend/playerDataCloneImportGuard.ts` |
| 权限拒绝 | inferPipeline 写权限闸铁律(assertWritable:全部落盘路径先过闸,默认 Managed 域;被拒目标不静默如实播报);demoGameScaffoldPrompt 读不到(权限/不存在)视为不空不打扰 | `src/inferPipeline.ts:7-10,283-287`+`src/demoGameScaffoldPrompt.ts:26` |

## 自我验收证据

- kodeCoreClient/hoverGapArms/stormRecovery(链条在案)当日 unit 10659(2113d5f4 门禁)+xvfb demo 25 RC=0(995e2929 批实测)内绿;RUST-009 三轴审计(2026-11-15)在案。

## 诚实条款

- **磁盘满无 ENOSPC 专测**:承载=写失败错误如实传播+原子写故障注入钉(非 ENOSPC 特化);真实 ENOSPC 事件在本会话经历过(/tmp tmpfs 满,属开发环境非产品面),未转化为产品测试,如实记账。
- watcher flood 的实测=e2e 输入风暴族(真实编辑器);文件系统级 watch 事件风暴(如外部批量 touch)无专测——fileChangeBypass 节流与版本闸承载,如实。
- client disconnect 按 VS Code 现实=窗口关闭/重载(进程同亡)与 webview 断连两形态;LSP 客户端多连接场景不存在(单宿主),如实划界。
