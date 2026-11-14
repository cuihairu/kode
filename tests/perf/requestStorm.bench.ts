/**
 * RUST-029 请求风暴基准:服务层(真实索引实现 + fake-vscode 桩)五类风暴面——
 *   S1 快速连续编辑:200 版连续 onDocumentChanged + 每版后 hover(每编辑请求流);
 *   S2 切换 tab:3 根同名 Avatar 轮转 45 次,每次换文档实例→索引吸收+冷 hover+补全;
 *   S3 批量重命名:50 次 invalidate(change)+新路径索引登记,基类解析不破为闸;
 *   S4 依赖变更:Avatar.def 20 版编辑诊断流 + 5 轮盘上改 def→重建 manager 全量再索引;
 *   S5 并发跳转补全:编辑流推进中 3 波 Promise.all 并发(定义+双补全+xml 诊断)。
 *
 * 只观测不改行为;断言只有语义命中面(确定性的 hits),墙钟一律不进断言
 * (只捕数量级回退的闸在 v02Baseline;风暴面先建测量,阈值归后续批次)。
 * 输出 STORM-ENV/STORM-METRIC 落 docs/perf/request-storm-run.txt(追加制,
 * KODE_STORM_OUT 可覆盖),与主 unit 门无交集(.bench.ts 独立 lane)。
 *
 * 跑法:KODE_STORM_LARGE_FILES=2000 npx vitest run --config vitest.bench.config.ts tests/perf/requestStorm.bench.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import {
  KBEngineCompletionProvider,
  KBEngineHoverProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  validateDocument,
  validateEntitiesXmlDocument
} from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { PythonClassIndex } from '../../src/backend/pythonClassIndex';
import { resetScanRootCache } from '../../src/scanRoots';

const ASSETS_OUT = process.env.KODE_STORM_ASSETS_OUT
  ?? path.join(os.tmpdir(), 'kode-storm-assets');
const LARGE_FILES = Number(process.env.KODE_STORM_LARGE_FILES ?? '2000');

const OUT_FILE = process.env.KODE_STORM_OUT
  ?? path.resolve(__dirname, '../../docs/perf/request-storm-run.txt');
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

const pooled = (name: string, samples: number[]): void => {
  emit(
    `STORM-METRIC ${name} n=${samples.length} ` +
    `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms ` +
    `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`STORM-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

/** 风暴文档:version 逐版递增(真实编辑器口径;文档存储按版本免重算)。 */
const stormDoc = (text: string, fileName: string, languageId: string, version: number) => {
  const doc = makeTextDocument(text, { fileName, languageId, uri: Uri.file(fileName) });
  Object.assign(doc, { version });
  return doc;
};

const makeCollection = (): { set(u: unknown, i: unknown): void; delete(): void; lastCount(): number } => {
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

const lineColOf = (text: string, needle: string): Position => {
  const idx = text.indexOf(needle);
  if (idx < 0) {
    return new Position(0, 0);
  }
  const before = text.slice(0, idx).split('\n');
  return new Position(before.length - 1, before[before.length - 1].length);
};

/** hover 命中面注入:生成器 Avatar.py 无 def 映射方法,补 onRpc0(基线同法) */
const injectOnRpc0 = (pyPath: string): string => {
  let text = fs.readFileSync(pyPath, 'utf8');
  if (!text.includes('onRpc0')) {
    text = text.replace(
      /^class (\w+):\n/m,
      (match, cls: string) => `class ${cls}:\n    def onRpc0(self, arg):\n        return arg\n`
    );
    fs.writeFileSync(pyPath, text, 'utf8');
  }
  return text;
};

/** 并发请求计时(Promise.all 各带独立墙钟) */
const timed = async <T>(call: () => Promise<T> | T): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await call();
  return { value, ms: performance.now() - started };
};

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

