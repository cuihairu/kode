// KODE-PERF-007 v0.2 最新性能基线(tests/perf 专用 bench 配置,不进 pnpm test 门禁):
//   KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/v02Baseline.bench.ts
//
// 在**当前树**(TS+Rust 合体线 v0.2)上建立自洽基线,量测面 = 真实 Provider 入口
// (KBEngineHoverProvider / KBEngineCompletionProvider / PythonCompletionProvider /
//  KBEngineDefinitionProvider / PythonDefinitionProvider / validateDocument /
//  validateEntitiesXmlDocument)+ 真实索引(EntityMappingManager / PythonClassIndex)。
//
// 覆盖任务要求的六维 × 三场景:
//   场景 large-30k(30,005 文件)/ multi-root(3 独立资产根 root_a|b|c)/ big-py(8000 方法单文件);
//   维度 Hover / Completion / Definition / Diagnostics / 内存(RSS)/ 宿主延迟。
// 每场景冷(构造后首扫在途)与热(EntityMappingManager 首扫收尾 / PythonClassIndex 全量扫描收尾)
// 两态:热态每指标 5 轮 × 20 样本报 P50/P95/P99/max(与 gate.bench 口径一致)。
//
// 宿主延迟口径:Provider 调用耗时 = 宿主事件循环阻塞段(全部在宿主线程执行);
// 启动延迟 = 激活墙钟(构造→def 首扫收尾)+ 全量 .py 扫描墙钟。
// 输出行以 V02-METRIC 前缀打印并落 docs/perf/v02-baseline-run.txt。只观测不改行为。

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
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  validateDocument,
  validateEntitiesXmlDocument
} from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { PythonClassIndex } from '../../src/backend/pythonClassIndex';
import { resetScanRootCache } from '../../src/scanRoots';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-v02-assets');
const LARGE_FILES = Number(process.env.KODE_PERF_LARGE_FILES ?? '30000');

const OUT_FILE = process.env.KODE_V02_OUT
  ?? path.resolve(__dirname, '../../docs/perf/v02-baseline-run.txt');
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

const metric = (name: string, values: number[]): void => {
  emit(
    `V02-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms max=${percentile(values, 1)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`V02-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

/** 阶段 RSS 采样器:25ms 周期记录 process.memoryUsage().rss(与 gate 口径一致) */
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

/** 文本中首次出现 needle 所在 (行,列)(0 基;列指向 needle 首字符)。 */
const lineColOf = (text: string, needle: string): { line: number; char: number } => {
  const idx = text.indexOf(needle);
  if (idx < 0) {
    return { line: 0, char: 0 };
  }
  const before = text.slice(0, idx).split('\n');
  return { line: before.length - 1, char: before[before.length - 1].length };
};

/** entities.xml 中 `<tag` 元素名内位置(光标落在名字中间)。 */
const posInTag = (text: string, tag: string): Position => {
  const idx = text.indexOf(`<${tag}`);
  if (idx < 0) {
    return new Position(0, 0);
  }
  const before = text.slice(0, idx + 1).split('\n'); // 越过 '<'
  return new Position(before.length - 1, before[before.length - 1].length + 1);
};

/** 指向一个或多个 workspace 根(stub findFiles 跨全部根遍历——KODE-PERF-004 多根路径)。 */
const pointWorkspaceAtRoots = (roots: string[]): void => {
  resetScanRootCache();
  stubWorkspace.workspaceFolders = roots.map((root, index) => ({
    uri: Uri.file(root),
    name: `ws${index}`,
    index
  }));
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
    const all: string[] = [];
    for (const root of roots) {
      all.push(...walk(root, `.${match[1]}`));
    }
    return all.map(file => Uri.file(file));
  };
};

/** 带 version 的文档(真实编辑器有版本,文档存储按版本免重算口径)。 */
const versionedDoc = (
  text: string,
  fileName: string,
  languageId: string
): ReturnType<typeof makeTextDocument> => {
  const doc = makeTextDocument(text, { fileName, languageId, uri: Uri.file(fileName) });
  Object.assign(doc, { version: 1 });
  return doc;
};

interface Scenario {
  name: string;
  roots: string[];
  entity: string; // 'Avatar' | 'BigEntity'
  pyPath: string;
  pyText: string;
  defPath: string;
  defText: string;
  entitiesPath: string;
  entitiesText: string;
  hoverMethod: string; // 必须 def 映射在案(命中面)
}

/** 场景装配:解析路径、准备文档文本(大/多根补 onRpc0 使 hover 命中)。 */
function buildScenario(
  name: string,
  roots: string[],
  entity: string,
  pyRel: string,
  defRel: string
): Scenario {
  const pyPath = path.join(roots[0], pyRel);
  const defPath = path.join(roots[0], defRel);
  const entitiesPath = path.join(roots[0], 'scripts', 'entities.xml');
  // 若生成的 py 无 def 映射方法,补一个 onRpc0(保持既有类结构,仅注入命中面)
  let pyText = fs.readFileSync(pyPath, 'utf8');
  if (!pyText.includes('onRpc0')) {
    pyText = pyText.replace(
      /^class (\w+):\n/m,
      (_match, cls: string) => `class ${cls}:\n    def onRpc0(self, arg):\n        return arg\n`
    );
    fs.writeFileSync(pyPath, pyText, 'utf8');
  }
  const defText = fs.readFileSync(defPath, 'utf8');
  const entitiesText = fs.readFileSync(entitiesPath, 'utf8');
  return {
    name,
    roots,
    entity,
    pyPath,
    pyText,
    defPath,
    defText,
    entitiesPath,
    entitiesText,
    hoverMethod: 'onRpc0'
  };
}

/** 一轮 5×20 样本分布(与 gate 多轮口径一致)。 */
async function measureWarm<T>(
  name: string,
  call: () => Promise<T> | T
): Promise<void> {
  const rounds: number[][] = [];
  for (let r = 0; r < 5; r += 1) {
    const round: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      await call();
      round.push(performance.now() - started);
    }
    rounds.push(round);
  }
  metric(name, rounds.flat());
}

