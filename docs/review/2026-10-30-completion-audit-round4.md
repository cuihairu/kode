# 2026-10-30 第四轮：新字典键索引的完成标记与性能复核

## 基线与结论

**CHANGES REQUIRED。** 本轮专门复核新增的 `e6f53ac` 实现及 `7008e15` 完成标记，固定基线为 `7008e1578dd70e23381dc7f67b435fa22ed2963d`。独立 archive 快照使用已有依赖，不包含共享工作区正在开发的 GLOBDATA-002、额外测试或其他未提交修改。本轮只改审计文档及 TODO。

确认 **12 项问题**，新增 **IDE-AUD-065..077** 十三个原子任务（索引目标的词法过滤与查询入口的词法过滤分开验收），重开 **GLOBDATA-001**。这说明功能已有真实实现但未达到稳定导航的完成条件，不等于原实现与测试全部无效。F12 来自既有共享 alias helper，是新功能继承的旧缺陷，不将全部发现都归咎于本次提交。

源码、已有测试、TODO 和前轮报告均 FOUND；实际 KBEngine 集群、扩展宿主真实使用轨迹及这轮 VSIX 录制 ABSENT，相关端到端效果 NOT ASSESSED。无配置的引擎 specialist，本轮未做引擎整体验证；未发现本轮适用的明确 ADR 引用，ADR 检查跳过。

既有 `globalDataIndex`、`extension`、`perfCallChainDoc` 测试 **3 文件、53 例通过**。两个独立探针使用真实源码与 vscode 替身；文件系统事件、文档事件和异步闸门由测试控制，临时文件在结束后删除。完整输出见 [运行证据](../perf/2026-10-30-audit-round4-reproductions.txt)。本轮不声称完整单测、跨平台或真机验收已完成。

## 结论表

以下代码行号对应固定基线，观察均 VERIFIED；源码没有改变时可以重复运行两个探针。

| 编号 | 级别 | 反例与源码依据 | 修正任务 |
| --- | --- | --- | --- |
| R4-F01 | P1 | 词法过滤只挡住查询源的行注释，未挡住索引目标和外层字符串。`globalDataIndex.ts:390-445` 对原始行做正则；`languageProviders.ts:4055-4061,5293-5297` 仅检查源行是否有引号外的 #。真实读点 F12 跳到 bad.py 的注释写点；引用列表含注释行和字符串中的假访问。把查询源放进普通字符串，也仍触发该导航 | AUD-065 目标扫描、AUD-066 查询源过滤 |
| R4-F02 | P2 | 字符串解引错误改变键身份。`globalDataIndex.ts:84-104` 遇反斜杠仅拼入后一个字符：键 `"\n"` 与 `"n"` 都归一为 n；`"\x41"` 得到 x41，与实际同值的 `"A"` 无法互链。Python literal_eval 对照确认实际值分别是换行、n、A、A | AUD-067 |
| R4-F03 | P1 | 不同项目同名键串跳。`globalDataIndex.ts:457,646` 的倒排键只有 dict 和 keySignature，provider 查询也不传根。在两个独立 workspace 根中，B 读 cfg 直接跳到 A 写 cfg。跨进程共享字典不意味着不同工程/集群共享命名空间 | AUD-068 |
| R4-F04 | P1 | 取消编辑并关闭文档后，索引仍使用未保存内容。`globalDataIndex.ts:498-499,633-641` 接 change，却没有 close 回读/撤销。disk 键在磁盘，编辑为 dirty 后丢弃关闭，查询得到 disk=0、dirty=1。与第二轮事件索引的问题同族，本轮确认新字典索引也复制了此缺口 | AUD-069 |
| R4-F05 | P1 | 在飞读盘吞掉后到的磁盘变更。`globalDataIndex.ts:546-547,579-584` 的 change 不升 revision，遇到 building 直接返回同一承诺。通过实际 watcher 回调先门住旧字节，再写入 latest 并发第二次 change：只有一次读盘，最终 disk=1、latest=0。不是仅伪造第二次调用没有写盘 | AUD-070 |
| R4-F06 | P1 | 移除 workspace 根后旧贡献不撤销。该类无 foldersChanged 监听，extension 也未给 dataDictIndex 接根重建。移除 A 后，query(cfg) 仍含 A 和 B。外部 assetsRoot 使用裸 workspace watcher 的覆盖不足也在源码中存在，但本轮未模拟真实外部 watcher 行为，不把它冒充同等运行实测 | AUD-071 |
| R4-F07 | P1 | 冷查询不能及时取消。`languageProviders.ts:3899-3902` 先 await 全量 ensureStarted，之后才查 token；初始化扫描也没有查询 token。门住 readFile 后取消，经过两次宏任务仍未返回，放开文件读取才结束。此处是可确定的依赖等待，不声称实测了几分钟超时 | AUD-072 |
| R4-F08 | P2 | 等待期间关闭开关仍发布结果。`resolveDataDictSitesAtPosition` 只在 await 前查 enableDataDictIndex。读盘门住后关闭开关，再放行，F12 仍返回此前的 cfg 写点。开关变化没有代际保护 | AUD-073 |
| R4-F09 | P1 | 初扫到挂 watcher 之间有丢事件窗口。`globalDataIndex.ts:523-542` 扫完才创建 watcher。捕获 writer 字节后、读取完成前删除实际文件，此时 watcher 数为 0；放行后文件已不存在，索引仍发布一个写点。早挂监听或扫描后校验/重放是必要的 | AUD-074 |
| R4-F10 | P1 | 文档已变更仍按旧光标上下文发布跳转。`languageProviders.ts:3890-3904` 在 await 前算 access，之后不复核版本。冷发现期间 reader 从 cfg 改为 different、版本 1→2，getText 与 lineAt 都返回新内容，结果仍返回旧 cfg 的 writer | AUD-075 |
| R4-F11 | P1 | 每次编辑同步全文件重扫，绕过统一预算。`globalDataIndex.ts:498-499,624-641` 将所有 Python change 直接送 noteSaved→getKbeAliases→findKbeDataDictAccesses→倒排替换，没有合并窗、单文件预算或调度取消。3,720,016 字节、120,000 个访问点的合成文件单次调用 **292ms**，期间 setImmediate 无法执行，保留 120,000 个站点。初扫的“8 并发+逐文件 setImmediate”不约束此编辑路径，也不分割单个大文件 | AUD-076 |
| R4-F12 | P2 | from-import 被误当成模块绑定。`kbeModuleIndex.ts:304-312` 对 from KBEngine import Entity 也把 KBEngine 放进 aliases；新索引因此接受并不存在的 KBEngine.globalData 访问。Python AST 对照只绑定 Entity。共享 helper 也没有处理局部遮蔽，本轮只对 from-import 的具体错误作已验证结论 | AUD-077 |

