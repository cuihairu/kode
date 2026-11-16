# RUST-222 验收纪要:非即时能力 progress + cancel 覆盖盘点与补齐

日期:2026-11-17。本纪要对账 RUST-222(旧 UI-005,主 todo 排队项)的验收口径与交付证据。结论:**九个用户可见长操作中七个既有 progress+cancel 完整面;两个缺口本批补齐(日志错误扫描、venv 创建);其余后台能力属设计上的静默后台,如实登记。**

## 验收口径 → 交付证据映射

| 非即时能力 | progress+cancel 面 | 证据 |
| --- | --- | --- |
| 后台索引预热(BG-WARM) | withProgress Window 位+cancellable+onCancellationRequested→controller.cancel(取消止步不写完成标记,下次激活重跑)——**完整既有** | `src/activate/monitoring.ts:350-359` |
| 数据库查询/导入 | withProgress cancellable+取消令牌探针(databaseQueryLifecycleIntegration 守卫面:时限+取消) | `src/databaseWiring.ts:283,593`;`src/databaseQueryLifecycleIntegration.ts` |
| 玩家数据克隆(读/导入) | withProgress cancellable×2(导入取消=回滚) | `src/backend/playerDataCloneCommands.ts:768,1074` |
| 热更失败目标重试 | withProgress Notification cancellable(取消探针每跳一发) | `src/activate/hotReload.ts:553`;`src/backend/hotReloadRetryCommand.ts:339` |
| 监控采集首拉 | withProgress cancellable | `src/activate/monitoring.ts:351` |
| 流泳道取样/调试附加 | cancellable:true ×2(debug 创建配置 false=秒级,如实不设) | `src/flowSwimlanePanel.ts:468`;`src/debugConfig.ts:1094,1375` |
| **日志错误扫描(全扫/重扫)** | **本批补齐**:withProgress Notification 逐文件报进度(`1/N 文件名`)+取消止步;取消后已扫文件如实留在报告+警告提示「报告含已扫描 N/M 个文件」 | **本批** `src/logErrorScan.ts`(RawScanHooks+scanRawLogErrorsWithProgress);命令与 rescan 双入口接线 |
| **venv 创建** | **本批补齐**:cancellable:true+令牌接子进程柄(取消=kill);半成品 venv 由既有验真面如实拒(verifyTarget 不过→不选用) | **本批** `src/backend/venvInterpreterPicker.ts`(runProcess/runVenvModuleProcess 增 onSpawn 钩子);`src/activate/utilityCommands.ts`(接线) |
| 导出诊断/复现摘要 | 即时快照(读既有账面,无长等待),不需要 progress | `src/activate/utilityCommands.ts`(reproSummary) |

## 本批增量(feat 5d8f7fce)

- `src/logErrorScan.ts`:RawScanHooks(beforeFile/isCancelled)可选参数;scanRawLogErrorsWithProgress 封装(Notification 位+取消旗标);runLogErrorScanCommand 与 extension.ts rescan 回调双入口接线;取消提示如实计数。
- `src/backend/venvInterpreterPicker.ts`:runProcess 增 onSpawn 钩子(spawn 后同步交柄);runVenvModuleProcess 透传。
- `src/activate/utilityCommands.ts`:venv 创建 progress 补 cancellable+kill 接线。
- 测试:logErrorScan 2 例(beforeFile 序号+总数/取消止步已扫如实保留)、venv onSpawn 1 例(真 spawn 拿到柄);fake-vscode withProgress stub 补 progress.report 记账面(RUST-222 注记)。
- prove-red:变异 scanRawLogErrors 删取消止步 → 1 红(RC=1)→ cmp 字节还原 → 复绿。
- 门禁:lint 0 / compile 0 / unit 10652 全绿。

## 诚实条款(设计上的静默后台,不冒充缺口)

- **常规索引调度(IndexScheduler)**:后台推进+交互让流,不阻塞用户操作;可见性由状态栏语言服务灯承载(RUST-219,忙碌脉冲+轮询),不是「转圈无反馈」形态。
- **语料镜像(mirrorCorpusToRust)**:激活期 fire-and-forget 后台,零用户交互(用户没点任何东西,不存在等待面);其可见性归 Core 状态灯/影子日志。
- **quickActions 前台脚本**:执行前 modal 确认+输出通道即时落账(stdout/stderr 逐字流);`background: true` 为服务器启动类不等待退出码。脚本自身时长由脚本决定,进度条无从报——如实登记。
- **CPU profile**:start 即时确认+stop 落盘即时反馈;开采期本身是采样不是等待。
- venv 创建取消语义=kill 子进程(python -m venv 被信号中断留半成品目录);VS Code 取消钮承诺的是「停止等待」,清理半成品属用户手动(下次创建 verifyTarget 如实拒绝误导选择)——不静默删目录。
