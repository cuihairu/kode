# Kode 门 1 基准补齐:端到端冷/热多轮 + 内存 + 失效重查(2026)

- 日期:2026-10-23 · 分支 v0.2 · 目的:ph0-gate.md 门 1 四个可测缺口的关门实测正本
- 实测代码:本轮工作树(bench 文件 `tests/perf/gate.bench.ts`;commit hash 见 git log)
- 对照:docs/perf/2026-baseline.md(PR1)、2026-final-report.md(PR7 §9.2 #1/#2/#8 + §6 #1/#2/#3)
- 原则:**无可复现数据的性能声明不进本报告**;关不了的门项如实留白,不硬凑。

## 1. 测试环境与口径

| 项 | 值 |
|---|---|
| 机器 | 与 PR1/PR7 同机:i9-10880H/14 逻辑核/45GiB/机械盘(ROTA=1),详见 docs/perf/hardware.md |
| Node.js | v24.21.0 |
| 资产集 | `scripts/generate-perf-assets.mjs --large-files 30000`(large 30,005 文件,与基线同一生成器同规模) |
| 量测面 | 真实 Provider 入口端到端:KBEngineHoverProvider / KBEngineCompletionProvider / PythonCompletionProvider / validateDocument / validateEntitiesXmlDocument + 真实索引(EntityMappingManager / PythonClassIndex);fake-vscode 桩 |
| 多轮口径 | 热态每指标 5 轮 × 20 样本:报全样本聚合 P50/P95/P99/max + 逐轮中位数列表 + 轮中位(门 1 缺口④的多轮中位要求) |
| 内存口径 | `process.memoryUsage().rss` 25ms 周期采样,阶段峰值绝对值 + 阶段增量双记;单进程口径(激活段与扫描段同进程,扫描段含激活段已驻留内存) |
| 复现命令 | `KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/gate.bench.ts` |
| 原始输出 | docs/perf/gate-run.txt(本轮实跑,2/2 场景通过,总墙钟 450s) |

## 2. 端到端时延:冷/热两态(large 30k)

### 2.1 激活期(首扫在途,冷态)

激活期 = manager 构造 → entity .def 首扫收尾(本轮 219.79ms;该扫描只走 .def 面,不等 30k .py 全量,与 PR5 U1 口径一致)。

| 指标(n=10) | P50 | P95 | max | 命中 |
|---|---|---|---|---|
| 冷 Hover(def 方法标注链,首样本起连发) | 0.19 ms | 116.01 ms | 116.01 ms | 首样本 1 hit |
| 冷 Python 补全(self. 面) | 0.09 ms | 1.34 ms | 1.34 ms | 5 items |
| 冷 诊断 .def(合法文档首算) | — | — | 2.49 ms | 0 items |
| 冷 诊断 .def(缺陷文档首算) | — | — | 6.71 ms | **4 items** |

冷 Hover P95 116ms 的构成:首扫窗口内请求等待 .def 定向解析就绪(与 coldHover.bench H1 同形态);首样本即命中,未触发 2500ms 预算兜底。

### 2.2 索引就绪后(热态,5 轮 × 20 = 100 样本)

| 指标 | 聚合 P50 | 聚合 P95 | P99 | max | 轮中位(5 轮) |
|---|---|---|---|---|---|
| Hover(def 方法标注链) | 0.05 ms | **0.09 ms** | 0.14 | 0.31 | 0.06/0.04/0.03/0.05/0.04 → **0.04 ms** |
| Completion .py(self. 面) | 0.04 ms | **0.08 ms** | 0.11 | 0.13 | 0.04/0.03/0.03/0.04/0.04 → **0.04 ms** |
| Completion .def(类型面) | 0.50 ms | **0.74 ms** | 0.77 | 0.91 | 0.63/0.51/0.46/0.46/0.48 → **0.48 ms** |
| Completion .def(标签面,单发) | — | — | — | 0.90 ms(9 items) | — |
| 诊断 .def(合法文档) | 0.27 ms | **0.57 ms** | 1.24 | 1.49 | 0.41/0.35/0.27/0.22/0.19 → **0.27 ms** |
| 诊断 .def(缺陷文档,4 findings) | 0.58 ms | **0.79 ms** | 0.95 | 1.42 | 0.65/0.62/0.54/0.59/0.47 → **0.59 ms** |
| 诊断 entities.xml(清单面) | 0.02 ms | **0.05 ms** | 0.07 | 0.59 | 0.02/0.02/0.02/0.01/0.02 → **0.02 ms** |

**对评审 §9.2 建议阈值的结论:Hover 热 P95 0.09ms ≤ 30ms ✔;Completion 热 P95 0.74ms ≤ 50ms ✔**(量测面为 Provider 入口端到端,不含 VS Code UI 序列化/extension host 事件循环,见 §5 缺口)。

## 3. 失效后首重查

| 场景 | 指标 | 实测 | 正确性 |
|---|---|---|---|
| .def 变更定向失效(PR4 A4-2 路径) | 映射重建墙钟(失效 → getMapping 可用) | **1.85 ms** | — |
| 同上 | 失效后首次 Hover 重查 | **0.29 ms**(重建后) | 1 hit |
| 同上 | 第二次 Hover(热) | 0.26 ms | 1 hit |
| .py 变更失效(归属 def 强制重解析) | 失效后首次 Hover 重查 | **0.30 ms** | 1 hit |
| 删除 .py(large,Gen0) | 失效墙钟(onFileChanged) | **28.04 ms** | — |
| 同上 | 失效后首次类名重查 | **0.56 ms** | Gen0 = **0 hit**(旧项已摘) |
| 同上 | 阳性对照(Avatar 仍在) | — | 1 hit |

## 4. 内存占用(进程 RSS,25ms 采样)

| 阶段 | 峰值 RSS | 阶段增量 | 备注 |
|---|---|---|---|
| 激活期(manager 构造 + .def 首扫 + 冷/热请求,~60s 窗口) | **115.40 MB** | **+32.40 MB**(起点 83.00 MB) | .def 面激活,与 30k .py 无关 |
| 全量扫描期(30,001 .py × 3 轮,每轮新 PythonClassIndex) | **687.19 MB** | **+571.64 MB**(段起点 115.55 MB) | 轮峰值 488.63 / 653.26 / 661.83 MB,轮间单调爬升 |
| 全量扫描墙钟(3 轮) | r0=126.4s r1=151.5s r2=166.0s,轮中位 **151.5s** | — | 机械盘抖动实证:同代码 3 轮极差 39.6s(±13%),回归判定必须多轮中位 |

内存注意:①扫描段峰值含 Node 堆未还部分与前三轮叠加的 page cache 外 RSS,单进程口径,轮间 RSS 未回落到轮起点,连续 3 轮爬升(488→653→662 MB)值得跟踪但非泄漏断言口径;②扫描期 RSS 峰值 ≈ 激活期峰值 6×,大头在 30k 文件类/基类/方法三层索引驻留。

## 5. 本轮关闭与仍开放的门项(对 ph0-gate.md 门 1)

**本轮以实测关闭**:
1. Hover 端到端 P95(§9.2 #1):热 P95 0.09ms / 轮中位 0.04ms,冷态首扫窗口 P95 116.01ms(§2)。
2. Completion 端到端 P95(§9.2 #2):.py 面 0.08ms、.def 面 0.74ms(§2.2)。
3. 冷启动内存占用(§9.2 #8 内存子项):激活期峰值 115.40MB(+32.40MB)、全量扫描期峰值 687.19MB(+571.64MB)(§4)。
4. bench 单轮抖动无中位(§5.1):热态全指标 5 轮中位 + 全量扫描 3 轮轮中位落盘;机械盘抖动实证 3 轮极差 39.6s(§4)。

**仍开放(不因本轮谎称关闭)**:
1. 端到端口径仍为 Provider 入口层:VS Code electron UI 序列化、extension host 事件循环延迟不在 fake-vscode 桩口径内(final-report §6 #6,`test:electron` 通道待补)。
2. A1-7 调用链图(Mermaid)未落——架构文档项,非 bench 项,本轮未动。
3. Rust 双轨对拍基准定义未立项——Rust 路径尚不存在,以上每一指标的同 fixture 同口径复测方案只能等 PR-012 输入时定义。
4. 扫描期 RSS 轮间爬升(488→653→662 MB)与 PERF-013 soak/OOM 限额口径未做——1h 压测不在本轮范围。
5. 诊断文档规模轴:本轮诊断对象为资产集内真实 .def(entities.xml),未含超大单文档分档(PERF-002 XL 档同源缺口)。

## 6. 与 PERF-006..014 的对应

| 条目 | 本轮覆盖 | 状态 |
|---|---|---|
| PERF-006 cold/warm 分组 | §2 冷/热两态齐 | 本轮实测(idle/busy、SSD/network FS、local/remote、root 数量轴仍开放) |
| PERF-007 P50/P95/P99/max | §2.2/§3 全指标四分位 + 多轮中位 | 本轮实测(队列耗时/排队长度/取消率未埋点,仍开放) |
| PERF-008 扫描统计 | 文件数/解析数沿用基线口径(30,001);失效节点数经 §3 场景 | 部分(索引版本/RPC 字节数未测) |
| PERF-009 Core 内存 | §4 RSS 峰值双阶段 | 部分(event loop delay/CPU/磁盘 IO 未测) |
| PERF-010..014 | CI 基线回归阈值、请求风暴、soak/OOM、degraded mode、跨机器口径 | 未动,仍开放 |
