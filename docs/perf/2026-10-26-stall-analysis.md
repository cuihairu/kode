# 2026-10-26：启用插件后 hover / Python 索引 / 跳转卡顿分析

分析基线：`550d824`。本次仅诊断，不代表已修复或已部署。

## 证据范围

检查当前源码，并用 Node 探针执行当前 TypeScript 经 transpile 后的真实
`PythonClassIndex.updateFile`、`IndexScheduler`、`raceWithBudget`。
探针对未调用的工作区发现、组合根、导航日志提供替身，路径规范化用恒等函数；
不经过真实 VS Code / Pylance / 用户磁盘。没有用户现场 CPU profile、已安装版本
和运行日志，因此不能把本地结果直接当作“半小时”的精确归因。

## 已确认缺陷

1. **首次 Python 索引维护存在平方级遍历。**
   `src/pythonClassIndex.ts:564` 每个文件都调用 `unindexFile`；`:645` 遍历
   `byName` 全部条目，即使该文件首次入库、根本没有旧类需要删除。
   每文件一个不同类时累计遍历 N(N−1)/2 个桶，且不断分配 entries 数组与
   filter 结果。下表为内存输入、无磁盘读取的单轮测量，时间非性能门槛：

   | 文件数 | 实际桶遍历次数 | 耗时 ms |
   | --- | --- | --- |
   | 1,000 | 499,500 | 98.07 |
   | 2,000 | 1,999,000 | 257.74 |
   | 4,000 | 7,998,000 | 875.66 |
   | 8,000 | 31,996,000 | 3,607.42 |

   30,000 个不同类对应约 4.5 亿次桶遍历（公式推算，非本轮量测）。旧报告
   把全扫约 100 秒主要归于磁盘，缺少排除这种算法成本的证据。

2. **共享单并发调度器有队首阻塞，优先级不能抢占运行中的首扫。**
   `src/extension.ts:373` 的调度器由两个索引共享；实体整个首扫作为一个
   background task 执行（`src/entityMapping.ts:230`）。
   `src/indexScheduler.ts:357` 在 runningId 非空时直接返回。
   首扫内部 setImmediate 只能让事件循环继续，不能释放调度器席位。
   探针先启动未结束的后台任务，再排 RequestLocal：50ms 后交互任务仍
   queued，只有显式结束后台任务才执行。故“优先队列”不等于前台不等全扫。

3. **交互跳转仍依赖全仓发现和全量索引。**
   `src/pythonClassIndex.ts:1020` 为排序按需候选等待全仓 discovery；
   `:1245` 在首轮无命中时等待 ensureScanned。组合根另有全量元数据派生。
   `src/entityMapping.ts:1116` 等路径仍等待 initialScan。
   之前命中快路径的 benchmark 不能覆盖未知方法、未建索引、慢发现等分支。

4. **同步 IO 仍阻塞扩展宿主，超时不能提供硬上限，也不取消底层工作。**
   `src/scanRoots.ts:192` 的外部资产根递归遍历使用 readdirSync，没有异步
   让路；`src/entityMapping.ts:1378`、`:1400` 的方法索引仍同步枚举/读文件。
   后者的让路检查只在成功处理 Python 文件后执行，只有目录或非 Python
   文件的长遍历不会触发该检查。单次慢同步 IO 本身也不可被定时器中断。
   `src/hoverBudget.ts:66` 使用同线程 setTimeout；探针 10ms 预算遇到
   150ms 同步阻塞，实际 150.34ms 才返回。Promise.race 返回后底层 work
   仍继续，`src/extension.ts:467` 收到的取消 token 也没有传给实现。

5. **两份 Python 索引的扫描范围、失效方式不一致。**
   `src/entityMapping.ts:1365` 的方法索引排除集合缺少 PythonClassIndex
   已排除的 vcpkg、third_party、out、site-packages 等目录；因此原先已经
   处理过的引擎依赖树扫描问题在另一条入口仍存在。
   `:967` 任意监听到的 Python change 都清空整个方法倒排索引，旧构建
   不取消。下次查询重新全树构建，保存期间可能存在重叠扫描。
   PythonClassIndex 对尚未缓存的 py 变更则走 invalidate，增加全扫代数。

6. **禁用 MRO 跳转的设置不能阻止激活时的 Python 全扫。**
   `src/extension.ts:525` 在项目门控通过后无条件 scheduleBackgroundScan。
   因此 package.json 中“关闭后不做全仓扫描”的描述与启动路径不符。
   不应把该设置当作已经验证的止血方案。

## 此前结论为何不充分

`docs/perf/2026-final-report.md` 使用 Linux、fake-vscode、生成资产测试；
报告明确端到端 hover、真实 VS Code 长会话未测，全量索引仍约 100 秒。
“局部命中更快”“单测通过”“加了超时”均不能证明整个扩展宿主可响应。
当前 Rust backend 仍受 serving gate 限制，shadow 保留 TS 服务路径；
已有 Rust 实现不意味着用户请求已经移出扩展宿主。

## 修复顺序与验收要求

1. 修正 unindexFile：按旧文件的类集合删除，首次入库不扫描其他文件的类。
   回归覆盖首次入库、同名跨文件类、删除与修改；用操作计数锁定线性增长。
2. 统一扫描根与排除规则；Python 文件变更仅更新该文件的方法桶。
   已过期构建必须取消或丢弃，禁止一保存就启动新的完整索引。
3. 交互请求查询已发布快照及定向依赖，不等待全仓发现/全扫。
   保持同名与多目标导航语义，不能靠提前返回不完整的单目标结果冒充修复。
4. 首扫拆成有界任务，消除共享队列的整轮占位；移除热路径同步 IO，
   大文件解析放独立 worker/server。接入取消，并限制过期请求继续消耗资源。
5. 真实 VS Code 中同时启动 Kode 与 Python 语言服务，覆盖冷启动、未知
   符号、外部根、含依赖树的大仓、连续保存、取消 hover、首次跳转。
   记录扩展宿主 event-loop delay / CPU profile、请求端到端耗时、扫描计数、
   取消后残留工作量与内存变化。上述现场验收完成前，不标“卡死已解决”。
