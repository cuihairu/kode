# messageTable 迁移取舍

- 日期:2026-10-29 · 基线:`e965991`(IDE-RST-004 收口后)
- 来源:todo IDE-RST-005;范围评审「R2.5 模块边界核对」messageTable 行(其「无产品调用点」结论已过时,§1 更正);输入对照 [2026-10-29-r2-index-inventory.md](2026-10-29-r2-index-inventory.md)(§2 现成、§4 缺口)。
- 对象:`src/messageTable.ts`(引擎装载语义模拟器:loadDefInfo 装配序、utype/aliasID 全局计数器、冲突与溢出检查)+ 两命令面 `kbengine.messagetable.preview`/`kbengine.messagetable.export`(extension.ts:1921/1945,SDK-001 `98f4a06` 与 SDK-002 `8065b95` 接线,共用 buildEntityMessageTable extension.ts:1895)。
- 锁定:tests/rstMessageTableTradeoffDoc.test.ts(章节/数字/配置事实/装配缺口/结论形态)。

## 1. 产品调用频率

- 调用点恰两处命令,均为**用户手动触发**的按需单实体计算:quickpick 选实体名 → 构建一次 → markdown 预览或 JSON 导出;先 `waitForInitialScan`,不在 hover/补全/诊断等交互路径上。
- 范围评审(2026-10-27)写「messageTable 无产品调用点」,该结论在评审时点为真、SDK-001/002 接线后**已过时,更正为:低频命令面存在**(评审早于 98f4a06/8065b95)。
- 每次命令调用新建 `createDefinitionSemanticsLoader(getIndexScanRoots())`,缓存不跨命令;首次构建含 def 文件冷读盘。无后台/定时/事件触发路径,无 workspace 级全量批算。

## 2. types.xml 与 alias 配置

- `MessageTableOptions { aliasIdEnabled?: boolean; typesXml?: string }`(messageTable.ts:78);**产品接线 `buildMessageTable(entityName, source)` 不传 options**(extension.ts:1903)——即:
  - `aliasIdEnabled` **恒 false**(on 臂只有测试覆盖)。与引擎默认一致:entitydefAliasID 引擎默认关;但用户在引擎侧开了该配置时预览不跟随——这是**产品配置接线欠账**,与迁移决策正交,若要如实对引擎先补产品配置面而不是迁 Rust。
  - `typesXml` **未喂**:messageTable.ts:395 `options.typesXml !== undefined` 门不通过,loadTypesXml 不执行,types.xml 用户类型不进编号 registry(基元 21 条照 DataTypes::initialize 装载序固定);类型面按「无 types.xml」口径推演。
- 迁移含义:Rust 侧要复刻这两面,还得先解决「VS Code 配置进入 Rust 索引」的通道(r2-index-inventory §4 已把 VS Code 配置列为【缺失】)。

## 3. 装配语义成本

messageTable 的成本不在解析,在**装载语义模拟本体**(全部从引擎源码逐行对齐而来):

- 装配序照 entitydef.cpp loadDefInfo:本 def 全量(Properties→CellMethods→BaseMethods→ClientMethods)→ Interfaces 声明序逐个并入(仅属性+方法,不递归)→ Components(独立 ScriptDefModule,全局缓存)→ Parent 递归;组件模块不并入表(其 utype 依赖 entities.xml 全局装载序,静态不可定,表不含)。
- 方法 utype:显式 `<Utype>` 登记已用集 / 未设置从 g_methodUtypeAuto(1) 取最小未占 / 冲突报错 / uint16 溢出(METHOD_UTYPE_MAX 65535)。
- aliasID:仅 entitydefAliasID 开时分配,属性从 4 起(1-3 保留 position/direction/spaceID)、ClientMethods 从 1 起、名字升序、超 255 回退 -1。
- 真值表面:PRIMITIVE_TYPE_UTYPES 21 条(装载序对拍 kbengine@f85ad81,SDK-005 `796db26` 审计面 src/sdkMessageNumberAudit.ts 可直接作 Rust parity golden 底座)、LIMITED_PROPERTY_NAMES(含引擎原表缺逗号拼接实效「componentdatabaseID」等照实收录)。

R2 输入缺口(r2-index-inventory §4,引用时按缺口计不按现成计):**消息编号规则与 def 树装配顺序缺失**——MethodDef 仅 name/name_span/line/args/exposed 五字段,无 `<Utype>` 值;无 Interfaces 并入、无组件模块语义、无全局计数器模拟。即迁移需在 Rust 侧**重建整个语义模拟器**,而非复用现有索引。

实测(2026-10-29 本机单轮,合成语料,真实 tmp 工作区+产品同构 loader 路径,探针已删;跨机器绝对值禁止比较,PERF-015):

| 语料 | build | methods | issues |
|---|---:|---:|---:|
| S 链深 5×40 方法×10 属性 aliasId=off | 41.05 ms | 200 | 280 |
| M 链深 10×100 方法×20 属性 aliasId=off | 65.52 ms | 1000 | 1440 |
| M-alias 同上 aliasId=on | 43.65 ms | 1000 | 1440 |
| L 单实体 500 方法×100 属性 aliasId=off | 23.53 ms | 500 | 0 |

读法:单实体构建几十毫秒级(含冷 loader 读盘与 Parent 链全量装配);aliasId 开不劣化。链语料 issues 非零是合成退化形态(链上级重声明同名触发冲突检查如实)。

## 4. 采纳/暂缓结论

**暂缓迁移**(与 RST-004 defAnalyzer 同判)。依据:

1. 成本面不痛:命令触发低频批通道,单实体几十毫秒,无交互阻塞面。
2. 语义移植量大而收益无着:Rust 侧无编号规则、无 `<Utype>` 字段、无装配序,等于重建整个模拟器;TS 面已被 SDK-005 真实引擎审计咬合(基元装载序对拍 kbengine@f85ad81),重写要重新挣回这份置信度。
3. 配置面先欠着:aliasIdEnabled/typesXml 产品接线未喂,迁 Rust 前还得先解决配置进索引的通道。

复评触发条件(任一满足即重开):

- messageTable 进入交互面(如 hover 展示 utype/编号)或出现全仓实体批量导出进命令/CI;
- 真实工程语料上单实体构建出现可感卡顿(现场证据,PERF-015 口径);
- R2 切流推进到门 2 golden 扩面需要消息表面。

若届时采纳,顺序:①编号规则与 `<Utype>` 字段先入 R2 模型(MethodDef 扩字段+全局计数器语义) → ②parity golden 用 SDK-005 审计序(f85ad81)对拍基元装载 → ③loadDefInfo 装配序模拟整体移植(Interfaces/组件/Parent 递归),aliasId/typesXml 配置通道同笔定。中途对拍不等即停,回到 TS 轨。
