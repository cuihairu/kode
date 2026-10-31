# 2026-10-30 第二轮：完成标记、产品接线与数据正确性

## 基线与结论

本轮基线 `57152966ecb0843104f42b675352fda993835f26`。使用独立 archive 快照和已有依赖运行，不混入主工作区其他 agent 的未提交源码、测试或 TODO。上一轮结论见 [第一轮深审](./2026-10-30-completion-and-lint-audit.md)。

**CHANGES REQUIRED。** 继续检查 NAV、GEN、PRJ、RUN、DBG、SDK、TSK、REL，并向事件索引、worker、日志、诊断及返回类型传播追查。全清单仍须区分“读过源码/测试”“满足原子条件”“产品入口已接”“真机验收完成”；这些状态不能互相代替。

本轮隔离单测：**4351 通过、9 跳过，399 个文件通过、1 文件跳过**。上一轮 Range 替身导致的失败已随 `5715296` 消失。单测全绿仍未覆盖下述反例。运行探针、原始结果见 [第二轮证据](../perf/2026-10-30-audit-round2-reproductions.txt)，独立脚本保存在同目录 `audit-round2-*-probe.cjs`，应从本基线根目录执行。

本轮另手动完成 baseline 的 compile、两个 Node18 bundle 与 webview 构建，再调用本地 vsce pack API（dependencies=false、不重复执行 prepublish）生成真实 VSIX；以解包产物运行 `--vsix`，**4 通过、退出码 0**。这验证当前包的身份、hover/跳转和包内 worker 路径；不等于已运行最低 VS Code 1.82 或 Windows/macOS。

另独立核验新提交 `c647fdf`：上一轮 F01 **确已修复**。超时后监听仍活，迟到 session 在 start 承诺尚未落定时停止一次，落定后监听和 tracker 集合归零。此结论只针对 F01，不覆盖同名会话误认 F02，也不覆盖后来的未提交改动。

## 新确认的问题

以下编号是本报告的 R2-F 编号，不与上一轮 F01 混用。探针使用临时目录、假连接/假调试会话；PID 测试替换了 process.kill，只记录参数，**没有发送真实信号**。单次性能值只用于定位，不作为跨机器验收基线。

