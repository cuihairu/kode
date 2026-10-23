// 门 1 基准补齐实测(PERF-006..014;tests/perf 专用 bench 配置,不进 pnpm test 门禁):
//   KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/gate.bench.ts
//
// 覆盖 ph0-gate.md 门 1 四个可测缺口(其余缺口如实留白,见 docs/perf/2026-gate-baseline.md):
//   G1 激活期(首扫在途)冷请求:Hover / Python 补全 / 诊断端到端首采样;
//   G2 激活墙钟(activation → 首扫收尾);
//   G3-G5 热态多轮分布:Hover / 补全(.py self. 面 + .def 标签/类型面)/
//         诊断(.def 标量结构面 + entities.xml 清单面),5 轮 × 20 样本,
//         报聚合 P50/P95/P99/max + 逐轮中位(多轮中位口径,PERF-007/门1 缺口④);
//   G6 失效后首重查:.def 定向失效 → 映射重建墙钟 + 首次 hover 重查;
//      .py 变更失效 → 首次 hover 重查;
//   G7 全量扫描(large 30k .py)多轮墙钟(3 轮取中位,机械盘抖动口径,门1 缺口④);
//   G8 内存:激活期与扫描期进程峰值 RSS(process.memoryUsage().rss 25ms 采样,
//      绝对峰值与阶段增量双口径,门1 缺口③/§9.2 #8 内存子项)。
// 全程走真实 Provider 入口(KBEngineHoverProvider/KBEngineCompletionProvider/
// PythonCompletionProvider/validateDocument/validateEntitiesXmlDocument)+ 真实索引,
// 资产集与 PR1 基线同生成器同规模。输出行以 GATE-METRIC 前缀打印并落 gate-run.txt。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import {
  KBEngineCompletionProvider,
  KBEngineHoverProvider,
  PythonCompletionProvider,
  validateDocument,
  validateEntitiesXmlDocument
} from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { PythonClassIndex } from '../../src/pythonClassIndex';
import { resetScanRootCache } from '../../src/scanRoots';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-gate-assets');
const LARGE_FILES = Number(process.env.KODE_PERF_LARGE_FILES ?? '30000');

