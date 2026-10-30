# 2026-10-30 完成标记、运行链路与 KBEngine lint 深度复审

## 结论与证据边界

结论：**CHANGES REQUIRED。不能认定“全部完成”。** 数据库/热更新从纯辅助模块推进到了生产入口，Python 异步解析、注解事件回放等修复也确实存在；但若干已勾选条目仍有可复现缺陷，取消和长期资源验收也存在取证盲区。

后续状态见 [第二轮深审](./2026-10-30-completion-audit-round2.md)：`c647fdf` 的 F01 迟到会话修复已独立复验通过；第二轮另有新的完成标记反例。本报告保留原固定基线事实，不能把其缺陷表当成所有后续提交的实时状态。

固定 Kode 基线 `bf26cbfadd598b976a67cb48a9d360eccd70c07e`，通过 Git archive 建隔离快照，恢复该提交的 Git 身份后运行测试，依赖指向现有 node_modules。不混入主工作区其他 agent 的未提交测试、VS Code 替身改动及临时夹具。所有下述缺陷和基线测试结果均指该提交，不自动覆盖后来的修复。

基线共盘点 **280 个 `IDE-*` 复选框，231 勾选、49 开放**。`IDE-REV` 37 勾选、1 开放；`IDE-GIT` 12 项均开放。完成状态已不是“全勾选”，而且原组汇总与修复细项存在状态不同步。逐项登记见 [完成状态盘点 CSV](../perf/2026-10-30-todo-audit.csv)：未深入验证的项明确标未评估，不能把全套测试通过当作每项独立验收。

本轮输入：源码、todo、提交历史、既有真机日志和测试代码均 FOUND；本机 KBEngine 源码提交 `f85ad81` FOUND；新鲜的真实 SSH/debugpy/MySQL 联调环境及新一轮全场景编辑器运行数据 ABSENT。本轮完成全清单盘点与高风险模块深查，不宣称已对所有 UI/远端协议场景逐项真机重新验收。

检查结果：

- 隔离基线单测：**4345 通过、1 失败、9 跳过，400 个测试文件**。失败是 `receiverNoneGuardQuickFix.test.ts` 的 Range 替身不支持四数字构造；这是测试基础设施缺陷，不能直接等同真实编辑器也失败。
- 隔离基线 `tsc --noEmit`、`eslint src --ext ts` 通过。使用 Node 直接运行已安装工具，避免 pnpm 在符号链接依赖目录上自动安装的噪声。
- 新一轮真实编辑器 `--demo` 导航回归：**25 通过，退出码 0**。此结果只覆盖该 demo 的定义目标场景，不能代替取消、长会话和真实服务端联调。
- 新一轮真实编辑器 `--final`：**0 通过、1 失败，退出码 1**；失败确为 F17 的嵌套量规被当成数字判断归零，实际工作队列已为零。日志同时捕获 F18 的文件关联设置写入错误和未处理拒绝。
- 两组运行探针只加载源码、使用假调试会话/假数据库连接，不连接生产数据库、不停止真实进程；结果见 [复现数据](../perf/2026-10-30-audit-reproductions.txt)。测量只用于定位，非统计性能基线。
- 单实体 6000 属性、约数百 KB `.def` 的 phased schema 冷构建：总计 **841.1ms**，自报最大连续片 **831ms**，虽然预算设置为 25ms。让路发生在整个实体处理之后。
- 本轮后续只修复 `hasattr` 漏报：提交 `c351606`。新增测试旧实现 4 失败/7 通过；修复后相关 8 文件 **41 通过**，类型与 lint 检查通过。其余问题登记待修，不能据此视作已解决。

## 已完成标记复核表

“确认缺陷”表示有运行复现或确定源码路径；“证据不足”表示测试未覆盖要求，不能凭此断言产品一定有该缺陷。

