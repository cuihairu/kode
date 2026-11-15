# 性能优化决策账本(decisions)

RUST-033:每一项优化的 profiling 证据、取舍、回退策略集中记账。新优化合入时
必须在本文件追加条目(证据=可复核锚点:commit hash / 报告文档 / 测试名;没有
证据链的优化不收账)。

纪律前提:
- 固定基准机纪律(PERF-015,hardware.md §1/§2):主报告只允许基准机读数,
  跨机器禁止比较绝对速度;趋势只有同机同档可比。
- 优化默认「只捕数量级回退」的宽松上界门(RUST-027/028),不钉绝对速度;
  置信区间经 `KODE_PERF_REPEAT`(RUST-032)观测,散布不做门禁硬闸。
- 服务轨道杀开关:`kbengine.core.backend=ts` 整体回退 Rust 服务面(TS 引擎
  冻结为兜底,语义对拍在案);TS 内部优化的回退=revert 独立 commit。

## 决策账本(按合入时间)

### KODE-PERF-001 流敏感解析缓存(b4f80f4c)
- 证据:commit b4f80f4c「cache flow analysis parse by document version」;
  流敏感分析按文档版本键控 LRU,重复 hover 命中缓存零重解析(测试钉在
  flow 版面;锚点随 perfCallChainDoc ANCHORS 锁步)。
- 取舍:缓存键=文档实例身份+版本(flowVersionKey.ts),不为跨实例复用
  (vscode 重开/测试替身同 fileName 会撞键——初版 uri|version 键踩过,
  纠偏为 WeakMap 单调 id);键不可知(undefined version)不缓存,宁可重解析
  不可读旧代。
- 回退:revert b4f80f4c;冷解析路径始终在,无缓存只回退到每次重解析。

### KODE-PERF-002 行起始偏移表(36296367)
- 证据:commit 36296367;自属性流诊断行号计算从平方级逐字符扫描改
  buildLineStarts 表+双指针,100k 行 5 万访问点实测 141,702ms → ~700ms
  (约 200x,记忆台账 2026-11-04 实测记录)。
- 取舍:表按文档一次性构建(O(N) 内存换 O(log N) 定位);编辑后整表重建
  (不做增量行偏移维护——增量维护复杂度换不来数量级收益)。
- 回退:revert 36296367,回退到逐字符扫描(慢但正确)。

### KODE-PERF-003 数据索引编辑缓冲收敛释放(b645b330)
- 证据:commit b645b330;GlobalDataIndex runEditRecompute 收敛提交位释放
  editBuffers 大文件快照,不再为已收敛打开文档积压完整文本(>64KB 收敛后
  残留 0 测试钉);AUD-005 记账/清理面不受影响(测试组回归钉)。
- 取舍:释放后重新编辑需重新登记(noteSaved),拿「下次编辑略多一次登记」
  换「常驻内存不随打开文档数线性涨」。
- 回退:revert b645b330,缓冲常驻(内存换 CPU)。

### KODE-PERF-004 调用图收集重铸(06c64e8b)
- 证据:commit 06c64e8b;多根遍历全 workspaceFolders 按 fsPath 去重、有界
  8 路并发异步读(旧同步读阻塞宿主)、超 10,000 文件明确截断策略
  (truncated/totalDiscovered 并入 stats,面板警告条,绝不静默装完整);
  测试+5,docs/perf/2026-11-04-v02-baseline.md 收集面记录。
- 取舍:截断保确定序(按路径),放弃「全量无论多大」——超界工作区诚实降级
  并明示,不在宿主里硬扛无界读。
- 回退:revert 06c64e8b(单根同步收集回归;截断面消失=超界工作区回退到
  无保护全量,不建议)。

### KODE-PERF-005 刷新代际守卫(1403e72f)
- 证据:commit 1403e72f;refreshGraph 入口取消旧代 CTS+代际自增,写入面
  canWriteRefresh 三面齐才可写;并发写入记账=1、收集在途预取消不写等测试钉。
- 取舍:取消落在写入面代际弃置+收集循环中断(不做真取消 RPC——RPC 面无
  CancellationToken 穿透,不假称已取消),已发出的请求照旧回包后丢弃。
- 回退:revert 1403e72f,旧代写入竞态面回归(不涉及正确性数据,仅体验)。

