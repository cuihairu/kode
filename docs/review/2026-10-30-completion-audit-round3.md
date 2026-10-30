# 2026-10-30 第三轮：根身份、引用图、生成回滚与 SDK

## 范围与结论

**CHANGES REQUIRED。** 固定基线 `a773c7c0263f5de85960acf1f7c1c5849c95cbc6`，使用独立 archive 快照和现有依赖。未混入共享工作区其他 agent 的未提交产品代码、测试与 TODO。本轮只提交审计材料及 TODO，不修改产品代码。

发现 **8 个新问题/设计缺口**，并为 **1 个已有记录的配置接线缺口**补上可执行反例。重开 **IDE-GEN-006**；新增 **IDE-AUD-055..064** 十个可单独验收的修复任务（视图关闭清理与 provider dispose 分开）。本报告不宣称完成全仓验收，也不把未测目标当作通过。

输入源码、已有测试、前两轮报告、原始 TODO 均 FOUND。按 code-review 技能做源码与证据复核；未配置引擎 specialist，本轮引擎整体验证 NOT ASSESSED。无本轮适用的明确 ADR 引用，ADR 合规核验跳过。真实 KBEngine 进程、跨平台编辑器、真实网络编解码和本轮完整 VSIX 未重跑，相关端到端效果 NOT ASSESSED。

相关既有测试 **8 文件、73 例全部通过**，但未覆盖下表反例。原始输出见 [第三轮证据](../perf/2026-10-30-audit-round3-reproductions.txt)。三个探针使用仓库 vscode 替身、临时实体文件、真实源码函数；SDK 使用 TypeScript 编译器做语义检查，生成器仅替换交互、写入及打开文件边界。不是 VS Code 真机录制，也不代表新增了产品回归测试。

## 结论表

源码行号以固定基线为准；所有下列观察均 VERIFIED，适用范围限于所列输入与生产接线。

| 编号 | 优先级 | 结论及依据 | TODO 处理 |
| --- | --- | --- | --- |
| R3-F01 | P1 | schema 展示丢失根身份。`databaseSchemaPresentation.ts:23-28,65` 的 URI 只含实体名，provider 调 `getDatabaseSchemaSnapshot(entityName)` 不传根；`extension.ts:1540` 入口同样如此。A/B 同名 Hero：显式传 B 的对照得到 B.onlyB，虚拟视图得到 A.onlyA。底层根缓存正确，产品入口仍可串根 | 新增 AUD-055；不撤销 SCH-002 的底层缓存验收 |
| R3-F02 | P1 | 展示面绕过缓存上限：`databaseSchemaPresentation.ts:21,27,60` 的 publishedRenders 没有关闭删除或 dispose.clear。顺次提供 46 个实体视图，在 textDocuments 为空的替身场景仍持有 46 个快照/行数组，底层 schema LRU 只有 32；dispose 后仍是 46。源码也没有接关闭事件。快照淘汰不代表整个展示链释放 | AUD-056 关闭清理、AUD-057 dispose 清理；不把未测堆内存字节数当作实测 |
| R3-F03 | P2 | 正常闭合标签被当作重复声明。`defReferenceGraph.ts:257-274` 把 rename 的开/闭标签两个编辑位置当作两份声明；一份 Parent.hp，经 Child 继承连接后即产生 duplicate-symbol。Project Doctor 消费相同结果 | AUD-058；检测应按声明节点计数，不能把重命名编辑次数当作声明数 |
| R3-F04 | P2 | 当前实体没有链接时，引用图丢失当前实体本身。`defReferenceGraph.ts:388-389` 只保留链接端点，单个 Solo.hp 的 definitions=0；Project Doctor 的 checkedFiles/checkedDefinitions 因而为 0。既有测试刻意排除无关 Orphan，不能据此推断整个设计必须纳入所有孤点；本问题只要求保留用户选中的 seed | AUD-059；明确 seed/连通分量与全项目扫描的不同范围 |
| R3-F05 | P1 | 本地改名检查不能防止给后代引入继承冲突。`defRenamer.ts:271` 与 `languageProviders.ts:5724` 只查声明文件：Hero.hp、Monster 继承 Hero 并独有 vigor，改 hp→vigor 返回无冲突且只编辑 Hero；同仓 analyzer 的 inherited-name-collision 从 0 变 1，指明实体加载失败 | AUD-061；NAV-008 明写“只查声明所在目标 def 文件”，保留其窄范围完成标记，不把新增继承要求倒算成历史造假 |
| R3-F06 | P1 | SDK 辅助成员与业务成员冲突。`clientSdkGenerator.ts:429-435` 固定输出 readonly entityId:number，同时原样输出业务 entityId:STRING。实际生成后 TypeScript 报 2300 重复标识、2687 修饰符不一致、2717 类型不一致。静态受限属性名单未包含 entityId；此项未声称做了真实引擎加载 | AUD-062；为辅助成员与业务成员制定冲突策略，并检查生成产物而非仅断言字符串 |
| R3-F07 | P2 | TS SDK 的 64 位整数表示有精度缺口。`clientSdkGenerator.ts:72,76` 将 UINT64/INT64 都映为 number，中文 SDK 文档也如此，未说明安全范围。生成 coins:number；9007199254740993 经 Number 再转 BigInt 得到 9007199254740992。此处证明的是类型表示无法覆盖引擎整数全域，未运行真实网络传输 | AUD-063；选择 bigint/字符串或明确受限模式，连同序列化边界一起定义，不能仅替换类型后宣称完整 SDK 兼容 |
| R3-F08 | P1 | 并发生成回滚会删除另一调用成功产物。`codeGenerator.ts:261,881-883,911-925` 复用实例 rollbackLedger，且“打开生成文件”仍处在回滚 try 中。First 停在打开提示，Second 完成；First 选择打开并遇到异常后，First.def 留着、Second.def 被删。两次调用同一个产品实例即可重叠 | 重开 GEN-006；AUD-064 隔离调用事务及提交后的 UI 错误 |
| R3-K01 | P2 | 已知缺口的运行验证：`extension.ts:2334-2342` 的共享 buildEntityMessageTable 未传 typesXml。方法 Arg=MY_INT、types.xml 定义 MY_INT→UINT32 时，默认调用 loadFailed=true/unknown-arg-type；同样输入传 typesXml 后成功。此项在 2026-10-29 messageTable 迁移取舍文档中已经承认，不能计作本轮新发现 | AUD-060 补真实配置接线；SDK-001/002 是预览/导出入口，不以此简单撤销其所有完成证据 |