/** 单场景全维度测量(冷 + 热 + 内存 + 启动延迟)。 */
async function measureScenario(scenario: Scenario): Promise<void> {
  const { name, entity, pyText, defText, entitiesText } = scenario;
  pointWorkspaceAtRoots(scenario.roots);

  // 文档
  const hoverPos = lineColOf(pyText, scenario.hoverMethod);
  const hoverDoc = makeTextDocument(pyText, {
    fileName: scenario.pyPath, languageId: 'python', uri: Uri.file(scenario.pyPath)
  });
  const hoverPosition = new Position(hoverPos.line, hoverPos.char + 1);

  const pyCompText = pyText + '\n        self.';
  const pyCompDoc = makeTextDocument(pyCompText, {
    fileName: scenario.pyPath, languageId: 'python', uri: Uri.file(scenario.pyPath)
  });
  const pyCompPosition = new Position(pyCompText.split('\n').length - 1, '        self.'.length);

  // py 定义:基类引用(class Cell<Entity>(<Entity>) → <Entity>.py)
  const pyDefText = `class Cell${entity}(${entity}):\n    pass\n`;
  const pyDefDoc = makeTextDocument(pyDefText, {
    fileName: path.join(path.dirname(scenario.pyPath), `Cell${entity}.py`),
    languageId: 'python',
    uri: Uri.file(path.join(path.dirname(scenario.pyPath), `Cell${entity}.py`))
  });
  const openParen = pyDefText.indexOf(`(${entity}`);
  const pyDefBefore = pyDefText.slice(0, openParen + 1).split('\n');
  const pyDefPosition = new Position(
    pyDefBefore.length - 1,
    pyDefBefore[pyDefBefore.length - 1].length + 1
  );

  // def 补全:<Type> 语境(类型补全)
  const defTypeText = defText + '\n  <Type> ';
  const defTypeDoc = versionedDoc(defTypeText, scenario.defPath, 'kbengine-def');
  const defTypePosition = new Position(defTypeText.split('\n').length - 1, '  <Type> '.length);

  // def 诊断:干净 def + 缺陷 def(未知 Flags/Type)+ entities.xml
  const defDoc = versionedDoc(defText, scenario.defPath, 'kbengine-def');
  const defDefectText = defText.replace(
    '</root>',
    '  <Properties>\n    <x>\n      <Flags>NOT_A_FLAG</Flags>\n      <Type>NOT_A_TYPE</Type>\n    </x>\n  </Properties>\n</root>'
  );
  const defDefectDoc = versionedDoc(defDefectText, scenario.defPath, 'kbengine-def');
  const entitiesDoc = versionedDoc(entitiesText, scenario.entitiesPath, 'xml');
  const defDefPosition = posInTag(entitiesText, entity);

  const collection = makeCollection();

  const phaseStartRss = process.memoryUsage().rss;
  once(`V02.${name}.process.rssAtStartMb`, mb(phaseStartRss), ' MB');

  const constructionAt = performance.now();
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  const index = new PythonClassIndex();
  const hover = new KBEngineHoverProvider(manager);
  const defComp = new KBEngineCompletionProvider(manager);
  const pyComp = new PythonCompletionProvider(manager);
  const defDef = new KBEngineDefinitionProvider(manager);
  const pyDef = new PythonDefinitionProvider(manager, index);

  // ---- 冷(构造后,首扫在途)----
  const activationSampler = startRssSampler();
  const coldHoverStarted = performance.now();
  const coldHover = await hover.provideHover(hoverDoc, hoverPosition);
  once(`V02.${name}.cold.hover`, performance.now() - coldHoverStarted);
  once(`V02.${name}.cold.hoverHits`, coldHover ? 1 : 0, ' hit');
  const coldPyCompStarted = performance.now();
  const coldPyComp = pyComp.provideCompletionItems(pyCompDoc, pyCompPosition);
  once(`V02.${name}.cold.completionPy`, performance.now() - coldPyCompStarted);
  once(`V02.${name}.cold.completionPyItems`, countOf(coldPyComp), ' items');
  const coldDefCompStarted = performance.now();
  const coldDefComp = defComp.provideCompletionItems(defTypeDoc, defTypePosition);
  once(`V02.${name}.cold.completionDef`, performance.now() - coldDefCompStarted);
  once(`V02.${name}.cold.completionDefItems`, countOf(coldDefComp), ' items');
  const coldDefDefStarted = performance.now();
  const coldDefDef = defDef.provideDefinition(entitiesDoc, defDefPosition);
  once(`V02.${name}.cold.definitionDef`, performance.now() - coldDefDefStarted);
  once(`V02.${name}.cold.definitionDefHits`, coldDefDef ? 1 : 0, ' hit');
  const coldPyDefStarted = performance.now();
  const coldPyDef = await pyDef.provideDefinition(pyDefDoc, pyDefPosition);
  once(`V02.${name}.cold.definitionPy`, performance.now() - coldPyDefStarted);
  once(`V02.${name}.cold.definitionPyHits`, coldPyDef ? 1 : 0, ' hit');
  const coldDiagStarted = performance.now();
  validateDocument(defDoc, collection as never);
  once(`V02.${name}.cold.diagnosticsDef`, performance.now() - coldDiagStarted);
  once(`V02.${name}.cold.diagnosticsDefItems`, collection.lastCount(), ' items');
  const coldDiagDefectStarted = performance.now();
  validateDocument(defDefectDoc, collection as never);
  once(`V02.${name}.cold.diagnosticsDefDefect`, performance.now() - coldDiagDefectStarted);
  const coldDiagXmlStarted = performance.now();
  validateEntitiesXmlDocument(entitiesDoc, collection as never);
  once(`V02.${name}.cold.diagnosticsEntitiesXml`, performance.now() - coldDiagXmlStarted);

  // ---- 激活墙钟(构造 → def 首扫收尾)----
  await manager.waitForInitialScan();
  once(`V02.${name}.activation.defScanWall`, performance.now() - constructionAt);
  const activationSamples = activationSampler.stop();
  rssReport(`V02.${name}.rss.activation`, activationSamples, phaseStartRss);

  // ---- 热(def 索引就绪;交互面稳态)----
  await measureWarm(`V02.${name}.warm.hover`, () => hover.provideHover(hoverDoc, hoverPosition));
  const warmHover = await hover.provideHover(hoverDoc, hoverPosition);
  once(`V02.${name}.warm.hoverHits`, warmHover ? 1 : 0, ' hit');
  await measureWarm(`V02.${name}.warm.completionPy`, () =>
    pyComp.provideCompletionItems(pyCompDoc, pyCompPosition)
  );
  once(
    `V02.${name}.warm.completionPyItems`,
    countOf(pyComp.provideCompletionItems(pyCompDoc, pyCompPosition)),
    ' items'
  );
  await measureWarm(`V02.${name}.warm.completionDef`, () =>
    defComp.provideCompletionItems(defTypeDoc, defTypePosition)
  );
  once(
    `V02.${name}.warm.completionDefItems`,
    countOf(defComp.provideCompletionItems(defTypeDoc, defTypePosition)),
    ' items'
  );
  await measureWarm(`V02.${name}.warm.definitionDef`, () =>
    defDef.provideDefinition(entitiesDoc, defDefPosition)
  );
  const warmDefDef = defDef.provideDefinition(entitiesDoc, defDefPosition);
  once(`V02.${name}.warm.definitionDefHits`, warmDefDef ? 1 : 0, ' hit');
  await measureWarm(`V02.${name}.warm.diagnosticsDef`, () =>
    validateDocument(defDoc, collection as never)
  );
  await measureWarm(`V02.${name}.warm.diagnosticsDefDefect`, () =>
    validateDocument(defDefectDoc, collection as never)
  );
  await measureWarm(`V02.${name}.warm.diagnosticsEntitiesXml`, () =>
    validateEntitiesXmlDocument(entitiesDoc, collection as never)
  );

  // ---- 全量 .py 扫描墙钟(启动宿主延迟)----
  const scanPhaseStartRss = process.memoryUsage().rss;
  const scanSampler = startRssSampler();
  const pyScanStarted = performance.now();
  await index.waitForInitialScan();
  once(`V02.${name}.startup.fullPyScanWall`, performance.now() - pyScanStarted);
  const scanSamples = scanSampler.stop();
  rssReport(`V02.${name}.rss.scan`, scanSamples, scanPhaseStartRss);

  // ---- 热 py 定义(索引全量就绪)----
  await measureWarm(`V02.${name}.warm.definitionPy`, () =>
    pyDef.provideDefinition(pyDefDoc, pyDefPosition)
  );
  const warmPyDef = await pyDef.provideDefinition(pyDefDoc, pyDefPosition);
  once(`V02.${name}.warm.definitionPyHits`, warmPyDef ? 1 : 0, ' hit');

  manager.dispose();
}

