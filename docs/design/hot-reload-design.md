# kode 热更新能力设计（用户令 2026-11-01 · 评审稿）

> 状态：**评审稿**。本文档先于代码，评审通过后再动实现；实现必须逐条
> 对齐本文措辞，复用本仓既有词汇（`HotReloadDeliveryOutcome` 等），
> 不新造术语。未实现的面在文中如实标注「未实现」，绝不写成已实现。
>
> 任务来源：`~/.hermes/cache/scratch/tasks/kode-hotreload-design.md`
> （用户令 2026-11-01，优先级 P1）。三个条目落 `todo.md`：
> IDE-HOT-100（状态机）、IDE-HOT-101（通道抽象）、IDE-HOT-102（配置与审计）。

## 1. 需求

1. **文件热更状态可视化**：每个脚本文件要有状态标识——未修改 / 已修改未重载 /
   已发送待回执 / 已重载生效 / 重载失败。
2. **重载通道双方案**：KBEngine 官方方案 + 第三方方案（第三方通常要自己配置，
   如 HTTP 请求触发）。

## 2. 既有地基（现状核对，实现前必须复核）

以下均为当前 `src/` 已落地并被既有测试钉住的面；本设计在其上叠加，不另立
第二套身份。

| 面 | 位置 | 语义 |
|---|---|---|
| 投递结果台账 | `src/hotReloadTargetState.ts` | 四态 `sent-unverified \| accepted \| applied \| failed`；键 = `rootId × targetId × file`（rootId=文件归属扫描根，targetId=服务实例）；`attempt`=发送代际（IDE-AUD-005）；`sentDigest`=发送时点冻结内容 sha256（IDE-AUD-006） |
| accepted 回执协议 | `src/hotReloadReceipt.ts` | JSON `{"status":"accepted","file":"<逐字回显>"}`（可选 targetId 一致） |
| applied 回执协议 | `src/hotReloadAppliedCheck.ts` | JSON `{"status":"applied","file":"<逐字回显>","digest":"<sha256>"}`；digest 与发送时点冻结基准比对；`settleAppliedStatus` 超时保持未确认 |
| HTTP 投递分类 | `src/hotReloadDelivery.ts` | 只认传输事实：2xx→sent-unverified，非 2xx/传输失败→failed；回包 body 一律不作为应用证据 |
| 状态栏反馈 | `src/hotReloadStatus.ts` | `watch-off \| ready \| sending \| sent-unverified \| failed`；结构性 def 变更回落 ready（IDE-REV-024） |
| def 结构闸 | `src/hotReload.ts:442-484` | 结构性 def 变更整批不发普通 reload，`setRestartRequired`（IDE-HOT-005 / IDE-REV-024） |
| HTTP quick action | `src/quickActions.ts` / `src/httpRequests.ts` | `@http:` 动作 → `runHttpRequest`；`HttpRequestEntry{url,method,headers,body}` 模板含 `${module}/${filename}` 等占位；`onHttpResponse` 响应面 |
| KBEngine 官方重载面 | 引擎源码实勘（AUD-007） | Python 模块函数 `KBEngine.reloadScript(fullReload)`；**不是 HTTP 接口、无回执**；经控制台/管理接口触达 baseapp/cellapp |
| 控制台访问 | `src/telnetClient.ts` | `KBEngineTelnetClient`（telnet 控制台，命令白名单） |
| 部署配置 | `src/projectProfiles.ts` | `ProjectProfile{id,displayName,assetsRoot,engineRoot,interpreterPath}`——部署级配置载体 |

**既有台账 vs 本设计的文件状态机，分工明确**：台账（`HotReloadTargetStateStore`）
记录**每次投递的结果**（按 rootId×targetId×file 最新一条）；新状态机在台账
之上按**文件 × 目标**给出 `CLEAN/DIRTY/SENT/APPLIED/FAILED` 生命周期态——台账
是事实源，状态机是派生视图。二者键同形（rootId×targetId×file），不另立身份。

## 3. IDE-HOT-100 [P1] 脚本文件热更状态机

### 3.1 状态定义

每个 `(rootId, targetId, file)` 一份状态。状态依据 = **文件内容 hash + 既有
回执协议**（IDE-HOT-002/003/004 的 accepted/applied），**不靠文件 mtime**。

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `CLEAN` | 未修改：内容与上次成功应用的基线一致 | 内容 sha256 == 基线 hash（基线=最近一次 APPLIED 时的内容 hash，或文件在会话基线册内首次出现且 hash 相等） |
| `DIRTY` | 已修改未重载：内容偏离基线 | 内容 sha256 != 基线 hash（文件编辑后未发） |
| `SENT` | 已发送待回执 | 该文件已入本批发送集，尚未收到 accepted/applied/failed 结算 |
| `APPLIED` | 已生效：基线更新 | applied 回执核验通过（digest 与发送时点冻结基准一致）→ 基线 hash 更新为所发内容 hash |
| `FAILED` | 重载失败 | 投递失败（failed）或回执超时未确认（unconfirmed-timeout） |

