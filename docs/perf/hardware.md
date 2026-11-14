# 性能基准硬件与环境(PERF-001)

- 日期:2026-10-23 · 分支:v0.2 · commit:36052c47cb26290b6829632c6c3ca31341161c96
- 口径:本文所有值为基准机实况(lscpu/free/lsblk --roba 实测),与 docs/perf/2026-baseline.md §1、2026-final-report.md §1 声明一致并补齐版本面。**主报告只允许使用本机;跨机器禁止比较绝对速度(PERF-015)。**

## 1. 机器规格

| 项 | 值 | 来源 |
|---|---|---|
| CPU | Intel(R) Core(TM) i9-10880H @ 2.30GHz | lscpu |
| 逻辑核 | 14(lscpu Thread(s) per core = 1 → 疑为虚拟机 vCPU 暴露,物理拓扑未见;标注待确认) | lscpu |
| RAM | 45GiB(Swap 31GiB;量测时 buff/cache 31-37GiB,基线数字为热缓存口径) | free -h |
| 磁盘 | /dev/sda 1.5T,ROTA=1(机械盘特征),LVM ubuntu--vg/ubuntu--lv,根分区 61% 用量(873G/1.5T) | lsblk/df |
| OS | Linux,内核 7.0.0-38-generic | uname |
| Node.js | v24.21.0 | node --version |
| VS Code | 1.142.0(CLI 报告值;bench 不经 VS Code,fake-vscode 桩) | code --version |
| Rust | rustc 1.99.0 (b940084d7 2026-09-28)(Rust Core 尚无代码,仅环境记录) | rustc --version |
| 量测框架 | vitest 5.0.3(`vitest.bench.config.ts`)+ fake-vscode 桩,真实索引实现 | package.json |
| KBEngine 引擎版本 | 待测(基准机无引擎树;V-07 KBENGINE_ROOT 探测未排期) | — |
| 观测开销 | PR1 埋点启用(聚合口径),所有数字含埋点开销 | docs/perf/2026-baseline.md |

## 2. 已知测量偏差(PERF-015 执行细则)

