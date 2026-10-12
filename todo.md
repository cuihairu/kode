# TODO

> 生成于 2026-10-11（巡检发现本仓无 todo 文件，按仓内文档整理）。来源标注在每组前。
> 2026-10-11 续做单逐项执行完毕，状态与证据如下，待用户验证。

## Marketplace 发布（来源：PROJECT_SUMMARY.md 未完成项）
- [x] 准备 Marketplace 截图 — 6 张实机截图落 `docs/screenshots/`：def-highlighting / def-intellisense / entity-explorer / dependency-graph / log-viewer / monitoring-panel（Xvfb + 本地扩展实跑截取，非摆拍拼图）。README.md / README.zh.md 均未引用截图，按任务口径无需同步
- [ ] 发布到 VSCode Marketplace — **仅用户手动执行（发布红线）**：不打版本号 tag、不建正式 Release、不跑正式发版 workflow；版本号只能由用户手动给出并触发

## KBEngine 源码对照复核（来源：KBENGINE_SOURCE_AUDIT_PLAN.md，13 个功能块）
- [x] 12 号「日志收集与日志界面」降级核对 — **定案 b：不支持/未完成适配**。依据：插件 `connect()` 直接抛异常从不建 socket（`src/logCollector.ts:55-64`），701/703 魔数仅在不可达死助手中且无引擎出处（`src/logCollector.ts:164-184`）；引擎侧协议面为 `registerLogWatcher`/`deregisterLogWatcher`/`writeLog` 流消息（引擎仓只读核对 `kbe/src/server/tools/logger/logger_interface.h:57-63`），插件未实现注册或回包处理。`docs/guide/logging.md` 与 `README.zh.md` 已是如实口径，无需再改。定案已记入计划文档块 12
- [x] 1-13 号功能块逐块复核 — 对照表如下（依据 = 源码 file:line 或计划文档章节）：

| 块 | 结论 | 依据 |
|---|---|---|
| 1 .def 语法高亮 | 已对照 | 计划文档块 1；实机截图 `docs/screenshots/def-highlighting.png` |
| 2 .def 智能提示 | 已对照 | `src/languageProviders.ts:252-305` 触发条件；实机截图 `def-intellisense.png`（Flags 枚举 13 项含中文说明） |
| 3 .def 悬停说明 | 已对照 | `src/languageProviders.ts:352`（hover provider）、`:697`（批 117 interface hover 口径） |
| 4 .def 诊断与校验 | 已对照，计划文本滞后 | `src/defAnalyzer.ts:41-50` 实为 9 项检查（批 99/116 各增 1 项），计划文本仍记 6 项快照——已在计划文档块 4 补记，非功能偏差 |
| 5 .def 跳转定义 | 已对照 | `src/languageProviders.ts:477`（definition provider）、`:2015-2016`（Parent 跳转）；`src/definitionWorkspace.ts:588-600`（entities.xml 查找） |
| 6 Python↔def 映射 | 已对照 | 计划文档块 6；`src/entityMapping.ts`、`src/pythonLanguageUtils.ts` |
| 7 实体浏览器 | 已对照 | `src/definitionWorkspace.ts:1032-1034`（hasBase/hasCell/hasClient 仅认 `true`）；实机截图 `entity-explorer.png` |
| 8 实体依赖分析 | 偏差已收口（2026-10-12 巡检推进单） | 原 `src/entityDependency.ts:164` 继承边正则只认 `<Parent><X/></Parent>` 元素形态、文本形态 `<Parent>X</Parent>` 继承边丢失；已改 `resolveParentReferenceName` 对齐引擎 `loadParentClass`（entitydef.cpp:890）两种形态 + 大小写敏感口径，锁定用例 `tests/entityDependencyParentText.test.ts` + 纯函数 8 例，详见 `KBENGINE_SOURCE_AUDIT_PLAN.md` 块 8 与 `TESTING.md` 批 119 |
| 9 代码生成器 | 已对照 | 计划文档块 9；`src/codeGenerator.ts` |
| 10 服务器管理 | 已对照 | 计划文档块 10；`src/serverManager.ts` |
| 11 调试支持 | 已对照 | 计划文档块 11；`src/debugConfig.ts` |
| 12 日志收集与日志界面 | 已对照，定案 b | 见上条；实机截图 `log-viewer.png` 即如实降级状态 |
| 13 监控面板 | 已对照 | 计划文档块 13；实机截图 `monitoring-panel.png`（无 watcher 响应时仅 machine 基础状态的如实空态） |

