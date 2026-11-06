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
2. **重载通道双方案**：KBEngine 官方方案（依赖引擎 `reloadScript`，经控制台）+
   自研接收器方案（本仓 HTTP 接收器 `scripts/hot-reload-receiver/`，端点由使用者
   自己配置）。

## 2. 既有地基（现状核对，实现前必须复核）

以下均为当前 `src/` 已落地并被既有测试钉住的面；本设计在其上叠加，不另立
第二套身份。

| 面 | 位置 | 语义 |
|---|---|---|
| 投递结果台账 | `src/hotReloadTargetState.ts` | 四态 `sent-unverified \| accepted \| applied \| failed`；键 = `rootId × targetId × file`（rootId=文件归属扫描根，targetId=服务实例）；`attempt`=发送代际（IDE-AUD-005）；`sentDigest`=发送时点冻结内容 sha256（IDE-AUD-006） |
| accepted 回执协议 | `src/hotReloadReceipt.ts` | JSON `{"status":"accepted","file":"<逐字回显>"}`（可选 targetId 一致） |
| 热更请求报文 | `src/hotReloadTransport.ts` + `scripts/hot-reload-receiver/referenceReceiver.mjs` | 请求体 `{"files":[...],"targetId"?,"sender_digests"?}`；`sender_digests` = 发送时点冻结 sha256（F3 三轮随报文下发），接收端自己把该内容写盘引擎目录后对产物重算 sha256 与之比对一致才回 applied（F3 四轮） |
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
    onReceipt: (receipt: ReloadReceipt) => void,
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary>;
}
```

`ReloadReceipt` 复用既有回执形状（`{status:'accepted'|'applied',file,digest?}`
或 `{status:'failed',file,reason}`），不新造协议。

### 4.2 内置实现 A：KBEngine 官方方案（依赖引擎 reloadScript，经控制台）

- 引擎官方重载面 = Python `KBEngine.reloadScript(fullReload)`（AUD-007 实勘，
  baseapp/cellapp 均注册），**无 HTTP 回执**。
- 触达路径 = 经既有 `KBEngineTelnetClient`（控制台）对 baseapp/cellapp 执行
  `reloadScript(fullReload)`（或等价控制台命令）；fullReload=true 全量、
  false 增量——按文件集是否涉 def 选。
- 回执 = 控制台输出行解析；**无 JSON 回执协议**——本实现只能给出
  「命令已发送/控制台已回显」级证据，绝不声称 applied（AUD-007 口径：
  引擎无 applied 回执，applied 只能来自扩展侧自定契约的 HTTP 通道）。

### 4.3 内置实现 B：自研接收器（HTTP 方案，本仓自研）

- 按部署配置 `HttpRequestEntry` 形状（url/method/headers/body 模板），
  占位符替换文件列表（既有 `${module}`/`${filename}` 等 + 本设计扩展
  `${files}` = 文件列表 JSON / `${fileList}` = 逗号分隔）。
- F3 三轮（2026-11-06 复审）：请求体自动附带 `sender_digests` 字段——
  发送时点冻结的内容 sha256（IDE-AUD-006 基准）随报文下发，形如
  `{"files":[...],"targetId":"...","sender_digests":{"<file>":"<sha256 hex>"}}`。
- F3 四轮（2026-11-06 复审，设计级）：applied 路径改为**接收端自己写产物**
  ——按报文 files 读到内容后由接收端自身代码直接落盘引擎目录
  （`--artifact-dir`），写后对产物重算 sha256 与 `sender_digest` 比对一致才回
  applied。
- 外部应用命令模式（`--apply-command`）降级：命令副作用不可证实（接收端
  证明不了产物是本次命令写的），退出 0 也最多 accepted，绝不 applied、不落
  应用台账；命令执行失败仍 failed。空操作场景从设计上不存在假 applied。
  （F3 五轮「回滚 best-effort/还原原内容」的旧表述已按七轮④/八轮②机制
  退役：现役机制下既有产物从未被触碰，收尾只清「已确认自建」的临时文件。）
  参考实现：`scripts/hot-reload-receiver/referenceReceiver.mjs`。
- F3 七轮（2026-11-07 第七轮复审，命名空间唯一 + 悬空 symlink 封死 +
  temp+rename 原子写）：
  - **产物命名空间只认暂存根（`--root`）内路径**：根外绝对路径直接拒绝整批
    （failed 回执，不写盘、不落台账）——六轮的「根外回落按绝对路径全结构
    展开」与根内相对路径共享同一命名空间（`/stage/tmp/X.py` 与 `/tmp/X.py`
    都映射 `tmp/X.py`，分批发送互覆盖），修后碰撞从映射规则上不存在。发送
    侧同步只发暂存根内路径：参考发送方（`roundtripProbe.mjs`）发送前校验
    所发文件在暂存根内，越界拒绝发送。
  - **符号链接逃逸防护（lstat 拒链接）**：写前对产物路径先做父目录链
    realpath 解析（任一级解析到 `--artifact-dir` 外即拒绝），再 lstat 最终
    组件——是 symlink（无论悬空与否）一律拒绝（failed 回执，不写不删）。
    六轮只做 realpath：对「指向目录外不存在文件」的悬空 symlink，realpath
    抛 ENOENT 回落到最深已存在祖先（引擎目录本身）误判安全，写入沿悬空链接
    逃逸；lstat 不跟随链接，悬空也拿到 symlink 状态，此路封死。
  - **temp+rename 原子写（检查-写入 TOCTOU 消除）**：产物先写为引擎目录内
    `'wx'` 独占创建的自建临时文件（进程级唯一名字，绝不碰撞；O_EXCL 绝不沿
    既有任何路径——含 symlink——写入），内容 sha256 与 `sender_digest` 的
    核验全部在临时文件上完成，最后 `fs.rename` 原子替换到产物位——rename
    不跟随目标 symlink，即使竞态在检查后把产物位换成 symlink 也是被整体
    替换而非被沿写逃逸；rename 目标的目录组件用 realpath 解析后的真实父
    目录构建（路径中无 symlink 中间层）。临时文件写前同样过 lstat/realpath
    校验。
  - **失败收尾只清理自建临时文件**：落盘失败/读回失败/哈希不符/rename 失败
    一律 failed，收尾只 unlink 临时文件，失败如实 `rollback_failed`
    （=残留临时文件路径），清干净才注明无残留——引擎目录里的既有产物从头到
    尾不被触碰，原产物天然原样保留（五/六轮的「还原原内容」回滚通路退役，
    预存在产物不会被误删或改写）。写前读旧产物的 ENOENT-only 语义保留：非
    ENOENT 读异常（`EACCES`/`EISDIR` 等）仍如实拒绝写入且不触碰，不覆盖
    不可核验的预存在产物。
- F3 八轮（2026-11-08 第八轮复审，目录竞争包含性验证 + 收尾清理标志位 +
  暂存唯一子目录）：
  - **rename 目标父目录双重验证**：rename 前立即 `realpathSync(父目录)` 并
    验证①**包含性**——解析结果必须在引擎目录（realpath）内；②**一致性**——
    解析结果必须与原路径逐字一致（否则说明路径中有 symlink 组件）；任一
    不过即拒绝本文件（failed 回执，不写盘、不落台账），通过后用解析出的
    真实父目录做 rename。七轮 rename 前的 realpath 只取不验：中间目录被
    竞态换成外部 symlink 时 rename 落到引擎目录外，换成内链时也沿 symlink
    组件到达别处。**残余窗口如实记录**：JS 无 `O_NOFOLLOW`，realpath→rename
    一瞬之间父目录链仍可能被竞态替换（窗口=相邻系统调用间隔，无法归零）；
    窗口内的替换被同一包含性+一致性验证拦截，跨窗口竞态如实为已知限制，
    不以「已消除」自称。
  - **失败收尾只清理「已确认自建」的临时文件**：`'wx'` 独占 `openSync` 成功
    返回是独立的**创建成功点**，临时文件校验时序=创建→写入→lstat/realpath
    校验→读回核验→rename。创建即失败（`EEXIST` 等）时同名既有文件不是本次
    创建的，收尾绝不触碰（七轮失败分支无条件 unlink 可能删掉非本次创建的
    文件，此路封死）；创建成功后的失败（写一半 `EFBIG`/读回失败/哈希不符/
    rename 失败）才允许收尾 unlink 自建临时文件，失败如实 `rollback_failed`。
  - **暂存副本独立唯一子目录**：暂存副本不再按 basename 落暂存根顶层——
    同批 `<root>/sub/X.py` 与 `<root>/X.py` 的顶层暂存路径相同，前者的暂存
    动作会直接覆盖后者的**源文件**（后续读回被污染内容，digest 自然不符）。
    修后按已清洗防碰撞的报文相对路径展开到 `<root>/.staged/<相对路径>`（与
    产物映射同一套防碰撞防逃逸规则），同批互不覆盖，也碰不到任何源文件或
    应用台账。
- F3 九轮（2026-11-06 第九轮复审，暂存命名空间隔离 + 暂存路径 symlink 防护
  + 收尾清理 dev/ino 比对）：
  - **源命名空间与暂存命名空间不相交**：八轮的 `.staged` 前缀仍在允许源
    文件树内——同批含既有 `<root>/.staged/X.py` 源文件时，`<root>/X.py` 的
    暂存副本 `copyFileSync` 直接覆盖该源文件。修后源路径第一段为 `.staged`
    → 属接收端暂存命名空间，拒绝整批（与路径清洗同一防线）。**symlink
    别名补口**：词法排除挡不住指向暂存树的别名（`root/alias → root/.staged`
    时同批暂存副本仍覆盖别名指向的源文件），修后对每个源文件 realpath
    解析，解析结果落在暂存树（`<root>/.staged` realpath）内 → 拒绝整批。
  - **暂存路径写前双重验证**（`safeStagingTarget`）：暂存写入此前无 symlink
    检查，`.staged` 链上任一级被换成 symlink 时 `copyFileSync` 沿链接逃逸/
    错写。修后对暂存父目录链取**最深已存在祖先**验证：包含性（在暂存根
    realpath 内）+ 一致性（**相对比较**：解析路径与原路径相对暂存根的相对
    路径逐字一致——树内 symlink 组件被拒，暂存根自身的合法 symlink 祖先
    （如 macOS `/tmp`）不误判）+ realpath 失败但组件存在（悬空 symlink 链）
    直接拒绝 + `lstat` 最终组件拒 symlink；任一不过即拒绝本文件暂存。
    **残余窗口如实记录**：检查→mkdir→copy 一瞬的竞态与 rename 同级，不以
    「已消除」自称。
  - **收尾清理 dev/ino 比对**：「确认自建」标志位防不住「创建后、收尾前
    路径被竞态替换」（替换文件与创建判定无关联）。修后创建成功点
    `fstatSync(fd)` 捕获临时文件 dev/ino，收尾 unlink 前 `lstat` 比对路径
    当前 dev/ino 与捕获一致才删；不符或捕获缺失（身份无法确认）→ 跳过并
    如实报 `rollback_skipped`。**残余窗口如实记录**：`lstat` 比对→unlink
    一瞬之间路径仍可能被竞态替换（窗口=相邻系统调用间隔，无法归零），与
    realpath→rename 窗口同级，如实为已知限制。
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

- 部署级重载通道配置面板（自研接收器 / KBEngine 官方）：`ProjectProfile` 下挂
  `hotReload` 段，通道选择 + 参数（自研接收器：url/method/headers/body 模板；
  官方：fullReload 默认）。
- **预设一键启用（快捷启用）**：首屏三预设——自研接收器[推荐]（默认参数
  `http://127.0.0.1:8000/reload`、POST、体 `{"files":${files}}`——**JSON 对象体**，
  只有对象体才会被 transport 自动附 `targetId`/`sender_digests`，接收端核对
  digest 后才回 applied；裸 `${files}` 数组体到不了 applied，故预设与高级配置
  的默认体同为此形）/ KBEngine 官方（默认 `127.0.0.1:2560`）/ 未配置，外加
  「高级配置」入口。单 profile 直接进预设首屏、多 profile 先选 profile，合计
  ≤2 步、零输入框；选预设即 `transport.probe()` 一键探活，**通过才写 profile
  启用**，不通如实报「探活不通,未启用」指回高级配置。多步流（选通道 → 逐项
  收参数 → 保存/探测）保留在高级配置内（命令带 `{ entry: 'advanced', profileId }`
  即直达该 profile 的高级流）。接收器端口须对齐：以
  `node scripts/hot-reload-receiver/referenceReceiver.mjs --port 8000 --root <暂存根>
  --mode apply` 启动（脚本缺省 `--port 0` 随机端口）。