| 编号 / 优先级 | 结论与触发路径 | 关联已勾选项 | 修正方向 |
| --- | --- | --- | --- |
| F01 / P1 | **已修复 (c647fdf)**：追踪器不再随守卫返回提前释放，活到 `onStartSettled` 落定（幂等）或管理器 `dispose` 兜底；`abandoned` 标记使永不落定的迟到自家会话立即停。prove-red 4 用例（REV-002 取消面 / attachRemote / REV-003 迟到成功 / AUD-001 永不落定面）旧源码红、新源码绿；门禁 lint+tsc+unit 4659 通过 + xvfb demo RC=0 | IDE-REV-003 | 追踪器活到 start 落定或本次会话完成清理，管理器卸载也应释放 |
| F02 / P1 | **确认缺陷**：只按 `session.name === attachConfig.name` 认领会话；同名并发会话被误认，超时停止了 `unrelated-same-name` | IDE-REV-002 | 每次 attach 使用唯一关联标记，校验配置/会话身份，而非显示名称 |
| F03 / P1 | **确认缺陷**：`attachViaTunnel` 在 `attachPortConfig` 返回成功后立即 finally stop 隧道。startDebugging 返回的是启动结果，不是会话结束；复现 `attached=true, killed=1` | IDE-PDBG-004 | 隧道绑定对应 DebugSession 终止事件，失败/取消及卸载兜底释放 |
| F04 / P1 | **确认缺口**：远端进程枚举只接进 py-spy。调试的 `pickProcessId` 仍使用本地 listProcesses，process attach 配置仍发给本地 debugpy | IDE-PDBG-005 | 明确支持远端 PID 附加的执行/隧道链；未实现前阻止远端选择悄悄走本地 |
| F05 / P1 | **确认缺陷**：hasattr 被当成任意 receiver 的非空证明。同一个 getter 返回 None 仍漏报，甚至 `hasattr(client)` 压掉 cell 警告 | receiver lint / B-7 | **已修复 c351606**，同码 Warning 继续出现，开关仍有效 |
| F06 / P1 | **确认缺陷**：同行 `if self.cell or ready: self.cell.send()`、None 分支里的嵌套条件 return、`print("return")`、已失效别名均可能消掉警告 | receiver lint / B-7 | 词法过滤、可靠条件分析、作用域与别名失效；不把出现关键字当作控制流证明 |
| F07 / P2 | **确认缺陷/缺口**：注释与普通字符串的 receiver 文本会报 Warning；`peer=self.cell; peer.send()` 却零诊断 | receiver lint | 调用发现复用词法/语法；别名使用点单独建模，不宣称已有完整别名检查 |
| F08 / P1 | **确认缺陷**：热更新旧响应的异步内容读取/核验会覆盖后一次结果；实测第二次 HTTP 500 后记录 failed，放行第一次 applied 核验后变为 applied | IDE-REV-023（也影响 021） | 每次发送有 generation/requestId，响应、内容基准、超时与台账比较并更新同一代 |
| F09 / P1 | **确认缺陷**：def 指纹遗漏 Parent、Interfaces、Components、Persistent 等结构。改变这些值仍 `structural=false`，可进入普通 reload | IDE-REV-024 | 对齐引擎实际装载/序列化面；对无法理解的变更保守阻止，不仅比较 Type/Flags/Arg |
| F10 / P1 | **确认缺陷**：同 profile 更换数据库地址时 SQL 缓存键仍只有 profileId+SQL。连接 B 查询拿回 A 的 SHOW TABLES，B 未真正执行查询 | IDE-REV-015 | 连接身份/配置代进入缓存键；变化、切换及旧查询晚回均不能污染新配置 |
| F11 / P1 | **确认缺陷**：查询生命周期先执行 run 再看取消，且优先接受 fulfilled；预取消仍 ran=1、completed。建连后的 SET READ ONLY 失败也未关闭连接，实测 close=0 | IDE-REV-017 | 调用前及 await 后核验取消/截止；连接初始化用 try/finally 安全收尾 |
| F12 / P1 | **确认缺陷**：预览列来源反查遍历所有 workspace、遇表名首命中即返回；没有活动 profile/root 入参。B 的同名表可跳 A 的 Hero.def | IDE-REV-018 | 真实连接、资产根、实体和 schema 同一身份；未知时说明未知而非借邻居 |
| F13 / P1 | **确认缺陷**：type storage phased 仍同步处理一个完整实体，内部属性递归和推导不让路；6000 属性实测片长 831ms，大于 25ms 预算 | IDE-REV-013 | 单实体内部按属性/节点/字节切片或 worker；真实计算中取消，不只在实体之间 |
| F14 / P1 | **证据不足**：REV032/033 闸门设在 provider 入口取消检查之后、实际查询工作之前。测试取消完才放行，主要证明放行后检查 token，未证明真实 IO/计算已经启动后的中止 | IDE-REV-032、033 | 在真实依赖/解析/查找进行到一半时取消，记录请求归属与实际停止；保留现有入口检查测试 |
| F15 / P2 | **证据不足**：REV034 正式阶段仅约 16 秒，worker 积压由测试直接调用分流器制造，并非编辑器事件自然形成；可验证短序列排干，不能据此保证长会话稳定 | IDE-REV-034 / IDE-ACC-009 | 将短压力验收与实际长会话分开；追加自然编辑事件、持续观察与缓存稳定性报告 |
| F16 / P1 | **确认缺口**：结构影响预览只比较 entity 根表，ARRAY/组件子表未进入命令的对照，不能覆盖“单实体所有结构影响” | IDE-REV-019 | 枚举同实体快照全部表，对每张表报告新增/移除/字段变化 |
| F17 / P1 | **确认验收缺陷**：finalMarks 算出的 hoverPass/definitionPass 只写日志，最后只断言命中次数；取三轮最优 P95 也不能代表总体 P95。同时 pendingWork 新增嵌套对象，而套件仍对所有 value 判 `===0`，当前形态不可能通过排干断言 | IDE-ACC-010 | 对齐量规类型，显式断言两个延迟门槛；预设采样与争用口径，不事后择优宣布达标 |
| F18 / P1 | **真机确认缺陷**：自动 JSONC 关联向 WorkspaceFolder scope 写 files.associations，VS Code 拒绝且激活期异步调用未处理拒绝；默认开关下多根工作区可触发 | 历史勾选“debug.json 标 jsonc” | 使用该设置支持的 scope，保留用户关联与托管记账，激活期错误收口 |