## 修正建议与验收边界

1. 优先修复生成事务：每次调用拥有独立账本，成功写入后明确提交边界；随后打开编辑器失败仅提示打开失败。重叠向导需验证互不删除/恢复对方文件；同目标并发冲突另沿已有拒绝覆盖任务处理。
2. 将根身份从命令参数贯穿 URI、provider、缓存、定位与刷新。A/B 同名实体要能同时打开两个不同视图，不能仅给底层缓存补单测。
3. publishedRenders 属于第二层强引用缓存，需要独立生命周期；关闭文档删除记录，dispose 清空并释放订阅。文档仍打开时应保留同代定位能力，避免简单截断破坏 SCH-010。
4. 图的 duplicate-symbol 遍历声明节点；先明确当前文件的连通分量与全项目 Doctor 的边界，再补孤立 seed。保留“不纳入无关 Orphan”的合理测试约束。
5. F2 的继承冲突预检纳入受影响闭包，至少同时检查父链与后代；拒绝消息列出冲突实体、段和位置。与第二轮“异步查引用后版本过期”分别验收。
6. SDK 生成把“代码可编译”和“数值语义正确”列成验收条件；辅助成员重名不能静默覆盖。64 位策略须说明编译目标与编解码兼容成本。
7. 消息表读取所选根的 types.xml 与相关 alias 配置，预览和导出共用同一构建输入；配置缺失/非法保留明确问题清单。

## 性能与完成状态的含义

展示 Map 的无界持有是本轮确认的内存生命周期风险；本轮没有 hover 十几分钟的真实扩展宿主采样，不能把它直接定为唯一根因。第二轮 worker 在飞预算、日志单轮同步读放大等问题仍待修复，不能因相关单测通过而关闭。

SCH-002 的根键缓存、SCH-010 的已发布代定位、NAV-008 的声明文件内冲突检查都有真实局部价值；本轮将它们的验收边界写清并新增适配层任务。只重开确实违反本项承诺的 GEN-006，避免以扩展需求为由批量否定完成项。CSV 的 review3 列仅覆盖本轮直接复核的少数条目，空白表示本轮未重新验收。

## 复现

从固定基线 checkout 根目录使用已有依赖执行（写入仅发生在临时目录，结束清理）：

```sh
node docs/perf/2026-10-30-audit-round3-data-probes.cjs
node docs/perf/2026-10-30-audit-round3-sdk-probes.cjs
node docs/perf/2026-10-30-audit-round3-generator-probe.cjs
```

SDK 探针比较输出类型与 JavaScript 数值表示，不模拟传输协议。schema 的工作区和打开文档状态由替身控制，泄漏结论还同时核对源码中缺少关闭清理接线。上一轮见 [第二轮报告](./2026-10-30-completion-audit-round2.md)。

后续：[第四轮审计](./2026-10-30-completion-audit-round4.md) 复核新增字典键索引的词法、根身份、生命周期和编辑性能。
