# SRC-001 抽象层分析：`src/extension.ts` 拆分

> 方法论（用户令 2026-11-07）：先阅读源码，把抽象先分析出来，根据抽象的层去拆分；
> 把抽象层中的概念整理到对应术语表与架构目录解说中，并说明理由为什么要这么拆分。
> 本文件是 SRC-001（拆分 `src/extension.ts`，P1，价值高）的**抽象层分析产出**，
> 不是机械剪切说明。分析基：当前 `src/extension.ts` 6798 行（`activate()` 505..6789）。

## 1. 现状：为什么拆不动

`src/extension.ts` 的 6798 行里，**几乎全部逻辑在 `activate(context)` 一个函数内**
（505..6789 ≈ 6284 行）。`activate` 是一段超长**命令式装配脚本**，没有模块边界：

- 顶层只有 4 个声明：`setProcessTopologySchedulerForTests`(496)、
  `getProcessTopologySchedulerForTests`(501)、`activate`(505)、`deactivate`(6789)。
- 所有 provider/manager/scheduler/command 都在 activate 闭包内**顺序创建**，靠
  `const` 闭包变量互相引用（`entityMappingManager` 被十几个后续 provider 消费、
  `indexScheduler` 被 `pythonClassIndex`/`entityMappingManager` 消费等）。
- 生命周期全部 `context.subscriptions.push(...)`，**销毁所有权隐含在激活顺序里**。

**结论**：不能"按行剪切"——大量状态是 activate 闭包局部变量，剪切会断依赖。
必须先梳理抽象层与每层的**依赖注入面**，再按层提取模块。

## 2. 提取的抽象层（读源码所得）

按 activate 内的装配段与职责，提取出 11 个抽象层 + 1 个组合根：

| 层 | 行区间(激活) | 抽象内容 | 关键实例 |
|---|---|---|---|
| L0 组合根/基础设施 | 505..728 | 配置读取、内容 provider、core 门、日志开关 | `kodeCoreGate`、`engineApiCatalog`、`databaseSchemaProvider` |
| L1 共享核心服务 | 729..1000 | 索引调度、实体映射、数据字典 | `indexScheduler`、`entityMappingManager`、`dataDictIndex` |
| L2 语言服务层 | 925..2285 | 补全/签名/悬停/定义/跳转/代码镜头/inlay/代码动作 | 20+ 个 `*Provider` |
| L3 诊断调度层 | 1667..2087 | 7 个 `DiagnosticScheduler`（def 方法一致性/用户类型契约/属性方向/只读写/角色误用/销毁后访问/进程拓扑） | 7 个 `*Scheduler` |
| L4 服务器/调试层 | 2878..3246 | server 管理、telnet、玩家数据、远程服务器、调试会话/目标 | `serverManager`、`telnetService`、`DebugSessionRegistry` |
| L5 视图层 | 2787..4326 及 4638..4971 | 侧栏树视图 provider（实体/服务/telnet/玩家/远程/调试目标/git 历史/范围历史/最终配置/快捷动作/组件状态） | 11 个 `*TreeProvider` |
| L6 热重载层 | 5010..5595 | 热重载状态机/版本/通道/文件装饰/镜头 | `HotReload*` 系列 |
| L7 生成器/项目层 | 5738..5956 | 代码生成器、项目向导、SDK 生成、桩导出 | `KBEngineCodeGenerator`、`clientSdkGenerator` |
| L8 监控/面板层 | 4660..4920 | 监控面板、运行查询、依赖 WebView、实体流 | `MonitoringWebView`、`EntityDependencyWebView`、`EntityFlowWebView` |
| L9 console 层 | 4589..4655 | machined 发现 hub、日志 tail、组件状态面板（KB-GC-001） | `ConsoleHub`、`ConsoleLogTailController`、`ComponentStatusTreeProvider` |
| L10 工具命令层 | 5887..6466 | 项目医生/符号引用/发现报告/身份/复现/服务状态/ruff | 10+ 个独立命令 |
| L11 释放逻辑 | 6789 | `deactivate` | — |（2026-11-08 结论：不抽文件——释放收口闭合于各层返回的共享句柄，组合根为唯一所有权面，`deactivate` 与 activate 内 dispose 块随组合根保留，SRC-001 全 11 层勾账完成） |

## 3. 按抽象层拆分的方案

**组合根保留 `activate()` 作为编排入口**（激活顺序 + 依赖装配 + 销毁所有权），
每个抽象层提取为独立模块，**显式传入依赖、返回 `Disposable[]`**：

