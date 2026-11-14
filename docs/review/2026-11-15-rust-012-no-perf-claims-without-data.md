# RUST-012 审计:无实验数据不得声称 Rust 性能快 N 倍;禁止靠删功能换性能

日期:2026-11-15。审计对象:todo.md RUST-012。方法:用户面文档全量声称扫描(README en/zh、features en/zh、configuration、commands)+ src/crates 注释扫描+性能数字出处盘点+删功能史核对。**结论:两判据 PASS;顺带修正一处与 RUST-012 同族的文档失真(README 双语 backend 默认值仍写 ts,实际 2026-11-08 起默认 rust)。**

## 1. 判据①无实验数据不得声称 Rust 快 N 倍:PASS

- 用户面文档声称扫描:**零命中**。README en/zh、docs/guide/features.md、docs/zh/guide/features.md、configuration.md、commands.md 中无任何「快 N 倍/faster/x×」式性能声称;唯一「倍」字命中是 consoleLogTail 配置表的 `702 → 65501 长连推流`(事件号/消息数事实,非性能倍数,如实描述不改)。
- src/crates 注释扫描:无 Rust/核心/backend 速度声称(命中均为「快捷命令/fast path/快进」等无关词)。
- 性能数字只活在测量文档,且全部带实验数据与口径:docs/perf/2026-11-04-v02-baseline.md(provider 级 bench,方法论+分位数+内存曲线)、2026-11-04-process-topology-diagnostics.md(合成 workspace 实测)、RUST-007 perf gate(断言回退上界,不声称优越性)。诚实登记在案:big-py definitionDef 0 hit=预期未命中如实注,不粉饰。
- 口径立此存照:任何未来的性能声称必须指向 docs/perf/ 下的实测文档与当轮环境,禁止无出处倍数。

## 2. 判据②禁止靠删功能换性能:PASS

- KODE-PERF-001..007 全部是保语义优化(LRU 键控/行起始表/快照释放/收集策略/代际守卫),每项带 parity/行为回归测试,无功能被移除。
- TS 推导引擎冻结为 kill-switch 兜底而非删除(精确性车道纪律「TS 引擎一行不动」);TS 轨道=完整历史特性面(RUST-009 轴1 已审);功能数只增不减(G2 审计 2026-11-14:配置数 152→154 对账)。
- features.md 无任何「移除以换取性能」条目;big-py 面的 0-hit 是解析域登记不是功能裁撤。

## 3. 同族修正(本批唯一生产面改动)

- README.md:207 与 README.zh.md:207 双语 backend 说明仍写「`ts` = default」,与 kodeCoreGate.ts `DEFAULT_CORE_GATE_CONFIG.backend = 'rust'`(2026-11-08 用户令「直接切 rust」;docs/guide/configuration.md:499 早已正确)失真。已改为:rust=默认(缺二进制/调用失败回落 TypeScript),ts=kill-switch,shadow=比对。docs-reconcile 全局令对账。

## 4. 门禁

纯审计+两行 README 文案;无代码触面;configuration.md 既有正确口径未动。
