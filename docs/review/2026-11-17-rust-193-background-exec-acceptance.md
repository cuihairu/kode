# RUST-193 验收纪要:后台执行不弹终端,状态/退出码/可取消/可查看日志四清楚

日期:2026-11-17。本纪要对账 RUST-193(旧 EXEC-005,主 todo 排队项)的验收口径与既有交付证据。结论:**五维(隐藏/状态/退出码/取消/日志)均有既有交付面,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 不弹出终端 | 受管批处理恒后台隐藏:spawnProcess `windowsHide: true` + POSIX `detached`(setsid 进程组长,负 pid 信号杀全组)——引擎组件与测试运行均经此面,零终端窗弹出 | `src/backend/processManager.ts:180-182`/`:117`/`:140` |
| 清楚显示进程状态 | 双面:①processManager 五态事件流(starting/running/stopping/exited/error)供程序消费;②componentStatusPanel(kbengine-explorer 视图)给用户——mem/usedmem/state 负载快照、state≠RUN 或内存超阈红色标记、刷新间隔可配+手动刷新同轮询;serverManager 状态映射 Stopping/Stopped | `src/backend/processManager.ts:44-50`;`src/componentStatusPanel.ts`;`src/serverManager.ts:336` |
| 清楚显示退出码 | 进程退出事件文本 `进程退出: code=…, signal=…` 逐行入每组件 OutputChannel;测试面 `exitCode` 字段(null=被信号终止或 spawn 失败)+R2-F19 会话失败呈报(非零退出/信号/解释器缺失=会话错误+stderr,整跑不冒充成功) | `src/backend/processManager.ts:245-254` + `src/serverManager.ts:352`;`src/pythonTestRunner.ts:42-47`;R2-F19 `src/extension.ts:1335-1343` |
| 可取消 | 引擎组件:`serverManager.stopComponent(component, targetId)`(命令面接线 serverControls)+RUN-004 就绪等待取消柄(stop 置位等待轮询即终止);进程级:killProcessTree(taskkill /T /F 或负 pid 杀全组);测试面:Test Controller `CancellationToken` 置位即停派生 | `src/serverManager.ts:750`/`:173`/`:584-603`;`src/activate/serverControls.ts:558`/`:753`;`src/extension.ts:1307-1310` |
| 可查看日志 | 每组件独立 OutputChannel 逐行 appendLine+查看时 show(true);不依赖 logger watcher 协议的文件尾读路径(consoleLogTail)+logViewer 全链(RUST-188 行);测试输出入 Test Results 面板 | `src/serverManager.ts:569`/`:352`/`:1026`;`src/backend/consoleLogTail.ts`;RUST-188 基线表 log viewer 行 |

## 本批增量

- 零代码增量:五维均为既有交付(processManager/componentStatusPanel/serverManager/pythonTestRunner/logViewer 既有钉),再造属仪式性重复。

## 诚实条款

- 「不弹出终端(**如用户选择**)」的形态:受管批处理**恒后台隐藏**(windowsHide 恒真),没有「弹终端 vs 后台」的用户配置开关——这是设计选择(批处理语义本就不该抢用户终端),如实登记;需要真终端交互的场景走 quickActions 显式终端面(RUST-192),两者按执行形态分面,不靠开关切换。
- componentStatusPanel 的 state 是引擎 guiconsole StatusWindow 语义的负载快照(机器态),与 processManager 五态是两个层面(引擎报告 vs 托管会话),面板呈现前者、事件流承载后者;两层各有消费面,不互相冒充。
