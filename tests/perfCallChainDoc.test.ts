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
const CITATION = /([A-Za-z][A-Za-z0-9_.-]*\.ts):(\d{1,5})\b/g;

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
  ['src/extension.ts', 1008, "startLanguageServiceOperation('hover'"],
  ['src/extension.ts', 1059, "startLanguageServiceOperation('definition'"],
  ['src/extension.ts', 1122, "startLanguageServiceOperation('definition'"],
  ['src/extension.ts', 926, "startLanguageServiceOperation('completion'"],
  ['src/extension.ts', 1420, "startLanguageServiceOperation('completion'"],
  ['src/extension.ts', 629, "startLanguageServiceOperation('diagnostics'"],
  ['src/extension.ts', 642, "startLanguageServiceOperation('diagnostics'"],
  // KODE-AUD-002:extension.ts C-19 诊断注释 +1 行(1326 后锚点随之 +1)
  ['src/extension.ts', 2144, 'onDidChangeTextDocument'],
  ['src/extension.ts', 2224, 'flushQueued()'],
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
  ['src/languageProviders.ts', 849, 'getDocumentLines(document)'],
  ['src/languageProviders.ts', 939, 'provideHover('],
  ['src/languageProviders.ts', 1778, 'shadowCompareDefinition'],
  ['src/languageProviders.ts', 1837, 'export function validateDocument('],
  ['src/languageProviders.ts', 1861, 'shadowObserveDefDocument'],
  ['src/languageProviders.ts', 1989, 'validateEntitiesXmlDocument'],
  ['src/languageProviders.ts', 4713, 'provideDefinitionTracedImpl'],
  ['src/languageProviders.ts', 5121, '层0 接收者段闸'],
  ['src/languageProviders.ts', 5227, 'withInitialScanTimeout'],
  // 2026-11-06:IDE-LINT-012 快速修复边界——languageProviders.ts 在 receiver
  // 守卫 provider 前新增 receiverFromDiagnosticLine helper(区间归属提取)+
  // 提取块重写,+31 行,7007 后锚点随之 +31(真位重探 7038;其余 languageProviders
  // 锚点均在 helper 之前,不受影响;出处随 baseline 锁步)。
  ['src/languageProviders.ts', 7038, 'provideCompletionItems('],
  // KR-AUD-04(DIA-1,2026-11-04):diagnosticScheduler.ts 统计面新增 errored
  // 字段(+4 行接口 +1 行初始化,全在诊断链锚点之前),本文件两个锚点 +5,
  // 出处随 baseline 锁步(baseline 的 :218/:248 本就指向注释行,越界面不受影响)
  ['src/diagnosticScheduler.ts', 228, 'requestQueued'],
  ['src/diagnosticScheduler.ts', 258, 'flushQueued'],
  ['src/hoverBudget.ts', 59, 'raceWithBudget'],
  ['src/documentStore.ts', 155, 'getDocumentLines'],
  ['src/pythonClassIndex.ts', 657, 'ensureCompositionRoots'],
  ['src/pythonClassIndex.ts', 1264, 'resolveClassBase'],
  ['src/pythonClassIndex.ts', 1376, '①② 两段查询']
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
