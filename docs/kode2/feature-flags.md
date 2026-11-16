# Feature Flag 台账(QA-016 / RUST-245)

大型功能 flag = 具备「旧实现并存 + 移除闸」性质的开关。守卫测试
`tests/featureFlagLedger.test.ts` 锁台账↔package.json 配置面一致、且台账里
每个 flag 在 tests/ 有开关测试,漂移即红。

## 大型功能 flag

| flag | 值 | 保护的旧实现 | 移除条件 | 当前状态 |
| --- | --- | --- | --- | --- |
| `kbengine.core.backend` | `ts` \| `rust` \| `shadow`,默认 `rust`;非法值/undefined/空串一律回落 `ts` | TS 语义分析引擎全族:`kodeCoreGate` 失败/缺二进制兜底轨道 + TS 推导引擎冻结面(pythonReturnTypeInference/selfFlow TS 侧,RUST-PRECISION 战役定案「TS 冻结为杀开关兜底」) | Rust 侧 parity 持续绿(perf 门 servingGate:语义五面钉+P99/RSS/CPU 界)+ph0-gate 门 3 回退演练成熟;移除属破坏性变更,须用户明确拍板,agent 不得自行判断「该删了」 | `rust`=服务轨道(2026-11-08 用户令「直接切到 rust」);`ts`=kill-switch 在役;`shadow`=对拍观测(镜像对比只记差异日志) |

### 移除闸机械面

- kill-switch 永远收得回来:`resolveBackendMode` 仅 `rust`/`shadow` 字面量生效,
  其余一律回落 `ts`(安全侧是 TS 真相;`tests/kodeCoreGate.test.ts` 钉)。
- rust 服务轨道失败/缺 `serverPath` 回落 TS 不误伤,留一次 notice 存照。
- shadow 对拍任何 Rust 侧失败只记差异日志,`compare()` 恒返回 TS 结果原样。
- 「移除旧实现」自动闸现状:ph0-gate 门 3 🟡——kill-switch/shadow/差异日志
  已落,provider 逐面接入 compare 后的首次实战回退演练未执行;演练过前不得删
  TS 兜底。台账本行状态变更随对应的勾行 commit 更新。

## 其余功能开关

`package.json` 其余 `kbengine.*` bool/string 开关(qa-execution-plan 盘点约
44 项)是单实现功能开关,不属「旧实现待移除」性质,无移除闸条目;其现值由
复现配置摘要导出(IDE-REL-007)自动枚举,不在此逐条重复。
