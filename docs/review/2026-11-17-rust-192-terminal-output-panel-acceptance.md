# RUST-192 验收纪要:交互程序走 terminal、后台批处理走可见输出面板+session 管理

日期:2026-11-17。本纪要对账 RUST-192(旧 EXEC-004,主 todo 排队项)的验收口径与既有交付证据。结论:**二分均已交付且按执行形态分面接线,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 交互程序 → VS Code terminal | quickActions 快速动作面:每个 action 名一个 terminal,`Map<string, vscode.Terminal>` 键控复用(同动作重复触发不堆终端),动作即交互 shell 程序(引擎命令/脚本)在真终端里跑,用户可直接键入 | `src/quickActions.ts:138`(actionTerminals Map)/`:185`(createTerminal);`tests/quickActionManager.test.ts` / `quickActionRunners.test.ts` |
| 后台批处理 → 可见输出面板 | 引擎组件面:每组件独立 OutputChannel(`KBEngine: <组件名>`),运行时事件逐行 appendLine,查看时 `show(true)` 可见面;测试批面:VS Code Test Controller `run.appendOutput` 流式输出到 Test Results 面板 | `src/serverManager.ts:569`/`:352`/`:1026`;`src/extension.ts:1308-1345`(Test Run 输出流);`tests/serverManager.test.ts` / `pythonTestRunner.test.ts` |
| session 管理 | processManager 受管会话:`ManagedProcessState` 五态机(starting/running/stopping/exited/error)+ `exitCode` + state 事件流,退出/信号/spawn 失败如实分态;测试面取消经 `CancellationToken`,会话级失败(R2-F19)不丢弃——退出码非零/信号终止/解释器缺失呈报会话错误+stderr,整跑不冒充成功 | `src/backend/processManager.ts:44-50`/`:211-254`;`tests/processManager.test.ts` / `processManagerGapArms.test.ts`;R2-F19 注记 `src/extension.ts:1335-1343` |

## 本批增量

- 零代码增量:terminal 复用、每组件 OutputChannel、五态 session、取消与会话失败呈报均有既有钉(RUST-189 盘点已把 terminal/OutputChannel 面列为 TerminalHandle 等价物),再造属仪式性重复。

## 诚实条款

- 「terminal/Pseudoterminal」满足前者:交互面用 `createTerminal` shell 复用,**未用 Pseudoterminal 自定义驱动 API**——快速动作均为 shell 程序交互,无自定义写入/回调驱动需求;如实登记不冒充两者皆备。
- 输出面板的「可见」语义:面板按需创建、查看动作时 `show(true)` 前置,后台常态不抢焦点;Test Results 面板由 VS Code 测试 UI 自管理。
- 后台批处理的进程收编度:引擎组件与测试运行走 processManager 受管面;RUST-189 残差(gitRunner/inferPipeline 直 spawn)不属本行「交互/后台批」二分面,待拍板事项不在此冒充收编。