## 关键源码依据与反例

### 调试会话生命周期

`src/debugConfig.ts:startAttachGuarded`：追踪订阅在 `onStartSettled` 内释放，但外围 finally 仍无条件释放，抵消了这次修复。`session.name` 的匹配也没有每次尝试的唯一性。

`src/debugConfig.ts:attachViaTunnel`：finally 的 stop 发生在 startAttachGuarded 返回 completed 时，真实会话才刚建立。`node_modules/@types/vscode/index.d.ts` 的 startDebugging 返回 Boolean 启动结果；会话结束需跟踪终止事件。本轮用真编排方法、假隧道验证，未在真 SSH 服务器上重跑。

### guard 的“存在”与“保证”不能混为一谈

以下样本均由基线 `computeReceiverNoneFindings` 实际计算，结果零条，而 `self.cell` 仍可能为 None：

```python
if self.cell or ready: self.cell.send()

if self.cell is None:
    if ready:
        return
self.cell.send()

if self.cell is None:
    print("return")
self.cell.send()

peer = self.cell
peer = other
if peer:
    self.cell.send()
```

原因分别是同行正则允许任意条件尾部、firstExitAfter 只找关键字、别名从不因重赋值失效。基线的 `hasattrGuard.test(text)` 甚至不匹配候选的 receiver，相关部分已在本轮修复，其余仍开放。

调用发现按原始逐行正则扫描，未遮蔽注释/字符串；`pythonParser.ts` 已有词法屏蔽逻辑，但 receiver 调用发现尚未复用。未来修复不应对每个命中调用整文词法扫描，避免从误报修复引入平方级性能退化。

### 热更新缺少“这一次发送”的身份

`src/hotReload.ts:handleResponse` 在 HTTP 回来后才 `readSentContent(file)`，读取的是届时文件内容，不是发起时冻结的内容；store 也没有 requestId。

确定性复现：第一次请求拿到 applied 回执，但门住其内容读取；同目标同文件发起第二次请求并得到 500，台账 failed；释放第一次读取，`verifyAppliedReceipt` 无条件 record applied，覆盖新结果。旧核验窗口同样可能注解新记录。

`src/hotReloadDefStructure.ts:buildStructuralFingerprint` 只记录 Properties 中 Type/Flags、三类方法 Arg。引擎 `entitydef.cpp` 的 Parent/Interfaces/Components/Persistent 参与装载/结构；改变合法示例的 Parent、Interfaces、Components 或属性 Persistent，基线均判定非结构性。首个无基线事件会阻止发送，但第二次及以后有基线时仍暴露缺陷。

accepted/applied 的 JSON 形态在客户端模块里有记录，测试可证明“解析器符合该形态”；本轮未找到可供新一轮联调的对应真实服务端环境/回执样本。**不能把模拟 JSON 测试当成已验证引擎 applied 协议**。缺协议证据的任务应保持部分完成，尤其原条目要求“缺协议证据时保持开放”。

### 数据库连接身份、初始化与来源

`profileDatabaseConnection.ts:createProfileScopedDriftExecutor` 对缓存的读写只传 profileId 和 SQL，`selectActive` 只在 profileId 改变时释放旧缓存。解析出了新配置不等于缓存自动属于新配置。旧连接的晚到查询结果也可在缓存清理后重新写入。

