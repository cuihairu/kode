# KFLOW-029(FLOW-029)受控采集预算登记与开销实测

日期:2026-11-14。任务:todo.md FLOW-029「验收开销及失败清理。验收:预登记采集时间/容量/开销预算,测停止/断连/引擎退出/丢事件/时钟偏差;报告实际采样边界。」

环境:本机 CPython 3.14.4(python3);采集器 `scripts/trace/monitoring_capture.py`(sys.monitoring,PEP 669);开销负载 `tests/fixtures/trace/workload_loop.py`(TRACE_LOOP_N 可调,leaf 环形调用);计时 3 次取最小(降噪)。

## 1. 预登记预算(traceBudget.ts 唯一出处)

| 项 | 默认 | 硬顶 | 依据 |
|---|---|---|---|
| 容量 maxEvents | 20000 | 200000 | 实测 0.018-0.024ms/事件:默认≈0.4-0.5s 开销上限(交互级);硬顶≈4s/工件体积天花板 |
| 时间 timeoutMs | 15000 | 120000 | demo 级目标脚本秒级完成;硬顶=2 分钟,超时即 kill(可关闭红线) |
| 开销 per-event | 0.05ms | — | 实测 0.018-0.024ms 的 2.5 倍裕量;护栏钉 10 倍(0.5ms)报红 |

预算消费面:`runControlledCapture`/`buildCollectorArgs` 的 maxEvents/timeoutMs **缺省即走默认、显式也受硬顶**(超硬顶抛错带预算值);测试钉 tests/traceBudget.test.ts(注册表锁步)。预算不改变 FLOW-025 红线(默认关闭/可关闭/有界)。

## 2. 开销实测(2026-11-14,3 次取最小)

| 环数 N | 裸跑基线 | 带采集 | 增量开销 | 事件数 | 每事件 |
|---|---|---|---|---|---|
| 2000 | 16.9ms | 112.4ms | 95.5ms | 4012 | 0.024ms |
| 20000 | 18.1ms | 732.1ms | 714.0ms | 40012 | 0.018ms |
| 50000 | 24.8ms | 1811.6ms | 1786.8ms | 100012 | 0.018ms |

判定:**线性无超线性**(每事件 0.018-0.024ms,纯 Python sys.monitoring 回调代价;固定启动成本 ~95ms 含解释器+采集器装载)。默认预算 20000 事件≈0.4-0.5s 开销,交互可用;硬顶 200000≈4s。

缓冲打满实测(丢事件对账):N=2000(4012 事件)配 --max-events=100 → 产物 100 事件 + drop 记账 {buffer-full, count=3912},100+3912=4012 对账一致;cap=1000 同法一致(3012)。

## 3. 失败形态矩阵(五形态全钉)

| 形态 | 行为 | 钉 |
|---|---|---|
| 停止(stop) | stop() → endReason=completed,startedAt/stoppedAt 入 raw.meta;超时到点 SIGKILL → 抛「超时关闭(窗口完整性不可宣称,产物丢弃)」 | traceCapture.test.ts 启停记账/超时 kill 例 |
| 断连(外部信号) | 子进程被外部信号杀掉(exit=null+signal)→ 抛「受控采集失败(exit=null,signal=SIGTERM)」,不读残缺产物 | traceCapture.test.ts「断连面」例(FLOW-029 新钉) |
| 引擎退出(非零退出) | exit≠0 → 抛错带 stderr 尾 4 行(引擎退出语义=目标脚本异常退出,产物不导入) | traceCapture.test.ts「spawn 失败路径」例 |
| 丢事件(缓冲打满) | 只计丢弃不入缓冲;drop 记账 {buffer-full,count} 与产物事件数对账;采集侧同法(--max-events 透传) | traceCapture.test.ts 有界丢弃例 + §2 实测 |
| 时钟偏差 | 同线程 timestamp 回退 → 协议层抛「时间轴不造假」(traceEventModel 构造期);跨进程时钟不可比 → 串联层不按时间裁剪(FLOW-027 R4);本采集面时钟=process-mono(单调域内无偏差面) | traceEventModel 构造闸 + traceCorrelation.test.ts 乱序例 |

## 4. 实际采样边界声明

- 采样面=**complete-within-window**:窗口(目标脚本 main() 全程)内逐事件完整;窗口外未知,不宣称全程轨迹(窗口声明 windowNote 随产物携带)。
- 时钟=**process-mono** 单进程单调;跨进程数值不可比,因果只认关联 ID(FLOW-026/027 口径)。
- 开销护栏:预算默认 20000 事件≈0.4-0.5s;护栏钉=每事件 <0.5ms(预算 10 倍)报红,实测 0.018-0.024ms 有 20 倍裕量。
- 采集入口状态:纯核心+运行面已交付(FLOW-025)+预算已登记(本批);**采集命令 UI 未接线**(须解释器 ≥3.12 能力探测+真实引擎联验,另立项),回放入口已接线(kbengine.flow.openTraceReplay,FLOW-028)。

## 5. 验收映射

| 验收原文 | 落点 |
|---|---|
| 预登记采集时间/容量/开销预算 | §1 TRACE_CAPTURE_BUDGET(默认/硬顶/开销三项,唯一出处+锁步钉) |
| 测停止/断连/引擎退出/丢事件/时钟偏差 | §3 五形态矩阵(每形态行为+钉) |
| 报告实际采样边界 | §2 实测数据 + §4 边界声明 |
