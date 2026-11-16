# RUST-187 验收纪要:Project Doctor 五项体检——四项既有交付 + 索引状态补齐

日期:2026-11-17。本纪要对账 RUST-187(旧 KBE-017,主 todo 排队项)的验收口径与交付证据。结论:**缺少引擎路径/Python 环境/错误 root 顺序/重复实体四项均为既有交付;索引状态为真实缺口,本批补齐(profileHealth 第五类「索引停滞」+调度面同源探针)后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 缺少引擎路径 | profileHealth `engine-missing`:engineRoot 未记录或不在盘上,入口=重新导入识别 | `src/profileHealth.ts`(IDE-PRJ-009);`tests/profileHealth.test.ts` |
| Python 环境 | `interpreter-missing`(未记录/不在盘,入口=设置键)+ `service-unavailable`(PRJ-005 三态判定,collectPythonServiceFacts 同源采集,入口=语言服务状态命令) | 同上;`tests/engineProfile.test.ts` |
| 错误 root 顺序 | `roots-ambiguous`:assetsRoot 不在盘上(profile 根定位失效),收集顺序固定首位 | `src/profileHealth.ts`;活动 profile 经 PRJ-010 稳定 ID 解析 |
| 重复实体 | Project Doctor(`kbengine.project.doctor`)跨文件 def 语义报告:defAnalyzer 语义问题族含 `duplicate-definition` / `duplicate-type-tag`(重名 def/重复 type tag),errors/warnings 分列输出面板 | `src/activate/utilityCommands.ts`(doctor 命令);`src/backend/defReferenceGraph.ts`(buildProjectDoctorReport);`src/backend/defAnalyzer.ts`;`tests/projectDoctorCommand.test.ts` |
| 索引状态(本批补齐) | profileHealth 第五类 `index-stalled`(索引停滞):探针=IndexScheduler.getStatus 同源计数,`failed>0`(有终态失败任务)才报,消息带 失败/排队/运行 三计数,入口=`workbench.action.reloadWindow`(重启窗口重建索引);failed=0 且排队/运行中=正常推进零打扰;探针缺省或 null=面不可用如实不判定;收集顺序固定末位(根歧义→缺引擎→缺解释器→缺语言服务→索引停滞);产品接线:`kbengine.profile.health` 传入 `indexScheduler.getStatus()` | **本批** `src/profileHealth.ts` + `src/activate/utilityCommands.ts` + `tests/indexStatusHealth.test.ts`(5 例) |

## 本批增量

- `src/profileHealth.ts`:`ProfileHealthIssueKind` + `'index-stalled'`;`ProfileHealthDeps`/`ProfileHealthSummaryDeps` + 可选 `indexStatus` 探针(结构化 Pick<SchedulerStatus, 'failed'|'queued'|'running'>);收集函数末位追加索引检查。
- `src/activate/utilityCommands.ts`:`kbengine.profile.health` 命令注入 `indexStatus: () => indexScheduler.getStatus()`(调度面已在 deps,零新装配)。
- `tests/indexStatusHealth.test.ts`(新,5 例):failed>0 报停滞带三计数与入口 / failed=0 排队运行零打扰 / 探针缺省与 null 不冒充 / 五类顺序末位 / 真调度器失败任务驱动判定(enqueue 抛错→getStatus().failed=1→停滞在册)。
- prove-red 双变异(消息计数断言『失败 2』→『失败 3』红;调度集成断言 failed=1→2 红),cp+cmp 字节还原。
- `IndexScheduler.getStatus` 零改动(计数面既有,SchedulerStatus 形状不动)。

## 诚实条款

- 「重复实体」的形态是 **def 语义层重复**(duplicate-definition/type tag,跨文件引用图),不是 entities.xml 里同名实体项的XML级查重;后者若有独立需求应另批登记,不冒充已覆盖。
- 「索引状态」的形态是**调度器终态计数**(failed/queued/running),不是索引内容健康度(覆盖率/新鲜度);后者无既有面,未实现不宣称。
- 索引停滞的恢复入口是重启窗口(重建索引的标准工作台动作),没有「单任务重跑」命令——如实给现有入口,不虚构精细恢复面。
- 门禁附记:lint 0 / compile 0 / unit 全量 10619 过,唯一红=hoverDeadlineContext 时序断言(墙钟单调递减,满载抖动族)solo 10/10 绿定案;ANCHORS 表不含 utilityCommands.ts/profileHealth.ts 行号锚,零位移。