- **连通性测试按钮**：调 `transport.probe()`，面板内显示 ok/detail。
- **状态栏快捷开关**：通道灯显示**当前已配置**通道（`热更:自研HTTP` 等），点击弹三选
  QuickPick 即切（选中即探活：绿=通并落盘 / 红=不写盘，红标与 tooltip 点名这次试的
  通道，灯文字不冒充未落盘状态）；一键修直达该 profile 的高级流；探活结论按
  「激活 profile + 通道配置身份」归属，profile 切换/改参数/面板写盘即作废，探活等待
  期间状态变化则该次结果作废不写。与既有发送态灯（优先级 98）分灯分色，通道灯 96。
- **默认键位**：`contributes.keybindings` 为 `kbengine.hotReload.configureChannel`
  注册 `ctrl+alt+r`（macOS `cmd+alt+r`，无 `when` 收窄），零配置可直接调起；
  键位避让 `ctrl+alt+h`（配置指南 HTTP 快捷请求示例键）与 telnet 面板键位。
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

## 8. 默认行为（用户令 2026-11-06 · 已落地）

1. **默认开启**：`kbengine.hotReload.enabled` 默认 `true`——`package.json`
   贡献默认值与 `readHotReloadSettings` 的缺省同改，配置缺失时也开；
   **显式写死 `false` 仍关**（用户显式关要生效）。默认 `globs` 不动
   （`**/*.py`），默认去抖 `500ms` 不动。