## 架构判断与修正顺序

该功能的方向可行：单例共享索引、倒排查询、8 路初扫和编辑 revision 守卫都有价值，定义与引用也确实共用生产实例。现阶段的问题集中在又复制出一套独立的索引生命周期，第二轮已出现的脏文档回退、在飞变更丢失和根变化清理问题没有得到统一约束。只看初始化让路和已有单测，无法得出“默认开启后性能很好”。

建议按以下顺序处理，各项仍须独立打勾和提交：

1. **先挡住错误目标**：词法过滤、根命名空间和键语义归一。跨项目跳转、注释写点及字符串假访问必须停止；源位置需要允许“真实下标内的字符串键”，不能简单排除所有字符串位置。
2. **恢复索引一致性**：弃改关闭、change revision/追赶、启动监听窗口、根切换清理。这些应纳入可复用的索引生命周期约束，避免每个新索引重复发明事件协议。
3. **恢复交互边界**：冷查询等待可取消，源文档版本和启用代际在发布前复核。调用取消不必强制取消其他查询共享的全局初扫，但被取消的调用必须及时返回。
4. **接入编辑预算**：先合并编辑事件，再按文件大小和访问点数量安排后台/分阶段计算；取消旧代任务，不发布过期结果，倒排提交也纳入预算。只把整个同步循环包进 setImmediate 不能满足单次执行上限。
5. **最后扩展类型互推**：GLOBDATA-002 仍未完成，本轮不审核其未提交实现。依赖有污染的写点索引做类型 union，会进一步放大错误提示，应先修索引输入和生命周期。

## 性能结论的边界

本轮确认的是一次新增同步阻塞路径及冷查询等待问题。292ms 是单机合成大文件观察值，不能直接外推到每个真实项目，更不能宣称已找全 hover 十几分钟的原因。需要结合第二轮尚未修复的 worker 在飞预算、日志单轮同步读取等问题，最终用真实扩展宿主 profile 和请求分段耗时收敛主因。

GLOBDATA-001 是在原 280 项 IDE CSV 基线之后新增的任务，因此本轮不改写旧 CSV 来伪造新增项的历史状态；完成标记、反例和后续修复条件记录在 TODO 与本报告中。

## 复现

先将两个探针从本审计提交复制到固定基线 checkout 的同名路径，再从该 checkout 根目录（已具备 node_modules）执行；也可保留脚本原位并使用绝对脚本路径。探针按当前工作目录加载源码，只写入并清理临时文件：

```sh
node docs/perf/2026-10-30-audit-round4-globaldata-probes.cjs
node docs/perf/2026-10-30-audit-round4-more-probes.cjs
```

第一个脚本覆盖词法、键、跨根、关闭、在飞事件、取消和开关；第二个覆盖启动窗口、源版本、大文件编辑和 import 绑定。它们是固定历史基线的观察脚本，不作为应该永远通过的产品回归断言。上一轮见 [第三轮审计](./2026-10-30-completion-audit-round3.md)。
