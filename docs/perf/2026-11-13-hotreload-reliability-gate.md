# HR-PR-09 hotreload/reliability-gate 可靠性门禁与性能报告(2026-11-13)

> 取证口径:组合性门禁套件 `tests/hotReloadReliabilityGate.test.ts`——只组合既有已证纯核
> (HR-PR-04 保存流水线 `src/backend/hotReloadSavePipeline.ts` + HR-WATCH-008 指纹撤回 +
> HR-WATCH-011 版本守卫),虚拟时钟零 IO;另附真时钟吞吐实测(本文件 run 记录
> `2026-11-13-hotreload-reliability-gate-run.txt`,测量脚本见 run 文件头注同源口径)。
> 只观测不改行为。

## 1. 测试环境

| 项 | 值 |
|---|---|
| OS | Linux(内核 7.0.0-42-generic) |
| Node.js | v24.21.0 |
| 量测框架 | vitest 5.1.0(门禁套件,虚拟时钟)+ 独立 node 脚本(吞吐实测,真时钟) |
| 纯核 | `src/backend/hotReloadSavePipeline.ts`(零 vscode 零 IO,时钟/定时器/快照读/语法闸全注入) |

## 2. 四门 + soak 覆盖面(套件 7 例,虚拟时钟)

| 门 | 场景 | 断言 | 证据 |
|---|---|---|---|
| 风暴 HR-WATCH-006/016 | 50 文件×4 连发=200 offer | 每文件恰一次、归并=4、总量不放大(50 事件) | tests/hotReloadReliabilityGate.test.ts:117 |
| 风暴超阈值 | 5001 文件,阈 5000 | 只预览不放行,显式 releasePreview 后一批放出 | :135 |
| 过期 HR-WATCH-011 | 在途期间新内容发出 | v1 响应晚到=stale 拒记;同版本响应不误判 | :150 |
| 断网 HR-WATCH-008 | 批次投递失败→异步撤回→同内容重发 | 撤回后同内容照发(不永久跳过);重发是新版本号 | :169 |
| 断网风暴 | 20 文件批量失败→撤回→恢复 | 一批全重发,delivered=20 | :185 |
| 安全 HR-WATCH-012 | 风暴中语法坏内容 | 一律拦截不发送不占版本号;恢复后版本从 1 起 | :208 |
| soak(缩放) | 1000 文件×10=10000 offer | 全量定稿恰一次、归并=10、版本=1、pending 清零 | :230 |

**prove-red 闭环**:拆除 harness 的 `forgetSent` 撤回调用→断网门两例恰红(指纹未撤→同内容判重→不重发)→恢复复绿。撤回时序建模=批次交出(onEmit)之后异步回调(核心契约:onEmit 后才 markSent,`src/backend/hotReloadSavePipeline.ts:548-549`;装配在发送结果到达时才调 forgetSent)。

## 3. 吞吐实测(真时钟,纯内存)

| 指标 | 值 |
|---|---|
| 10,000 offer(1000 文件×10 连发)→ 发出事件 | 1000(每文件恰一次,去抖归并) |
| offer 登记路径 | 37 ms(≈3.7 µs/offer,归并入既有 pending) |
| 全链(offer+去抖冲口+稳定两拍跳过+发批) | 157 ms |
| 同内容第二波去重 | 新发 0(首波 1 事件,HR-WATCH-010 三同键判重) |
| 门禁套件墙钟 | 7 例 ≈1.2 s(虚拟时钟,零 IO) |

哈希口径注:稳定窗关闭(stability=0)时快照哈希为空串→判重键不成立,**不去重照发**(
核心诚实设计:内容不可比时不硬猜「同内容」,HR-WATCH-010 判重要求 hash 非空);上表去重
行带稳定窗(有哈希)口径。

## 4. 边界(如实,不夸大)

- **24h 真 soak 未跑**:本会话口径=规模缩放 soak(10k 事件虚拟/真时钟各一)。24 小时
  连续运行属长时驻留验收,需真机装配面(HR-PR-02..08 接线批)就绪后另行执行,不在纯核
  套件可证范围。
- **跨平台:仅 Linux 实测**。套件零 IO 零 vscode(纯逻辑),凡 vitest 可跑处即可复跑,
  但 Windows/macOS 数值未采集(darwin nightly 仅编译口径);不编造跨平台数字。
- **端到端网络口径未含**:吞吐为纯内存+真时钟(不含真实 HTTP/引擎往返);端到端时延
  归 HR-HTTP 车道既有真网 mock server 套件(HR-HTTP-017)。
- 风暴/断网/安全/过期四门的**装配级**(真 watcher→真发送链)验收随接线批,本套件钉的是
  纯核行为契约。