2. **零配置开箱即用**：`kbengine.hotReload.actionName` 留空（默认）时，
   保存 .py → 去抖 → 默认热更请求 `POST http://127.0.0.1:8090/hotfix?module_name=<模块名>`，
   body 同带 `module_name=<模块名>`（query 与 body 各带一份，兼容不同服务端
   读参口径，同值重复无害）。端点与参数名只在
   `BUILTIN_HTTP_REQUEST_EXAMPLE` 一处定义，`src/hotReloadDefaultHotfix.ts`
   同源取用，与 `package.json` 默认值测试锁同步；全仓旧拼写由
   `tests/hotfixSpellingGate.test.ts` 全量 grep 断言清零。
3. **模块名口径**：优先 `resolveModuleDualName`（书 §19.1，与
   file-change-meta 同一口径）；未配 `kbengine.hotReload.tempEdit.scriptRoot`
   或该文件解析不支持时，回落 `${module}` 的 `__init__.py` 包边界扫描
   （与默认示例模板同一占位来源，不新造占位）。
4. **诚实回报**：连接拒绝/超时/非 2xx 一律 `failed`（状态栏 + 日志带原因，
   引擎未起如实报失败）；2xx 也只到「已发送（未确认）」，状态栏不标已生效。
   默认路径不弹错误窗（每次保存都弹会刷屏），原因落审计日志。
