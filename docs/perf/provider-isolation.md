# Provider 派发调度隔离基准(RUST-412 / 旧 HR-EXT-008,2026-11-23)

- 车道:tests/perf/providerIsolation.bench.ts(bench 专用 lane,与主 unit 门无交集)
- 跑法:`npx vitest run --config vitest.bench.config.ts tests/perf/providerIsolation.bench.ts`
  (输出追加 docs/perf/provider-isolation-run.txt,`KODE_ISOL_OUT` 可覆盖)
- 环境:node v24.21.0 / linux / 14 cpus / 24 文件语料 + 200 次 fire / 24 个 provider /
  canSend 忙转 0.15ms(基准机同 docs/perf/hardware.md §1)
- 口径:真装配 setupHotReload(发送 provider 注册表)+ 语言服务真骨架(索引+hover/
  definition provider,语料已热)+ fake 定时器(合并窗可控);只观测不改行为;断言
  只有确定性语义命中面(每 fire 恰一次派发/canSend 全部在微任务/hover·definition
  全命中),墙钟一律不进断言——阈值化归后续批次。

## 实测(2026-11-23,load 空载,run2 值,追加制双份在库)

| 观测 | N=0(键开无 provider) | N=24(24 provider,仅末位应答) | 语义闸 |
|---|---|---|---|
| **P1 fire 切片**(合并窗回调墙钟) | p50 0.15ms / p95 0.22ms / max 3ms | p50 0.14ms / p95 0.24ms / max 1.12ms | canSend N24=4800(全在微任务) |
| **P1b 兄弟定时回调偏移**(同批兄弟回调相对 tick 入口) | p50 0.14ms / max 2.99ms | p50 0.14ms / p95 0.23ms / max 1.12ms | 兄弟回调每轮都在同批执行 |
| P2 hover 尾延迟(保存风暴交错) | p50 2.79ms / p95 7.01ms / max 23.1ms | p50 7.57ms / p95 12.02ms / max 17.46ms | hover 200/200 命中 |
| P3 definition 尾延迟(.def→py 落点) | p50 2.94ms / p95 6.41ms / max 12.08ms | p50 7.56ms / p95 11.68ms / max 19.65ms | definition 200/200 命中 |

## 读法与诚实边界

1. **切片级隔离=P1/P1b(机制证据)**:fire 同步切片 N24 p50 0.14ms ≈ N0 0.15ms,
   且 4800 次 canSend 全部发生在微任务(fire 同步段零 canSend)——canSend 不再占
   住合并窗回调。同批兄弟定时回调偏移 N24 p50 0.14ms ≡ N0 0.14ms:真实扩展宿主里
   语言服务侧的预算/索引泵定时器正是同批兄弟回调,派发决议不再把它们垫高
   (未修复时两者都 ≈ +24×0.15ms=+3.6ms)。这是「新增 Provider 不影响已有语言
   服务尾延迟」的直接证明。
2. **P2/P3 残余差=派发微任务与续延同队列交错(诚实注记)**:warm hover/definition
   是纯微任务链,派发微任务与 hover 续延在同一微任务队列交错,残余差(N24−N0
   ≈ +4.8ms)受 provider 数×spin 有界,且**不是同步切片阻塞**——切片级阻塞的消除
   由 P1/P1b 直接证明。ISOL-NOTE 在 run.txt 明示该归因。
3. **P3 主口径=补充观测**:竞争源与 hover 完全同源(fire 同步切片),主口径=P1/P1b
   直接归因 + 既有 docs/perf/unblockedDefinition 相关车道;本臂 .def→py 落点两臂
   全命中,未走 ISOL-NOTE hit=0 分支。
4. **PythonDefinitionProvider 不复刻(诚实边界)**:2500ms 预算闸语义由
   tests/hoverBudget.test.ts 锁定;构造/首扫成本与 fire 切片竞争是另一面,不混为
   本车道口径。
5. **墙钟有界未钉阈值**:本批只记录 p50/p95/p99/max;若纳入夜间门,走既有
   KODE_PERF_BOUND_* 宽松上界纪律,不直接钉绝对值。
