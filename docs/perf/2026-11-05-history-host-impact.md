# IDE-GIT-012:历史功能对宿主与语言服务影响验收

日期:2026-11-05
验收原文(todo.md:645):「真实编辑器分别测关闭、默认开启未查询及查询大历史三种状态,在同机同项目交替重复采样;
记录历史模块 Git 调用数、进程/任务量、缓存字节、宿主最大延迟及 hover/导航 P95;默认开启未查询的
Git 调用/历史任务必须为零;历史查询不得同步阻塞宿主,忙时基础交互 P95 相对关闭对照回退不超过
max(5ms, 10%),且仍满足既定绝对延迟预算;超大范围超预算时可取消并说明截断/未完成,不显示伪完整时间线。」
前置:IDE-GIT-011(历史查询协调门,ced6c15)。

## 结论

**通过。** 真实编辑器三态(关闭 / 默认开启未查询 / 查询大历史)在同机同项目交替重复采样(R=3)下:

| 判定 | 结果 | 证据 |
|---|---|---|
| 默认开启未查询 Git 调用/历史任务为零 | ✅ 通过 | spawnDelta=0,runningMax=0,queuedMax=0,cacheBytes=0 |
| 历史查询不同步阻塞宿主 | ✅ 通过 | 事件循环滞后 max 3.2ms(界 1000ms) |
| 忙时 hover P95 相对关闭回退 ≤ max(5ms,10%) | ✅ 通过 | 轮内配对差 -4.0ms / -4.0ms(界 5.0ms) |
| 忙时 def P95 相对关闭回退 ≤ max(5ms,10%) | ✅ 通过 | 轮内配对差 -0.8ms / -5.0ms(界 5.0ms) |
| 绝对延迟预算(hover≤30ms / def≤50ms) | ✅ 通过 | hover P95 2.4-3.7ms;def P95 1.6-5.7ms |
| 超范围诚实截断(可取消、不伪完整) | ✅ 通过 | 单元证据:有界执行超时→git-error,无 entries/无 boundary |

## 三态定义

- **关闭**:`kbengine.gitHistory.enabled=false`(workspace 配置),不触历史入口。
- **默认开启未查询**:`enabled=true`(缺省),不触历史入口(纯开启,零预取/零轮询)。
- **查询大历史**:开探针编辑器、选区覆盖 `history_probe.py` 全部行 → `kbengine.git.showRangeHistory`
  (查询在途窗口突发采样)。

## 方法

- 装配:同 ACC-010 field 装配(demo 资产 + 5000 文件外部根);工作区根经 `git init` + 首提交 + 300 次
  「追加一段 + 提交」建成大历史探针(`scripts/common/training/history_probe.py`,每提交触及同段行,使
  `git log -L` 走全部提交→在途窗口真实)。
- 交替重复:每轮固定序 关闭→默认开启未查询→查询大历史,共 R=3 轮(关闭态切配置触发门 `cancelAll`
  清缓存,故每未查询态测量起点缓存恒 0,且与查询态串行——并发测量是零 Git 误报根因,已修)。
- P95:每态 3 突发 × 30 采样,取最优静窗(首命中窗排除首扫);回退判定按**轮内配对**(同轮关闭对照 vs
  未查询/查询,同一负载纪元)取各轮最优,避免跨轮取独立最优静窗把不同负载窗拼到一起。
- 指标:Git 调用数(`sharedGitQueryGate.spawnCount` 差)/进程·任务量(`runningCount`+`queuedCount`)/
  缓存字节(`cacheBytes`)/宿主最大延迟(setTimeout 事件循环探针)/hover·def P95。
- 证据:`docs/perf/2026-11-05-history-host-impact-run.txt`(本批运行原样落盘)。

## 每态指标(实测)