5. **一键关**：状态栏「热更」项点击 = 执行 `kbengine.hotReload.toggle`，
   把 `kbengine.hotReload.enabled` **写回配置**（有工作区文件写 Workspace，
   否则写 Global），配置变更监听随即拆/建 watcher，即时生效不必重启窗口；
   非模态提示新状态并给「打开日志」入口。命令面与状态栏点击同一条路。
6. **首激活提示**：第一次激活弹一次非模态提示（点名端点与一键关入口），
   弹出即记 `workspaceState` flag，此后不再打扰；选「立即关闭」直接写回
   配置关掉热更。极简装配上下文（无 `workspaceState`）不弹。
7. **结构性 def 仍拦**：默认路径同样在 def 结构闸之后执行，结构性变更
   照旧整批拦下并标 `RESTART_REQUIRED`（不放宽）。

## 9. 架构分界：HTTP 热更请求由 TS 发起（不可再议）

**结论（用户令 2026-11-06，写入即为准）：HTTP 热更请求由扩展（TS）发起，
不由 rust 发起。**

理由：

1. `HttpReloadTransport`（`src/hotReloadTransport.ts`）已实现全套——
   占位替换 / sender_digests 冻结 / targetId / 回执解析 / 台账；
2. rust 13 个 crate 零 HTTP 客户端依赖，加 reqwest 撞「零依赖铁律」；
3. 事件源已定为 VS Code watcher，事件、元信息、模块名、版本台账全在 TS，
   rust 发送要反向绕 IPC；
4. rust 挂了热更照常（结构闸等判定已在 TS 侧），rust 发送会把热更绑死在
   rust 进程上。

**分界**：TS 管编排与传输（状态机、台账、回执、HTTP 请求）；rust 管纯计算
（解析 / 索引 / 克隆）。rust 是被 spawn 的纯函数服务，不承担 I/O 与状态。

**例外**：将来若需要 rust 常驻长连接/连接池对接引擎（高频批量推送），再评估
下沉——前提是事件与元信息协议已纯数据化，届时可换实现不改契约。
