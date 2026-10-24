# ADR-002 — Rust 核心替换以基准驱动,逐模块双轨切换

- 状态:已接受(2026-10-23,PR-003)
- 关联:书 BUILD-002、PH0-GATE、ARCH-012(无数据不吹 Rust 快)、PH2-03、PR-010..012;上游证据:docs/perf/2026-baseline.md、docs/perf/baseline.md、docs/perf/2026-final-report.md、docs/kode2/ph0-gate.md

## 术语

| 术语 | 本 ADR 中的含义 | 术语表 |
|---|---|---|
| 基准驱动 | 每个模块进入 Rust 替换前,先有 TS 基线、Rust 同口径复测与 parity 证据。 | [2.3](../glossary.md#terms-performance) |
| 双轨 | TS 与 Rust 接收同参请求并比较正确性/延迟;TS 为现行服务真相。 | [2.1](../glossary.md#terms-architecture) |
| 切流 | 把服务路径从 TS 切到 Rust;必须先通过 PR-012 的切流前置条件清单。 | [2.1](../glossary.md#terms-architecture) |
| 影子模式 | Rust 只接收镜像请求并记录差异,不发布结果。 | [2.1](../glossary.md#terms-architecture) |
| 对拍 / parity | 同一输入下逐字段比较 TS 与 Rust 的可观察输出。 | [2.2](../glossary.md#terms-parser) |
| ARCH-012 | 没有同机同口径实测数据不得声称 Rust 更快。 | [2.3](../glossary.md#terms-performance) |

## 背景

现有 TS 实现已经过 PR1/PR7 两轮优化并有同机同 fixture 的基准正本。
"用 Rust 重写解析/查询核心"是高成本决策,不能凭主观感觉(书执行协议第 5 条)。

## 决策

1. **不整体重写**。Rust Core 按模块(§3 目标树 crate 边界)逐个引入;
2. 每个候选模块进入 Rust 替换前,必须有:
   - 同机同 fixture 的 TS 基线数字(正本:docs/perf/baseline.md 与 docs/perf/);
   - Rust 实现的同口径复测(P95/中位/内存,release build,禁用 debug 数据 — SYNTAX-006);
   - 正确性 parity:PH0-02 golden fixture(`tests/fixtures/parity/golden.json`)对拍通过后才切流;
3. 切换采用**双轨模式**(PR-010 起):请求按比例分流 TS↔Rust,差异记录 latency 与 correctness,可一键回退 TS;
4. 双轨对拍基准定义是 PR-012 门禁输入;基准未过关(含尾延迟)不扩大迁移面(PH2-GATE)。

## 当前切片的含义

PR-003 只落 workspace + stdio LSP 骨架 + transport,**不含任何解析/语义逻辑**,
因此本 ADR 不声称任何性能优势;骨架的性能基线(启动耗时、握手 RTT)随 PR-003
e2e 首次可测,后续模块在同一口径上累加。

## 后果

- 正面:每一步替换都有回退路径与量化证据;避免大爆炸重构(书 §17 前言)。
- 负面/约束:双轨期间维护两套实现,parity fixture 是长期资产,必须随行为变更重录(`KODE_PARITY_UPDATE=1` + sha256 确认)。
- 否决的替代:"直接重写再对齐"(无法回退、无证据)、"永远不换 Rust"(TS 单线程天花板已在 final-report 场景中出现,机会成本随工程规模上升)。