### 3.2 状态转移

```
CLEAN ──(内容 hash 偏离基线)──▶ DIRTY
DIRTY ──(入发送集)────────────▶ SENT
SENT ──(applied 回执+digest 一致)──▶ APPLIED (基线=所发内容 hash)
SENT ──(accepted 回执)────────▶ SENT (保持待回执,注解 accepted;仍等 applied)
SENT ──(投递失败/回执超时)──▶ FAILED (带原因;不冒充 applied)
APPLIED ──(文件再改)────────▶ DIRTY (新一次偏离)
FAILED ──(文件改/用户重试)──▶ DIRTY (可再发)
```

约束：
- **mtime 不参与判定**——只有内容 hash 偏离基线才标 DIRTY；改权限/touch
  不改内容不标脏。
- **SENT 不因 accepted 提前转 APPLIED**——accepted 只注解（HOT-003 口径：
  「应用仍需核验」），仍等 applied 或超时。
- **FAILED 不冒充 applied**——回执超时保持未确认语义（`unconfirmed-timeout`），
  如实标 FAILED 但 detail 注明「未确认/超时」，不称已生效。
- **重试**：FAILED 再发走既有重试面（IDE-HOT-007 / IDE-REV-026），重发即
  新 SENT（新代际 attempt 推进）。
- **结构性 def 变更不进本状态机**——走 IDE-HOT-005 的 `restartRequired` 面
  （整批不发），本状态机该批文件标 `RESTART_REQUIRED`（见 3.3 补充态）。

### 3.3 补充态：结构性 def

IDE-HOT-005 的 `setRestartRequired` 把结构性 def 变更拦在发送前。本状态机
给这批文件一个可呈现的补充态：

| 补充态 | 含义 |
|---|---|
| `RESTART_REQUIRED` | 结构性 def 变更，普通 reload 被拦；需重启进程后再应用 |

`RESTART_REQUIRED` 是 `FAILED` 的邻居但语义不同（不是失败，是保守拦下），
展示上单独着色，不与 FAILED 混用。

### 3.4 IDE 呈现

- **文件树角标**（FileDecorationProvider）：按状态给文件名角标/颜色——
  DIRTY=橙、SENT=蓝、APPLIED=绿、FAILED=红、RESTART_REQUIRED=紫；CLEAN 无角标。
- **CodeLens 状态点**：在文件顶部（或首个实体定义上方）挂状态点 + 当前
  基线 hash 前 12 位 + 最近一次投递 detail。
- **状态过滤**：命令/视图工具栏按状态过滤——「看哪些改了还没重载」
  （= DIRTY ∪ SENT 的过滤视图）。

### 3.5 验收（IDE-HOT-100）

1. 内容 hash 偏离基线 → DIRTY；改回原内容（hash 回基线）→ CLEAN（mtime 变化无关）。
2. 入发送集 → SENT；applied 回执 + digest 一致 → APPLIED 且基线更新为所发 hash。
3. accepted 回执 → 保持 SENT（注解 accepted），不提前转 APPLIED。
4. 投递失败 / 回执超时 → FAILED，detail 带原因，不冒充 applied。
5. 结构性 def 变更 → RESTART_REQUIRED，不进普通 reload。
6. 重试 → 新 SENT（attempt 推进），成功后再 APPLIED。
7. 按状态过滤只列出 DIRTY/SENT（「改了还没重载」）。

## 4. IDE-HOT-101 [P1] 重载通道抽象（transport 接口）

### 4.1 接口

```ts
interface ReloadTransport {
  /** 通道标识（配置/审计用）：'kbengine-official' | 'http' */
  readonly kind: 'kbengine-official' | 'http';
  /** 连通性测试（配置面板按钮用） */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /**
   * 发送一组文件重载。返回回执流——每次回执（accepted/applied/failed）
   * 逐条推送；HTTP 实现=既有 onHttpResponse 面，官方实现=控制台输出解析。
   */
  send(
    target: { rootId: string; targetId: string },
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void
  ): Promise<ReloadSendSummary>;
}
```

`ReloadReceipt` 复用既有回执形状（`{status:'accepted'|'applied',file,digest?}`
或 `{status:'failed',file,reason}`），不新造协议。

### 4.2 内置实现 A：KBEngine 官方方案

- 引擎官方重载面 = Python `KBEngine.reloadScript(fullReload)`（AUD-007 实勘，
  baseapp/cellapp 均注册），**无 HTTP 回执**。
- 触达路径 = 经既有 `KBEngineTelnetClient`（控制台）对 baseapp/cellapp 执行
  `reloadScript(fullReload)`（或等价控制台命令）；fullReload=true 全量、
  false 增量——按文件集是否涉 def 选。
