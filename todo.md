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
| 8 实体依赖分析 | **偏差（已登记）** | `src/entityDependency.ts:164` 继承边正则只认 `<Parent><X/></Parent>` 元素形态，文本形态 `<Parent>X</Parent>` 引擎 `getKey` 同样装载（块 16 批 96 定性），文本形态 def 继承边丢失；按铁律未改功能代码，登记待后续批次收口 |
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