describe('RUST-029 请求风暴(编辑/tab/重命名/依赖变更/并发)', () => {
  let largeRoot = '';
  let multiRoots: string[] = [];
  let avatarPath = '';
  let avatarText = '';
  let avatarDefPath = '';
  let avatarDefText = '';
  let entitiesPath = '';
  let entitiesText = '';
  let hoverPos: Position;

  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    multiRoots = ['root_a', 'root_b', 'root_c'].map(name => path.join(ASSETS_OUT, 'multi-root', name));
    avatarPath = path.join(largeRoot, 'scripts', 'base', 'Avatar.py');
    avatarText = injectOnRpc0(avatarPath);
    for (const root of multiRoots) {
      injectOnRpc0(path.join(root, 'scripts', 'base', 'Avatar.py'));
    }
    avatarDefPath = path.join(largeRoot, 'scripts', 'entity_defs', 'Avatar.def');
    avatarDefText = fs.readFileSync(avatarDefPath, 'utf8');
    entitiesPath = path.join(largeRoot, 'scripts', 'entities.xml');
    entitiesText = fs.readFileSync(entitiesPath, 'utf8');
    hoverPos = lineColOf(avatarText, 'onRpc0');
    hoverPos = new Position(hoverPos.line, hoverPos.character + 1); // 光标进方法名内(基线口径)
    emit(
      `STORM-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} largeFiles=${LARGE_FILES} assets=${ASSETS_OUT}`
    );
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  it('S1 快速连续编辑:200 版编辑流,每版索引吸收+hover', async () => {
    pointWorkspaceAtRoots([largeRoot]);
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    const hover = new KBEngineHoverProvider(manager);
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    const updateSamples: number[] = [];
    const hoverSamples: number[] = [];
    let hits = 0;
    const rssBefore = process.memoryUsage().rss;
    const streamStarted = performance.now();
    for (let version = 1; version <= 200; version++) {
      const text = avatarText + `\n    def storm_v${version}(self):\n        pass\n`;
      const doc = stormDoc(text, avatarPath, 'python', version);
      const t0 = performance.now();
      await index.onDocumentChanged(doc);
      updateSamples.push(performance.now() - t0);
      const t1 = performance.now();
      const result = await hover.provideHover(doc, hoverPos);
      hoverSamples.push(performance.now() - t1);
      if (result) {
        hits += 1;
      }
    }
    const streamWall = performance.now() - streamStarted;
    once('S1.editStream.wall', streamWall);
    pooled('S1.indexUpdate', updateSamples);
    pooled('S1.hoverAfterEdit', hoverSamples);
    once('S1.hoverHits', hits, ' hit');
    expect(hits).toBe(200);
    once('S1.editStream.rssDelta', mb(process.memoryUsage().rss - rssBefore), ' MB');
    // 语义收口:编辑流末态 hover 活
    const lastDoc = stormDoc(
      avatarText + '\n    def storm_v200(self):\n        pass\n', avatarPath, 'python', 200
    );
    await index.onDocumentChanged(lastDoc);
    expect(await hover.provideHover(lastDoc, hoverPos)).not.toBeNull();
    manager.dispose();
  }, 300000);

  it('S2 切换 tab:3 根同名 Avatar 轮转 45 次', async () => {
    pointWorkspaceAtRoots(multiRoots);
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    const hover = new KBEngineHoverProvider(manager);
    const pyComp = new PythonCompletionProvider(manager);
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    const switchSamples: number[] = [];
    let hoverHits = 0;
    let compItems = 0;
    for (let cycle = 0; cycle < 45; cycle++) {
      const root = multiRoots[cycle % multiRoots.length];
      const p = path.join(root, 'scripts', 'base', 'Avatar.py');
      const text = fs.readFileSync(p, 'utf8');
      const doc = stormDoc(text, p, 'python', cycle + 1);
      const t0 = performance.now();
      await index.onDocumentChanged(doc);
      const hoverAt = lineColOf(text, 'onRpc0');
      const got = await hover.provideHover(doc, new Position(hoverAt.line, hoverAt.character + 1));
      const comp = await pyComp.provideCompletionItems(
        stormDoc(text + '\n        self.', p, 'python', cycle + 1),
        new Position(text.split('\n').length, '        self.'.length)
      );
      switchSamples.push(performance.now() - t0);
      if (got) {
        hoverHits += 1;
      }
      if (Array.isArray(comp)) {
        compItems += comp.length;
      }
    }
    pooled('S2.switch', switchSamples);
    once('S2.hoverHits', hoverHits, ' hit');
    once('S2.completionItemsTotal', compItems, ' items');
    expect(hoverHits).toBe(45);
    manager.dispose();
  }, 300000);

  it('S3 批量重命名:50 次 invalidate+新路径登记,基类解析不破', async () => {
    pointWorkspaceAtRoots([largeRoot]);
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    const pyDef = new PythonDefinitionProvider(manager, index);
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    // 固定的基类引用文档(CellAvatar.py `class CellAvatar(Avatar)`),风暴全程
    // 反复跳转:重命名风暴不得打断基类解析(真实重构最常见的连带面)。
    const cellText = 'class CellAvatar(Avatar):\n    pass\n';
    const cellPath = path.join(path.dirname(avatarPath), 'CellAvatar.py');
    const cellDoc = stormDoc(cellText, cellPath, 'python', 1);
    await index.onDocumentChanged(cellDoc);
    // 光标进基类名内(基线口径:开括号后一位)
    const openParen = cellText.indexOf('(Avatar');
    const basePos = new Position(0, openParen + 1);

    const renameSamples: number[] = [];
    let defHits = 0;
    for (let i = 0; i < 50; i++) {
      // 服务层重命名吸收面:旧路径失效 + 新路径文档登记(内容不变)
      const newPath = path.join(path.dirname(avatarPath), `Avatar_moved${i}.py`);
      const doc = stormDoc(avatarText, newPath, 'python', i + 1);
      const t0 = performance.now();
      index.invalidate(avatarPath, 'change');
      await index.onDocumentChanged(doc);
      const got = await pyDef.provideDefinition(cellDoc, basePos);
      renameSamples.push(performance.now() - t0);
      if (got) {
        defHits += 1;
      }
    }
    pooled('S3.rename', renameSamples);
    once('S3.baseResolutionHits', defHits, ' hit');
    expect(defHits).toBe(50);
    manager.dispose();
  }, 300000);

  it('S4 依赖变更:Avatar.def 20 版诊断流 + 5 轮全量再索引', async () => {
    pointWorkspaceAtRoots([largeRoot]);
    const collection = makeCollection();

    // (a) def 编辑诊断流:合法属性与缺陷属性交替(缺陷版有真诊断可发布)
    const diagSamples: number[] = [];
    for (let v = 1; v <= 20; v++) {
      const defect = v % 2 === 0;
      const extra = defect
        ? '  <Properties>\n    <x>\n      <Flags>NOT_A_FLAG</Flags>\n    </x>\n  </Properties>\n'
        : `  <Properties>\n    <stormProp${v} type="UINT32" flags="BASE"/>\n  </Properties>\n`;
      const doc = stormDoc(
        avatarDefText.replace('</root>', extra + '</root>'),
        avatarDefPath, 'kbengine-def', v
      );
      const t0 = performance.now();
      validateDocument(doc, collection as never);
      diagSamples.push(performance.now() - t0);
    }
    pooled('S4.defDiag', diagSamples);

    // (b) 依赖变更 → 全量再索引风暴:盘上改 def → 重建 manager → 首扫 → 首 hover
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    await manager.waitForInitialScan();
    let firstHoverHits = 0;
    const reindexWalls: number[] = [];
    for (let round = 1; round <= 5; round++) {
      fs.writeFileSync(
        avatarDefPath,
        avatarDefText.replace(
          '</root>',
          `  <Properties>\n    <reindex${round} type="UINT32" flags="BASE"/>\n  </Properties>\n</root>`
        )
      );
      manager.dispose();
      const t0 = performance.now();
      const rebuilt = new EntityMappingManager({ subscriptions: [] } as never);
      const rebuiltHover = new KBEngineHoverProvider(rebuilt);
      await rebuilt.waitForInitialScan();
      const doc = stormDoc(avatarText, avatarPath, 'python', round);
      const got = await rebuiltHover.provideHover(doc, hoverPos);
      reindexWalls.push(performance.now() - t0);
      if (got) {
        firstHoverHits += 1;
      }
      rebuilt.dispose();
    }
    once('S4.reindex.rounds', 5, ' rounds');
    pooled('S4.reindex', reindexWalls);
    once('S4.reindex.firstHoverHits', firstHoverHits, ' hit');
    expect(firstHoverHits).toBe(5);
    // 还原盘上 def(资产目录由 afterAll 清,不留风暴态)
    fs.writeFileSync(avatarDefPath, avatarDefText);
  }, 300000);

  it('S5 并发跳转补全:编辑流推进中 3 波并发请求', async () => {
    pointWorkspaceAtRoots([largeRoot]);
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    const hover = new KBEngineHoverProvider(manager);
    const pyComp = new PythonCompletionProvider(manager);
    const defComp = new KBEngineCompletionProvider(manager);
    const pyDef = new PythonDefinitionProvider(manager, index);
    const collection = makeCollection();
    const entitiesDoc = stormDoc(entitiesText, entitiesPath, 'xml', 1);
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    // 固定的基类引用文档(与 S3 同形),并发风暴全程定义跳转不破
    const cellText = 'class CellAvatar(Avatar):\n    pass\n';
    const cellPath = path.join(path.dirname(avatarPath), 'CellAvatar.py');
    const cellDoc = stormDoc(cellText, cellPath, 'python', 1);
    await index.onDocumentChanged(cellDoc);
    const cellOpenParen = cellText.indexOf('(Avatar');
    const basePos = new Position(0, cellOpenParen + 1);

    const requestSamples: number[] = [];
    let defHits = 0;
    const streamStarted = performance.now();
    for (let version = 1; version <= 50; version++) {
      const text = avatarText + `\n    def storm_v${version}(self):\n        pass\n`;
      const doc = stormDoc(text, avatarPath, 'python', version);
      await index.onDocumentChanged(doc);
      if (version === 17 || version === 34 || version === 50) {
        // 编辑流推进中插入一波并发:定义 + py 补全 + def 补全 + xml 诊断
        const compPos = new Position(text.split('\n').length, '        self.'.length);
        const wave = await Promise.all([
          timed(() => pyDef.provideDefinition(cellDoc, basePos)),
          timed(() =>
            pyComp.provideCompletionItems(
              stormDoc(text + '\n        self.', avatarPath, 'python', version), compPos
            )
          ),
          timed(() =>
            defComp.provideCompletionItems(
              stormDoc(avatarDefText + '\n  <Type> ', avatarDefPath, 'kbengine-def', version),
              new Position(0, 0)
            )
          ),
          timed(() => validateEntitiesXmlDocument(entitiesDoc, collection as never))
        ]);
        for (const request of wave) {
          requestSamples.push(request.ms);
        }
        if (wave[0].value) {
          defHits += 1;
        }
        const comps = wave[1].value;
        expect(Array.isArray(comps) ? comps.length : 0).toBeGreaterThan(0);
      }
    }
    const streamWall = performance.now() - streamStarted;
    pooled('S5.concurrentRequests', requestSamples);
    once('S5.stormWall', streamWall);
    once('S5.waves', 3, ' waves');
    once('S5.definitionHits', defHits, ' hit');
    expect(defHits).toBe(3);
    // 收敛面:最后版本 hover 活
    const finalDoc = stormDoc(
      avatarText + '\n    def storm_v50(self):\n        pass\n', avatarPath, 'python', 50
    );
    await index.onDocumentChanged(finalDoc);
    expect(await hover.provideHover(finalDoc, hoverPos)).not.toBeNull();
    manager.dispose();
  }, 300000);
});
