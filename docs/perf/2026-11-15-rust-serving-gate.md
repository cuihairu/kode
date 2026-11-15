# Rust 服务态门禁装配纪实(2026-11-15,审计 P1-3 收口)

审计出处:2026-11-15 用户审计发现 [P1-3]——「性能不过不得合并」没有真正强制执行:
perf-gate 只跑 TS v02Baseline(真实 kode-server 的服务面从未进合并门),soak 只挂
TS 侧,Rust 服务态长跑只有一次性 serving-state 观测。本批把两道 Rust 车道装进门。

## 门 1:servingGate.bench.ts(每次 PR,合并阻塞面)

`tests/perf/servingGate.bench.ts` + `tests/perf/servingBounds.ts`(纯界限模块,
KODE_SERVING_BOUND_* 可覆盖,非法值回退缺省不抛不猜;单测钉
`servingBounds.test.ts` 进主 unit 门)。缺省(无 KODE_SERVING_GATE=1)整套 skip,
bench 目录整跑不重放;CI 显式启用。

界 = 宽松上界纪律(只捕数量级回退,不跨机绝对值比较,PERF-015 同款),基线
`docs/perf/serving-state-run.txt` 本机 3000 def 档推导:

| 面 | 基线实测 | 界(缺省) | 余量口径 |
|---|---|---|---|
| spawn.start p99 | 13.8ms | 5000ms | CI 慢 runner ~10x |
| mirror3000.total | 64ms | 10000ms | 磁盘抖动 ~10x |
| steady.definition p99 | 2.78ms | 30ms | 墙钟 ~10x |
| steady.completion p99 | 1.07ms | 15ms | 墙钟 ~10x |
| steady.diagnostic p99 | 4.48ms | 40ms | 墙钟 ~10x |
| editRoundTrip.diagnostic p99 | 6.84ms | 60ms | 墙钟 ~10x |
| mirrorRssDeltaMb | 110MB | 300MB | 内存最紧 ~2.7x(不抖动) |
| steadyRssMb | 116MB | 400MB | ~3.4x |

断言位:各测量面只记账 violations,收尾 it 统一断言全集——任何一面超界都让门红。

CI 接线:`ci.yml` perf-gate job 新增三步(Cache Rust builds → Build kode-server →
Serving gate),job 时长 20→30 分钟;门红照旧上传运行文件归因。
required status checks(把 perf-gate 设为必须绿)仍属仓库设置主侧操作,workflow
无法代设(ci.yml 注释同款提示)——审计该项的仓库设置部分需用户在
Settings→Branches→protection 落,已如实列。

## 门 2:servingSoak.bench.ts(Rust 服务态 soak)

`tests/perf/servingSoak.bench.ts`:真实 kode-server + 真实 client,2000 def 语料,
5s 窗混合负载轮转(definition→completion→每第 5 轮 didChange 编辑→diagnostic,
编辑属性名 `_p0`→`_p0_vN>` 全局同改保 XML 配平),RSS 逐窗采样。档位
KODE_SERVING_SOAK_SECONDS(缺省 60,nightly 600,本地 1h 可自行拉),超时按时长
自动放宽。四闸:

1. 零错误(任一请求抛错计数,>0 红);
2. 全程有请求(每窗 requests>0,服务未失能);
3. RSS 增量 < KODE_SERVING_SOAK_RSS_GROWTH_MB(缺省 100;Rust 分配器保留策略,
   界宽松只捕数量级泄漏;基线后采样起点,首窗索引成本不计入);
4. 无病态退化:末季度 definition p50 < 首季度 ×10+5ms(数量级回退闸,单窗尾刺
   不红,与 soak.bench.ts 同纪律)。

CI 接线:perf-gate 60s 档(PR 时长);nightly validate job 600s 发布档 + 运行文件
上传留档。

## 实测记录(2026-11-15 本机,追加制 run 文件)

- `docs/perf/serving-gate-run.txt`:绿档(spawn p99 9.48ms / mirror3000 56.02ms /
  steady definition p99 1.9ms / completion 0.77ms / diagnostic 1.86ms /
  editRoundTrip p99 3.13ms / RSS 94MB)+ 红档存证(tight bound 0.001 →
  `violations=1 steadyDiagnosticP99Ms observed=0.91 > bound=0.001`)。
- `docs/perf/serving-soak-run.txt`:60s 官方档(12 窗 56467 请求 0 错误,
  defP50 1.06→1.04ms 无退化,RSS 67.7→64.39MB 增量 -3.31MB)+ 10s 校验档 +
  闸④ prove-red 存证(`expected -3.5 to be less than -1000` 红)。

## prove-red

- 门 1:`KODE_SERVING_BOUND_STEADY_DIAGNOSTIC_P99_MS=0.001` → 门红(violations=1),
  恢复缺省复绿。
- 门 2:闸③负顶(ceiling=-1000,低于任何真实增量)→ 红;恢复缺省复绿。
  (首轮 prove-red 用 ceiling=-1 假绿——growth -3.5MB 本就低于 -1,属比较方向
  自误非闸缺陷;如实记。)

## 实现期自审修正(如实)

1. 稳态面首版漏镜像语料——在 10 文档服务器上量稳态,闸名不副实;修正为
   镜像满语料后量测(与 servingState 基线同形),修正后 definition p99
   0.42→1.9ms、RSS 11→94MB,门数字才有意义。
2. 健康面文档数=defCount+3:三类 XML(types/entities/alias)必须先行镜像,
   漏镜像门跑即红(实证抓出并修)。
3. RSS 基点必须在镜像前采样(镜像后补采基点恒 ~0,闸失效)。

## 诚实边界

- servingGate 的 spawn/mirror 为独立 client 实例逐面测,steady 面 mirror 满语料
  后量测;TS v02Baseline 门照旧并行,两门互不替代。
- soak 的 RSS 判据是服务进程 RSS 方向界(分配器保留策略),非逐对象泄漏归因;
  深挖仍靠 VmRSS 逐窗曲线人工审。
- required status checks 属仓库设置主侧操作(见上),本批不假称已强制。
- 编辑流轮转面覆盖 didChange 版本递增+属性追加,未覆盖批量重命名/删档风暴
  (requestStorm.bench.ts 已有 TS 侧同形,不重复造)。
- 观察到 steady 面 definition max=2395ms 单点(满语料镜像后首查含惰性建索引
  类工作)——p99 闸不红,该尾点正是审计 P1-2b(分派仍主线程同步)的用户可见
  形态,修泵后此数字应显著收敛,留作 2b 验收对照点。
