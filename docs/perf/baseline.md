# Kode Phase 1 性能基线

- 日期:2026-10-24 · 分支:`v0.2`
- 用途:Phase 1 收口基线;只用于同机同口径回归,不用于跨机比较。
- 环境:[docs/perf/hardware.md](hardware.md)(Intel i9-10880H,14 vCPU,45 GiB RAM,Linux 7.0.0-38-generic,Node v24.21.0,rustc 1.99.0)。
- 术语:[docs/kode2/glossary.md](../kode2/glossary.md#terms-performance)。

## 1. 基线摘要

| 指标 | Rust | TS | 倍差 | 口径与样本 |
|---|---|---|---|---|
| Definition P95 | 0.39 ms | 2.33 ms | Rust/TS 0.17× | 30k 资产集,100 样本,5 轮×20,热态 |
| 解析吞吐 | 20.0 / 37.0 / 19.1 MB/s | 1.67 / 3.35 / 2.85 MB/s | Rust/TS 6.7×–11.9× | T1/T2/T3,两次进程级运行 × 18 个测量轮 |
| 解析峰值内存 | 2.9 / 6.8 / 124.1 MiB | 70.8 / 229.6 / 1,154.2 MiB | TS/Rust 9.3×–33.8× | `VmHWM`,每侧每档一个进程 |

- P95:Rust 0.39 ms / TS 2.33 ms。
- 吞吐:6.7×–11.9×。
- 内存:9.3×–33.8×。

吞吐与内存的三个值依次对应 T1(28 文件,9,270 B)、T2(1,352 文件,417,448 B)、T3(2,001 文件,10,538,731 B)。倍差方向:P95 与吞吐为 Rust/TS,内存为 TS/Rust。

## 2. 数据出处

| 数字 | 提交 | 正本 | 说明 |
|---|---|---|---|
| Definition P95 0.39 / 2.33 ms | `74a4e5b` | [docs/kode2/phase2-slice-a-rerun.txt](../kode2/phase2-slice-a-rerun.txt) | `S2.definitionDefProp`;Rust 100 样本,TS 100 样本 |
| 解析吞吐 6.7×–11.9× | `d44fbcb` | [docs/perf/2026-parser-head2head.md](2026-parser-head2head.md)、[run.txt](2026-parser-head2head-run.txt) | 两侧对齐到 `parse+extract` 口径 |
| 解析峰值内存 9.3×–33.8× | `d44fbcb` | 同上 | `VmHWM` 与 `/usr/bin/time -v` Max RSS 交叉核对 |

`d44fbcb` 的产品代码零改动,只新增 bench 驱动与语料生成器;TS 侧使用唯一化语料,避免 `parseDefDocument` 的全文缓存把命中伪装成解析。

## 3. 口径

- **Definition P95**:真实 Provider 入口的 `provideDefinition`,同 URI 同 position,30k 资产集,5 轮×20 热态样本;Rust 侧经 shadow 通道。
- **解析吞吐**:Rust `parse_def`/`parse_entities`/`parse_types`/`parse_alias` 对 TS `parseDefDocument` + 语义提取;全量逐文件解析一轮,T1/T2/T3 各做 2 次进程级运行、每次 18 个测量轮。
- **解析峰值内存**:进程 `VmHWM`,与 `/usr/bin/time -v` 的 Max RSS 交叉核对;TS 值包含 Node 运行时地板 42.5 MiB。
- **金丝雀**:每轮检查 `SURFACE props/methods` 两侧同值,增量口径断言首扫 `rebuilds == 文件数`、二扫 `rebuilds == 0` 且 `cache_hits == 文件数`。

## 4. 未覆盖

1. P95 数字来自 definition 面;parser 吞吐与内存不由此推断 hover/completion 的端到端 P95。
2. parser 基准不含 transport、extension host、索引调度与磁盘 IO。
3. 冷盘、Windows、macOS、Remote SSH/WSL/Containers 未测。
4. 置信区间未算;T1 的 Rust 绝对值为亚毫秒,±11.7% 轮间漂移只作量级参考。

## 5. 复现

- Definition P95:`npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts`
- Parser 三档语料与两侧驱动:见 [docs/perf/2026-parser-head2head.md §7](2026-parser-head2head.md)。
- 机器与偏差口径:见 [docs/perf/hardware.md](hardware.md)。
