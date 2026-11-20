# 扫描与响应性审核证据（2026-11-19）

问题账本：仓库根 `todo.md` 的 KODE-RESP-001..010，共 10 项（P1 9 项、P2 1 项），记录的是审核时的缺陷，当前修复状态以 `todo.md` 为准。

审核 HEAD 为 `53fbe395`，实际读取当前工作树，包括开始前已有的暂存改动。本轮未修改产品代码；探针直接编译/转译当前源码，不依赖可能陈旧的 out/ 或 bin/ 产物。范围为扫描发现、共享调度器、Rust ingest/worker 准入、语料镜像、协议写入与解释器目录发现，不能视为全产品无遗漏审核。

## 可重跑探针

这些探针断言审核时观察到的旧行为。针对对应审核快照，在仓库根运行：

```sh
node docs/review/evidence/2026-11-19-responsiveness/scheduler-probe.cjs
node docs/review/evidence/2026-11-19-responsiveness/mirror-scan-probe.cjs
rustc --edition=2021 -Awarnings docs/review/evidence/2026-11-19-responsiveness/single-core-probe.rs -o /tmp/kode-single-core-probe
/tmp/kode-single-core-probe
```

本轮全部退出码 0。这里的成功表示断言捕获到了缺陷，不能作为功能正确的绿灯；修复后相应缺陷断言应失效，并应改成产品回归测试。

| 条目 | 观察结果 | 边界 |
| --- | --- | --- |
| RESP-002 | 后台任务挂起时 RequestLocal 保持 queued；运行中 cancel 无效 | 运行真实 scheduler，发现由受控 Promise 代替 |
| RESP-003 | 同步 throw 逸出，runningId 保留，后续任务不执行 | 探针捕获微任务异常以检查残留状态；真实环境会交给宿主异常处理 |
| RESP-004 | LUT 占槽等首扫，首扫分块排队等槽 | 真实 scheduler + 生产依赖形状复刻，未运行完整 EntityMappingManager/VS Code 事件链 |
| RESP-005 | 单 worker 空闲也拒绝后台准入 | 编译当前 pool 模块；未运行真实单核 RPC 与 shutdown |
| RESP-007 | open(v2,new) → close → open(v1,old) | 运行真实 corpus mirror + gate；VS Code 文件读取和传输为受控替身 |
| RESP-008 | 外部 `.kbengine/inferred/A.py` 被返回 | 真实临时目录遍历与扫描实现，工作区 API 为替身；临时目录已清理 |

RESP-001/006/009/010 为调用链和实现静态证据，未宣称完成真实用户工程延迟、峰值内存或 UI 卡顿实测。真实场景验收要求已逐项写入 todo。

## 相关现有测试

```sh
node node_modules/vitest/vitest.mjs run tests/indexScheduler.test.ts tests/kodeCoreCorpusMirror.test.ts tests/scanRoots.test.ts tests/defMethodLut.test.ts --maxWorkers=2
```

本轮结果：4 文件、63 测试通过，8.31 秒，退出码 0。这说明现有这些测试通过不足以排除上述探针捕获的缺口；未运行全仓测试，也未修改既有测试。
