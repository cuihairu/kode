import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// A1-7「主要调用链图(Mermaid)」文档锁:docs/perf/2026-baseline.md §7 的四条
// 调用链(hover / definition / completion / diagnostics)是"真实路径取证"文档,
// 不是示意图——图上一处 file:line 一旦漂移,文档就在骗读者。此锁分两面:
// ① 结构面:四个 mermaid 块必须是 flowchart TD、节点标签引号配平、边只用
//   `-->` / `-.->`、等待点统一走 classDef waitPoint 虚线框且都进了 class 列表;
// ② 取证面:块内每个 `file.ts:NNN` 出处都要能解析到真实文件且行号不越界,
//   并逐个核对关键锚点行首仍是所引符号/注释(代码迁移即红,防文档悄悄过期)。
// 未覆盖项如实标注:完整 mermaid 语法解析另走脚本(mermaid dist 声明的
// dompurify 是幻影依赖,Node 侧要 resolve hook 兜底,不适合塞进测试门禁)。

const root = join(__dirname, '..');
const reportPath = join(root, 'docs', 'perf', '2026-baseline.md');
const report = readFileSync(reportPath, 'utf8');

const mermaidBlocks: string[] = [...report.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
  match => match[1].trim()
);

const NODE_LINE = /^([A-Za-z][A-Za-z0-9_]*)([[{(])(".+?)([\]})])\s*$/;
const EDGE_OPERATORS = ['-->', '-.->'];
const CITATION = /([A-Za-z][A-Za-z0-9_./-]*\.ts):(\d{1,5})\b/g;

const sourceLines = (relative: string): string[] =>
  readFileSync(join(root, relative), 'utf8').split('\n');

/** §7 四条链的承重锚点:行号 → 该行必须仍含所引符号(迁移即红) */
const ANCHORS: Array<[string, number, string]> = [
  // 2026-11-03:extension.ts 顶部新增三行 import(injectDebugpyListen /
  // runListeningRowFocus / makeProbeOne),§7 四条链的 extension.ts
  // 锚点与 docs/perf/2026-baseline.md 的出处整体 +3
  // 2026-11-03(二):extension.ts 新增 activateInferPipeline import(221)与
  // 装配行(4731,在全部锚点之后),§7 全部 extension.ts 锚点与出处 +1
  // KODE-AUD-001:extension.ts 测试访问器块 +14 行(427 前锚点) +
  // setProcessTopologySchedulerForTests 装配行 +1 行(1597 后锚点再 +1):
  // 549~1298 锚点 +14,1839/1913 锚点 +15
  // 2026-11-04:IDE-HOT-102 extension.ts 顶部新增两行 import(hotReloadChannelConfig
  // /hotReloadTransport),全部 extension.ts 锚点 +2(出处随 baseline 锁步)
  // 2026-11-04(二):KODE-PERF-001 流解析缓存——extension.ts 顶部新增 1 行
  // import(flowVersionKeyForDocument) + 诊断装配块 +6 行(723):723 前锚点
  // +1(566/579→567/580),723 后锚点 +7(821/903/954/1017/1315/1857/1931 各 +7)
  // 2026-11-05:KB-VER-002(31c3417)/KB-VER-004(d88a221) 与 IDE-GIT-001 的
  // 语言服务导入与命令装配行位移——languageProviders.ts 顶部 import +1(全部
  // 锚点 +1)、extension.ts 顶部 import/引擎版本建议装配 +10(全部锚点 +10),
  // §7 出处随 baseline 锁步
  // 2026-11-05(二):IDE-GIT-005 文件历史视图——extension.ts 顶部新增 5 行
  // import(gitHistoryTree 三符号),全部 extension.ts 锚点 +5(出处随 baseline 锁步)
  // 2026-11-05(三):IDE-GIT-006 版本 diff/内容——extension.ts 顶部新增 8 行
  // import(gitHistoryTree type GitHistoryItem + gitHistoryDiff 五符号),全部
  // extension.ts 锚点再 +8(出处随 baseline 锁步)
  // 2026-11-05(四):IDE-GIT-010 范围历史视图——extension.ts 顶部新增 8 行
  // import(gitRangeHistoryTree 四符号 + editorSelectionToRange),全部
  // extension.ts 锚点再 +8(出处随 baseline 锁步)
  // 2026-11-05(五):IDE-GIT-011 历史查询协调门——extension.ts 顶部新增 1 行
  // import(sharedGitQueryGate),全部 extension.ts 锚点 +1(本批已提交);
  // pythonClassIndex.ts 锚点保持 1233/1345(HEAD 口径)——并发会话在途 +9 未提交,
  // 非本批代码;该会话提交其 +9 时须把锚点再移到 1242/1354 并随 baseline 锁步。
  // 2026-11-05(六):积压锚点真位对账——KB-VER/KB-API/IDE-GIT/CFG 系列提交与
  // AUD-016(languageProviders.ts 定义派发后闸)累计位移未锁步,锚点红。逐符号
  // 真位重探:extension.ts 锚点 942/993/1056/860/1354→964/1015/1078/882/1376
  // (+22),599/612→605/618(+6,其后新增 +16),1896/1970→1918/1992(+22);
  // languageProviders.ts 非均匀位移 725/815/1623/1682/1706/1834/4475/4896/
  // 5002/6777→849/939/1778/1837/1861/1989/4713/5121/5227/7007(TYP-ARRAY/
  // NAV-PROP/KB-API 悬停面等多段新增);pythonClassIndex.ts 并发会话审计批次
  // (KR-AUD-26/28)落位 640/1233/1345→657/1264/1376。出处随 baseline 锁步。
  // 2026-11-05(七):KODE-CFG-006 entryScriptFile 断点预填——extension.ts 顶部
  // 新增 1 行 import(prefillEntryScriptBreakpoints),全部 extension.ts 锚点再
  // +1(965/1016/1079/883/1377/606/619/1919/1993,出处随 baseline 锁步)。
  // 2026-11-05(八):热更巷(RT-3/RT-9)——extension.ts 顶部 +1 行 import
  // (createDefStructuralGate),全部 extension.ts 锚点 +1(966/1017/1080/884/
  // 1378/607/620/1920/1994);其后 4718 附近共享 def 闸装配块 +10 与重试闸
  // 依赖块 +12 均在全部锚点之后,不再位移。出处随 baseline 锁步。
  // 2026-11-05(十):并入 main(IDE-GIT 守卫顶部 import)后全部 extension.ts 锚点再 +1;
  // 出处随 baseline 锁步(2026-baseline.md 同步)。
  // 2026-11-05(八):IDE-GIT 范围历史未保存守卫——extension.ts 顶部新增 1 行
  // import(rangeHistoryDirtyGuard),全部 extension.ts 锚点再 +1(出处随 baseline 锁步)。
  // 2026-11-05(九):IDE-LINT-007 只读写入诊断——extension.ts 顶部新增 5 行
  // import(readOnlyWriteDiagnostics 三符号),诊断集合块 +47 行(1669 后锚点),
  // 触发行 open/close/change 各 +1:567 前锚点全部 +5,1921/1995 锚点分别
  // +63/+65(真位重探:1984/2060,出处随 baseline 锁步)。
  // 2026-11-06:IDE-LINT-011 lint 规则注册表——extension.ts 顶部新增 1 行
  // import(renderLintRulesReport),全部 extension.ts 锚点 +1(真位重探
  // 973/1024/1087/891/1385/614/627/1985/2061,命令装配块在全部锚点之后不再
  // 位移;出处随 baseline 锁步)。
  // 2026-11-06(二):IDE-LINT-008 RPC 实参数量诊断——extension.ts 顶部新增
  // 5 行 import(rpcArgCountDiagnostics 三符号),全部锚点 +5;诊断装配块
  // (entityMapping 提升 + rpcArgCountItems +20)在 632 后,其后锚点再 +20:
  // 真位重探 998/1049/1112/916/1410/619/632/2010/2086,出处随 baseline 锁步。
  // 2026-11-06(三):IDE-LINT-009 角色错用诊断——顶部再 +5 行 import
  // (roleMisuseDiagnostics 三符号),全部锚点 +5;独立集合装配块 +54 在
  // 1415 后,其后锚点再 +54;open/close 触发 +2/+3、change 触发 +2 依次
  // 累计,onDidChangeTextDocument 锚点 +64、flushQueued 锚点 +66(flush
  // 触发 +2 在锚点后不累计):真位重探 624/637/921/1003/1054/1117/1415/
  // 2074/2152,出处随 baseline 锁步。
  // 2026-11-06(四):IDE-LINT-010 销毁后访问诊断——顶部再 +5 行 import
  // (postDestroyDiagnostics 三符号),全部锚点再 +5;独立集合装配块 +55
  // 在 1420 后,其后锚点再 +55;open/close 触发 +2/+3、change 触发 +2、
  // flush 触发 +2 依次累计,onDidChangeTextDocument 锚点 +70、flushQueued
  // 锚点 +72(flush 触发在两者之间):真位重探 629/642/926/1008/1059/1122/
  // 1420/2144/2224,出处随 baseline 锁步。
  // 2026-11-06(五):KR-AUD-78 来源镜真实行映射——extension.ts 顶部 +2 行
  // import(buildPythonTypeStubLineMap / buildEntityTypeStubLineMap),1309 处
  // python 来源镜装配块 +6 行,1309 前锚点 +2、其后锚点 +8(5389 处 entity
  // 来源镜装配块 +8 在全部锚点之后不再位移):真位重探 631/644/928/1010/
  // 1061/1124/1428/2152/2232,出处随 baseline 锁步。
  // 2026-11-06(六):KR-AUD-54 拓扑根随触发文档(48bccec)——1894/1913/1998
  // 三处闭包签名各 +1(2016/2028 行内改写无净增,2442 后 KR-AUD-55 块在锚点
  // 后不累计),onDidChangeTextDocument/flushQueued 锚点 +3:真位重探
  // 2155/2235,出处随 baseline 锁步;并发会话在途 extension.ts 未提交编辑
  // 不入本批校准,其提交时须自行再探。
  // 2026-11-06(七+八+九):并发合流——PY-ENV 二期 venv 自动发现(顶部 +13 行
  // import)与 CLONE-P5 玩家数据克隆(顶部 +10 行 import)先后落在 extension.ts
  // 顶部(前段锚点累计 +23);CFG-02 configContract 展开 +6 落在 1532,只推
  // 后段锚点(onDidChangeTextDocument/flushQueued)再 +6,前段锚点不再位移;
  // BG-WARM 后台预热顶部另 +2 行 import(backgroundWarmup / warmupStages)。
  // 逐符号真位重探(相对 origin/main 的 1043/1094/1157/961/1461/664/677/
  // 2330/2410,再叠加 BG-WARM +2):1045/1096/1159/963/1463/666/679/2332/2412,
  // 出处随 baseline 锁步。
  // 2026-11-06(十一):fileChangeMeta(方案 B)——extension.ts 顶部 import 由 1 行
  // 变 3 行(setJumpLogEnabled 保留,新增 createFileChangeMetaResolver /
  // logIndexFileChangeMeta,+2),python 索引订阅处新增解析器装配块 +13 与
  // 第二订阅者 +6(共 +19,落在 1159 与 1463 之间):
  // 1159 前锚点 +2(666/679/963/1045/1096→668/681/965/1047/1098),
  // 1159 本身 +2(→1161),其后锚点 +21(1463/2332/2412→1484/2353/2433),
  // 出处随 baseline 锁步。
  // 2026-11-06(十二):热更监视面批次——顶部再 +1 行 import
  // (createFileChangeRouter)+ activate 内 +2 行(捕获 setupKodeCoreGate 返回的
  // 门,给 §11.3 旁路投递口用),全部 extension.ts 锚点再 +3(真位重探
  // 671/684/968/1050/1101/1164/1487/2356/2436);路由表装配(约 5581)与
  // activate 返回的 registerFileChangeConsumer 都在全部锚点之后不再位移;
  // 出处随 baseline 锁步。
  // 2026-11-06(十三):ruff lint 批次(IDE-RUST-005)——顶部 import +7
  // (child_process execFile 1 行 + ruffLint 导入块 6 行),全部 extension.ts
  // 锚点再 +7(真位重探 678/691/975/1057/1108/1171/1494/2363/2443);ruff 接线
  // 本体(约 6861)在全部锚点之后不再位移;出处随 baseline 锁步。
  // 2026-11-06(十四):机器人控制批次(IDE-BOT-001)——TelnetWebView import 后
  // 新增 botsControl 导入块 5 行,全部 extension.ts 锚点再 +5(真位重探
  // 683/696/980/1062/1113/1176/1499/2368/2448);bots 命令装配(约 4269)在
  // 全部锚点之后不再位移;出处随 baseline 锁步。
  // 2026-11-09(HOT-VER 集成):状态栏版本号批次——extension.ts 顶部 import
  // +3(hotReloadSectionReader / readHotReloadSettings 各 +1,新增
  // hotReloadFileVersion +1),叠在 IDE-PYSPY-001 的 +2 之上:全部 extension.ts
  // 锚点 = PYSPY 批次真位再 +3(版本簿装配块约 5506 起,在全部锚点之后不再
  // 位移)。逐符号真位重探 685/698/982/1064/1115/1178/1501 →
  // 688/701/985/1067/1118/1181/1504,出处随 baseline 锁步。
  // 2026-11-07(DEMO-GAME-006):空工程脚手架批次——projectCreate import 1 行
  // 拆 3 行(createDemoGameProject + demoGameTemplate/demoGameScaffoldPrompt
  // 各 +1),全部 extension.ts 锚点再 +2(真位重探 690/703/987/1069/1120/
  // 1183/1506/2375/2455);命令装配块(约 6388 起)在 flushQueued 之后不再
  // 位移;出处随 baseline 锁步。
  // 2026-11-07(合并 origin/main):KODE-DBG-001(+1)、KODE-I18N-002(+1)与
  // KODE-CFG-009 配置消费通道接线(顶部 import +2 + activate 预取 +3 = +5)均
  // 作用于 extension.ts 顶部——全部 extension.ts 锚点按合并树真位重探
  // 683/696/980/1062/1113/1176/1499,出处随 baseline 锁步。
  // 2026-11-07(批B):C-22 def 属性只读视图 inlay——extension.ts 顶部 import +1
  // (366 行)与装配块 +10(1435 行),366 后锚点 +1、1435 后锚点 +11:真位重探
  // 684/697/981/1063/1114/1177/1510/2379/2459,出处随 baseline 锁步。

  ['src/extension.ts', 1063, "startLanguageServiceOperation('hover'"],
  ['src/extension.ts', 1114, "startLanguageServiceOperation('definition'"],
  ['src/extension.ts', 1177, "startLanguageServiceOperation('definition'"],
  ['src/extension.ts', 981, "startLanguageServiceOperation('completion'"],
  ['src/extension.ts', 1510, "startLanguageServiceOperation('completion'"],
  ['src/extension.ts', 684, "startLanguageServiceOperation('diagnostics'"],
  ['src/extension.ts', 697, "startLanguageServiceOperation('diagnostics'"],
  // KODE-AUD-002:extension.ts C-19 诊断注释 +1 行(1326 后锚点随之 +1)
  // 2026-11-06(五):KR-AUD 席 C——languageProviders.ts 悬停面两处改动(数据字典
  // 落点判定与 definition 同源 + findEventCalls 版本键缓存)使 1134/1516 之后的
  // 锚点整体 +12(真位重探 1778/1837/1861/1989/4713/5121/5227/7038 →
  // 1790/1849/1873/2001/4725/5133/5239/7050)。
  // 2026-11-06(六):IDE-PYSPY-001 extension.ts 顶部 import +2 行(PYSPY_RECORD_DEFAULTS/
  // runPyspySchedule 引入)→ 上列 9 处 extension.ts 锚点整体 +2(真位重探 683/696/980/
  // 1062/1113/1176/1499/2368/2448 → 685/698/982/1064/1115/1178/1501/2370/2450);
  // HOT-VER 再 +3(见上)→ 后段锚点 2373/2453;DEMO-GAME-006 再 +2(见上)→ 2375/2455。
  ['src/extension.ts', 2379, 'onDidChangeTextDocument'],
  ['src/extension.ts', 2459, 'flushQueued()'],
  // 2026-11-07(IDE-LIV-007):extension.ts 顶部 import +1(exceptionSourceLocator)
  // → 上列全部 extension.ts 锚点再 +1(真位重探 691/704/988/1070/1121/1184/1507/2376/2456),
  // LIV-007 命令装配约 5361 起在全部锚点之后不再位移;出处随 baseline 锁步。
  // 2026-11-07(KODE-CFG-009):配置消费通道接线——顶部 import +2(serverConfigResolve
  // 块 1 行 + profileConfigResolveOverrides 并入既有 profileDatabaseConnection import
  // 1 行),activate 门接线后预取 +3 行(注释 2 + void ensureConfigResolved 1)
  // → 全部 extension.ts 锚点再 +5;合并 origin/main 后真位已按合并树重探
  // 683/696/980/1062/1113/1176/1499/2368/2448(见上「合并 origin/main」条),
  // 连接读值接线(约 3040 起与 3217/3252/3300/3337 四命令 await)在全部锚点之后
  // 不再位移;出处随 baseline 锁步。
  // KODE-AUD-002:languageProviders.ts 顶部 import +1 行 + C-19 code 常量注释块
  // +6 行(6140 后锚点 +7,6140 前锚点 +1)
  // TYP-ARRAY(2026-11-04):languageProviders.ts 新增 def 属性类型推导 hover 面
  // (import + getLanguageFeatureConfig 注释 + 内建分支链接 + 独立异步面 +
  // resolveSelfPropertyAnnotationHover 方法 + locator 守卫),§7 的
  // languageProviders.ts 锚点按真位逐点重探(非均匀位移),出处随 baseline 锁步
  // NAV-PROP(2026-11-04):languageProviders.ts 移除 EntityMappingIndex import
  // (-1,行 41 后全部锚点 -1)+ F12 属性命中改 defLocation 优先 + 新增
  // providePythonPropertyReferences / enclosingPythonClassAt 方法面,§7 的
  // languageProviders.ts 锚点逐点重探:724/814/1622/1681/1705/1833/4474/4895/
  // 5001 各 -1,provideCompletionItems 6707→6776(非均匀),出处随 baseline 锁步
  // 2026-11-06(十五):属性先装载镜批次(IDE-PROP-001)——languageProviders.ts
  // 顶部 import +1(propertyInitOrderLens)+ getLanguageFeatureConfig 配置键 +3
  // (313)+ resolvePropertyLandingLine 导出注释 +1(3908)+ PropertyCodeLensProvider
  // provideCodeLenses 重构 +33(5693,双开关分流):3908 前锚点 +4,
  // 3908~5688 锚点 +5,其后锚点(provider 重构后)+38(真位重探 853/943/1794/
  // 1853/1877/2005/4730/5151/5257/7101);出处随 baseline 锁步(4691/5151/5257
  // 三处 baseline 原引 4673/5133/5133 系既有漂移,本批一并修到真位)。
  // 2026-11-07:C-21 KBEngine Python API 文档 hover——languageProviders.ts
  // 顶部 import +13(pythonApiHoverDocs 五符号 + hoverLocale 三符号)+
  // getLanguageFeatureConfig hover.apiDocs 配置键 +3(329)+ provideKnownHover
  // C-21 文档段 +22(1639)+ resolveBuiltinPropertyAnnotation B 触发追加段
  // +9:全部锚点非均匀位移,真位重探 871/961/1841/1900/1924/2052/4801/
  // 5209/5315/7159;baseline 原引 2018→2065、4691→4749 一并锁步。交付②第四类
  // 触发点(def 声明方法追加段)resolveDefMethodAnnotation +12:1360 后锚点
  // 再 +12(1852/1911/1935/2063/4812/5220/5326/7170),baseline 同步。
  ['src/languageProviders/inlay.ts', 42, 'getDocumentLines(document)'],
  ['src/languageProviders/hover.ts', 129, 'provideHover('],
  ['src/languageProviders/navigation.ts', 24, 'shadowCompareDefinition'],
  ['src/languageProviders/validation.ts', 13, 'export function validateDocument('],
  ['src/languageProviders/validation.ts', 37, 'shadowObserveDefDocument'],
  ['src/languageProviders/validation.ts', 165, 'validateEntitiesXmlDocument'],
  // 2026-11-06(十六):IDE-DB-001 持久字段容量说明——languageProviders.ts
  // describeTypeStorageShape 各形态分支附容量行,2776 后 +11;其后锚点
  // 随之 +11(真位重探 4741/5162/5268/7112;2005 前不受影响;出处随 baseline
  // 锁步)。
  ['src/languageProviders/pythonDefinition.ts', 303, 'provideDefinitionTracedImpl'],
  // 2026-11-06(六):二次并入 origin main(KR-AUD-84 引擎整串开关表在 4725 后
  // +13)——层0 接收者段闸/withInitialScanTimeout/provideCompletionItems 锚点
  // 再 +13(真位重探 5146/5252/7063,出处随 baseline 锁步)。
  ['src/languageProviders/pythonDefinition.ts', 711, '层0 接收者段闸'],
  ['src/languageProviders/pythonDefinition.ts', 817, 'withInitialScanTimeout'],
  // 2026-11-06:IDE-LINT-012 快速修复边界——languageProviders.ts 在 receiver
  // 守卫 provider 前新增 receiverFromDiagnosticLine helper(区间归属提取)+
  // 提取块重写,+31 行,7007 后锚点随之 +31(真位重探 7038;其余 languageProviders
  // 锚点均在 helper 之前,不受影响;出处随 baseline 锁步)。
  ['src/languageProviders/completion.ts', 633, 'provideCompletionItems('],
  // KR-AUD-04(DIA-1,2026-11-04):diagnosticScheduler.ts 统计面新增 errored
  // 字段(+4 行接口 +1 行初始化,全在诊断链锚点之前),本文件两个锚点 +5,
  // 出处随 baseline 锁步(baseline 的 :218/:248 本就指向注释行,越界面不受影响)
  ['src/diagnosticScheduler.ts', 228, 'requestQueued'],
  ['src/diagnosticScheduler.ts', 258, 'flushQueued'],
  ['src/hoverBudget.ts', 59, 'raceWithBudget'],
  ['src/documentStore.ts', 155, 'getDocumentLines'],
  ['src/pythonClassIndex.ts', 657, 'ensureCompositionRoots'],
  ['src/pythonClassIndex.ts', 1264, 'resolveClassBase'],
  // 2026-11-07:DEMO-GAME-001 夹具扩容——pythonClassIndex.ts 组合根缓存注释块
  // +8 行(1345 前锚点),1376→1384(出处随 baseline 锁步)
  ['src/pythonClassIndex.ts', 1384, '①② 两段查询']
  // 2026-11-06:KBE-CFG-001..005(2a87d77)工作区配置契约诊断——extension.ts
  // 顶部 import +4(1014 前锚点全 +4),activate 装配块 +136 落在 1432 之后:
  // onDidChangeTextDocument/flushQueued 锚点 +140(2155→2295/2235→2375);
  // languageProviders/diagnosticScheduler 等其余锚点经合并后真位复核不变
  // (本侧 6947a63 与 origin 9947c55 两路重探收敛同值)。出处随 baseline 锁步。
  // KODE-ARCH-001(2026-11-07):languageProviders.ts 纯移动拆分为
  // src/languageProviders/* 子模块——languageProviders.ts 锚点随拆分轮次逐轮
  // 真位重探到新模块文件,出处随 baseline 锁步;行映射由拆分脚本机械推导,
  // 零行为变更。
];

describe('perf baseline §7 调用链图结构面', () => {
  it('四条调用链的 mermaid 块齐备且都是 flowchart TD', () => {
    expect(mermaidBlocks.length).toBe(4);
    mermaidBlocks.forEach((block, index) => {
      expect(block.split('\n')[0].trim(), `第 ${index + 1} 块缺 flowchart 头`).toBe('flowchart TD');
    });
    expect(report).toContain('## 7. 主要调用链图');
    for (const heading of ['### 7.1 Hover', '### 7.2 Definition', '### 7.3 Completion', '### 7.4 Diagnostics']) {
      expect(report, `缺小节 ${heading}`).toContain(heading);
    }
  });

  it('标签引号配平、边只用 -->/-.->、每块等待点都进 class 列表', () => {
    const problems: string[] = [];
    mermaidBlocks.forEach((block, index) => {
      const quoteCount = (block.match(/"/g) ?? []).length;
      if (quoteCount % 2 !== 0) {
        problems.push(`块${index + 1} 双引号 ${quoteCount} 个,未配平`);
      }
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'flowchart TD') continue;
        if (trimmed.startsWith('classDef ') || trimmed.startsWith('class ')) continue;
        if (NODE_LINE.test(trimmed)) continue;
        if (trimmed.includes('-->') || trimmed.includes('-.->')) {
          const pipes = (trimmed.match(/\|/g) ?? []).length;
          if (pipes % 2 !== 0) {
            problems.push(`块${index + 1} 边标签竖线未配平: ${trimmed}`);
          }
          continue;
        }
        problems.push(`块${index + 1} 不识别的行: ${trimmed}`);
      }
      const classLine = block.split('\n').find(line => line.trim().startsWith('class '));
      if (!/classDef waitPoint fill:#fff3cd/.test(block)) {
        problems.push(`块${index + 1} 缺 waitPoint 虚线框样式`);
      }
      if (!classLine || !/waitPoint/.test(classLine)) {
        problems.push(`块${index + 1} 没有把等待点编入 class 列表`);
      }
    });
    expect(problems, `mermaid 结构问题: ${problems.join('; ')}`).toEqual([]);
    expect(EDGE_OPERATORS.length).toBe(2);
  });
});

describe('perf baseline §7 调用链图取证面', () => {
  it('块内每个 file.ts:NNN 出处都能解析且不越界', () => {
    const unresolved: string[] = [];
    for (const block of mermaidBlocks) {
      let match: RegExpExecArray | null;
      CITATION.lastIndex = 0;
      while ((match = CITATION.exec(block)) !== null) {
        const [citation, file, rawLine] = match;
        let lines: string[];
        try {
          lines = sourceLines(`src/${file}`);
        } catch {
          unresolved.push(`${citation}(文件不存在)`);
          continue;
        }
        const line = Number(rawLine);
        if (line < 1 || line > lines.length) {
          unresolved.push(`${citation}(该文件仅 ${lines.length} 行)`);
        }
      }
    }
    expect(unresolved, `过期/越界出处: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('承重锚点行首仍是所引符号(迁移即红)', () => {
    const drift: string[] = [];
    for (const [relative, line, expected] of ANCHORS) {
      const actual = sourceLines(relative)[line - 1] ?? '';
      if (!actual.includes(expected)) {
        drift.push(`${relative}:${line} 期望含「${expected}」,实际「${actual.trim() || '(空行)'}」`);
      }
    }
    expect(drift, `锚点漂移: ${drift.join('; ')}`).toEqual([]);
  });
});
