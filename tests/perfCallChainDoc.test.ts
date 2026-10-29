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
  ['src/extension.ts', 698, "startLanguageServiceOperation('hover'"],
  ['src/extension.ts', 734, "startLanguageServiceOperation('definition'"],
  ['src/extension.ts', 793, "startLanguageServiceOperation('definition'"],
  ['src/extension.ts', 623, "startLanguageServiceOperation('completion'"],
  ['src/extension.ts', 1071, "startLanguageServiceOperation('completion'"],
  ['src/extension.ts', 434, "startLanguageServiceOperation('diagnostics'"],
  ['src/extension.ts', 447, "startLanguageServiceOperation('diagnostics'"],
  ['src/extension.ts', 1149, 'onDidChangeTextDocument'],
  ['src/extension.ts', 1189, 'flushQueued()'],
  ['src/languageProviders.ts', 675, 'getDocumentLines(document)'],
  ['src/languageProviders.ts', 751, 'provideHover('],
  ['src/languageProviders.ts', 1366, 'shadowCompareDefinition'],
  ['src/languageProviders.ts', 1425, 'export function validateDocument('],
  ['src/languageProviders.ts', 1449, 'shadowObserveDefDocument'],
  ['src/languageProviders.ts', 1458, 'validateEntitiesXmlDocument'],
  ['src/languageProviders.ts', 3922, 'provideDefinitionTracedImpl'],
  ['src/languageProviders.ts', 4275, '层0 接收者段闸'],
  ['src/languageProviders.ts', 4381, 'withInitialScanTimeout'],
  ['src/languageProviders.ts', 5795, 'provideCompletionItems('],
  ['src/diagnosticScheduler.ts', 211, 'requestQueued'],
  ['src/diagnosticScheduler.ts', 241, 'flushQueued'],
  ['src/hoverBudget.ts', 59, 'raceWithBudget'],
  ['src/documentStore.ts', 154, 'getDocumentLines'],
  ['src/pythonClassIndex.ts', 640, 'ensureCompositionRoots'],
  ['src/pythonClassIndex.ts', 1228, 'resolveClassBase'],
  ['src/pythonClassIndex.ts', 1340, '①② 两段查询']
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
