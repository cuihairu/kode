# RUST-196 验收纪要:日志聚合 ring buffer / 流式过滤 / 文件 tail / 不全量进 Webview

日期:2026-11-17。本纪要对账 RUST-196(旧 EXEC-008,主 todo 排队项)的验收口径与既有交付证据。结论:**五维中四维既有交付、磁盘轮转无载体(N/A),本批为对账收口(零代码增量),轮转与 watchFile 装配缺口如实登记。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| ring buffer 聚合 | LogHub 三重有界:retained 上限(DEFAULT_CAPACITY 10000)+pending 上限(MAX_PENDING_EVENTS 10000/MAX_PENDING_BYTES 8MB,超限丢最旧计 dropped)+批出有界(MAX_BATCH_BYTES 128KB/单轮 poll 64KB/时间片 25ms),LogBatch 上报 dropped/capacity 如实记账 | `src/backend/logHub.ts:69-75`/`:123`/LogBatch(:38-42) |
| 流式过滤 | 宿主侧先算:LogFilter 过滤在宿主过滤后只 append 增量进页面(「过滤在宿主侧先算,页面只 append,整页重渲只留给用户动作」),高频日志不整页重渲 | `src/logWebView.ts:47`/`:55-58` |
| 文件 tail | 生产在役=consoleLogTail:logger TCP 长连实时推流(registerLogWatcher 65501,断线指数退避 1s→30s,701 保活,组件过滤每次读配置),出可见 OutputChannel+错误级跳转;hub 侧另有 watchFile 轮询 tail 面(200ms 轮询+单轮字节上限)已实现+测试钉,**生产装配零调用** | `src/backend/consoleLogTail.ts`(头注+`:412-435`);`src/backend/logHub.ts:239-243`;`tests/logHub.test.ts`(watchFile 3+钉) |
| 避免全量导入 Webview | 三层:①hub retained/pending 有界(RING 行);②宿主侧过滤+增量 append(过滤行);③webview backpressure(IDE-RES-006:暂停消费时在途只留一批,待发槽)+DOM 有界(5000 条 trim 旧条目) | `src/logWebView.ts:41`/`:627-641` |

## 本批增量

- 零代码增量:五维中四维均有既有钉,再造属仪式性重复。

## 诚实条款

- **磁盘轮转无载体**:kode 侧零自写盘日志面(引擎日志落盘与轮转属引擎自身域,kode 只经 TCP 通道 tail/收集)——轮转在现架构下无对象;若未来 kode 增加本地日志落盘面,轮转随面一并设计,本纪要不冒充已覆盖。
- hub.watchFile 是**已实现未装配**面(生产文件 tail 走 consoleLogTail TCP 推送);是否装配(如无 machined/logger 时的降级尾读)属 RUST-195 拍板范围,本批不动。
- 「不全量导入 Webview」的背压语义是「webview 暂停消费时在途只留一批」,恢复消费后从 retained 补——不是丢弃式限流,retained 仍全量可查。