`databaseQueryLifecycle.ts` 在 run() 之前没有取消检查，循环又先认 fulfilled/rejected 再看 token/deadline；这与本轮 readiness await 后复核修复存在同类遗漏。`databaseDrift.ts:createMysqlDriftExecutorWith` 取得连接后执行 SET READ ONLY，初始化抛错时没有 cleanup。

`extension.ts` 的 preview resolveColumnSourceTable 遍历全部 workspace 根；`createPreviewColumnSourceTableResolver` 首个同表名即返回。运行探针中即使用户想查 B，输入没有 B 身份可传，稳定返回 A 的声明。对应 schema impact 命令也以名字在所有 workspace 中首命中，应同时检查相同问题；不能只改单个 helper 的排序。

### 性能验收不能只看函数名含 async/phased

`databaseSchema.ts:buildTypeStorageUsageIndexPhased` 在 `refreshTypeStorageUsageRecord` **完成之后** 才核对预算，后者调用同步 getDatabaseSchemaSnapshot。单实体中 collectPersistentProperties、schema 推导及 XML 操作仍不可中途响应取消。测试的 heartbeat 最终为 true，只说明整个实体之后有一次 yield；831ms 片长才是实际限制。

REV032/033 的新增门控确实改进了“取消前已经完成”的旧测试，但门控在真正查询开始前，因此不能验证下游工作停止。落潮 IO 计数也取在取消请求已经 await 完成之后，且是全局计数，缺少请求归属；这一测试面应继续保留，但需补真实在途取消面。

最终验收 `src/test/electron/suite/finalMarks.test.ts` 中 hoverPass/definitionPass 无 assert；即使日志 pass=false，末尾仍只检查 30/30 命中。`Object.values(pendingAtMeasure).every(count => count === 0)` 又把 `caches`、`worker`、`annotationBuilds` 对象与零比较；这些值不可能等于零。旧报告对应旧量规形态，不能证明当前套件仍通过。缓存容量也不应该被要求为零，真正要排干的是 queued/running。

真机 --final 已重现该断言失败，实际 diagnostics/worker/annotationBuilds/index/schema 待处理量均为零。另有 `CodeExpectedError: Unable to write to Folder Settings because files.associations does not support the folder resource scope`；对应 `src/jsoncAssociation.ts` 的 WorkspaceFolder 更新及扩展激活期未捕获的异步调用。fake-vscode.update 无实际设置 schema 验证，所以此前只做替身测试无法发现这个完成标记问题。

## 通过与未评估

确认存在的修复：syncDocumentParse 推进解析 revision；注解 TTL 重建的保存/删除/迁移事件无条件登记；首次 hover 不再同步提取全部文档注解；receiver 异步入口改用 asyncDocumentParse/worker；schema 热命中新鲜度不再读取内容；查询 wrapper 已透传 destroy；数据库与热更新相关 helper 已接部分真实命令。这些成果不应因为新反例而整组撤销。

真实引擎协议联调、所有导航/重命名场景新一轮真机复验、实际长时资源稳定性：**NOT ASSESSED — 本轮无新运行数据**。已有日志仍保留为历史证据。Python Rust R2b 决策条目 REV038 原本就开放，本轮不擅自关闭；先解决仍同步的真实路径，再决定是否迁移。

Engine specialist validation: NOT ASSESSED — 仓库没有 project.yaml engine.name 或相应 specialist 配置；本轮直接核对可用 KBEngine 源码，不等同外部专家验证。No ADR references found for the reviewed task changes — ADR compliance skipped；本报告不对不可读或不存在的 ADR 作合规通过判断。

## 规范与后续交付

用户要求的写法规范已集中到 [KBEngine 写法陷阱与 lint 规则](../zh/guide/kbengine-lint-rules.md)，列出实际诊断 code、适用边界、源码符号与待实现规则。新 lint 不能仅有文档：必须从真实文档事件进入 Problems，有类型/角色与版本守卫，并有危险反例、合法正例、关闭开关和性能证据。

修正任务登记在 todo 的 IDE-AUD / IDE-LINT。只重开本轮发现明确反例或明确缺验收的条目；其他勾选项保持原状，状态盘点里标“未独立验收”，不冒充复审通过。先修调试生命周期、热更新代际和单实体阻塞，再继续扩展功能。一次只完成一个原子行为，验证后单独提交推送。
