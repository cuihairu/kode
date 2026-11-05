# 性能分析能力边界（KODE-FEAT-002 · 2026-11-05）

> 条目原文：明确性能分析能力边界：现有运行时指标/py-spy 快照 vs 未实现的
> flamegraph/周期采样，分清已做与未做。
>
> 本文只划边界，不改代码。所有结论来自本工作树真实源码（file:line 为调研时刻
> 事实），未做项的形态提案见 `docs/design/pending-feature-shapes.md`。

## 已做（现有能力）

### 1. 运行时指标：监控面板（轮询快照，非时序）

- 入口：命令 `kbengine.monitoring.show`（Monitoring Panel webview）。
- 数据面：`src/monitoringCollector.ts` —— `MonitoringCollector` 经
  `src/kbengineProtocol.ts` 的 `discoverLocalComponents` / `queryWatcherPath`
  走引擎 watcher 协议轮询；每组件一份 `ComponentMetrics`
  （cpuUsage/memoryUsage/load/connections/entityCount/messagesPerSecond/
  objectPoolMemory/objectPoolSize/uptime/status）+ 全局 `SystemOverview` 汇总。
- 边界：**面板内只有当次快照与诊断事件（`MonitoringDiagnostic`），无历史
  时序存储、无趋势图表、无告警**。两次刷新之间的数据不存在（调研确认
  monitoringCollector/monitoringWebView 无 history/samples/ring 结构）。

### 2. 调用栈快照：py-spy dump（一次性，非持续）

- 入口：Servers 树 `$(pulse)` 图标 / 命令 `kbengine.debug.pyspyDump`。
- 数据面：`src/pyspyDump.ts` —— `runPyspyDump` 跑
  `py-spy dump --pid <pid> --nonblocking`（不暂停目标进程），调用栈写入
  `KBEngine py-spy` 输出通道；探测/安装按所选解释器定位
  （`resolvePyspyCommand`，IDE-PDBG-006）；ptrace 权限失败拼指引。
- 远程面：py-spy 探测/安装/dump 经 ssh 前缀分派（`src/remoteConnection.ts`，
  IDE-PDBG-004/005），远端 PID 走远端进程清单选择。
- 边界：**单进程、单次、纯文本栈**。没有采样周期、没有聚合、没有可视化。

### 3. 引擎运行时查询：telnet watcher 面（通用查询，非专项 profiling）

- `src/runtimeQueryWebView.ts` 经 `queryWatcherPath`/`querySpaces` 查任意
  watcher 路径与 space 列表。这是通用查询口，不是性能分析器；引擎侧
  telnet console 的 profile 类命令 kode 未封装。

### 4. 扩展宿主自观测（分析对象是 kode 自身，不是引擎）

- `kbengine.metrics.showSummary` / `showActiveTasks`
  （`src/languageServiceMetrics.ts`）：语言服务自身的任务/CPU 计数。
- `kbengine.metrics.startCpuProfile` / `stopCpuProfile`
  （`src/cpuProfileCapture.ts`）：扩展宿主 CPU profile 抓取。
- 基准套件：`tests/perf/*.bench.ts` + `docs/perf/`（v0.2 baseline 等），
  全部面向扩展自身开销。

## 未做（明确不在现状内）

| 能力 | 状态 | 去向 |
|---|---|---|
| py-spy record 火焰图（`--format flamegraph` SVG） | 未实现（仓库无 `record`/`flamegraph` 引用） | IDE-PYSPY-001，形态已调研（pending-feature-shapes.md §3） |
| 定时/周期采集（每 N 秒采 X 次） | 未实现 | IDE-PYSPY-001 同条 |
| 火焰图/采样结果 webview 展示 | 未实现 | IDE-PYSPY-001 同条（沿 `runtimeQueryWebView` 模式提案） |
| 运行时指标历史时序（存储/趋势/告警） | 未实现（监控面板仅快照） | 无条目；若立项需先定存储面（内存环形缓冲 vs 落盘） |
| 引擎 telnet console profile 命令封装（cellapp/baseapp `profile`） | 未实现 | 无条目 |
| 持续采样后台任务（CPU/内存随时间曲线） | 未实现 | 无条目；与监控面板同源 watcher 协议可扩展 |

## 结论

- 「快照」侧（watcher 指标 + py-spy dump）已闭环且远程可用；「持续」侧
  （采样、时序、火焰图）整体未做，其中火焰图/周期采集已立项为
  IDE-PYSPY-001，其余（指标时序、telnet profile 封装）无条目，需要时先立项。
- 复用约束（对 PYSPY-001 与后续条目有效）：周期采集/火焰图必须复用
  `pyspyDump.ts` 的解释器定位（`resolvePyspyCommand`）、ptrace 指引、
  `killProcessTree` 与 ssh 分派面，不得另起一套探测/安装路径。