```
src/extension.ts            # 组合根:激活顺序编排(不删,瘦身)
src/activate/
  infrastructure.ts         # L0:配置读取、内容 provider、core 门、日志开关
  coreServices.ts           # L1:indexScheduler/entityMappingManager/dataDictIndex
  languageServices.ts       # L2:20+ 语言 provider 装配
  diagnostics.ts            # L3:7 个 DiagnosticScheduler 装配与接线
  serverControls.ts         # L4:server/telnet/debug 装配
  views.ts                  # L5:11 个树视图 provider 装配
  hotReload.ts              # L6:热重载装配
  generators.ts             # L7:生成器/项目/SDK 命令
  monitoring.ts             # L8:监控/WebView 面板
  console.ts                # L9:KB-GC-001 console hub/tail/面板
  utilityCommands.ts        # L10:工具命令
```

每个模块形态：

```ts
// 每层一个 deps 类型:显式声明它消费哪些共享实例(依赖注入面)
export interface LanguageServicesDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
  dataDictIndex: GlobalDataDictIndex;
  indexScheduler: IndexScheduler;
}
// 返回本层注册的全部 Disposable(销毁所有权随组合根统一 push)
export function activateLanguageServices(deps: LanguageServicesDeps): vscode.Disposable[];
```

**为什么这样拆（理由）**：
1. **依赖注入面显式化**——现在 provider 靠闭包变量隐式捕获 `entityMappingManager`，
   无法在模块间传；提取成 `deps` 类型后，每个模块的依赖一目了然，缺失在编译期报错。
2. **激活顺序保留在组合根**——L2 语言服务依赖 L1 核心服务先建、L6 热重载依赖
   `indexScheduler` 等，顺序在 `activate()` 里仍是显式调用序，不隐式乱序。
3. **销毁所有权单一**——每层返回 `Disposable[]`，组合根统一 `context.subscriptions.push`，
   不出现"谁注册谁销毁"的多头所有权。
4. **测试可注入**——模块接受 `deps`，测试可用替身注入，不再整树激活。
5. **渐进迁移**——一次抽一层、每层自测绿再抽下一层，不一次性机械搬迁
   （禁 SRC-011 所述"一次性机械搬迁"）。

## 4. 概念 → 术语表

需把下列抽象层概念登记进 `docs/kode2/glossary.md`（§2.1 架构与运行）：

| 术语 | 英文/别名 | 定义 |
|---|---|---|
| 组合根 | composition root | `activate()` 中负责按序创建共享实例、编排各层激活器、统一登记销毁的入口层；激活顺序与依赖装配的唯一所有者。 |
| 激活器 | layer activator | 每个抽象层一个 `activateXxx(deps): Disposable[]` 函数；显式接收本层依赖、返回本层注册的销毁句柄。 |
| 依赖注入面 | layer deps | 每层激活器的入参类型，显式声明该层消费的共享实例（如 `entityMappingManager`）；替代闭包变量隐式捕获。 |
| 共享实例 | shared instance | 跨层复用的核心对象（`indexScheduler`/`entityMappingManager`/`dataDictIndex`/`serverManager`）；由组合根创建并注入。 |
| 销毁所有权 | dispose ownership | 每个 Disposable 的销毁责任归属；拆分层后统一由组合根 `context.subscriptions` 持有，避免多头释放。 |

## 5. 架构目录解说

写入 `docs/architecture/current-state.md` 的 state refresh：SRC-001 完成后，
`src/extension.ts` 从 6798 行单体缩为**组合根编排层**，11 个抽象层各归
`src/activate/*` 模块；激活顺序与依赖装配留在组合根，语言服务/诊断/服务器/
视图/热重载/生成器/监控/console/工具命令各自独立成模块。

## 6. 执行顺序与验收

1. 先抽 **L0 基础设施**（无内部依赖，最安全）→ 自测绿。
2. 再抽 **L1 核心服务** → L2 语言服务 → L3 诊断 → 逐层推进，每层绿。
3. 每抽一层：`tsc`/`eslint`/`vitest` 全绿 + 对账 `docs/perf/2026-baseline.md` §7 锚点
   （extension.ts 行号随抽取位移，须逐次真位重探）。
4. 最后 deactivate 释放逻辑（L11）随组合根。

> 关联：SRC-002..005（entityMapping/globalDataIndex/codeGenerator/definitionWorkspace）
> 与 SRC-007..008（Rust wire_codec/def_md5）同方法——先读源码提抽象层、按层拆分、
> 概念进术语表、说明理由；SRC-013（生成物 apiDocs.ts）不拆，SRC-014（Rust 16 crate）
> 无动作。
