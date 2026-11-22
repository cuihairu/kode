# Hot Reload 安全与功能完成矩阵(HR-QA-018 / RUST-430)

> 签收矩阵(2026-11-22 首版)。本文件与 `tests/hotReloadAcceptanceMatrix.test.ts` 守门测试同生共死:
> 文档中每个「已签收」单元引用的证据必须真实存在于仓库(测试 ② 直证),每个「被拦」单元必须
> 在测试内 `BLOCKED_CELLS` 同步存在(测试 ③ 直证)。改本文件不同步改测试 → 门禁红。
> 四轴定义与代码真实枚举锁步(测试 ①):凡代码支持的集合变化,必须同步更新本文件与测试。

## 四轴

| 轴 | 取值(与代码锁步) | 依据 |
| --- | --- | --- |
| target | 部署 profile(profile.id → targetId;零档时自动创建默认档) | `src/backend/hotReloadChannelConfig.ts`(ensure 默认档兜底,用户令 2026-11-10) |
| engine profile | 部署 profile 档(默认档 / 用户新建档 / 切换) | 同上 |
| 文件类型 | `.py`(身份解析) / `.def`(结构闸) / 其他(解析器拒) | `src/backend/hotReloadModuleIdentity.ts`(`language:'python'`)、`src/backend/hotReloadDefGate.ts` |
| 触发方式 | `onSave`(默认) / `onDiskChange` / 手动命令 | `src/hotReload.ts`(`HOT_RELOAD_DEFAULT_TRIGGER_MODE='onSave'`、`HotReloadTriggerMode`) |

## 已签收单元(证据 = 测试文件 + it 名)

| id | 单元(轴组合) | 证据 | 备注 |
| --- | --- | --- | --- |
| C1 | `.py` × onSave × 单 target × 默认档 | `tests/hotReloadModuleIdentity.test.ts`(HR-MOD-006 多根候选/零命中/ambiguous) | 身份解析:全名/短名/根归属/语言;发送面由 channel wiring 覆盖 |
| C2 | `.py` × onDiskChange × 单 target | `tests/hotReloadDiskWatchWiring.test.ts`(HR-WATCH-001/005 切建/切拆) | onDiskChange 显式选中才建磁盘面 |
| C3 | `.py` × 手动 × Watch 关 | `tests/hotReloadFallbackCycle.test.ts`(关 Watch + 手动回退) | 关监视下手动触发仍写同一台账(RUST-429) |
| C4 | `.def` × 结构变化 × 任意触发 | `tests/hotReloadDefGateWiring.test.ts`(结构性 def 变更拦下) | 拦下不发,提示需重启;F1 基线不误滚 |
| C5 | `.def` × 非结构变化(仅注释) | `tests/hotReloadDefGateWiring.test.ts`(非结构 def 变更照常发送) | 重启确认建立基线后放行 |
| C6 | 非 `.py` × 任意 | `tests/hotReloadModuleIdentity.test.ts`(not-python 诊断码) | 解析器拒,诊断码透传 |
| C7 | 多 target(多 profile) | `tests/hotReloadChannelConfig.test.ts`(多 profile 预设流) | target=profile.id;多档并存不互混 |
| C8 | 安全 × 密钥不泄出 | `tests/hotReloadSecretLeakGuard.test.ts`(history DTO 无密钥形状字段) | header/token 只允许在出站传输 DTO(RUST-421) |
| C10 | 插件 × 0/5/20 × 崩溃隔离 | `tests/hotReloadPluginLoad.test.ts`(0/5/20 注册/应答序/清册 + canSend 崩溃隔离,收编后以确定性成本模型为准:canSend 调用数=首应答位置) | load 成本有界(应答短路/全不应答线性,确定性成本模型非墙钟);崩溃插件隔离跳过并如实上报(onProviderError),不打断核心解析(RUST-426) |
| C11 | Watch/HTTP × 长稳 soak | `tests/hotReloadSoak.test.ts`(watcher 200 次 rebuild 泄漏界/台账 500 文件逐键单条封顶/串行 300 次连接复用/重试线性) | 四门不变式(确定性不变量,非墙钟):无 watcher 泄漏(创建数=销毁数+存活,存活有界,dispose 归零)、状态增长无界(台账逐键单条覆盖+历史库环形淘汰)、无连接泄漏(connection 计数恒 1,keepAlive 复用)、无重试风暴(只重发仍失败者);24h 真墙钟不在门禁口径,与 `hotReloadReliabilityGate` 的 10k 缩放 soak 同口径(RUST-428) |

## 被拦单元(依赖未完成子任务,暂不可签收)

| id | 单元 | 阻断任务 | 原因 |
| --- | --- | --- | --- |
| C9 | `.py` × profile 切换 × UI 完整名 | RUST-424 | HTTP 正确传短名且 UI 永远完整名的装配面(接线批 HR-PR-02/03 收官后验) |
| C12 | 跨平台真机 × 路径/localhost | RUST-423 | 真机实测未做;纯核路径矩阵已落(376ec986),localhost 指向已钉 |

## 红线声明

- 本矩阵只记录「代码可证」的事实,凡证据不足的单元一律列被拦,不凭「应该能行」签收(与
  `docs/hotreload/current-implementation.md` 的 `unknown` 口径一致)。
- 任何单元从被拦转签收,必须同时更新:本文件 + 测试内 `BLOCKED_CELLS`/`SIGNED_CELLS` +
  对应子任务 todo 行;门禁红即提醒不同步。
