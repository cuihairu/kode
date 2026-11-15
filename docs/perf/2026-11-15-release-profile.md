# RUST-063 release profile 以测量为准(2026-11-15)

A/B 实测:默认 release vs `lto="thin" + codegen-units=1 + strip="symbols"`,
同一 HEAD、同一负载(spawn+handshake / 100 次定义往返 / CLI schema validate ×20 /
二进制体积),原始数据 `2026-11-15-release-profile-run.txt`(L 档 14 CPU,
PERF-015 纪律:数字只指路,跨机禁比)。

## 结果

| 面 | A 默认 | B 调优 | 判读 |
|---|---|---|---|
| spawn+handshake | 3.27ms | 3.00–4.64ms(4 遍) | 单发测量,重叠带内,无可测回退 |
| 定义往返 p50 | 1.461ms | 1.469/1.484/1.521/1.576ms | 差 ≤4%,噪声带内 |
| CLI schema p50 | 4.3ms | 4.0–5.2ms | 同带(Run 间自带 ±1ms 抖动) |
| kode-server 体积 | 7.50MB | 5.32MB | **−29%**(strip 主导) |
| kode-kbengine 体积 | 1.61MB | 1.10MB | **−32%** |

## 裁定

- **采纳** `[profile.release] lto="thin" + codegen-units=1 + strip="symbols"`
  (workspace Cargo.toml):墙钟所有测量面无可测回退,体积 −29%/−32%。
- **拒绝**(不盲目最大化):fat LTO、opt-level=z/max、panic=abort——无测量
  动机,徒增编译时长与排查成本;codegen-units=1 的编译时长增加(~22s→101s
  全量重编)在 CI 缓存(RUST-061)下可接受。
- 行为不变:新 profile 下 lib 测试 kode-server 430 / kode-kbengine 35 /
  kode-python 189 全绿;平台包仍走同一 workspace profile(六平台 CI 逐平台
  cargo test 继续覆盖)。
- 回退面:删除 Cargo.toml `[profile.release]` 节即回默认 profile(独立小节,
  冲突面小)。