const OUT_FILE = process.env.KODE_GATE_OUT
  ?? path.resolve(__dirname, '../../docs/perf/gate-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const median = (samples: number[]): number => percentile(samples, 0.5);

const metric = (name: string, values: number[]): void => {
  emit(
    `GATE-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms max=${percentile(values, 1)}ms`
  );
};

/** 多轮分布:聚合全样本分位 + 逐轮中位数列表与其 median(多轮中位口径) */
const metricRounds = (name: string, rounds: number[][]): void => {
  metric(`${name}.all`, rounds.flat());
  const roundMedians = rounds.map(round => median(round));
  emit(
    `GATE-ROUNDS ${name} rounds=${rounds.length} ` +
    roundMedians.map((m, i) => `r${i}Median=${m}ms`).join(' ') +
    ` roundMedian=${median(roundMedians)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`GATE-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

/** 阶段 RSS 采样器:25ms 周期记录 process.memoryUsage().rss */
const startRssSampler = (intervalMs = 25): { stop(): number[] } => {
  const samples: number[] = [];
  const timer = setInterval(() => {
    samples.push(process.memoryUsage().rss);
  }, intervalMs);
  return { stop: (): number[] => { clearInterval(timer); return samples; } };
};

const rssReport = (name: string, samples: number[], phaseStartRss: number): void => {
  const peak = samples.length > 0 ? Math.max(...samples) : phaseStartRss;
  once(`${name}.peakRssMb`, mb(peak), ' MB');
  once(`${name}.peakRssDeltaMb`, mb(peak - phaseStartRss), ' MB');
};

/** 轮询直至条件成立(失效重建类异步面的确定性等待),返回等待墙钟 */
const waitFor = async (predicate: () => boolean, timeoutMs = 30000): Promise<number> => {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      return -1;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  return performance.now() - started;
};

/** ProviderResult 兜底计数(Promise/数组/null 三态统一按数组长度计) */
const countOf = (items: unknown): number => (Array.isArray(items) ? items.length : 0);

/** 诊断收集替身:记账最后一次发布条数(与 validateDocument 发布面对接) */
interface StubCollection {
  set(uri: unknown, items: unknown): void;
  delete(uri: unknown): void;
  lastCount(): number;
}

const makeCollection = (): StubCollection => {
  let last = 0;
  return {
    set: (_uri: unknown, items: unknown): void => {
      last = Array.isArray(items) ? items.length : 0;
    },
    delete: (): void => {
      last = 0;
    },
    lastCount: (): number => last
  };
};

describe('门 1 基准补齐:端到端冷/热多轮 + 内存 + 失效重查(large 30k)', () => {
  let largeRoot = '';

  const pointWorkspaceAt = (root: string): void => {
    resetScanRootCache();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const walk = (dir: string, suffix: string): string[] => {
      const found: string[] = [];
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return found;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git' && entry.name !== 'build' && entry.name !== 'third_party') {
            found.push(...walk(full, suffix));
          }
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          found.push(full);
        }
      }
      return found;
    };
    stubWorkspace.findFiles = async (pattern: unknown): Promise<Uri[]> => {
      const glob = String(pattern);
      const match = /\*\.(\w+)$/.exec(glob);
      if (!match) {
        return [];
      }
      return walk(stubWorkspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `.${match[1]}`)
        .map(file => Uri.file(file));
    };
  };

  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    emit(
      `GATE-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} largeFiles=${LARGE_FILES} assets=${ASSETS_OUT}`
    );
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  it('G1-G6:激活期冷请求 → 热态多轮分布 → 失效后首重查(含激活期 RSS)', async () => {
    pointWorkspaceAt(largeRoot);
    // 与 coldHover.bench 同口径:补 Avatar.py 的 onRpc0(def 声明 onRpc0..3,
    // py 侧 self+1 参过形参闸),hover/补全落在真实 def 标注链上。
    const avatarPath = path.join(largeRoot, 'scripts', 'base', 'Avatar.py');
    const avatarText =
      'class Avatar:\n' +
      '    def onEnterWorld(self):\n        return 0\n\n' +
      '    def onRpc0(self, arg):\n        return arg\n';
    fs.writeFileSync(avatarPath, avatarText, 'utf8');
    const avatarDefPath = path.join(largeRoot, 'scripts', 'entity_defs', 'Avatar.def');
    const entitiesXmlPath = path.join(largeRoot, 'scripts', 'entities.xml');
    const avatarDefRaw = fs.readFileSync(avatarDefPath, 'utf8');

    // .def 编辑缓冲:文件原文 + 追加一行「<Type> 」(类型补全语境)与「<」(标签补全语境)
    const defTypeDocText = avatarDefRaw + '\n  <Type> ';
    const defTagDocText = avatarDefRaw + '\n  <';

    const hoverDoc = makeTextDocument(avatarText, {
      fileName: avatarPath, languageId: 'python', uri: Uri.file(avatarPath)
    });
    const hoverPosition = new Position(4, 13); // onRpc0 方法名内
    const completionDoc = makeTextDocument(avatarText + '        self.', {
      fileName: avatarPath, languageId: 'python', uri: Uri.file(avatarPath)
    });
    const completionPosition = new Position(6, '        self.'.length);
    // 缺陷 .def 缓冲:根内注入未知 Flags/Type 值节点(保持 XML 合法,AST 可解析),
    // 诊断链确定产出 Error(默认开关 diagnostics.checkUnknownFlags=true)
    const defDefectDocText = avatarDefRaw.replace(
      '</root>',
      '  <Properties>\n    <x>\n      <Flags>NOT_A_FLAG</Flags>\n      <Type>NOT_A_TYPE</Type>\n    </x>\n  </Properties>\n</root>'
    );
    const defDefectDoc = makeTextDocument(defDefectDocText, {
      fileName: avatarDefPath, languageId: 'kbengine-def', uri: Uri.file(avatarDefPath)
    });
    Object.assign(defDefectDoc, { version: 1 });

    const defTypeDoc = makeTextDocument(defTypeDocText, {
      fileName: avatarDefPath, languageId: 'kbengine-def', uri: Uri.file(avatarDefPath)
    });
    const defTypePosition = new Position(defTypeDocText.split('\n').length - 1, '  <Type> '.length);
    const defTagDoc = makeTextDocument(defTagDocText, {
      fileName: avatarDefPath, languageId: 'kbengine-def', uri: Uri.file(avatarDefPath)
    });
    const defTagPosition = new Position(defTagDocText.split('\n').length - 1, '  <'.length);
    const entitiesDoc = makeTextDocument(fs.readFileSync(entitiesXmlPath, 'utf8'), {
      fileName: entitiesXmlPath, languageId: 'xml', uri: Uri.file(entitiesXmlPath)
    });
    // 版本令牌:有 version 才进 documentStore 同版本免重算口径(真实编辑器有版本)
    Object.assign(defTypeDoc, { version: 1 });
    Object.assign(entitiesDoc, { version: 1 });

    const collection = makeCollection();

    const phaseStartRss = process.memoryUsage().rss;
    once('G0.process.rssAtPhaseStartMb', mb(phaseStartRss), ' MB');
    const activationSampler = startRssSampler();

    const constructionAt = performance.now();
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const hoverProvider = new KBEngineHoverProvider(manager);
    const pyCompletion = new PythonCompletionProvider(manager);
    const defCompletion = new KBEngineCompletionProvider(manager);

    // G1:激活期(首扫在途)冷请求
    const coldHoverSamples: number[] = [];
    let coldHoverFirstHits = -1;
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      const hover = await hoverProvider.provideHover(hoverDoc, hoverPosition);
      coldHoverSamples.push(performance.now() - started);
      if (i === 0) {
        coldHoverFirstHits = hover ? 1 : 0;
      }
    }
    metric('G1.activation.coldHover', coldHoverSamples);
    once('G1.activation.coldHoverFirstHits', coldHoverFirstHits, ' hit');

    const coldCompSamples: number[] = [];
    let coldCompItems = -1;
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      const items = pyCompletion.provideCompletionItems(completionDoc, completionPosition);
      coldCompSamples.push(performance.now() - started);
      if (i === 0) {
        coldCompItems = countOf(items);
      }
    }
    metric('G1.activation.coldCompletionPy', coldCompSamples);
    once('G1.activation.coldCompletionPyItems', coldCompItems, ' items');

    const coldDiagStarted = performance.now();
    validateDocument(defTypeDoc, collection as never);
    once('G1.activation.coldDiagnosticsDef', performance.now() - coldDiagStarted);
    once('G1.activation.coldDiagnosticsDefItems', collection.lastCount(), ' items');
    const coldDiagDefectStarted = performance.now();
    validateDocument(defDefectDoc, collection as never);
    once('G1.activation.coldDiagnosticsDefDefect', performance.now() - coldDiagDefectStarted);
    once('G1.activation.coldDiagnosticsDefDefectItems', collection.lastCount(), ' items');

    // G2:激活墙钟(构造 → 首扫收尾)
    await manager.waitForInitialScan();
    once('G2.activation.initialScanCompletion', performance.now() - constructionAt);

    // 热态命中校验(补全/悬停确实出结果,不是空转)
    const warmHover = await hoverProvider.provideHover(hoverDoc, hoverPosition);
    once('G2.activation.warmHoverHits', warmHover ? 1 : 0, ' hit');
    const warmCompItems = pyCompletion.provideCompletionItems(completionDoc, completionPosition);
    once('G2.activation.warmCompletionPyItems', countOf(warmCompItems), ' items');
    const warmDefCompItems = defCompletion.provideCompletionItems(defTypeDoc, defTypePosition);
    once('G2.activation.warmCompletionDefItems', countOf(warmDefCompItems), ' items');

    // G3:热态 Hover 多轮(5 轮 × 20)
    const hoverRounds: number[][] = [];
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        await hoverProvider.provideHover(hoverDoc, hoverPosition);
        round.push(performance.now() - started);
      }
      hoverRounds.push(round);
    }
    metricRounds('G3.warmHover', hoverRounds);

    // G4:热态补全多轮(.py self. 面 + .def 类型/标签面)
    const compPyRounds: number[][] = [];
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        pyCompletion.provideCompletionItems(completionDoc, completionPosition);
        round.push(performance.now() - started);
      }
      compPyRounds.push(round);
    }
    metricRounds('G4.warmCompletionPy', compPyRounds);

    const compDefRounds: number[][] = [];
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        defCompletion.provideCompletionItems(defTypeDoc, defTypePosition);
        round.push(performance.now() - started);
      }
      compDefRounds.push(round);
    }
    metricRounds('G4.warmCompletionDef', compDefRounds);

    const defTagStarted = performance.now();
    const tagItems = defCompletion.provideCompletionItems(defTagDoc, defTagPosition);
    once('G4.warmCompletionDefTag', performance.now() - defTagStarted);
    once('G4.warmCompletionDefTagItems', countOf(tagItems), ' items');

    // G5:热态诊断多轮(.def 标量/结构面 + entities.xml 清单面;首查已在 G1 冷态)
    const diagDefRounds: number[][] = [];
    let diagDefItems = -1;
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        validateDocument(defTypeDoc, collection as never);
        round.push(performance.now() - started);
        if (diagDefItems < 0) {
          diagDefItems = collection.lastCount();
        }
      }
      diagDefRounds.push(round);
    }
    metricRounds('G5.warmDiagnosticsDef', diagDefRounds);
    once('G5.warmDiagnosticsDefItems', diagDefItems, ' items');

    const diagDefectRounds: number[][] = [];
    let diagDefectItems = -1;
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        validateDocument(defDefectDoc, collection as never);
        round.push(performance.now() - started);
        if (diagDefectItems < 0) {
          diagDefectItems = collection.lastCount();
        }
      }
      diagDefectRounds.push(round);
    }
    metricRounds('G5.warmDiagnosticsDefDefect', diagDefectRounds);
    once('G5.warmDiagnosticsDefDefectItems', diagDefectItems, ' items');

    const diagXmlRounds: number[][] = [];
    let diagXmlItems = -1;
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        validateEntitiesXmlDocument(entitiesDoc, collection as never);
        round.push(performance.now() - started);
        if (diagXmlItems < 0) {
          diagXmlItems = collection.lastCount();
        }
      }
      diagXmlRounds.push(round);
    }
    metricRounds('G5.warmDiagnosticsEntitiesXml', diagXmlRounds);
    once('G5.warmDiagnosticsEntitiesXmlItems', diagXmlItems, ' items');

    // G6:失效后首重查
    // ① .def 定向失效(PR4 A4-2 路径):变更 → 定向重解析 → 映射重建 → 首次 hover
    const defHandler = manager as unknown as {
      handleDefFileChanged(defPath: string, kind: string): void;
    };
    defHandler.handleDefFileChanged(avatarDefPath, 'change');
    const recoveryMs = await waitFor(() => manager.getMapping('Avatar') !== undefined);
    once('G6.defInvalidation.mappingRecovery', recoveryMs);
    const requeryStarted = performance.now();
    const requeryHover = await hoverProvider.provideHover(hoverDoc, hoverPosition);
    once('G6.defInvalidation.firstHoverRequery', performance.now() - requeryStarted);
    once('G6.defInvalidation.firstHoverRequeryHits', requeryHover ? 1 : 0, ' hit');
    const secondStarted = performance.now();
    await hoverProvider.provideHover(hoverDoc, hoverPosition);
    once('G6.defInvalidation.secondHoverRequery', performance.now() - secondStarted);

    // ② .py 变更失效(handlePythonFileChanged:强制重解析归属 def)→ 首次 hover
    const pyHandler = manager as unknown as {
      handlePythonFileChanged(pythonPath: string): void;
    };
    pyHandler.handlePythonFileChanged(avatarPath);
    const pyRequeryStarted = performance.now();
    const pyRequeryHover = await hoverProvider.provideHover(hoverDoc, hoverPosition);
    once('G6.pyInvalidation.firstHoverRequery', performance.now() - pyRequeryStarted);
    once('G6.pyInvalidation.firstHoverRequeryHits', pyRequeryHover ? 1 : 0, ' hit');

    // G8(激活期段):激活期进程 RSS 峰值
    const activationSamples = activationSampler.stop();
    rssReport('G8.activation', activationSamples, phaseStartRss);

    manager.dispose();
  }, 900000);

  it('G7-G8:全量扫描多轮墙钟(3 轮中位)+ 扫描期峰值 RSS + 删除失效首重查', async () => {
    pointWorkspaceAt(largeRoot);
    const scanStartRss = process.memoryUsage().rss;
    once('G0.process.rssAtScanPhaseStartMb', mb(scanStartRss), ' MB');
    const scanSampler = startRssSampler();

    const roundWalls: number[] = [];
    const roundPeaks: number[] = [];
    let lastIndex: PythonClassIndex | null = null;
    for (let r = 0; r < 3; r += 1) {
      const index = new PythonClassIndex();
      const started = performance.now();
      const classes = await index.findClassesByName('Avatar');
      const wall = performance.now() - started;
      once(`G7.fullScan.round${r}`, wall);
      once(`G7.fullScan.round${r}.hits`, classes.length, ' hits');
      roundWalls.push(wall);
      roundPeaks.push(process.memoryUsage().rss);
      lastIndex = index;
    }
    emit(
      `GATE-ROUNDS G7.fullScan rounds=3 ` +
      roundWalls.map((w, i) => `r${i}=${Math.round(w / 100) / 10}s`).join(' ') +
      ` roundMedian=${Math.round(median(roundWalls) / 100) / 10}s`
    );

    // G8:删除失效 → 首重查(索引仍持旧项 → 失效 → 旧类应 0 命中)
    const victim = path.join(largeRoot, 'scripts', 'base', 'gen', 'm0', 'Gen0.py');
    fs.rmSync(victim, { force: true });
    const invalidateStarted = performance.now();
    await lastIndex!.onFileChanged(victim);
    once('G8.deleteInvalidation.wall', performance.now() - invalidateStarted);
    const requeryStarted = performance.now();
    const remaining = await lastIndex!.findClassesByName('Gen0');
    once('G8.deleteInvalidation.firstRequery', performance.now() - requeryStarted);
    once('G8.deleteInvalidation.firstRequeryHits', remaining.length, ' hits');
    const kept = await lastIndex!.findClassesByName('Avatar');
    once('G8.deleteInvalidation.positiveRequeryHits', kept.length, ' hits');

    const scanSamples = scanSampler.stop();
    rssReport('G8.scanPhase', scanSamples, scanStartRss);
    emit(
      'GATE-METRIC G8.scanPhase.roundPeaksMb n=3 ' +
      roundPeaks.map(p => mb(p)).join('/')
    );
  }, 1500000);
});