describe('KODE-PERF-007 v0.2 最新性能基线(large/multi-root/big-py × 六维)', () => {
  let largeRoot = '';
  let multiRoot = '';
  let bigPyRoot = '';

  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    multiRoot = path.join(ASSETS_OUT, 'multi-root');
    bigPyRoot = path.join(ASSETS_OUT, 'big-py');
    emit(
      `V02-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} largeFiles=${LARGE_FILES} assets=${ASSETS_OUT}`
    );
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  it('large-30k:30,005 文件 × 六维(冷+热+内存+启动延迟)', async () => {
    const scenario = buildScenario(
      'large-30k',
      [largeRoot],
      'Avatar',
      'scripts/base/Avatar.py',
      'scripts/entity_defs/Avatar.def'
    );
    await measureScenario(scenario);
  }, 900000);

  it('multi-root:3 独立资产根(同名 Avatar/Inventory)× 六维', async () => {
    const roots = ['root_a', 'root_b', 'root_c'].map(name => path.join(multiRoot, name));
    const scenario = buildScenario(
      'multi-root',
      roots,
      'Avatar',
      'scripts/base/Avatar.py',
      'scripts/entity_defs/Avatar.def'
    );
    await measureScenario(scenario);
  }, 600000);

  it('big-py:8000 方法单文件 × 六维(大 Python 文件压力)', async () => {
    const scenario = buildScenario(
      'big-py',
      [bigPyRoot],
      'BigEntity',
      'scripts/cell/BigEntity.py',
      'scripts/entity_defs/BigEntity.def'
    );
    await measureScenario(scenario);
  }, 600000);
});
