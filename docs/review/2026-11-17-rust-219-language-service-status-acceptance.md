# RUST-219 验收纪要:状态栏 Core ready/indexing/partial/error + engine profile + resource root + 索引进度

日期:2026-11-17。本纪要对账 RUST-219(旧 UI-002,主 todo 排队项)的验收口径与交付证据。结论:**数据面齐备而消费面缺失(真增量,RUST-187 判例),本批补语言服务状态栏(纯核四态机+装配接线+测试钉),含一处侦察发现的既有 mock-vs-wire 漂移修复。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| Core ready | 索引三计数全零 → `$(check) Kode 索引: 就绪` 脸,缀 engine profile·资源根(已知时) | `src/backend/languageServiceStatus.ts`(buildLanguageServiceStatus ready 态) |
| Core indexing | running/queued>0 → `$(sync~spin)` 脸带运行/排队计数;忙碌期控制器保活轮询(默认 1s,落定即停),不做逐键刷新 | 同上 busy 态;`LanguageServiceStatusController`(timers 注入可测) |
| Core error | failed>0 → `$(error)` 脸带三计数,优先于忙碌判定;恢复入口(tooltip)=重启窗口重建索引,与 profile 健康汇总同口径 | 同上 error 态;`src/profileHealth.ts:134` 同一恢复入口 |
| partial(部分索引) | **无数据面,如实不冒充**:SchedulerStatus 只有 failed/queued/running 三计数,无 partial 维度——状态机只呈现三计数真值,不发明第四态 | `src/backend/indexScheduler.ts:100`(SchedulerStatus 形状);纪要诚实条款 |
| engine profile | 活动 profile 展示名缀在状态栏文本(未知时无后缀不编造);与 IDE-PRJ-010 同源(resolveActiveProfile) | `src/activate/utilityCommands.ts`(collectInputs→profileName) |
| resource root | assetsRoot 基名缀在状态栏文本(未知时无后缀) | 同上(resourceRoot=path.basename(assetsRoot)) |
| 索引进度 | 判定与 profile 健康汇总同源(indexScheduler.getStatus,RUST-187 同源探针);running 任务对象归一 0/1,失败/排队沿用原计数 | 同上(collectInputs 归一注记) |
| 面不可用 | index 探针 null → `$(circle-slash)` 未知脸,hasFailures/isBusy 双 false,不装就绪 | 同上 unknown 态;测试第 1 例 |

## 本批增量(feat 3e98f013)

- `src/backend/languageServiceStatus.ts`(新):纯核四态机(判定顺序固定:未知→失败→忙碌→就绪)+ LanguageServiceStatusController(事件驱动 refresh/忙碌保活轮询/dispose 全清);StatusBarItemLike 结构子集(tooltip/command 宽为最小结构),后端零 vscode 依赖。
- `src/activate/utilityCommands.ts`(接线):优先级 92 空档(server 100/telnet 99/热更 98/解释器 97/热更通道 96/日志 tail 95/核心 94/MCP 93);触发=激活+活动 profile 切换(onDidChangeActiveProfile)+kbengine.* 配置变化+保存文件(索引入队驱动)+根变化;点击开 kbengine.profile.health。
- `src/profileHealth.ts`(漂移修复):失败消息曾把 `running` 对象直接插值(渲染 `[object Object]`)——单测 mock 把 running 当数字而线上 SchedulerStatus.running 是活动任务对象,正交 mock-vs-wire 漂移;归一为活动任务 0/1。
- 测试:`tests/languageServiceStatus.test.ts`(新,9 例:四态机 6+控制器 3 含轮询启停/dispose);`tests/indexStatusHealth.test.ts`(+1 wire 形状回钉:`运行 1` 非 `[object Object]`);`tests/extension.test.ts`(装配清单 8→9 灯+92 灯形状钉,不竞速索引队列瞬态)。
- prove-red:变异纯核忙碌判定(`if (false)`)→ 3 例红(RC=1)→ cp+cmp 字节还原 → 复绿。

## 诚实条款

- 「索引进度」的形态是**三计数(失败/排队/运行)+忙碌脉冲脸**,不是百分比进度条——调度面无总量计数,进度率不可推导,不发明。
- partial(部分索引)无数据面,SchedulerStatus 无该维度;若未来调度器产出分域完成度,状态栏随数据面扩展。
- 状态栏文本为中文(与 profile 健康汇总/profile 灯既有面同语言口径);Core 生命周期取自索引调度探针,非独立 Core 心跳——Core 不可达时语义面走既有降级链(RUST-137+ 影子对拍/TS 兜底),状态栏不重复探测。
- 轮询触发面=忙碌落定自动停+五个事件(激活/profile 切换/配置/保存/根变化);连续键入不触发刷新(保存驱动,设计选择)。
