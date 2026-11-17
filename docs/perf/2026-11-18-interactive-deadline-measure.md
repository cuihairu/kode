# QA-004 交互截止与降级测量(2026-11-18)

任务:QA-004(旧 KSEM-QA-04)——测量交互截止与降级。验收:记录排队/解析/查询/IPC/渲染分段及 P50/P95/P99;服务存活但无响应时真实超时,取消不能只改 UI。

## 方法

套件 `tests/interactiveDeadlineMeasure.test.ts`(真实二进制 `target/debug/kode-server`,缺失 skip),5 例:

1. **分段计时采样**:热态(预热后)hover ×40 轮全量样本(不挑最快一轮),逐轮记录三段:镜像 IPC 往返(mirror)、语义请求 IPC 往返(query)、响应面提取(extract),加 provider 全链对照(providerTotal)。
2. **存活但无响应真实超时**:假服务器(`tests/helpers/kodeDeadServer.cjs`,握手应答后挂起)→ `request` 以 `TIMEOUT` 拒绝(400ms 窗,实测 [300,2500) ms);第二次仍挂起 TIMEOUT 无 EXITED = 进程存活但无响应(KBUG-TIME-02 硬超时兜底)。
3. **取消真传播**:假服务器仅在收到 `$/cancelRequest` 时回 -32800 → 错误包到达即证明取消经传输层真实传播(CORE-007),请求以 `REQUEST_CANCELLED` 拒绝,非客户端本地伪造。
4. **预算到期降级**:`awaitWithInteractiveBudget` 超预算(300ms)真实放弃 rust 等待回 null(不等 3000ms work);迟到结算挂 catch 吞,零 unhandled rejection(KBUG-TIME-03/04)。
5. **TS 降级轨道对照**:门未装配时 TS 悬停链全链仍可用(隔离语义不依赖 rust 存活),与 rust 轨道共享同一交互预算语义。

## 阈值预登记

- 三段与全链 **P99 < 2000ms**(`INTERACTIVE_SERVE_BUDGET_MS`,预算=设计截止)。套件断言钉死;超预算即预算失效,该红。
- rust 内部解析/查询细分无回传字段(服务器仅 health 带 uptime_ms),诚实合并在 query 段;排队面(rust executor job 队列)在 query 段内,TS 侧不可分。这是本测量的口径边界。

## 实测(xvfb 无关,纯 Node vitest;2026-11-18)

| 段 | n | P50 | P95 | P99 | max |
| --- | --- | --- | --- | --- | --- |
| mirror(镜像 IPC) | 40 | 0.5 | 0.7 | 0.8 | 3.2 |
| query(语义 IPC,含 rust 解析) | 40 | 2.4 | 3.0 | 3.0~3.1 | 3.2~3.5 |
| extract(面提取) | 40 | 0.1 | 0.1~0.2 | 0.2~0.3 | 0.3~0.4 |
| providerTotal(rust 轨道全链) | 40 | 3.0~3.1 | 3.8~3.9 | 4.1~4.2 | 5.7~5.8 |
| tsFallbackTotal(TS 降级轨道,n=1) | 1 | — | — | — | 12.7~13.9 |

两次独立跑全绿(数值为两跑区间);run 日志:`2026-11-18-interactive-deadline-measure-run.txt`。

## 结论

- 热态交互链 P99=4.2ms,距 2000ms 预算有三个数量级余量;预算在冷启动(进程 spawn+握手+镜像+语料环境)下才可能触顶——这正是预算的设计场景(QA-002 判例②冷客户端判例)。
- 真实超时(KBUG-TIME-02)、取消真传播(CORE-007+RUST-072 服务器侧排队摘除/在途丢弃 -32800)、预算降级(KBUG-TIME-03/04)三机制均有行为钉,prove-red 三咬(超时钉扰动应答红/取消钉扰动静默红/预算钉扰动膨胀红)。