### KODE-PERF-006 进程拓扑诊断成本测量(e60c6b9→docs/perf/2026-11-04-process-topology-diagnostics.md)
- 证据:合成 workspace 三场景报告:input+map 同步段 ~260ms@1000def/2000f
  为宿主延迟主导项;Rust 校验墙钟大头但异步非阻塞;结论=两场景无风险。
- 取舍:纯测量零生产行为变更;优化候选(同文件 lineStarts 去重/input
  O(N×O))已登记未实施——无实测瓶颈不预优化。
- 回退:不适用(测量件)。

### KODE-PERF-007 v0.2 性能基线(aa3cf8c7→docs/perf/2026-11-04-v02-baseline.md)
- 证据:provider 级 bench 三场景六维(large 热态全亚毫秒;big-py Hover
  P50 3.38ms 为 large ~26x;启动全量扫描 10.4s vs 交互面 370ms 即就绪;
  扫描期 RSS +127.91MB)。
- 取舍:bench 与单测分车道(.bench.ts 只经 vitest.bench.config.ts 跑),
  换「单测门不被分钟级负载拖垮」;启动全量扫描不阻塞交互(后台扫)是
  既有架构决策,基线只把它钉进数字。
- 回退:不适用(测量件)。

### IDE-RES-002/AUD-022 解析 worker 有界化(积压 8MiB/在途 16 任务+8MiB)
- 证据:tests/pythonParserWorkerGauge.test.ts(量规/拒绝/峰值全钉)、
  tests/pythonIndexBacklogOverflow.test.ts(拒绝不变 unhandled rejection)、
  IDE-REV-030 拒绝计数恢复保留;RUST-031 补用户明示面(405036c9)。
- 取舍:超预算拒绝=该次编辑不入索引待下次重试(可用性换稳定性);8MiB
  单文件恒拒绝=超大文件诚实降级并警示(RUST-031),不为其放开无界内存。
- 回退:常量可在源码调大(不建议放开);台账/警示面随量规走,删面即回
  静默(不建议)。

### RUST-027 门禁阈值可配置(nightly/ci.yml)
- 证据:gateBounds.ts 缺省宽松上界表 + `KODE_PERF_BOUND_*` 覆盖;
  prove-red=紧界 0.001ms 三场景全红。
- 取舍:门只捕数量级回退,不捕百分比级回归(假阳率优先于灵敏度);
  required-check 强制化属仓库属主侧设置。
- 回退:`KODE_PERF_BOUND_*` 运行时放宽即运行时回退面;或 CI 摘除 perf-gate job。

### RUST-028 基线快照管道 / RUST-032 置信区间
- 证据:perfBaseline.ts 纯投影(schema kode-perf-baseline/1,无第二真源);
  repeatStats.ts nearest-rank 置信行(M 档 REPEAT=3 实测 102 行,散布 0-20%)。
- 取舍:快照=运行文件的结构化投影不是独立真源;散布只观测不做硬闸
  (硬闸在抖动环境下假阳优先);CI M 档与本机 L 档分轨互不换算。
- 回退:不适用(观测件);env 不设即旧行为。

### RUST-029/030 风暴/浸泡车道
- 证据:docs/perf/2026-11-15-request-storm.md(五面风暴,泄漏判定=gc 后
  heapUsed 非 RSS——探针实证 heapUsed 平坦而 RSS +77MB 属 V8 段预留);
  soak-run.txt 60s 档官方记录(errors=0/heapGrowthMb=0.42)+soak-1h-run.txt
  1h 档官方记录(2026-11-15:windows=720/requests=21600/errors=0/hover 命中
  100%/heapGrowthMb=1.39/P50 0.3→0.24ms 无退化,报告
  2026-11-15-soak-1h.md)。
- 取舍:泄漏硬闸只在 `--expose-gc` 下生效(gc 不可用诚实跳过内存闸);
  退化守卫只捕 10x 量级;RSS 只记录不断言。
- 回退:不适用(bench 车道,零生产影响)。

## 维护规则

- 每项优化合入时在本文件追加一节:证据(可复核锚点)/取舍(放弃了什么)/
  回退(revert hash 或运行时开关);无运行时开关的如实写「revert 提交,
  冲突面小/大」。
- 测量件(bench/报告)不设回退面;生产行为件必须有明确回退路径。
- 数字引用必须能回到证据锚点;本文件不复制原始数据,只指路。