1. 单轮机械盘抖动大:U4 全量口径同代码两轮 130.3s / 89.9s(docs/perf/2026-final-report.md §5);**判定回归必须多轮取中位;RUST-032(2026-11-15)已建 `KODE_PERF_REPEAT`(1-10,>1 时每场景整跑 R 遍、每指标取代表值落账,场景收尾汇 V02-REPEAT 行 median/p05/p95/min/max/spreadPct,纯核 tests/perf/repeatStats.ts nearest-rank 与主 bench 百分位同源;M 档 REPEAT=3 实测 34 指标×3 场景 102 行,散布 0-20% 区间)。散布只观测不做门禁硬闸;跨机器绝对比较依旧禁止。**
2. 全部 PR1-7 数字为服务层(fake-vscode + 真实索引),不含真实 VS Code UI 序列化、provider 调度、extension host 事件循环延迟——端到端口径待测(基线 §5、final-report §6#6)。
3. 进程内存(RSS 峰值)从未记录——待测(final-report §6#2)。
4. 冷/热盘缓存未分离量测——待测。
5. Windows/macOS、网络文件系统、Remote 场景:待测(ARCH-010 范围)。
6. RUST-027(2026-11-15):nightly perf 门阈值可经 `KODE_PERF_BOUND_*` 环境变量覆盖(缺省=宽松上界表 tests/perf/gateBounds.ts;prove-red=紧界 0.001ms 三场景全红);nightly 上传基准运行文件 perf-baseline-run 产物(30 天)。噪声控制现状=宽松上界(只捕数量级回退)+暖态 n=100 采样+共享 runner 抖动余量 7-11x;多轮取中位已建(RUST-032 `KODE_PERF_REPEAT`,V02-REPEAT 置信行;散布只观测不硬闸)。
7. RUST-028(2026-11-15)基线管道三面:①基线自动生成——bench 经 `KODE_PERF_BASELINE_JSON_OUT` 把当次 recordedMetrics 投影成机器可读快照(schema kode-perf-baseline/1,tests/perf/perfBaseline.ts 纯函数,M 档实测 3 场景 102 指标),nightly 上传 perf-baseline-snapshot 产物(90 天滚动=趋势序列);原始记录仍 v02-baseline-run.txt(提交在库追加制,已补 M 档 CI 档位记录)。②PR 对比闸——ci.yml 新 perf-gate job,每 PR 跑同一 bench(M 档 2000 文件,KODE_PERF_GATE=1),断言 2026-11-04 基线推导的宽松上界(CI runner 实测绿的同套界),红=基准不过=合并阻塞面;强制化需在仓库 Settings→Branches→protection 把「CI/CD / perf-gate」加入 required status checks(属主侧设置,workflow 无法代设)。③趋势纪律——只有同机同档可比(PERF-015 禁跨机器绝对值比较):PR 闸对比的是上界而非跨机 delta;本机 L 档记录(2026-11-04 起)与 CI M 档记录分轨,互不换算。

## 3. Fixtures 规格(PERF-002/003/004 现状)

现有确定性生成器 `scripts/generate-perf-assets.mjs`(同机器同资产复现:`KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/baseline.bench.ts`;RUST-019 起 `--preset S|M|L|XL` 一键分档+每场景统计摘要,重复生成字节级一致已验)。

| 书分档 | 生成命令 | large 场景实测(2026-11-15,14 核 Linux) |
|---|---|---|
| S(200) | `--preset S` | 205 文件 / 19.7 KiB / 201 class / 401 def(+small 7 文件行为口径树) |
| M(2k) | `--preset M` | 2,005 文件 / 194.7 KiB / 2,001 class / 4,001 def |
| L(10k) | `--preset L` | 10,005 文件 / 975.9 KiB / 10,001 class / 20,001 def |
| L 覆盖超集(缺省) | `--large-files 30000`(bench 同参) | 30,005 文件(30,000 生成 .py,1 类 2 方法 + Avatar 骨架) |
| XL(50k+) | `--preset XL` | 50,005 文件 / 4,921.2 KiB / 50,001 class / 100,001 def |
| XRoot(3+ 根) | multi-root 场景(与档无关) | 18 文件,3 根,同名实体 Avatar、同名类 Inventory |
| 专项 | 场景缺省 | big-py 5(单文件 8,000 方法/754 KiB)、def-heavy 1,323(1,200 .def + 40 组 XML 变体/7,200 def 方法)、noise 406(.git/build/third_party 干扰/401 class) |

统计口径=生成后全树走读:文件数/UTF-8 字节/`^class ` 与 `^\s+def ` 计数(.py)/`<onRpc` 计数(.def);生成器每次运行末尾打印同格式摘要。

RUST-020 对抗性样例已建:adversarial 场景(63 文件/9.5 KiB/54 class;`--only adversarial` 单独生成)=深继承(Chain0..Chain50 def Parent 链+py 同构链)、循环别名(TYPE_A↔TYPE_B 类型环+LoopA↔LoopB Parent 环)、不完整 XML(截断 def+截断 entities 两形)、非 ASCII 路径(scripts/base/怪物/武器库/宝剑.py)、符号冲突(base/cell 同名 Avatar 两实现);六钉 tests/generatePerfAssets.test.ts 走真实解析通路(buildDefChain 深链 50 层无截断/Parent 环 visited 截断/两种截断形在解析位抛错且调用方 try/catch 跳过为真实容错语义)。

RUST-021 真实引擎样例车道(env 隔离,样例永不入库):`KODE_PERF_REAL_ENGINE_ROOT` 指向引擎 checkout,tests/perf/realEngineCorpus.bench.ts 经 `hasEngineTreeMarker`(kbe/src/lib/common/version.h)校验后在引擎自带脚本语料上量测盘点(.py/.def 计数+字节+class 符号)+全量 .def 容错解析(解析位 throw 按调用方口径计 parse-fail);未配置=`engine=not-configured` 如实申报零声称不红,指错目录=红出来让人修。输出落 docs/perf/real-engine-corpus-run.txt(KODE_REAL_ENGINE_OUT 可覆盖,配置了真引擎才开新记录窗)。本地 fork(BigWorld-Engine-14.4.1)实测(2026-11-15)=语料稀疏如实入账:py=12(19.1 KiB,class=4) def=1(Account.def,parse-fail=0)——引擎树主体是 C++,Python 资产仅 sdk_templates 样例;fantasydemo 级大语料不在本 fork,取得授权后指向同 env 即得实测,无需改码。隔离纪律:引擎树自带许可条款,**任何引擎文件绝不提交本仓**;与合成样例(generate-perf-assets.mjs,本仓自有)物理隔离。

## 4. 分段时延口径(PERF-005)

已落地分段(PR1 89e8783 埋点,11 类事件):completion / hover / definition / diagnostics / python-index-scan / entity-mapping-scan / type-registry-query / file-discovery / document-parse 等;每请求记录总耗时、文件发现/读取/解析/缓存命中计数、是否等待初始化、索引 generation、文档 version、结果状态(ok/miss/取消/异常)。已测数字与原始输出索引见 docs/architecture/current-state.md「PERF-005」节;未覆盖分段:extension activation(真实 VS Code)、workspace discovery、publish、Core spawn/handshake(直至 PR-003 前 N/A)——待测。

## 5. 优化决策记录(PERF-016)

docs/perf/decisions.md 待建(本 PR 文件范围受限);现有证据位置:PR2/3/5/6 报告 docs/perf/2026-pr*.md、评审跟踪表 docs/review/2026-10-22-unified-semantic-index-refactor.md、复测对照 docs/perf/2026-final-report.md §3-§5。