| 编号 | 优先级 | 问题与证据 | 完成标记影响 |
| --- | --- | --- | --- |
| R2-F01 | P0 | worker 全局积压可绕过预算：100 个不同文件的第一份任务全部直接 post，总输入 26,214,500 字节；8MiB 预算下 queuedBytes=0、budgetRejects=0 | IDE-RES-002 不能继续按全局资源有界关闭。**已修 1e36690**（todo.md IDE-AUD-022：在途数量 16/字节 8MiB 双硬上限，首份任务在途满时转待派发排队受 8MiB 字节预算，回包后 drainAllQueues 全局让路面派发最新；量规加 postedBytes/maxPostedJobs/maxPostedBytes；测试：100 文件首份不全部 post、恢复后排队首份结算、在途满时首份排队可被新版本合并）。**量规覆盖已修 c463555**（todo.md IDE-AUD-023：复现摘要 worker 段新增在途字节/在途上限与总保留=任务/字节，host 等待与已投递两层并存一次可读，不能只凭 running 高或 queuedBytes=0 误读无积压） |
| R2-F02 | P0 | 日志 poll 在同步 for 循环读完整次增量；2,148,890 字节/30,000 行实测约 170ms；capacity=10 时 pending=30,000，只有 retained 有界 | 单块 Buffer 上限确实存在，但 IDE-RES-005 的单轮总量与整个发送链资源边界未交付。**已修 bae99bc**（todo.md IDE-AUD-024：logHub poll 单轮 64KB 字节预算 + 25ms 时间片，到预算/时间片即中断让出宿主，StringDecoder 保留读界切开的多字节字符；测试：3 万行突增心跳可走、轮数≥20、单轮不占排干一半、跨块多字节不损坏、64KB 预算拆多轮）。**pending 有界已修 84bae0d**（todo.md IDE-AUD-025：logHub pending 事件数 10000/字节 8MiB 双限额，超限 shift 丢最旧，pendingBytes/pendingDropped 记账，flush 出队减字节，clear/dispose 排空；量规 getLogHubGaugeForTests 读 pending/pendingBytes/pendingDropped；测试：50 条快生产慢消费超限丢最旧、字节限额独立先触、取消/释放排空） |
| R2-F03 | P1 | 关闭诊断后旧异步结果重新发布：输出依次为 cleared、old-warning；切代后也可先发布 new-config，再被 old-config 覆盖 | **已修 d9f9c52**（todo.md IDE-AUD-026：diagnosticScheduler 异步发布守卫补两道——计算在途时开关关闭→disabledAsyncDropped 不写回 collection；计算在途时代已切换→staleGenerationDropped 不发布也不把新代标成已发布；测试：在途关闭旧包不回写、切代后 new-config 先发布不被 old-config 覆写、旧包先到不标新代已发布同版本仍重算。IDE-DIA-007 随此关闭，验收面 extension.test.ts「切换 receiver 诊断开关时重新计算未编辑文档」全绿） |
| R2-F04 | P1 | F2 版本检查早于异步 Python 引用查找；等待中目标 v1→v2、插入一行后仍返回旧的第 2 行编辑范围 | **已修 9c1ca28**（todo.md IDE-AUD-027：provideRenameEdits 异步 python 查找后复核四道——取消返回 null、目标 version≠startVersion 拒绝、依赖 def 快照漂移拒绝、python 访问位置重读失效拒绝；测试 defRenameRecheckInputs 5 例 prove-red 先红后绿。IDE-NAV-010 随此关闭） |
| R2-F05 | P1 | 属性引用按 owner 文件原文正则扫描，结果包含字符串、注释、同文件另一普通类的 self.hp；复现行 3/4/5/8 均入结果 | IDE-NAV-002、011 的“确定归属”不完整；F2 会复用这些编辑点。**已修 8980cd3**（todo.md IDE-AUD-028：新增 src/pythonSelfScope.ts 纯函数 findOwnerSelfPropertyAccesses——经 pythonCodeLines（pythonParser 导出）掩码排除字符串/注释（位置不位移），按缩进栈跟踪 class/function 作用域与函数首参是否 self，只保留 owner 类直接方法内“self 即 owner 实例”的真读写点；嵌套重绑 def helper(self) 排除、闭包沿用外层保留、嵌套类/模块级函数排除、self.<prop>( 方法调用排除。entityMapping.getIncomingPythonPropertyAccesses 弃原文正则逐行扫描，按 owner 文件走 findOwnerSelfPropertyAccesses；Shift+F12 引用面与 F2 重命名面同源共享确认结果。测试 pythonSelfScope 6 例：复现行 3/4/5/8 只收 3、嵌套重绑排除闭包保留、嵌套类排除、方法调用排除、三引号跨行字符串排除、真 ws 集成只收 Hero 行 3。IDE-NAV-002、011 随此闭环） |
| R2-F06 | P1 | RPC 引用同样不识别字符串与类作用域；真实 Hero 调用、字符串及 Other 类调用均入结果，行 3/4/7 | IDE-NAV-003、012 需重开。**已修 05a53a5**（todo.md IDE-AUD-029：src/pythonSelfScope 重构共用作用域行走 buildOwnerScopeWalk+isOwnerMethodSelfAccess（AUD-028 同套规则②③）供属性/RPC 两面共用，新增 findOwnerSelfReceiverCalls 走同一过滤 + self.&lt;receiver&gt;.&lt;method&gt;( 调用括号断言。entityMapping.getIncomingPythonReceiverCalls 弃原文正则逐行扫描，按 owner 文件走 findOwnerSelfReceiverCalls；F2 重命名面同源共享确认结果。测试 pythonSelfScopeReceiver 7 例：复现行 3/4/7（注释 5 亦入）只收 3、嵌套重绑排除闭包保留、嵌套类排除、receiver 段隔离 cell/base/client 各只收本段、无括号非调用排除、三引号跨行字符串排除、真 ws 集成只收 Hero 行 3。IDE-NAV-003、012 随此闭环） |
| R2-F07 | P1 | entities.xml 登记写到了磁盘，脏文档缓冲仍无 Fresh；用户正常保存原缓冲后磁盘 Fresh 消失 | **已修 13b1079+732499c+72341e4**（todo.md IDE-AUD-030/031：四个写入面同规则收口。①generatorForms.registerSpaceEntity（表单向导空间面，13b1079）：打开文档走 WorkspaceEdit 缓冲插入，读缓冲到 applyEdit 同一快照无 await 间隙，重名检查与 `</root>` 插入点按缓冲区当前文本定位，applyEdit 未落地或缓冲未现登记即如实说明；bufferEdits 记账进 rollbackFormWrites 撤销（只撤本次插入且缓冲仍恰好含该插入才动）。②codeGenerator.registerInEntitiesXml（实体向导面，732499c）：同一缓冲写入规则，未打开才 writeFileAtomic；回滚账本扩 bufferEdits，rollbackGeneration 改 async 先撤缓冲插入再还原盘写覆盖——修掉“注册前备份 snapshot.content（打开时=缓冲全文）回滚写盘”把用户未保存改动覆盖进盘的隐患，两调用点删手工备份改由注册面按实际写入面记账。③固定字典 registerFixedDictType + ④组件挂载 attachComponentToEntity（表单另两面，72341e4）：打开 types.xml / 目标 def（含脏）时同样进缓冲区，未打开才原子写盘；共用 insertIntoOpenBuffer（applyEdit 抛错但文本已进缓冲按实文复核仍算落地），写点自记账本 FormWriteLedger。IDE-GEN-007 随此闭环） |
| R2-F08 | P1 | 新项目只在预览前查冲突；确认期间其他来源新增 entities.xml，确认后被空模板覆盖，preservedConcurrentFile=false | 已修 9f44263：落盘前重查+原子不覆盖(link/EEXIST)+回滚字节比对三面闭环，见 IDE-AUD-032 |
| R2-F09 | P1 | 事件索引不监听脏文档关闭/放弃修改，关闭后仍返回 EV_DIRTY | 已修 665bc97：onDidCloseTextDocument 自愈面(版本作废在途+强制重读盘+preferDisk 跳过脏覆盖)，见 IDE-AUD-033 |
| R2-F10 | P1 | 事件 indexFile 在途时新磁盘事件直接复用原 Promise，不递增磁盘 revision、不安排尾随更新；第二次更新可永久丢失 | 已修 8908616：在途复用递增 revision+trailingReads 合并尾随读，删除/重命名在途不复活测试锁定，见 IDE-AUD-034 |
| R2-F11 | P1 | 事件初扫支持外部根，但 watcher 只有 workspace 字符串 glob；无外部根 RelativePattern、根切换/移除订阅和缓存清理 | IDE-SNP-009 的“各消费索引”与根生命周期仍有遗漏。统一根移除覆盖事件索引（WorkspaceIndex.removeRoot+订阅）已修 6eb1ac7（todo.md IDE-AUD-036）；外部根 watcher 生命周期已修 265f99e（todo.md IDE-AUD-035，refreshExternalWatchers 挂 RelativePattern 切根重建） |
| R2-F12 | P1 | 根移除只清 documentStore，defParser 全局 AST 缓存仍持有原文；实测释放文档 1 个，XML cache 仍 entries=1 | IDE-RES-008 需重开；全局 8 条/8MiB 预算可缓解，却不等于根移除释放 |
| R2-F13 | P1 | 生产启动命令走 startAutoComponents，未调用 startTargetGroup；machine 返回 false 后仍启动 logger、dbmgr | IDE-RUN-006 只交付了未接入命令的 API | 已修 6ad1ad1（startAutoComponents 改调 startTargetGroup 统一依赖图，machine 失败/未 ready 时 logger/dbmgr 不再继续；命令级测试入 tests/extension.test.ts） |
| R2-F14 | P1 | retryTarget 只被 serverManager 自身与测试使用，实际命令仍走 start/restart，缺少失败单目标重试入口 | IDE-RUN-008 尚未形成产品闭环 | 已修 c89ce43（新增 kbengine.server.retry 命令面：失败目标登记 + QuickPick 选择带原因，已就绪目标不重启；命令级测试入 tests/extension.test.ts） |
| R2-F15 | P1 | 进程模式 attach 的名称不匹配 DebugSessionRegistry 的端口名称正则；实际生成的 `KBEngine: Python attach to cellapp` 得到 links=0 | IDE-DBG-005、006、008 在进程模式下不完整：会话关联、结束行为、工作台状态都受影响 |
| R2-F16 | P1 | 当前变量 `x=original(); x=0` 仍推导 EXPECTED；同文件 original 无返回注解时又借另一个打开文件的 OTHER_FILE | IDE-HOV-016 的作用域/显式本地定义约束不完整。前半「最后一次写入」已修 e3d6885（todo.md IDE-AUD-042）；后半「同文件无注解不借另一打开文件」已修 0ea00fe（todo.md IDE-AUD-043，级联顶层 unannotatedNames 检查在 fromOthers 前）。2026-10-31 复核关闭（todo.md IDE-HOV-016 标注 4934\|7+25 demo 复验） |
| R2-F17 | P1 | `from mod import original as local` 丢失被导入的原始名字，查桶用 local 而非 original；未起别名时 EXPECTED，起别名后 null | IDE-HOV-017 显式绑定未全部支持。已修 be79881（todo.md IDE-AUD-044，from-import 绑定保留 symbol=original，查桶用 symbol）。2026-10-31 复核关闭（todo.md IDE-HOV-017 标注 4934\|7+25 demo 复验） |
| R2-F18 | P1 | hover 预算返回 null 后底层请求独占 token 仍未取消，underlyingTokenCancelled=false；内层 race 未传 onStop | 前台有界返回不等于后台停止，可能堆积过时工作 |
| R2-F19 | P1 | Python 测试进程退出 1、stderr 有 teardown 错误，但出现 PASSED 节点后结果仍全部 passed；runPythonTests 丢弃了退出码 | IDE-TSK-005 需区分节点主体成功与整个测试会话失败 |
| R2-F20 | P2 | class TestReal 之后出现普通 class Ordinary，发现器仍把 Ordinary.test_not_pytest 登记为 TestReal 的方法 | IDE-TSK-004 需重开 |
| R2-F21 | P2 | 兼容检查命令传 extension 目录，但 helper 参数是 manifest 文件路径；有 package.json 和 out/extension.js 也报 EISDIR、bundle error、版本缺失 | 生产命令接线错误，新增修正任务 |
| R2-F22 | P2 | 同一检查用 KBEngine 2.5.10 比较 VS Code ^1.84.0，并据此给 engine-version=ok；当前宿主版本根本没参与 | 比较的是不同产品版本，不能当兼容性证明 |
| R2-F23 | P1 | killProcessTree 没有拒绝 pid<=0，传 0 会转发到 process.kill(0, SIGTERM)；ManagedProcess 的缺失 PID 又默认成 0 | 无效 PID 必须先拒绝，不能把进程组语义当成单个目标；本轮未发送信号 |
| R2-F24 | P2 | 标为零 VS Code 依赖的 databaseSchemaCore 仍导入 definitionWorkspace/sharedFileSnapshot，传递依赖 vscode，并有输入读取/存在性检查；隔离导入失败 | IDE-ARC-004 只完成部分抽离；deriveDatabaseTables 函数纯，不代表整个 core 模块纯 |
| R2-F25 | P1 | 异步诊断把计时起点放在 computeAsync 完成后的 then 内；实测一次 35ms 计算的 diagnostics 聚合 total/max/P95 均为 0 | 成本排序可能漏掉真实慢诊断，需修采集起点，不能用当前零耗时证明诊断便宜 |
| R2-F26 | P1 | 实际 QuickActionManager 以 false 表示未执行/失败；热更新外层只看 Promise 是否拒绝，false 仍被记 sent-unverified；重试编排也未检查 false | IDE-HOT-002、IDE-REV-026 不能继续按真实发送状态已验收关闭 |
| R2-F27 | P1 | `runByName('@http:debug:0', options)` 直接跳 runHttpRequestFrom，只转发两个参数，丢掉 onHttpResponse；同样影响 settings 入口 | 前一轮回执接线在这些真实 HTTP 入口不完整，REV-022/023 保持开放 |

## 关键路径说明

### worker：限制了 host 的一段等待队列，没有限制完整解析积压

`src/pythonParserWorkerHost.ts:parsePythonFileResponsive` 只有文件已 inFlight/pendingLatest 时才核对 queuedBytes。一个新文件直接 dispatchJob→postMessage；只有一个 Worker，但不同文件可以同时全部投递。被转移到 worker 消息队列的字符串不再计入 host queuedBytes。

“已派发就释放 host 字符串”是有用的改进，却没有消除 worker/native 队列里的待处理源码。需要全局派发并发/在途量和总字节预算，不能只测“40 个文件各提交第二版”。当前 running 指标实际是 posted 数，不能理解为一个 worker 正同时执行 100 个解析。

### 日志：分块分配不等于时间片，也不等于背压

`src/logHub.ts:watchFile` 每块至多 1MiB，但 poll 内用同步 for 把 stat.size 全读完；对长行还不断拼接 partial。`append` 对 pending 没有容量约束，flush 的 maxBatchBytes 只约束一次发送，不能约束生产者已经积压的数量。`logWebView` 的两个发送槽确实有界，**本轮不撤销它自身已经实现的背压能力**；问题在它上游。

这是用户卡顿的候选瓶颈，不等于已经确定“十几分钟 hover”的现场根因。需要把日志增量、worker 积压和实际宿主 CPU profile 放到同一请求窗口关联。

### 诊断：版本、关闭代、配置代都要在回包时核对

`src/diagnosticScheduler.ts:computeAndPublish` 的异步 then 核对文档 version 和 releaseEpoch，却不核对 enabled 和发起时 generation，最后还把旧结果记为当前 generation 已发布。因而关闭/重新配置虽清掉集合，旧 Promise 仍可回写并阻止当前版本再次计算。

正确验收需要门住真实异步计算，切换开关或配置代并发布新结果，再释放旧结果。只测试“开关切换时立即清空”不够。

同一异步发布路径的计时从 then 内开始，漏掉整个异步计算阶段。35ms 的延迟探针得到聚合耗时 0；应分别记录端到端等待、实际计算与发布阶段，避免计量口径把瓶颈隐藏掉。

### 引用与 F2：文件归属不能替代 token/类作用域归属

`EntityMappingManager.getIncomingPythonPropertyAccesses/getIncomingPythonReceiverCalls` 只过滤 owner 文件，然后扫整份原文。不区分注释、字面量、普通类、嵌套函数或 self 的不同绑定。`KBEngineRenameProvider` 把这些位置全部用于 TextEdit，所以错误不只出现在引用列表。

F2 的输入版本记录在等待 Python 引用之前形成；这些 Python 输入还没有纳入 refs。应在最后一次 await 后统一核验目标、相关 def 和 Python 输入，过期重算或拒绝。不能只在“用户第二次调用 provider”时比较上一轮手势记录。

此外 `KBEngineReferencesProvider` 忽略 includeDeclaration 上下文，这属于独立 API 完整性补项；本轮不拿它冒充 NAV-002/003 的词法误归属根因。

### 生成：磁盘正确的一瞬间不能代表保存后的结果

`codeGenerator.registerInEntitiesXml` 从共享快照取文本是正确方向，但 writeFileAtomic 只改盘。打开的脏文档仍是注册前文本，用户保存即可撤销扩展的修改。应通过编辑器编辑 API 保持缓冲、版本与撤销链一致，关闭文件才使用磁盘原子写。

`generatorForms` 的 space 登记、types.xml 入库、组件挂载仍有 fs.readFileSync 基底路径，应逐入口补同样的脏缓冲保护。不能为统一策略只让两个入口使用同一个确认框。

`projectCreate` 在 await 确认后未重新验证文件，临时文件+rename 本身允许替换已有目标。创建模式需要 no-clobber 保证，不能把“原子覆盖”当成“拒绝覆盖”。

### 启动与调试：管理器方法、命令、树界面必须串起来

`extension.ts` 的 `kbengine.server.start` 无 target 时仍调用旧 startAutoComponents；这个方法按固定排序和一秒 sleep 启动，既不使用 dependsOn，也不看上一步启动是否失败。startTargetGroup/retryTarget 的单测说明 API 有效，不能证明用户入口在用它。

端口模式的 DebugSessionRegistry 名称解析已存在；新进程模式生成另一种名称，却没有提供结构化目标元数据。不能把这条常用路径上的无挂链会话显示成“尚未附加”，更不能据此执行错误的 keep/stop 策略。唯一尝试 ID 的修复也应与上一轮同名会话问题保持同一身份设计。

热更新的真实动作入口也必须按返回值契约接线。`QuickActionManager.runByName` 返回 Promise<boolean>，但 setupHotReload 和 resendHotReloadTarget 将任意 resolve 当作成功；未知动作、被拒绝/失败的动作也可能进入“已发送未确认”。而直接 `@http:` 分支没有传 options，回执观察器根本到不了真实响应。只在 setupHotReload 测试中用假 runAction 主动调用观察器，不能证明这个产品链路已经贯通。

### 返回类型：别名、覆盖赋值与显式未知不能借用旧答案

`extractFileImports` 的 names 表只存模块，不存原始符号名；local 别名被拿去直接查 original 的桶，必然缺项。`matchingAssignments` 又只收“右侧可解析为调用”的赋值，忽略后续常量赋值或未知调用的遮蔽。`cascadeAnnotation` 在同文件无注解名进入 shadowedNames 后，仍先返回其他打开文件的同名注解。

这些都要求返回未知或使用当前可靠的绑定，而不是“在项目里找到一个同名方法就给答案”。与真正缺少类型时的降级要分开：没有证据不能制造精确类型。

## 分组复核与未测边界

[原始任务盘点 CSV](../perf/2026-10-30-todo-audit.csv) 追加第二轮源码、测试入口和结论字段，保留第一轮字段。196 条此前未独立验收项都纳入分组取证，**纳入取证表不等于独立验收通过**；明确反例的原项重开，其余项按证据强度保留限制。

| 组 | 本轮确认存在的实现与测试面 | 主要限制 |
| --- | --- | --- |
| NAV | provider 注册、Outline、workspace symbols、QuickFix、未保存快照与实现查询 | 引用词法/作用域、F2 回包前版本校验有反例 |
| GEN / PRJ | 原子写、预览、创建模板、profile UUID/存取/选择、解释器来源、根切换事件 | 脏缓冲闭环和创建期间冲突有反例；角色根剥离不等于重新跑过 Pylance 双角色验收 |
| RUN / DBG | target 键、依赖拓扑/ready 判定、树杀、端口窗口、会话结束策略 | 组启动/重试入口与 PID 模式会话关联缺口；无新真实 SSH/debugpy 服务器联验 |
| SDK | 活动 profile 根传入生成器、JSON 预览/导出、头部溯源、21 个基元编号对拍 | 基元装载序对拍不是所有实体/组件 RPC 编号都已联调；模板不是完整协议客户端 |
| TSK | TaskProvider、compileall matcher、测试控制器与固定任务上下文 | 测试发现类作用域和非零退出码有反例；无新 Windows 子进程链验收 |
| REL / MET | VSIX worker 保留规则、bundle 入口、构建 SHA、版本声明互锁、取证/读取量规；本轮真实 VSIX 4 项烟测通过 | 最低版本/跨平台未实测；兼容检查命令有独立接线/版本域问题，异步诊断耗时漏算 |
| EVT / IDX / SNP | 初扫 single-flight、文件快照、根分区、owner 多对多、编辑 revision、统一通知 | 事件在途磁盘更新、关闭恢复、外部根 watcher 与全局 AST 清理仍缺 |
| HOV / BUD / DIA | 单遍注解提取、异步索引、文档版本/关闭代、token 透传、共享等待者隔离 | 作用域/别名类型有反例；deadline 返回不取消底层；诊断配置代未守护回包 |
| SCH / RES | schema 纯推导/缓存、按依赖失效、worker 同文件合并、日志/webview 局部上限 | 上一轮单实体 831ms 阻塞未因方法叫后台而消失；本轮全局 worker/日志上游边界未闭合 |
| ARC / RST / LIV | 类型/格式化/适配层抽离、Rust serving 状态区分、迁移输入缺口、协议源码对拍 | 后台任务仍在宿主线程；非等价 RPC 通道下界不能当 schema 功能端到端对拍；真实引擎 LIVE-003..007 仍开放 |
| ACC / REV / PDBG | 已保存的真实编辑器证据与新增量规、前一轮定向修复 | 本轮不将旧日志自动标为新提交通过；第一轮 --final 当前失败与假闸取消边界仍须补验 |

一个没有升级为产品缺陷的例子：createWaiterUnionToken 的 undefined 等待者直接调用测试会被忽略；但当前 provider 总是先创建一个有实体的 deadline token，因此本轮**不据这个 helper-only 样本重开 IDE-BUD-008**。同样，单块日志 Buffer、webview 两槽、默认实例端口窗口等已有能力保留，不因上游新反例整组撤销。

新反例需真实外部资源才能完成验收的部分，继续标 **NOT ASSESSED — NO NEW RUNTIME DATA**。源码审查不能给 Windows/macOS、真实 MySQL、长时稳定性、完整协议版本兼容性盖章。

schema 的分层也有具体边界：`deriveDatabaseTables` 在显式输入上是纯函数，但所在 `databaseSchemaCore.ts` 还负责共享快照、注册表和文件存在性输入；它不能在没有 vscode 的普通 Node 环境直接导入。若继续拆纯核心，应把输入收集移到适配面，使用真正无 host 依赖的导入测试，而非只查核心文件有没有直接写 `import vscode`。

## 后续交付

新增 IDE-AUD-022 起的原子任务；每项对应一个行为和确定性验收。优先全局 worker 背压、日志时间片/队列、诊断配置代、F2 精确引用与版本守卫。继续遵守完成一项、验证一项、提交推送一项；本轮报告不夹带其他 agent 的源码或 TODO 在途修改。

后续：[第三轮审计](./2026-10-30-completion-audit-round3.md) 补充根身份、生成并发回滚、引用图与 SDK 的运行反例，并区分原验收范围与新增要求。
