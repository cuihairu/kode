# KSEM-DATA-01(SEM-042)复核共享数据现有接线 — 审计纪实

日期:2026-11-14。todo.md SEM-042(旧 KSEM-DATA-01):复核共享数据现有接线。验收:核实 globalData/baseAppData/cellAppData 的引用/跳转/类型消费和工程隔离;**已有功能只记录差距不重复实施**。

## 交付面

**`tests/globalDataIndexAudit.test.ts`**(9 例审计钉,零生产码改动)——四轴复核 + 差距钉,全部直接钉「当前真值」:

### 接线复核结论(现状全绿的部分)

1. **装配面**:单例 `GlobalDataDictIndex`(`src/activate/coreServices.ts:65` 构造+dispose 登记)注入四消费面——definition(`src/activate/languageServices.ts:330`)/ hover(`:192`)/ inlay(`:591`)/ references(`:680`)。一例单工作区内四处同时消费同键族(definition 跳写点 / references 全量 / hover 出类型+首写点 / inlay 出 union),单例语义即装配事实;
2. **开关面**:`kbengine.python.enableDataDictIndex`(package.json:2083,默认 true)→ `setPythonDataDictIndexEnabled` + 代际(`pythonDefinition.ts:44-60`,AUD-073 在飞代际拦截)。关闭时 definition/references 交回常规链(静默,不残结果);
3. **引用/跳转面**:读点 F12 → 首个写点;Shift+F12 同键族全量(**含自身读点**——无写点键返回自身位置,不是空数组,本批断言坑);注释假访问不触发;函数调用键(callFn)跨文件解析(函数定义表 + 引用方重扫,既有 GapArms 已钉);
4. **类型消费面**:读点 inlay = 同键写点值类型 union(同根 int+str 两写点 → `: int | str`,SEM-044 现状:联合已并、来源说明未做);推不出(空 `{}` / 调用式 RHS)诚实不出;
5. **工程隔离面**:双根同键不互链(AUD-068 根身份键 `siteKey(root, dict, key)`——根 B 的查询/类型只见根 B 的写点);三字典键空间互不相混(byKey 含 dict 维,baseAppData 写点不入 cellAppData 查询)。

### 差距账(记录在案,不实施——后续项归属)

| # | 差距 | 当前行为(实测) | 后续项 |
|---|------|----------------|--------|
| 1 | **三字典无补全面** | 全仓补全面零 `dataDictIndex` 消费(cellData 键补全有先例 `cellDataCompletion.ts:cellDataKeyCompletionContext`);键名补全/写入来源列表不存在 | SEM-043 |
| 2 | **del 归读点(无删除态)** | `del KBEngine.globalData["k"]` → `kind='read'`(探针实测);删除对可用性/类型的影响不表达 | SEM-045 |
| 3 | **`.get(k, default)` 的 default 丢弃** | `parseGetAccess` 只取首实参(defaults 不入面,`valueText` 恒 null);写 None + get 带 default 的读点显 `: None` 不显兜底类型 | SEM-045 |
| 4 | **进程域不收窄** | 引擎真源:globalData 全进程(`entity_app.h:419`)、baseAppData 仅 baseapp(`baseapp.cpp:461`)、cellAppData 仅 cellapp(`cellapp.cpp:200`);索引/查询无脚本角色过滤——scripts/base 读点与 scripts/cell 写点同键互链(`cellScriptRoleAndEntity` 角色先例只在 cellData 面) | SEM-045 |
| 5 | **hover 文案中文硬编码** | `hover.ts:720-724`(推导自本写点右侧表达式/读点 · 同键写点/首个写点)无 l10nText(仓内 l10n 机制在 `nlsRuntime`,配置 hover 等面已用) | 待排(非 DATA 车道验收项,记录在案) |
| 6 | **多写者「联合」已并、「来源说明/契约冲突」未做** | 读点 union 已并多写点类型(去重保序);写点来源列表/声明契约冲突检测不存在 | SEM-044 |
| 7 | **静态常量按真实绑定解析未做** | 键归一化:字面量→原值、标识符→名字、f-string→骨架+`*`;同名标识符恒当同一键值(值语义,按真实绑定解析未接) | SEM-043 |

## prove-red 说明

本批**零生产码改动**(复核批):prove-red 变异不适用——审计钉的证明力来自断言即当前真值(接线破坏/语义漂移即红);差距 2/3/4 的「当前行为」先经探针实证再钉(findKbeDataDictAccesses 直跑),不凭猜测写断言。

## 坑账

1. **references 含自身读点**:同键族=同字典内写+读点**含自身**——无写点键返回自身位置非空数组(`hit.sites.map` 命中即返回),断言勿写 `toBeNull`/`toEqual([])`;
2. **探针车道**:`findKbeDataDictAccesses` 必传 `aliases`(空集合=零访问点的诚实边界);`src/globalDataIndex.ts` 依赖 vscode 不能 tsx 直跑,纯逻辑探针走 `src/backend/globalDataIndexCore`;
3. **tsx 相对路径**:探针脚本放 /tmp 时 `./src/...` 解析 MODULE_NOT_FOUND——放仓库根或用绝对路径。

## 门禁

compile 0 / eslint 0 / vitest 全量(本批 +9 例审计钉)/ xvfb demo 25 RC=0(全量门禁数以跑批时点为准,见 todo.md 勾行)。
