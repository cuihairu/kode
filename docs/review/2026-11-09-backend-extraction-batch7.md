# TS 后端独立目录抽取 · 批次 7(hotReload 纯逻辑族)2026-11-09

续批次 1-6,同式推进。

## 范围(22 件,`git mv` 至 src/backend/)

hotReloadAppliedCheck / hotReloadBatchSummary / hotReloadBatchSummaryCommand /
hotReloadChannelConfig / hotReloadChannelSend / hotReloadDefaultHotfix /
hotReloadDefGate / hotReloadDefHash / hotReloadDefStructure /
hotReloadDelivery / hotReloadFileState / hotReloadFileStateFilter /
hotReloadFileVersion / hotReloadNotice / hotReloadReceipt / hotReloadRetry /
hotReloadRetryCommand / hotReloadRevisionEvidence /
hotReloadRevisionEvidenceCommand / hotReloadTargetState / hotReloadTempEdit /
hotReloadTransport

选族依据:hotReload 27 件中零 `from 'vscode'` 的 22 件纯逻辑(共 ~5.1k 行)。
**留 src/ 的 hotReload 面**:hotReload(编排器)、hotReloadStatus /
hotReloadToggle / hotReloadFileStateLens / hotReloadFileDecorations(UI 五件)。

## 改动面

- import 重基 147 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- type-only 编译期边 2 处可接受(运行时擦除,零 vscode 运行时依赖):
  hotReloadChannelSend→`../hotReload`(HotReloadTimerDeps)、
  hotReloadTempEdit→`../hotReload`(ConfigReader)、
  hotReloadChannelConfig→`../projectProfiles`(ProjectProfile)。
- 值依赖出向 src 留守件经规则 (a) 改 `../`:httpRequests /
  httpRequestService / variableSubstitution / nlsRuntime / sharedFileEvents /
  telnetClient;族内互引落位后天然兄弟解析。
- 反向面核验:backend 既有 62 件零 hotReload 引用。
- 活文档路径对账 72 处:features.md en+zh 各 36;余 3 处 `src/hotReload*.ts`
  为留守 UI 五件引用,如实保留。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- **全量套件抓获 1 真问题 + 1 既有抖动**:hotReloadDefGateWiring 源锁测试以
  `join(__dirname,'..','src',name)` 变量拼路径读 hotReloadDefGate.ts——字面量
  `src/<name>.ts` 锚预检抓不到该类(批次 5 同类=静态字面量),修为显式
  `src/backend` 段;同型扫查全 tests 无其余搬移件动态读(余下唯一
  hotReloadStatus.ts 为留守件,如实保留)。hoverDeadlineContext 时间预算
  满载抖动,隔离复跑 2 文件 21/21 绿。修后全量重跑见提交前记录。
- 全量 vitest 修后重跑 693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;
  docs:build RC=0。
- **提交 6c63aae8**(2026-11-09 推 main):80 文件 227+/180-,并发会话面零牵连
  (8 排除件 diff 核验零批次 7 内容)。
