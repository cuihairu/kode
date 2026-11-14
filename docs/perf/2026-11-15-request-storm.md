# 请求风暴基准(RUST-029,2026-11-15)

- 车道:tests/perf/requestStorm.bench.ts(bench 专用 lane,与主 unit 门无交集)
- 跑法:`npx vitest run --config vitest.bench.config.ts tests/perf/requestStorm.bench.ts`
  (档位 `KODE_STORM_LARGE_FILES` 缺省 2000;输出追加 docs/perf/request-storm-run.txt,`KODE_STORM_OUT` 可覆盖)
- 环境:node v24.21.0 / linux / 14 cpus / M 档 2,005 文件(基准机同 docs/perf/hardware.md §1)
- 口径:服务层(真实索引实现 + fake-vscode 桩),只观测不改行为;断言只有确定性语义命中面
  (S1=200/S2=45/S3=50/S4=5/S5=3,全部钉死),墙钟一律不进断言——数量级回退闸归 v02Baseline 门,
  风暴面本批只建测量(阈值化归后续批次按需收编)。

## 五类风暴面实测(2026-11-15,M 档,提交在库记录)

| 面 | 场景 | 关键值 | 语义闸 |
|---|---|---|---|
| S1 快速连续编辑 | 200 版连续 onDocumentChanged + 每版 hover | 流总墙钟 99.82ms;单版索引吸收 p50 0.06ms / p99 0.26ms;版后 hover p50 0.28ms / p99 0.61ms(max 23.5ms 首版冷解析离群);流内 RSS +12.18MB | hoverHits 200/200 |
| S2 切换 tab | 3 根同名 Avatar 轮转 45 次(每次新文档实例→索引吸收+冷 hover+补全) | 单次切换 p50 0.47ms / p99 2.4ms | hoverHits 45/45;补全 135 items |
| S3 批量重命名 | 50 次 invalidate(change)+新路径登记 | 单次吸收 p50 0.27ms / p95 0.61ms(max 48.39ms 一次离群);基类解析(CellAvatar→Avatar)全程不破 | baseResolutionHits 50/50 |
| S4 依赖变更 | Avatar.def 20 版编辑诊断流 + 5 轮盘上改 def→重建 manager 全量再索引 | def 诊断 p50 0.93ms / p99 5.17ms;全量再索引单轮 p50 5.8ms / max 8.04ms | 再索引后首 hover 5/5 命中 |
| S5 并发跳转补全 | 50 版编辑流推进中 3 波 Promise.all 并发(定义+py 补全+def 补全+xml 诊断) | 并发单请求 p50 0.46ms / p99 2.31ms;风暴总墙钟 6.93ms | 定义跳转 3/3 不破;补全 >0;末版 hover 收敛命中 |

## 读法与诚实边界

1. **量级结论**:五类风暴在 M 档(2,005 文件)全部亚毫秒~低毫秒稳态,无一处锁死或
   无界增长(S1 流 RSS +12MB 有界,S4 全量再索引 8ms 与 RUST-022 激活面一致)。
   S1 max 23.5ms 与 S3 max 48ms 的单点离群是首次冷解析/GC 尾部,不影响稳态百分位。
2. **口径边界**:本车道是服务层(fake-vscode + 真实索引),不含真实 VS Code UI 序列化与
   extension host 事件循环延迟(hardware.md §2#2);诊断调度器的合并/取消面另由
   diagnosticScheduler 单测与 KODE-PERF-006 拓扑基准覆盖,此处不重复。
3. **命中面注入**:生成器 Avatar.py 无 def 映射方法,基线与风暴同法注入 onRpc0
   (只注入命中面,不改既有类结构);hover 光标必须落在方法名内(基线口径)。
4. **阈值化待建**:本批断言只钉语义命中;若后续要把风暴墙钟纳入夜间门,应走
   KODE_PERF_BOUND_* 同款宽松上界纪律(RUST-027),不直接钉绝对值。
