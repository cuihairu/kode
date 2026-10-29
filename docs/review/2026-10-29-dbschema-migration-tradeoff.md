# 数据库纯推导迁移取舍

- 日期:2026-10-29 · 基线:`1eda8ff`(IDE-RST-005 收口后)
- 来源:todo IDE-RST-006;范围评审修正建议 3 同源要求(收益不得以「解析行数更少」代替,须计含 IPC 的端到端耗时);输入对照 [2026-10-29-r2-index-inventory.md](2026-10-29-r2-index-inventory.md)(§2 现成、§4 缺口)。
- 对象:数据库 schema 纯推导面——SCH-001(`3873e32`)拆出的 `deriveDatabaseTables`(src/databaseSchemaCore.ts:205,纯函数不读配置/文件)与其上游快照管线 `getDatabaseSchemaSnapshot`(def/types.xml 解析→父链/Interfaces/组件合并→mysql 建表,LRU 缓存 SCH-002 `685fc24`)。
- 锁定:tests/rstDbSchemaTradeoffDoc.test.ts(章节/数字/缺口点名/IPC 结论方向)。

## 1. 调用面与缓存形态

与 messageTable(低频命令)不同,schema 面挂在**交互路径**上,但构建已被缓存/预热挪离交互路径:

- 属性 hover:describePropertyDatabaseStorage(languageProviders.ts:2012 消费)→ getDatabaseSchemaSnapshot 单源;SCH-007(`dbbe9a0`)验收已锁「连续悬停同实体不同属性不重复构建」——交互路径实际走的是 **LRU 缓存命中**,不是推导。
- 冷构建在后台:SCH-006(`8bfb370`)scheduleBackgroundSchemaWarmup(extension.ts:732 接线,waitForInitialScan 后逐实体入队,统一调度器限流,阶段闸可取消)。
- 虚拟文档/导航(SCH-010)读已发布快照;命令面(kbengine.database.open 等)同为按需。
- 即:交互时点的推导成本=缓存命中;缓存未热时的构建发生在后台任务,不占交互线程。

## 2. 输入缺口(相对 R2)

r2-index-inventory §4 已列(引用时按缺口计不按现成计):

- 【缺失】VS Code 配置:tablePrefix 等在 TS 配置面,Rust 索引无配置通道。
- 【缺失】项目布局与文件存在性:entities.xml 域位、types.xml 别名、脚本文件存在性——schema 合并(父链/Interfaces/组件)依赖这套布局发现,kode-root 只对齐了根发现。
- 【缺失】未保存缓冲区:def/types.xml 的脏文档版本参与快照过期判定(inputVersions 三轴),Rust 索引只吃磁盘文本。

推导本体(mysql 建表/FIXED_DICT 展开/数组子表)为纯函数,SCH-001/ARC-004(`f9948ac`)已拆出零 vscode 依赖核心——移植面存在,但上面三缺口是硬前置。

## 3. 含 IPC 的耗时对比

方法:2026-10-29 本机单轮,合成语料(真实 tmp 工作区:scripts/entities.xml+entity_defs/*.def+types.xml,UINT32/别名/ARRAY 混合,链上持久属性);TS 面=getDatabaseSchemaSnapshot 冷构建(清缓存)与缓存命中(同实体同根=同 URI/版本口径,50 次均值);Rust 面=kode-server(target/debug,经 kodeCoreClient stdio 通道)同 URI 同 version 重复请求 50 次往返(definition=最轻面 IPC 下界,diagnostic=解析+诊断面)。**单轮、合成语料;跨机器绝对值禁止比较(PERF-015)。**

| 面 | 数字 |
|---|---|
| TS 冷构建 S 链深 5×10 属性 | 18.25 ms |
| TS 冷构建 M 链深 10×20 属性 | 18.12 ms |
| TS 冷构建 L 单实体 100 属性 | 5.46 ms |
| TS 缓存命中(交互路径实付) | 0.047–0.298 ms/次 |
| Rust definition 往返(含 IPC) | avg 0.550 ms(min 0.384/max 2.586) |
| Rust diagnostic 往返(含 IPC) | avg 0.339 ms(min 0.284/max 0.450) |

读法:

- **交互面无收益,方向为负**:Rust 通道单次往返下界(0.339 ms)已不低于 TS 缓存命中实付(0.047–0.298 ms)——即使 Rust 侧推导零耗时,含 IPC 的总耗时也不优于现状,只会更慢。这正是验收要防的「以行数代替收益」:R2 解析更快不等于端到端更快。
- **可争的只有冷构建**(5–18 ms),但它已在后台预热(SCH-006)且被 LRU 摊销(SCH-002),不落在用户体感;把 18 ms 挪进 Rust 省下的量级不敌新增的 IPC、缓存一致性(版本三轴)与缺口三件的移植成本。
- Rust 侧当前**不存在 schema 推导面**,上表 Rust 数字是现有通道(definition/diagnostic)的实测下界,不是等价功能对拍——等价对拍在补齐 §2 缺口前不可执行,如实记录。

## 4. 采纳/暂缓结论

**暂缓迁移**。依据:

1. 含 IPC 的端到端判据为负:交互路径 TS 缓存命中 0.047–0.298 ms,Rust 单次往返下界 0.339 ms 起,迁移后交互面只慢不快。
2. 冷构建 5–18 ms 已由后台预热+LRU 摊销,无用户体感痛点。
3. 硬前置缺口三件(VS Code 配置通道/项目布局与文件存在性/未保存缓冲区),等价对拍在补齐前不可执行。

复评触发条件(任一满足即重开):

- 真实工程(千级实体/深链/大 types.xml)冷构建出现秒级或后台预热排队可感(现场证据,PERF-015 口径);
- R2 切流推进到门 2 golden 扩面需要 schema 面,且缺口三件已在此前批次补齐;
- 缓存/预热架构变更(如缓存撤销、预热移除)使交互路径重新直付构建成本。

若届时采纳,顺序:①配置与布局缺口先入 R2(VS Code 配置通道+entities.xml/types.xml 布局发现) → ②纯推导核心(databaseSchemaCore 纯函数)移植+SDK/审计式 golden 对拍(同输入恒同表列,SCH-001 测试面改喂双实现) → ③缓存与过期轴(版本三轴)定 IPC 侧口径——缓存留 TS 或下沉 Rust 须同笔定,否则交互面退化为每次往返。中途对拍不等即停,回到 TS 轨。
