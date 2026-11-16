# RUST-229 验收纪要:可禁用重扫描/索引的配置与禁用后「部分不可用」标注

日期:2026-11-17。本纪要对账 RUST-229(旧 UI-012,主 todo 排队项)的验收口径与交付证据。结论:**配置维部分既有(两个键索引开关早已存在且可即时生效),标注维是真缺口(禁用后消费面全部静默跳过零提示),本批以双标注点收口——hover 键位禁用说明(即时)+ profileHealth 第六类问题(汇总+修复入口)。**

## 侦察账本(全仓禁用面盘点)

- **无 rescan 禁用配置**:quickActions 扫描/日志扫描均为纯手动命令(用户主动触发,不存在"禁用自动重扫"的语义);globalDataIndex 自动但此前无开关之外的可禁用项。
- **既有禁用开关(配置维已存在)**:`kbengine.python.enableDataDictIndex` / `kbengine.python.enableSpaceDataIndex`(默认 true);`extension.ts` affectsConfiguration 即时生效(setPythonDataDictIndexEnabled/setSpaceDataIndexEnabled)。
- **真缺口**:禁用后消费面(hover/typeInlayHints/补全/定义/引用)全部静默 early-return——用户主动关掉键扫描后,相关结果在界面上零说明,部分不可用状态不可见。

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 记录可禁用的配置 | 两开关在设置页既有条目(默认开);profileHealth 汇总把「禁用态」作为可发现问题列出,键名/修复入口直指设置 | 本批 `src/profileHealth.ts` 第六类 `index-disabled`(逐开关一项,entry kind='setting' target=对应键) |
| 禁用后标明结果部分不可用 | ①hover:开关关闭时光标命中数据字典键位给机制说明(键名+开关名+「类型/写点位置结果不可用,相关视图可能部分不可用」+重开指引);非键位零打扰;不触发懒建不查索引;②profileHealth:两开关禁用各登记一条「部分不可用」问题 | 本批 `src/languageProviders/hover.ts`(禁用标注分支,共享 dictAccess 口径不动,本地重算落点)+`src/profileHealth.ts`;钉 `tests/hoverGapArms.test.ts`/`tests/profileHealth.test.ts` 各新例 |

## 本批增量(feat)

- `src/languageProviders/hover.ts`:禁用标注分支——条件(languageId=python && dataDictIndex 装配 && 开关关 && 键位命中 && 非行内注释);MarkdownString 含键标签/开关名/部分不可用/重开指引;置于共享 dictAccess 判定之后(manager 系分支之前,机制说明优先)。
- `src/profileHealth.ts`:`ProfileHealthIssueKind` 五类→六类(+`index-disabled`,LABELS「索引开关已禁用」);deps 增 `indexToggles?` 探针(缺省/返回 null=面不可用,如实不判定,向后兼容);collectProfileHealth 末位追加检测(顺序固定尾位);showProfileHealthSummary 缺省探针现读两键(与 hover/补全/定义引用同源口径)。
- 新钉测试 3 例:profileHealth 两开关全关逐项登记+setting 入口/全开·缺省·null 不登记;hoverGapArms 禁用键位标注+非键位零打扰。
- prove-red:变异 hover 禁用分支文案 → 红(断言「部分不可用」缺失,收到 MUTATED-ARM)→ cp+cmp 字节还原;变异 profileHealth spaceData 检测(false && 短路)→ 红(toHaveLength(2) got 1)→ cmp 还原。
- 门禁:lint 0 / compile 0 / unit 10659 全绿(10656+3);ANCHORS(perfCallChainDoc 覆盖 hover.ts)零漂。

## 诚实条款

- **spaceData 无 hover 面**:空间数据索引的即时标注不落 hover(hover 只有数据字典键位面);其禁用可见性由 profileHealth 汇总承载(含 setting 入口),如实记账。
- **runtimeQuery.enabled 不在本面**:其禁用已有提示(errStreamDisabled),且属轮询面非重扫/键索引面。
- **手动命令(quickActions 扫描/日志扫描)不需要禁用配置**:用户主动触发即知情,无"静默部分不可用"问题,不造开关(不造轮子判例)。
- 禁用标注是**机制说明**而非数据:不给类型/写点(索引关着就是查不到),只给「哪里关的、少了什么、怎么开回来」。
