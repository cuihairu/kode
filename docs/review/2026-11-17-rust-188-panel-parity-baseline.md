# RUST-188 验收纪要:dashboard/monitor/log viewer 能力 parity 基线表(迁移前盘点)

日期:2026-11-17。本纪要对账 RUST-188(旧 KBE-018,主 todo 排队项)的验收口径与交付形态。结论:**「迁移后」不存在在途迁移可对量,本批交付可交付的一半——能力 parity 基线表(前半盘点)落档,并把「任何未来迁移批次须逐行对本表复核」立为常设义务(后半挂账);据此勾行。**

## 能力 parity 基线表(迁移前 = 当前 main 状态)

| 能力面 | 命令/入口 | 能力要点 | 测试钉(迁移后逐行复核的对照物) |
| --- | --- | --- | --- |
| 运行时查询/monitor 面板 | `kbengine.runtimeQuery.*`(默认关) | 逐组件 queryWatcher(query-only 协议,RUST-184 审计钉)+ 观察清单增删(空路径/重复拒绝)+ 结果订阅轮询(`pollIntervalMs` 下限 500)+ 组件身份对账 + 缺失字段标「未知」绝不猜 | `tests/runtimeQueryWebView.test.ts` / `runtimeQueryWebViewRedesign.test.ts` / `ideLiv003LiveWatcherVerification.test.ts` / `ideLiv004LiveSpacesVerification.test.ts` / `watcherProtocolAudit.test.ts` / `spaceWatcherProtocolHonesty.test.ts` |
| log viewer | `kbengine.logs.showViewer/connect/disconnect` | logCollector 引擎 logger 通道(自动重连可配置、手动断开不自动重连)+ logParser + logErrorScan 错误扫描跳转 + 64MB 上限单文件 readError 不中断 + 不依赖 logger watcher 协议的文件尾读路径(consoleLogTail) | `tests/logCollector.test.ts` / `logCollectorSocket.test.ts` / `logHub.test.ts` / `logParser.test.ts` / `logErrorScan.test.ts` / `logErrorScanRedesign.test.ts` / `logWebView.test.ts` / `logWebViewGaps.test.ts` |
| 组件状态 dashboard | `kbengine.consoleComponentPanel.refresh` + componentStatusPanel | 组件状态面板:组件清单/状态汇总(进程拓扑诊断链 KR-AUD-54 多根审计) | `tests/componentStatusPanel.test.ts` / `processTopologyDiagnostics.test.ts` / `processTopologyMultiRoot.test.ts` / `cov-debug-process.test.ts` |
| telnet 控制台面板 | telnetService/telnetWebView/kbengineConsoleHub | 密码协商态机 + IAC + `isCommandAllowed` 白名单 + `:quit` 恒拒 + 断线回探测态 + 「只拆自己」socket 清理 | `src/backend/telnetClient.ts` 协议钉;RUST-183 对账纪要;`tests/cov-debug-process.test.ts` 等 |
| 配置合并视图 | configVisualizerPanel | 来源/优先级/冲突/最终值四维 + 取数面 Interactive/Cpu(RUST-180 命名钉) | RUST-180 对账纪要 + `config_resolve_lane.rs`;`tests/configVisualizer*` 族 |
| 数据库管理面 | databaseManagementWebView | schema 视图/drift/模拟(RUST-181 隔离钉 + IDE-DB-006 四态证据) | RUST-181 对账纪要;`tests/databaseDrift*.test.ts` 4 文件 + `databaseSchema*.test.ts` 族 |
| 实体关系/调用图/流面板 | entityDependencyWebView / entityCallGraphView / entityFlowWebView / flowSwimlanePanel | 依赖图三模式(依赖/引用/relations)+ 调用链渲染 + 流泳道 | `tests/entityDependencyRelations.test.ts` / `entityFlowGraph.test.ts` / `entityFlowPanel.test.ts` / `entityFlowWebViewRedesign.test.ts` / `flowCallGraphData.test.ts` / `flowSwimlanePanel.test.ts` |
| Project Doctor 健康汇总 | `kbengine.profile.health` + `kbengine.project.doctor` | 五类健康(含本批索引停滞)+ def 语义报告(RUST-187) | `tests/profileHealth.test.ts` / `indexStatusHealth.test.ts` / `projectDoctorCommand.test.ts` |

## 常设迁移义务(后半挂账)

- 任何涉及上述能力面的迁移/重写批次(Rust 分发通道、tower-lsp 重基、面板重构),必须在批次对账中**逐行对照本表**:每行给「迁移后等价面 + 等价测试钉」或如实登记降级;缺行即红。
- Rust 侧既有 parity 纪律(parity golden / split-parity / mock-vs-wire 契约钉)继续作为迁移批的通用门;本表是 UI 能力维度的补充清单,不替代通用门。

## 诚实条款

- 「迁移后」维度不可交付:当前无在途的面板迁移工作(分发通道/tower-lsp 车道明确不在现役战役内,见精确性主车道计划);本纪要不伪造迁移对照,只立基线与义务。
- 表内「能力要点」列是与文档/钉同源的最小事实集,不新写能力宣称;测试钉数量随批次自然增长,迁移复核以当时 HEAD 的钉为准,本表只锚定能力行不冻结钉清单。
