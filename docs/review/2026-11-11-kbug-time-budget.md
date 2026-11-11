# KBUG-TIME 交互请求截止控制 —— 修复纪实(2026-11-11)

账本:`todo.md` KBUG-TIME 组(P1,审计基线 `10f4b85e`)。缺陷 = Rust 类型
hover 链路无请求截止:`localReturnTypeRust.ts` 调 `gate.runInRust` 未传
`timeoutMs`,`kodeCoreClient.ts` 仅在 `opts.timeoutMs` 有值时启动计时;
服务进程存活但不响应时该请求无限挂起,hover 不降级。同类无界面一并收口:
语料 serving 四面(definition/completion/hover/diagnostic)的
`serveInRust` 同样未传预算,`mirrorDocument` 前置的 `client.start()` 同样
无界;`client.start()` 内部的 initialize 握手也无界。

## 缺陷定位(修前)

- `src/backend/localReturnTypeRust.ts:46`:`runInRust(METHOD, params)` 无 opts;
- `src/backend/kodeCoreClient.ts:188`:`if (opts?.timeoutMs)` 无值即无计时器;
- `src/backend/kodeCoreShadowFaces.ts` 四个 serve* 面:`serveInRust(method,
  params, null)` 无 opts;`mirrorDocument` 内 `client.start()` 无界;
- `src/backend/kodeCoreGate.ts:358`:`runInRust` 内 `await client.start()` 无界;
- `src/languageProviders/hover.ts:374/:222` 注释宣称「Rust 腿 client 自带
  超时」——与事实相反,属虚假声明,已随修复改正。

## 修复

1. **握手预算(KBUG-TIME-02)**:`KodeCoreClientOptions.startTimeoutMs`
   (默认 10s);`initialize()` 以同值传 `timeoutMs` —— 存活不响应时
   `start()` 以 `TIMEOUT` 拒绝,pending/计时器照常清理。重启路径握手失败
   语义不变(仍走既有 catch → kill → EXITED)。
2. **交互端到端预算(KBUG-TIME-02/03)**:`kodeCoreShadowFaces.ts` 新增
   共享壳 `awaitWithInteractiveBudget(work, budgetMs, isCancelled?)`:
   - 预算计时 + 取消探测(50ms 轮询)任一先到即放弃等待返回 null(调用方
     走 TS 降级),不是「只发 cancel 再无界等」;
   - 败方 promise 挂 `catch(() => undefined)`,迟到结算不产生未处理
     rejection,迟到响应不改变已定结果(KBUG-TIME-04 后半);
   - `work` 收到与预算同值的 `timeoutMs`,transport 层同步发
     `$/cancelRequest` + 硬超时(budget+2000,显式计入清理窗口)回收
     pending/计时器(KBUG-TIME-05)。
3. **接预算的面**:
   - `localReturnTypeRust.ts`(`LOCAL_RETURN_RUST_BUDGET_MS = 2000`,
     生产入口即本面);
   - 语料 serving 四面(`INTERACTIVE_SERVE_BUDGET_MS = 2000`):mirror +
     serve 整体在预算壳内,mirror 的 start 挂死同样被预算截住;
   - 后台命令面(messageTable/def lint/defMd5/databaseSchema/dependency
     graph 等)不接交互预算,沿用各自语义(与账本「与后台命令预算区分」一致)。
4. **取消传递(KBUG-TIME-04)**:`inferLocalReturnTypeFromRust` 增第 5 参
   `isCancelled?: () => boolean`;hover.ts 传
   `() => token?.isCancellationRequested ?? false`(光标移开/文档更新/
   provider 取消即时结束等待)。
5. **清理读口(KBUG-TIME-05)**:`KodeCoreClient.pendingCountForTests()`。

## prove-red 与回归(仓库内)

新套件 `tests/kodeCoreInteractiveBudget.test.ts`(替身服务器新增
silentRpc / silentInitialize / delayRpc=<ms> / delayInitialize=<ms> 故障
注入模式,真实 stdio 进程,非 mock):

- **修前红**:6/6 全红——存活不响应(silentRpc)与 initialize 挂死
  (silentInitialize)两例由外部截止(8s)抓出挂死;长队列(delayRpc=2600)
  不降级(等到 2600ms 还回了结果);start 无预算挂死;取消参数无效;
  pending 永不清理。运行:`npx vitest run tests/kodeCoreInteractiveBudget.test.ts`
  (修前 6 failed / 修后 6 passed,~25s)。
- **修后绿**:6/6 + 邻接 8 套件(kodeCoreClient/Gate/ShadowFaces/
  pythonLocalReturnTypeRust/E2E/GateWiring/ShadowCorpus/ServingE2E)
  113/113 + hover 系 20 套件 140/140。

## KBUG-TIME-06 四状态记录(替身注入,生产入口面级)

| 状态 | 注入 | 结果 |
| --- | --- | --- |
| 存活无响应 | `silentRpc` | 预算(2s)内降级 null → TS 链;pending 在硬超时窗口(budget+2s)内归零;restartGeneration 保持 0(无重启风暴) |
| 慢启动 | `delayInitialize=400` | start 被预算覆盖,400ms 后正常命中(不误杀慢启动) |
| 长任务排队 | `delayRpc=2600` | 预算点降级 null,迟到响应被吞、不改已结算结果 |
| 正常快速 | `delayRpc=0` | 直接命中 {target,annotation,methodName} |

取消路径:`isCancelled` 100ms 后置真 → ~150ms 内返回 null(不等预算),
同 client 并发未取消请求照常命中(取消不波及其他在途)。服务恢复语义:
预算降级不 kill 进程、不置失败冷却,后续请求照常(新请求新预算)。

## 命令与证据

- 修前红/修后绿:`npx vitest run tests/kodeCoreInteractiveBudget.test.ts`
- 邻接:`npx vitest run tests/kodeCore*.test.ts tests/pythonLocalReturnTypeRust.test.ts`
- 门禁:`npm run lint`(0)/ `npx tsc -p ./ --noEmit`(0)/
  `npx tsc -p tsconfig.mocha.json --noEmit`(0)/ `npm run test:unit`(全量)/
  `xvfb-run -a npm run test:demo:editor`(RC=0)
- 遗留口径:hover.ts 注释虚假声明已修正;后台命令面预算属各自语义不属本组。