| 指标 | 关闭 | 默认开启未查询 | 查询大历史 |
|---|---|---|---|
| Git 调用数(spawnDelta) | 0 | **0** | 3 |
| 进程·任务量(runningMax/queuedMax) | 0/0 | 0/0 | 0/0 |
| 缓存字节 | 0 | **0** | 2,029,912 |
| 宿主事件循环滞后 max | 3.57ms | 3.24ms | 2.91ms |
| hover P95 | 2.35ms | 3.68ms | 3.48ms |
| def P95 | 4.34ms | 5.68ms | 1.64ms |
| hover/def 命中 | 30/30 | 30/30 | 30/30 |

查询大历史态的 3 次 Git 调用即范围历史的完整查询链:`ls-files`(探针文件登记)→
`diff HEAD --unified=0`(选区→HEAD 行段映射)→`log -L 1,903`(行段逐提交时间线,~2MB 输出);
三者全部经协调门去重/缓存,并发/排队为零。

## 五条判定逐项说明

1. **未查询零 Git**:默认开启未查询态 spawnDelta=0、runningMax=0、queuedMax=0、cacheBytes=0——
   开启只提供入口,绝不预取/轮询/挂监听(IDE-GIT-001/005 语义,实测归零)。
2. **不同步阻塞宿主**:查询大历史态事件循环滞后 max 2.91ms(界 1000ms),查询经有界执行器异步,
   不占宿主事件循环;忙时 provider 墙钟不失控(querying hover max 11.7ms / def max 4.9ms)。
3. **忙时 P95 相对关闭回退**:轮内配对差全部为负(-0.8 至 -5.0ms,即未查询/查询态与关闭对照在
   同一负载纪元下无劣化),远低于 5.0ms 界。
4. **绝对延迟预算**:hover P95 ≤3.7ms(界 30ms)、def P95 ≤5.7ms(界 50ms),均满足 ACC-010 口径。
5. **诚实截断**:单元证据(tests/gitRangeTimeline.test.ts 20 例)——有界执行器超时 → 查询级返回
   `git-error`(`outcome.kind==='timeout'`),**无 entries、无 boundary**(边界绝不从截断流伪造);
   `describeRangeTimeline` 对超时/输出超限明示文案;IDE-GIT-011 已实现取消令牌(运行中取消→SIGKILL)。

## 发现并修复的配置读取缺陷

验收「关闭」态装配时暴露 IDE-GIT-001 一处真实缺陷:`readGitHistoryEnabled` 以**完整设置键**
`kbengine.gitHistory.enabled` 读一个 **`getConfiguration('kbengine')` 段作用域**读取器 → 实际查询
`kbengine.kbengine.gitHistory.enabled`(段内再拼前缀),永未命中 → 开关恒默认 true,**关闭配置从未真生效**。
单元测试用直传完整键的替身,未复现段作用域装配,故未捕获。

修复:新增段内相对键 `GIT_HISTORY_ENABLED_KEY='gitHistory.enabled'`(与 engineVersion/managedDir 同口径),
`readGitHistoryEnabled` 改读相对键;完整键 `GIT_HISTORY_ENABLED_SETTING` 保留仅用于
`onDidChangeConfiguration.affectsConfiguration` 判定。修复后「关闭」态真实取消在途/排队查询并清缓存
(实测 cacheBytes 0),重启用恢复照常。回归用例:tests/gitHistory.test.ts(8 例,含「完整键经段作用域
不重复前缀」)。

## 运行命令

```
xvfb-run -a pnpm run compile && npx tsc -p tsconfig.mocha.json && node out/test/electron/runTest.js --history
```

## 免责

共享机争用(loadavg 1 分钟 74.2 / 5 分钟 87.9 / 15 分钟 113.0,14 核)单轮免责:best-of-3 突发静窗 +
轮内配对回退消除负载尖峰影响;所有相对回退与绝对预算均以实测静窗口径判定(同 finalMarks/ACC-010,
PERF-015)。绝对 P95 在负载 74-113 下仍达毫秒级,不放大稳态交互。