- 回执 = 控制台输出行解析；**无 JSON 回执协议**——本实现只能给出
  「命令已发送/控制台已回显」级证据，绝不声称 applied（AUD-007 口径：
  引擎无 applied 回执，applied 只能来自扩展侧自定契约的 HTTP 通道）。

### 4.3 内置实现 B：第三方 HTTP 方案

- 按部署配置 `HttpRequestEntry` 形状（url/method/headers/body 模板），
  占位符替换文件列表（既有 `${module}`/`${filename}` 等 + 本设计扩展
  `${files}` = 文件列表 JSON / `${fileList}` = 逗号分隔）。
- 回执 = 响应体走既有 accepted/applied 解析（HOT-003/004）；这是**唯一**
  能产生 applied 证据的通道（AUD-007：`{"status":"applied",...}` 是扩展侧
  自定契约，作用于用户配置的 `@http:` URL 的回包体）。

### 4.4 通道选择

- 通道按**部署（deployment profile）**配置选择：`ProjectProfile` 的
  `id` 下挂 `hotReload.channel = 'kbengine-official' | 'http'` + 该通道参数。
- 未配通道 → 回落既有 `kbengine.hotReload.actionName` quick action 通道
  （`@http:`/脚本），行为与现状一致。
- **结构性 def 变更仍走 IDE-HOT-005 的「需重启」路径，不进热更通道**
  （任何通道都不发普通 reload 给结构性 def 批）。

### 4.5 验收（IDE-HOT-101）

1. `send` 按通道把文件集送达：HTTP 通道=既有 HTTP 请求面（url/method/
   headers/body 模板 + `${files}` 占位）；官方通道=控制台 reloadScript。
2. 回执流逐条推送：HTTP 通道=响应体解析（accepted/applied）；官方通道=
   控制台回显（不产生 applied）。
3. 通道按部署 profile 选择；未配回落既有 actionName 通道。
4. 结构性 def 批不进任何热更通道（到 IDE-HOT-005 重启路径）。
5. `probe()` 连通性测试：HTTP=端点可达；官方=控制台可连。

## 5. IDE-HOT-102 [P2] 重载配置与审计

### 5.1 配置面板

- 部署级重载通道配置面板（官方/HTTP 自定义）：`ProjectProfile` 下挂
  `hotReload` 段，通道选择 + 参数（HTTP：url/method/headers/body 模板；
  官方：fullReload 默认）。
- **连通性测试按钮**：调 `transport.probe()`，面板内显示 ok/detail。
- 结构性 def 的「需重启」提示与既有 `setRestartRequired` 同源。

### 5.2 审计

- 全部重载动作进审计：**谁 / 何时 / 哪些文件 / 通道 / 结果**。
  - 谁 = 触发源（watcher 自动 / 命令手动 / 重试 / 临时编辑）。
  - 何时 = 注入时钟时间戳。
  - 哪些文件 = 文件集。
  - 通道 = `transport.kind`（或回落 actionName 通道的 quick action 名）。
  - 结果 = 终态（APPLIED/FAILED/未确认）+ detail。
- 审计落点 = 既有 `KBEngine 热更新` OUTPUT 通道（hotReloadStatus.log）
  + 台账 `HotReloadDeliveryRecord`（既有事实源，不另立）。审计面补
  「触发源/通道」两个字段到记录或独立审计行。

### 5.3 验收（IDE-HOT-102）

1. 配置面板按部署 profile 读写通道与参数；未配回落既有行为。
2. 连通性测试按钮调 probe 并显示结果。
3. 每次重载动作审计行含 谁/何时/哪些文件/通道/结果 五要素。
4. 结构性 def 的需重启也进审计（通道=「拦截:需重启」）。

## 6. 边界与红线

- **无回执协议不冒充**：官方通道（引擎原生 reloadScript 无 JSON 回执）与
  HTTP 通道按 AUD-007 口径区分——applied 只能来自 HTTP 自定契约回包体，
  官方通道最多给「已发送/控制台回显」，绝不标 applied。
- **不靠 mtime**：状态判定只用内容 hash。
- **复用既有词汇**：状态机/通道/审计都用本仓既有面（台账、回执解析、
  def 结构闸、控制台客户端、ProjectProfile），不新造第二套身份。
- **无新依赖**：不加 npm/cargo 包；复用 node:crypto sha256 原语。
- **文档先于代码**：本文档为评审稿；评审通过前不动 `src/`。

## 7. 实施顺序（评审通过后）

1. IDE-HOT-100：状态机模块（`src/hotReloadFileState.ts`）+ 文件树角标/
   CodeLens/过滤 + prove-red。
2. IDE-HOT-101：`ReloadTransport` 接口 + 两实现（HTTP 复用既有请求面，
   官方走控制台）+ 按 profile 选择 + prove-red。
3. IDE-HOT-102：配置面板 + 连通性测试 + 审计五要素 + prove-red。

每步门禁 = lint + tsc + test:unit + xvfb demo，勾行带 commit hash，
文档（features.md/zh）同步对账。
