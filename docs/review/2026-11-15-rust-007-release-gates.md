# RUST-007 审计与落地:语义正确性、内存上限、稳定性与尾延迟均为发布门槛

日期:2026-11-15。审计对象:todo.md RUST-007。方法:枚举现有 CI/nightly 门槛,对照判据四轴找缺口,落地缺的门槛。**结论:正确性与稳定性门槛已在 CI/nightly;内存上限与尾延迟此前只有测量(base bench)没有闸——本批把 KODE-PERF-007 bench 升级为可断言发布门槛(KODE_PERF_GATE=1),接线进 nightly validate job,判据收口**。(版本红线不变:门槛是 nightly 全链闸,正式版本号发布仍只由用户手动触发。)

## 1. 四轴对照

| 判据轴 | 现有闸 | 缺口与本批动作 |
|---|---|---|
| 语义正确性 | CI 每次 push:vitest 全量(10186 例)+ Rust cargo tests + mocha 烟测;nightly 全链复跑 | 已有;另在 perf gate 增补语义命中面(hover/definitionPy 必命中=标注链与基类解析活,§3) |
| 稳定性 | mocha 扩展宿主烟测(exit 0 = 稳定面)+ nightly 7 平台打包验证(verify-platform-set) | 已有 |
| 内存上限 | bench 只测不闸(PERF-007 是纯观测) | **本批上闸**:扫描期 RSS 峰值 ≤700MB、增量 ≤400MB、激活期增量 ≤200MB |
| 尾延迟 | bench 报 p95/p99/max 但零断言;个别 unit 测试有宽松上界(PERF-006 族) | **本批上闸**:热态全维度 p99 ≤100ms、max ≤300ms;启动墙钟 def 扫描 ≤15s / 全量 .py 扫描 ≤120s |

## 2. 门槛机制(`tests/perf/v02Baseline.bench.ts`)

- `KODE_PERF_GATE=1` 时每场景收尾按 `GATE_BOUNDS` 断言,违规清单非空即场景红;缺省纯观测(与 PERF-007 行为一致,主 unit 门禁不含 bench——`vitest.config.ts` include `tests/**/*.test.ts` 与 bench 配置 `tests/perf/*.bench.ts` 互不重叠)。
- 边界=2026-11-04 基线 × 7~30x 宽松上界(PERF-006 纪律:只捕数量级回退,不捕负载抖动——共享 runner 墙钟抖动大;RSS 几乎无抖动故内存界收最紧 2.4~3.1x)。对照基线最坏值:交互热态 p99 14.5ms / max 26.7ms、全量 .py 扫描 10.4s、扫描期 RSS 峰值 251-287MB / 增量 +127.9MB、激活期增量 0MB。
- 不入闸项如实登记:big-py definitionDef 0 hit(基线 §5.1 已登记预期);completion items 数(随功能漂移);冷态指标(首扫在途,命中为 0 属预期,且单样本抖动大)。
- 证明:本机 30k 全尺度 gate 绿(RC=0,102 指标,hits=1,scanWall 2.8s / RSS 309MB 全在界内);prove-red=把 warmP99Ms 界临时收到 0.01ms → 三场景全红(RC=1,断言确实打在记录面上)→ `cp` 还原 `cmp` 字节一致后复绿。

## 3. nightly 接线(`.github/workflows/nightly.yml` validate job)

`Run tests (full gate)` 步后新增 `Perf gate` 步:`KODE_PERF_GATE=1 KODE_PERF_LARGE_FILES=30000 pnpm exec vitest run --config vitest.bench.config.ts tests/perf/v02Baseline.bench.ts`。nightly=48h 有提交即跑的滚动全链(AUD 口径),即「发布前的门槛序列」:lint+全量测试+烟测+**内存/尾延迟/启动墙钟闸**。nightly 绿 ≠ 自动发版:正式版本仍严格走用户手动触发红线。

## 4. 边界声明

- 门槛跑在 fake-vscode 桩工作区(PERF-007 同口径):provider 级量测,非真实编辑器端到端;IPC/渲染附加延迟不在闸内。
- 界是「数量级回退探测」不是 SLA:基线 × 7~30x 的墙钟界不拦 2~5x 的机器慢化(那是抖动);内存界 2.4~3.1x 更紧,拦留存类回退(PERF-003 族)。
- 尾延迟主导项(进程拓扑全量诊断 ~260ms,KODE-PERF-006)不在本 bench 面,维持既有 loose-bound unit 测试(1000def<5000ms)作其闸。