## 导航与配置文档在途核对（来源：本轮巡检派单记录）
- [x] 核对此前派单是否全部落地（4/4 完成）：
  1. 最终配置默认开启 — 完成，commit `dbd65c5`（`package.json:403-412`：`kbengine.showFinalConfigOnOpen` 与 `kbengine.autoRefreshFinalConfig` 默认均为 `true`）
  2. configuration.md 逐字段重写 — 完成，commit `00f2cf3`（`docs/configuration.md` 逐配置项重写；同批含 features.md telnet 配置源纠错）
  3. features.md telnet 配置源纠错 5 处 — 完成，commit `00f2cf3`（telnet 端口来源由臆测改为源码可证实口径）
  4. CellMethods/Properties 导航补充口径四形态 — 完成，commit `d3711f5` + `5ecce25` + `3b45b67`（导航四档/四形态收口，`docs/language.md:127` 口径同步）

验收：真实验证（VSCode 实装截图 / pnpm 测试全绿 / 文档与代码一致），测试绿才 push，commit 英文简短。
本单改动范围：`docs/screenshots/`（新增 6 图）、`KBENGINE_SOURCE_AUDIT_PLAN.md`（3 处复核/偏差补记）、本文件；未动任何功能代码。

## 用户 2026-10-12 功能单登记（3 条，先登记后开工）

- [ ] **批122 数据库模拟** — 验收：① 规格先落文档，逐条带引擎 file:line（entity_table_mysql.cpp 的 syncToDB/init_db_item_name、entitydef.cpp 的 loadDefPropertys/loadInterfaces、datatypes.cpp 的 loadTypes，KBENGINE_SOURCE_AUDIT_PLAN.md 块19 已记部分照抄）；② 给定 def 树产出每张表的行数据模拟（结构列 id/sm_autoLoad/parentID、位置朝向列、组件子表、ARRAY/FIXED_DICT 展开、ENTITYCALL 不落列）；③ 支持增改删后的行变化预览与约束冲突提示（类型不符/缺列/重名）；④ 输出 mysql DDL + 行数据（JSON 或 SQL INSERT），可导出；⑤ 与真实引擎差异如实列（redis 后端不模拟、列序按文档序等已在块19 遗留登记的照抄）；⑥ 交付=产物路径 + 新增用例数与结果 + 用仓内真实 def 树跑出产物贴出 + 单 commit 英文简短。来源：用户 2026-10-12
  - 进度：引擎写库语义只读核对进行中（建表 DDL / INSERT-UPDATE 判定 / 各类型列映射）。
- [ ] **批123 网络包结构生成** — 验收：① 规格先写文档带引擎 file:line：utype 的语义（参数/方法类型标识）与编号（消息 id）分配规则，规格来源 = entitydef 消息面（Base/Cell 方法的 Arg/Utype/Exposed）与 messages.xml 类消息定义，不许凭印象；② 从 def 树产出包结构定义：每个客户端可见方法的参数序列、utype 序列、消息编号表，输出可机读 json 与可人读 markdown 表；③ 编号冲突/未定义引用报错（对齐引擎装载语义）；④ 与块9 代码生成器、块19 数据库 schema 同一份 def 解析结果复用，不建第三套解析器。来源：用户 2026-10-12
  - 进度：引擎 utype/Exposed/消息编号语义只读核对进行中。
- [ ] **批124 def 图形化架构流程图** — 验收：① 一个 .def 画出 client 通知 → baseapp → cellapp 的调用与自动同步关系，带方向线，优先动画；② 复用现有 def 解析（块1-9 同一份解析结果，不建第三套解析器）；③ 节点=实体+三个域分区（Client/Base/Cell），域内列方法与属性；④ 边的语义按引擎规则逐条给出处（源码 file:line）：Client→Base=ClientMethods 里 Exposed 的客户端通知/请求；Base→Cell=createCellEntity/AddCellEntity、CellMethods 调用；属性同步边按属性 Flags 位（OWN_CLIENT/OTHER_CLIENT/BASE_AND_CELL/CELL_PRIVATE 等）判定方向，自动同步用虚线或不同颜色，悬停说明写清「为什么是自动同步（哪个 flag）」；⑤ 客户端请求与服务器下行通知方向可区分（箭头方向+图例）；⑥ 形式=VSCode webview 内 SVG/HTML，支持导出，与块8 实体依赖图风格一致；⑦ 动画先做数据流动（沿边移动的点），成本过高降级为静态图+悬停高亮整条链路且降级写进文档；⑧ 交付=用仓内测试 def 生成图并截图入证据，每类边各至少一条在图上可辨，图例与 flag 说明写进 docs。来源：用户 2026-10-12
  - 进度：引擎 Flags 位值/同步方向、ClientMethods/Exposed、createCellEntity 调用点只读核对进行中。
