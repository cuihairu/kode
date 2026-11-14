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

1. 单轮机械盘抖动大:U4 全量口径同代码两轮 130.3s / 89.9s(docs/perf/2026-final-report.md §5);**判定回归必须多轮取中位,bench `--repeat`/置信区间待建**。
2. 全部 PR1-7 数字为服务层(fake-vscode + 真实索引),不含真实 VS Code UI 序列化、provider 调度、extension host 事件循环延迟——端到端口径待测(基线 §5、final-report §6#6)。
3. 进程内存(RSS 峰值)从未记录——待测(final-report §6#2)。
4. 冷/热盘缓存未分离量测——待测。
5. Windows/macOS、网络文件系统、Remote 场景:待测(ARCH-010 范围)。

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

RUST-020 对抗性样例已建:adversarial 场景(63 文件/9.5 KiB/54 class;`--only adversarial` 单独生成)=深继承(Chain0..Chain50 def Parent 链+py 同构链)、循环别名(TYPE_A↔TYPE_B 类型环+LoopA↔LoopB Parent 环)、不完整 XML(截断 def+截断 entities 两形)、非 ASCII 路径(scripts/base/怪物/武器库/宝剑.py)、符号冲突(base/cell 同名 Avatar 两实现);六钉 tests/generatePerfAssets.test.ts 走真实解析通路(buildDefChain 深链 50 层无截断/Parent 环 visited 截断/两种截断形在解析位抛错且调用方 try/catch 跳过为真实容错语义)。真实 KBEngine 引擎样例(PERF-004,fantasydemo 等):待测,须与合成样例隔离存放。

## 4. 分段时延口径(PERF-005)

已落地分段(PR1 89e8783 埋点,11 类事件):completion / hover / definition / diagnostics / python-index-scan / entity-mapping-scan / type-registry-query / file-discovery / document-parse 等;每请求记录总耗时、文件发现/读取/解析/缓存命中计数、是否等待初始化、索引 generation、文档 version、结果状态(ok/miss/取消/异常)。已测数字与原始输出索引见 docs/architecture/current-state.md「PERF-005」节;未覆盖分段:extension activation(真实 VS Code)、workspace discovery、publish、Core spawn/handshake(直至 PR-003 前 N/A)——待测。

## 5. 优化决策记录(PERF-016)

docs/perf/decisions.md 待建(本 PR 文件范围受限);现有证据位置:PR2/3/5/6 报告 docs/perf/2026-pr*.md、评审跟踪表 docs/review/2026-10-22-unified-semantic-index-refactor.md、复测对照 docs/perf/2026-final-report.md §3-§5。
