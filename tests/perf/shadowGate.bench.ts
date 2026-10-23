// PR-012 perf/gate-phase2 实测(书 §17 PR-012 L440 原文:真实大型数据压力
// 测试和性能/正确性验收)。不进 pnpm test 门禁,bench 专用配置跑法:
//   TMPDIR=/tmp KODE_PERF_LARGE_FILES=30000 KODE_GATE2_OUT=docs/kode2/pr-012-gate2-run.txt \
//     npx vitest run --config vitest.bench.config.ts tests/perf/shadowGate.bench.ts
//
// 三段(与 docs/kode2/pr-012-perf-gate.md 一一对应):
//   S1 真实大规模 shadow 正确性对拍:30k 资产集上走真实 backend=shadow 门
//      (KodeCoreGate.compare → KodeCoreClient → release kode-server),
//      收集 ShadowDiffLog verdict 统计 + firstDiffPath 样本 + 语义面分解
//      (补全标签序列/悬停命中与符号身份)。Phase2 首片扩面:definition
//      (声明词探针 + entities/types 注册面对齐样本)与 diagnostics
//      (validateDocument 语料子集面)。文档同步腿(didOpen/didChange)
//      由本 bench 显式驱动。
//   S2 TS vs Rust 双轨同参数计时(ARCH-012 解禁:本单就是对比验收单):
//      同 URI 同 position,TS provider 直调 vs Rust 协议往返(含 transport,
//      early signal 口径,pr-012.md §5 注意条款),5 轮×20,分位口径同门 1。
//   S3 压力:连发 burst(并发 50)、编辑风暴(150 轮 didChange→重查)、
//      内存 soak(1200 次 compare + 双进程 RSS 25ms 采样 + 日志有界复核)。
//
// 铁律:所有数字来自真实执行,原样落 GATE2-METRIC 行;不通过如实报 FAIL。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import { KBEngineCompletionProvider, KBEngineDefinitionProvider, KBEngineHoverProvider, validateDocument } from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { resetScanRootCache } from '../../src/scanRoots';
import { KodeCoreGate, ShadowDiffEntry, ShadowDiffLog, firstDiffPath } from '../../src/kodeCoreGate';
import { KodeCoreClient } from '../../src/kodeCoreClient';
import { diagnosticsToLspFace, locationToLspFace } from '../../src/kodeCoreShadowFaces';
import { DiagnosticCollection } from '../fake-vscode/core';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-shadow-gate-assets');
const LARGE_FILES = Number(process.env.KODE_PERF_LARGE_FILES ?? '30000');
const SERVER_BIN = process.env.KODE_SERVER_BIN
  ?? path.resolve(__dirname, '../../target/release/kode-server');
const OUT_FILE = process.env.KODE_GATE2_OUT
  ?? path.resolve(__dirname, '../../docs/kode2/pr-012-gate2-run.txt');

const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

// ---- 统计助手(与 gate.bench.ts 同口径) ---------------------------------

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
    `GATE2-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms max=${percentile(values, 1)}ms`
  );
};
const metricRounds = (name: string, rounds: number[][]): void => {
  metric(`${name}.all`, rounds.flat());
  const roundMedians = rounds.map(round => median(round));
  emit(
    `GATE2-ROUNDS ${name} rounds=${rounds.length} ` +
    roundMedians.map((m, i) => `r${i}Median=${m}ms`).join(' ') +
    ` roundMedian=${median(roundMedians)}ms`
  );
};
const once = (name: string, value: number | string, unit = ''): void => {
  emit(`GATE2-METRIC ${name} ${value}${unit}`);
};
const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

const startRssSampler = (read: () => number, intervalMs = 25): { stop(): number[] } => {
  const samples: number[] = [];
  const timer = setInterval(() => {
    samples.push(read());
  }, intervalMs);
  return { stop: (): number[] => { clearInterval(timer); return samples; } };
};

const rssReport = (name: string, samples: number[]): void => {
  if (samples.length === 0) {
    once(`${name}.samples`, 0);
    return;
  }
  once(`${name}.peakRssMb`, mb(Math.max(...samples)), ' MB');
};

/** kode-server 进程 RSS(/proc VmRSS,KB);进程不可读返回 NaN 采样跳过 */
const serverRssReader = (client: KodeCoreClient): (() => number) => {
  const statusPath = (): string => `/proc/${client.childProcess?.pid ?? 0}/status`;
  return (): number => {
    try {
      const line = fs.readFileSync(statusPath(), 'utf8')
        .split('\n')
        .find(l => l.startsWith('VmRSS:'));
      return line ? Number(/\d+/.exec(line)?.[0] ?? 0) * 1024 : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };
};

// ---- 对拍面定义(两侧同输入同面;分解见报告 §3) ---------------------------

interface HoverLspFace {
  contents: { kind: 'markdown'; value: string } | null;
}

/** TS Hover → LSP hover 面:contents 平铺为 markdown 文本(适配器,报告 §3.1) */
const tsHoverToLsp = (hover: unknown): HoverLspFace => {
  if (!hover || typeof hover !== 'object') {
    return { contents: null };
  }
  const contents = (hover as { contents?: unknown }).contents;
  const pieces = Array.isArray(contents) ? contents : [contents];
  const value = pieces
    .map(piece => {
      if (typeof piece === 'string') {
        return piece;
      }
      return (piece as { value?: string })?.value ?? '';
    })
    .join('');
  return { contents: value ? { kind: 'markdown', value } : null };
};

interface LspCompletionFace {
  isIncomplete: boolean;
  items: { label: string; kind?: number; detail?: string }[];
}

/** TS CompletionItem[] → LSP completion 面(vscode kind 0 基 → LSP 1 基 +1) */
const tsItemsToLsp = (items: unknown): LspCompletionFace => {
  const list = Array.isArray(items) ? items : [];
  return {
    isIncomplete: false,
    items: list.map(item => {
      const typed = item as { label?: unknown; kind?: number; detail?: string };
      const label = typeof typed.label === 'string' ? typed.label : String(typed.label);
      const out: { label: string; kind?: number; detail?: string } = { label };
      if (typeof typed.kind === 'number') {
        out.kind = typed.kind + 1;
      }
      if (typeof typed.detail === 'string' && typed.detail) {
        out.detail = typed.detail;
      }
      return out;
    })
  };
};

/** 悬停语义身份:双侧 markdown 首个 **name** 词(命中 + 符号身份对拍面) */
const markdownIdentity = (face: HoverLspFace): { hit: boolean; name: string | null } => {
  const value = face.contents?.value ?? '';
  const match = /^\s*\*\*([^*]+)\*\*/.exec(value) ?? /\*\*([^*]+)\*\*/.exec(value);
  return { hit: Boolean(face.contents), name: match ? match[1] : null };
};

const labelsOf = (face: LspCompletionFace): string[] => face.items.map(item => item.label);

describe('PR-012 phase2 门:shadow 大规模对拍 + 双轨计时 + 压力(30k)', () => {
  let gate: KodeCoreGate;
  let client: KodeCoreClient;
  let manager: EntityMappingManager;
  let hoverProvider: KBEngineHoverProvider;
  let defCompletion: KBEngineCompletionProvider;
  let defDefinition: KBEngineDefinitionProvider;
  const diffLog = new ShadowDiffLog();
  const diffSamples: ShadowDiffEntry[] = [];
  diffLog.subscribe(entry => diffSamples.push(entry));
  let defDeclSamples = 0;

  const pointWorkspaceAt = (roots: string[]): void => {
    resetScanRootCache();
    stubWorkspace.workspaceFolders = roots.map((root, index) => ({
      uri: Uri.file(root), name: `ws${index}`, index
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
      const folders = stubWorkspace.workspaceFolders ?? [];
      const seen = new Set<string>();
      const out: Uri[] = [];
      for (const folder of folders) {
        for (const file of walk(folder.uri.fsPath, `.${match[1]}`)) {
          if (!seen.has(file)) {
            seen.add(file);
            out.push(Uri.file(file));
          }
        }
      }
      return out;
    };
  };

  /** def 文件确定性采样:def-heavy 每第 6 个 Unit{i}.def + large/Avatar.def */
  const sampledDefs = (): { file: string; text: string }[] => {
    const out: { file: string; text: string }[] = [];
    const defsDir = path.join(ASSETS_OUT, 'def-heavy', 'scripts', 'entity_defs');
    for (let i = 0; i < 1200; i += 6) {
      const file = path.join(defsDir, `Unit${i}.def`);
      out.push({ file, text: fs.readFileSync(file, 'utf8') });
    }
    const avatar = path.join(ASSETS_OUT, 'large', 'scripts', 'entity_defs', 'Avatar.def');
    out.push({ file: avatar, text: fs.readFileSync(avatar, 'utf8') });
    return out;
  };

  beforeAll(() => {
    if (!fs.existsSync(SERVER_BIN)) {
      throw new Error(`kode-server release 二进制不存在: ${SERVER_BIN}(先 cargo build -p kode-server --release)`);
    }
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    emit(
      `GATE2-ENV node=${process.version} platform=${os.platform()} cpus=${os.cpus().length} ` +
      `largeFiles=${LARGE_FILES} assets=${ASSETS_OUT} server=${SERVER_BIN}`
    );
    pointWorkspaceAt([
      path.join(ASSETS_OUT, 'def-heavy'),
      path.join(ASSETS_OUT, 'large')
    ]);
    // 语料补齐:生成器 types.xml/alias.xml 是属性式(JSONDATA type="UINT32"),
    // 属性式经 parse_types/parseTypesXml 属性式口径两侧同识别(G-C 关闭单 ②);
    // 再追加两实现 golden 门都接受的文本式确定性条目(SHADOW_GATE_*),让类型/
    // 别名面在真实属性式语料之外仍有文本式可比样本(两侧同读此文件)。
    // 注意:alias.xml 的属性式 BOOL_LIST 两侧同不产出别名面条目(parse_alias/
    // buildAliasXmlCustomTypeInfo 同口径),别名面对拍样本由文本式条目承担。
    for (const scenario of ['def-heavy', 'large']) {
      const typesXml = path.join(ASSETS_OUT, scenario, 'scripts', 'types.xml');
      const aliasXml = path.join(ASSETS_OUT, scenario, 'scripts', 'entity_defs', 'alias.xml');
      if (fs.existsSync(typesXml)) {
        fs.writeFileSync(
          typesXml,
          '<root>\n  <JSONDATA type="UINT32"/>\n  <SHADOW_GATE_TYPE> UINT32 </SHADOW_GATE_TYPE>\n</root>\n',
          'utf8'
        );
      }
      if (fs.existsSync(aliasXml)) {
        fs.writeFileSync(
          aliasXml,
          '<root>\n  <BOOL_LIST type="ARRAY" of="BOOL"/>\n  <SHADOW_GATE_ALIAS> UINT32 </SHADOW_GATE_ALIAS>\n</root>\n',
          'utf8'
        );
      }
    }
    manager = new EntityMappingManager({ subscriptions: [] } as never);
    hoverProvider = new KBEngineHoverProvider(manager);
    defCompletion = new KBEngineCompletionProvider(manager);
    defDefinition = new KBEngineDefinitionProvider(manager);
    client = new KodeCoreClient({
      binaryPath: SERVER_BIN,
      initializeParams: { processId: process.pid, rootUri: `file://${ASSETS_OUT}`, capabilities: {} }
    });
    gate = new KodeCoreGate({
      clientFactory: () => client,
      diffLog
    });
    gate.setConfig({ backend: 'shadow', serverPath: SERVER_BIN, shadowTimeoutMs: 5000 });
  }, 900000);

  afterAll(async () => {
    await gate.dispose();
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
  });

  it('S0:真实索引激活(TS 首扫 + Rust 握手)', async () => {
    const scanStarted = performance.now();
    await manager.waitForInitialScan();
    once('S0.tsInitialScanMs', Math.round(performance.now() - scanStarted));
    await client.start();
    const health = await client.health();
    once('S0.rustServer', `${health.serverVersion}@pid${health.pid}`);
    once('S0.gateState', JSON.stringify(gate.state));
  }, 600000);

  it('S1:30k 资产集 shadow 正确性对拍(verdict 统计 + 首分歧 + 语义分解)', async () => {
    // 语料预置:Rust corpus 视图只认已 didOpen 的文档,根级 entities/types/alias
    // 先入库(与 TS 侧 getTypesXmlSnapshot/getRegisteredEntities 的解析范围对齐,
    // 两侧语料范围一致后类型/别名面才可比)。
    const corpusXml: string[] = [];
    for (const scenario of ['def-heavy', 'large']) {
      corpusXml.push(
        path.join(ASSETS_OUT, scenario, 'scripts', 'entities.xml'),
        path.join(ASSETS_OUT, scenario, 'scripts', 'types.xml'),
        path.join(ASSETS_OUT, scenario, 'scripts', 'entity_defs', 'alias.xml')
      );
    }
    for (const file of corpusXml) {
      if (fs.existsSync(file)) {
        client.openDocument(`file://${file}`, 'xml', 1, fs.readFileSync(file, 'utf8'));
      }
    }
    const defs = sampledDefs();
    const stats = {
      hoverBothHit: 0, hoverTsOnly: 0, hoverRustOnly: 0, hoverBothMiss: 0,
      hoverNameAgree: 0, hoverNameDisagree: 0,
      compExact: 0, compRustSubset: 0, compDiverge: 0, compRustNull: 0,
      rustOnlyLabels: new Map<string, number>(),
      // Phase2 首片:definition 声明词探针(F12 provider 脸 vs Rust 语料面,
      // 划归边界如实分解)+ 注册面对齐样本 + diagnostics 面
      defDeclExact: 0, defDeclDiverge: 0, defDeclTsOnly: 0, defDeclRustOnly: 0, defDeclBothMiss: 0,
      defRegistryExact: 0, defRegistryDiverge: 0,
      diagBothEmpty: 0, diagMatch: 0, diagDiverge: 0
    };
    let sampleIndex = 0;

    for (const def of defs) {
      const uri = `file://${def.file}`;
      // 基线版(v1):两个悬停面(属性 hp / 方法 onRpc0,行号由生成器定死)
      client.openDocument(uri, 'kbengine-def', 1, def.text);
      const baseLines = def.text.split('\n');
      const propLine = baseLines.findIndex(l => l.includes('<hp '));
      const methodLine = baseLines.findIndex(l => l.includes('<onRpc0 '));
      const faces: { method: string; params: unknown; line: number; col: number }[] = [];
      if (propLine >= 0) {
        faces.push({ method: 'textDocument/hover', params: hoverParams(uri, propLine, 6), line: propLine, col: 6 });
      }
      if (methodLine >= 0) {
        faces.push({ method: 'textDocument/hover', params: hoverParams(uri, methodLine, 6), line: methodLine, col: 6 });
      }
      // 类型补全面(v2)与根级标签面(v3):全文追加触发行(与 gate.bench 同法)
      const typeText = `${def.text}\n  <Type> `;
      const tagText = `${def.text}\n  <`;
      const compFaces: { method: string; version: number; text: string; col: number }[] = [
        { method: 'textDocument/completion', version: 2, text: typeText, col: '  <Type> '.length },
        { method: 'textDocument/completion', version: 3, text: tagText, col: '  <'.length }
      ];

      for (const face of faces) {
        const tsDoc = makeTextDocument(def.text, {
          fileName: def.file, languageId: 'kbengine-def', uri: Uri.file(def.file)
        });
        const tsHover = await hoverProvider.provideHover(tsDoc, new Position(face.line, face.col));
        const tsFace = tsHoverToLsp(tsHover);
        // 同参数 Rust 直取(语义分解用;compare 内部是独立镜像请求)
        const rustRaw = await client.request(face.method, face.params, { timeoutMs: 5000 }) as HoverLspFace | null;
        const rustFace: HoverLspFace = { contents: rustRaw?.contents ?? null };
        await gate.compare(face.method, face.params, tsFace, uri);
        const tsId = markdownIdentity(tsFace);
        const rustId = markdownIdentity(rustFace);
        if (sampleIndex < 3) {
          emit(
            `GATE2-HOVERFACE #${sampleIndex} tsId=${JSON.stringify(tsId)} ` +
            `rustId=${JSON.stringify(rustId)} tsValueHead=${JSON.stringify((tsFace.contents?.value ?? '').slice(0, 40))} ` +
            `rustValueHead=${JSON.stringify((rustFace.contents?.value ?? '').slice(0, 40))}`
          );
        }
        if (tsId.hit && rustId.hit) {
          stats.hoverBothHit += 1;
          if (tsId.name === rustId.name) {
            stats.hoverNameAgree += 1;
          } else {
            stats.hoverNameDisagree += 1;
          }
        } else if (tsId.hit) {
          stats.hoverTsOnly += 1;
        } else if (rustId.hit) {
          stats.hoverRustOnly += 1;
        } else {
          stats.hoverBothMiss += 1;
        }
        sampleIndex += 1;
      }

      // ---- Phase2 首片:definition 声明词探针(划归边界如实分解) ----------
      // F12 provider 脸(属性/方法词优先 Python 脚本/注册回落)与 Rust 语料
      // 声明面不同构:这里只做直接对拍分解统计,不进 diffLog(注册面对齐
      // 样本才进 compare verdict)。
      for (const probe of [{ line: propLine, col: 6 }, { line: methodLine, col: 6 }]) {
        if (probe.line < 0) {
          continue;
        }
        const tsDoc = makeTextDocument(def.text, {
          fileName: def.file, languageId: 'kbengine-def', uri: Uri.file(def.file)
        });
        const tsLocation = await defDefinition.provideDefinition(tsDoc, new Position(probe.line, probe.col));
        const tsFace = locationToLspFace(tsLocation);
        const params = hoverParams(uri, probe.line, probe.col);
        const rustRaw = await client.request('textDocument/definition', params, { timeoutMs: 5000 }) as {
          uri?: string;
          range?: unknown;
        } | null;
        const identity = (face: unknown): string => JSON.stringify(face ?? null);
        if (defDeclSamples < 2) {
          defDeclSamples += 1;
          emit(
            `GATE2-DEFFACE #${defDeclSamples} probe=${probe.line}:${probe.col} word=${baseLines[probe.line]?.trim().slice(0, 30)} ts=${identity(tsFace)} rust=${identity(rustRaw)}`
          );
        }
        // 同一性按 compare 同口径(canonical,屏蔽 serde_json 键序差异)。
        if (tsFace && rustRaw?.uri) {
          if (firstDiffPath(tsFace, rustRaw) === null) {
            stats.defDeclExact += 1;
          } else {
            stats.defDeclDiverge += 1;
          }
        } else if (tsFace) {
          stats.defDeclTsOnly += 1;
        } else if (rustRaw?.uri) {
          stats.defDeclRustOnly += 1;
        } else {
          stats.defDeclBothMiss += 1;
        }
      }

      // ---- Phase2 首片:diagnostics 面(validateDocument 语料子集)---------
      {
        const diagDoc = makeTextDocument(def.text, {
          fileName: def.file, languageId: 'kbengine-def', uri: Uri.file(def.file)
        });
        const collection = new DiagnosticCollection();
        const captured: unknown[] = [];
        const originalSet = collection.set.bind(collection);
        // fake DiagnosticCollection 按 Uri 对象身份存取,改为 set 面捕获。
        collection.set = (uri: never, diags: never) => {
          captured.push(...(diags as unknown[]));
          originalSet(uri, diags);
        };
        validateDocument(diagDoc as never, collection as never);
        const tsDiagFace = diagnosticsToLspFace(captured as never);
        const diagParams = { textDocument: { uri } };
        const rustDiagRaw = await client.request('textDocument/diagnostic', diagParams, { timeoutMs: 5000 }) as {
          kind?: string;
          items?: unknown[];
        } | null;
        await gate.compare('textDocument/diagnostic', diagParams, tsDiagFace, uri);
        const tsItems = JSON.stringify(tsDiagFace.items);
        const rustItems = JSON.stringify(rustDiagRaw?.items ?? null);
        if (sampleIndex < 3) {
          emit(
            `GATE2-DIAGFACE #${sampleIndex} ts=${tsItems.slice(0, 160)} rust=${rustItems?.slice(0, 160)}`
          );
        }
        // 语义同一性按 compare 同口径(canonical,屏蔽 serde_json 键序差异)。
        if (firstDiffPath(tsDiagFace.items, rustDiagRaw?.items ?? null) === null) {
          if (tsItems === '[]') {
            stats.diagBothEmpty += 1;
          } else {
            stats.diagMatch += 1;
          }
        } else {
          stats.diagDiverge += 1;
        }
        sampleIndex += 1;
      }

      for (const face of compFaces) {
        client.changeDocument(uri, face.version, face.text);
        const tsDoc = makeTextDocument(face.text, {
          fileName: def.file, languageId: 'kbengine-def', uri: Uri.file(def.file)
        });
        Object.assign(tsDoc, { version: face.version });
        const tsItems = await defCompletion.provideCompletionItems(
          tsDoc, new Position(face.text.split('\n').length - 1, face.col)
        );
        const tsFace = tsItemsToLsp(tsItems);
        const params = completionParams(uri, face.text.split('\n').length - 1, face.col);
        const rustRaw = await client.request(face.method, params, { timeoutMs: 5000 }) as LspCompletionFace | null;
        await gate.compare(face.method, params, tsFace, uri);
        const tsLabels = labelsOf(tsFace);
        const rustLabels = rustRaw ? (rustRaw.items ?? []).map(item => String(item.label)) : [];
        const rustOnly = rustLabels.filter(label => !tsLabels.includes(label));
        const tsOnly = tsLabels.filter(label => !rustLabels.includes(label));
        if (rustRaw === null) {
          // Rust 判面不接管(null):不算语义分歧,归结构面覆盖差
          stats.compRustNull += 1;
        } else if (tsLabels.join('\u0001') === rustLabels.join('\u0001')) {
          stats.compExact += 1;
        } else if (rustOnly.length === 0) {
          stats.compRustSubset += 1;
          for (const label of tsOnly) {
            stats.rustOnlyLabels.set(`ts-only:${label}`, (stats.rustOnlyLabels.get(`ts-only:${label}`) ?? 0) + 1);
          }
        } else {
          stats.compDiverge += 1;
          for (const label of rustOnly) {
            stats.rustOnlyLabels.set(label, (stats.rustOnlyLabels.get(label) ?? 0) + 1);
          }
        }
        sampleIndex += 1;
      }
    }

    // xml 悬停面 + .py 结构性缺口探针(large 根)
    const xmlFaces: { file: string; wordLine: number; col: number }[] = [
      { file: path.join(ASSETS_OUT, 'large', 'scripts', 'types.xml'), wordLine: 2, col: 6 },
      { file: path.join(ASSETS_OUT, 'large', 'scripts', 'entities.xml'), wordLine: 1, col: 6 },
      { file: path.join(ASSETS_OUT, 'large', 'scripts', 'entity_defs', 'alias.xml'), wordLine: 2, col: 6 }
    ];
    for (const face of xmlFaces) {
      const text = fs.readFileSync(face.file, 'utf8');
      const uri = `file://${face.file}`;
      client.openDocument(uri, 'xml', 1, text);
      const tsDoc = makeTextDocument(text, {
        fileName: face.file, languageId: 'xml', uri: Uri.file(face.file)
      });
      // Phase2 首片:注册面 definition(entities.xml/types.xml 声明词 →
      // def/本文件落点,provider 脸与 Rust 语料面同构,进 compare verdict)。
      {
        const tsLocation = await defDefinition.provideDefinition(tsDoc, new Position(face.wordLine, face.col));
        const tsFace = locationToLspFace(tsLocation);
        const params = hoverParams(uri, face.wordLine, face.col);
        const rustRaw = await client.request('textDocument/definition', params, { timeoutMs: 5000 }) as unknown;
        await gate.compare('textDocument/definition', params, tsFace, uri);
        emit(
          `GATE2-REGFACE ${path.basename(face.file)} ts=${JSON.stringify(tsFace)} rust=${JSON.stringify(rustRaw)}`
        );
        if (firstDiffPath(tsFace, rustRaw) === null) {
          stats.defRegistryExact += 1;
        } else {
          stats.defRegistryDiverge += 1;
        }
      }
      const tsHover = await hoverProvider.provideHover(tsDoc, new Position(face.wordLine, face.col));
      const tsFace = tsHoverToLsp(tsHover);
      const params = hoverParams(uri, face.wordLine, face.col);
      const rustRaw = await client.request('textDocument/hover', params, { timeoutMs: 5000 }) as HoverLspFace | null;
      await gate.compare('textDocument/hover', params, tsFace, uri);
      const tsId = markdownIdentity(tsFace);
      const rustId = markdownIdentity({ contents: rustRaw?.contents ?? null });
      emit(
        `GATE2-XMLFACE ${path.basename(face.file)} ts=${tsId.hit ? tsId.name : 'null'} ` +
        `rust=${rustId.hit ? rustId.name : 'null'}`
      );
      if (tsId.hit && rustId.hit) {
        stats.hoverBothHit += 1;
        if (tsId.name === rustId.name) {
          stats.hoverNameAgree += 1;
        } else {
          stats.hoverNameDisagree += 1;
        }
      } else if (tsId.hit) {
        stats.hoverTsOnly += 1;
      } else if (rustId.hit) {
        stats.hoverRustOnly += 1;
      } else {
        stats.hoverBothMiss += 1;
      }
      sampleIndex += 1;
    }
    // .py 探针:TS def 方法标注面(非空)vs Rust null(.def 语料面之外的覆盖缺口)
    const avatarPy = path.join(ASSETS_OUT, 'large', 'scripts', 'base', 'Avatar.py');
    const pyText =
      'class Avatar:\n' +
      '    def onEnterWorld(self):\n        return 0\n\n' +
      '    def onRpc0(self, arg):\n        return arg\n';
    fs.writeFileSync(avatarPy, pyText, 'utf8');
    client.openDocument(`file://${avatarPy}`, 'python', 1, pyText);
    const pyDoc = makeTextDocument(pyText, {
      fileName: avatarPy, languageId: 'python', uri: Uri.file(avatarPy)
    });
    const pyHover = await hoverProvider.provideHover(pyDoc, new Position(4, 13));
    const pyParams = hoverParams(`file://${avatarPy}`, 4, 13);
    await gate.compare('textDocument/hover', pyParams, tsHoverToLsp(pyHover), `file://${avatarPy}`);
    const rustPyRaw = await client.request('textDocument/hover', pyParams, { timeoutMs: 5000 });
    stats.hoverTsOnly += pyHover ? 1 : 0;
    stats.hoverBothMiss += !pyHover && rustPyRaw === null ? 1 : 0;
    stats.hoverRustOnly += !pyHover && rustPyRaw !== null ? 1 : 0;
    sampleIndex += 1;

    const summary = gate.diffLog.summary();
    once('S1.samplesTotal', sampleIndex);
    once('S1.shadowLog', JSON.stringify(summary));
    once('S1.hoverBothHit', stats.hoverBothHit);
    once('S1.hoverNameAgree', stats.hoverNameAgree);
    once('S1.hoverNameDisagree', stats.hoverNameDisagree);
    once('S1.hoverTsOnlyHit', stats.hoverTsOnly);
    once('S1.hoverRustOnlyHit', stats.hoverRustOnly);
    once('S1.hoverBothMiss', stats.hoverBothMiss);
    once('S1.compExactSequence', stats.compExact);
    once('S1.compRustSubsetOfTs', stats.compRustSubset);
    once('S1.compDiverge', stats.compDiverge);
    once('S1.compRustNullJudge', stats.compRustNull);
    once('S1.defDeclExact', stats.defDeclExact);
    once('S1.defDeclDiverge', stats.defDeclDiverge);
    once('S1.defDeclTsOnly', stats.defDeclTsOnly);
    once('S1.defDeclRustOnly', stats.defDeclRustOnly);
    once('S1.defDeclBothMiss', stats.defDeclBothMiss);
    once('S1.defRegistryExact', stats.defRegistryExact);
    once('S1.defRegistryDiverge', stats.defRegistryDiverge);
    once('S1.diagBothEmpty', stats.diagBothEmpty);
    once('S1.diagMatch', stats.diagMatch);
    once('S1.diagDiverge', stats.diagDiverge);
    const topRustOnly = [...stats.rustOnlyLabels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    once('S1.rustOnlyTopLabels', topRustOnly.map(([k, v]) => `${k}x${v}`).join(',') || '(none)');
    // 首分歧样本(前 5 条 diff/rust 侧失败)
    for (const entry of diffSamples.filter(e => e.verdict !== 'match').slice(0, 5)) {
      emit(`GATE2-DIFFSAMPLE #${entry.seq} ${entry.verdict} ${entry.method} ${entry.uri ?? ''} :: ${entry.detail ?? ''}`);
    }
    once('S1.gateState', JSON.stringify(gate.state));
  }, 900000);

  it('S2:TS vs Rust 双轨同参数计时(热态 5 轮×20,含 transport early-signal 口径)', async () => {
    const def = path.join(ASSETS_OUT, 'def-heavy', 'scripts', 'entity_defs', 'Unit0.def');
    const baseText = fs.readFileSync(def, 'utf8');
    const uri = `file://${def}`;
    client.openDocument(uri, 'kbengine-def', 1, baseText);
    const hoverLine = baseText.split('\n').findIndex(l => l.includes('<onRpc0 '));
    const typeText = `${baseText}\n  <Type> `;
    client.changeDocument(uri, 2, typeText);
    const compLine = typeText.split('\n').length - 1;
    const compCol = '  <Type> '.length;

    const tsHoverDoc = makeTextDocument(baseText, { fileName: def, languageId: 'kbengine-def', uri: Uri.file(def) });
    const tsCompDoc = makeTextDocument(typeText, { fileName: def, languageId: 'kbengine-def', uri: Uri.file(def) });
    Object.assign(tsCompDoc, { version: 2 });

    const bench = async (
      name: string,
      tsCall: () => Promise<unknown>,
      rustCall: () => Promise<unknown>
    ): Promise<void> => {
      const tsRounds: number[][] = [];
      const rustRounds: number[][] = [];
      for (let r = 0; r < 5; r += 1) {
        const tsRound: number[] = [];
        const rustRound: number[] = [];
        for (let i = 0; i < 20; i += 1) {
          let started = performance.now();
          await tsCall();
          tsRound.push(performance.now() - started);
          started = performance.now();
          await rustCall();
          rustRound.push(performance.now() - started);
        }
        tsRounds.push(tsRound);
        rustRounds.push(rustRound);
      }
      metricRounds(`${name}.ts`, tsRounds);
      metricRounds(`${name}.rust`, rustRounds);
      const tsP95 = percentile(tsRounds.flat(), 0.95);
      const rustP95 = percentile(rustRounds.flat(), 0.95);
      once(`${name}.ratioRustOverTsP95`, Math.round((rustP95 / Math.max(tsP95, 0.01)) * 100) / 100, 'x');
    };

    await bench(
      'S2.hoverDefMethod',
      () => hoverProvider.provideHover(tsHoverDoc, new Position(hoverLine, 6)),
      () => client.request('textDocument/hover', hoverParams(uri, hoverLine, 6))
    );
    await bench(
      'S2.completionDefType',
      () => defCompletion.provideCompletionItems(tsCompDoc, new Position(compLine, compCol)),
      () => client.request('textDocument/completion', completionParams(uri, compLine, compCol))
    );

    // Phase2 首片:definition(声明词探针,定义落点解析)双轨计时。
    const propLine = baseText.split('\n').findIndex(l => l.includes('<hp '));
    await bench(
      'S2.definitionDefProp',
      async () => defDefinition.provideDefinition(tsHoverDoc, new Position(propLine, 6)),
      () => client.request('textDocument/definition', hoverParams(uri, propLine, 6))
    );
    // Phase2 首片:diagnostics(validateDocument 语料子集)双轨计时。
    await bench(
      'S2.diagnosticsDef',
      async () => {
        const collection = new DiagnosticCollection();
        validateDocument(tsHoverDoc as never, collection as never);
        return collection.get(Uri.file(def)).length;
      },
      () => client.request('textDocument/diagnostic', { textDocument: { uri } })
    );

    // compare() 通道总开销(TS 直调 + Rust 镜像 + 规范比较;切流前接线成本参考)
    const compareRounds: number[][] = [];
    for (let r = 0; r < 5; r += 1) {
      const round: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        await gate.compare(
          'textDocument/completion',
          completionParams(uri, compLine, compCol),
          { isIncomplete: false, items: [] },
          uri
        );
        round.push(performance.now() - started);
      }
      compareRounds.push(round);
    }
    metricRounds('S2.compareChannel.completionDefType', compareRounds);
  }, 900000);

  it('S3:压力 —— 连发 burst + 编辑风暴 + 内存 soak + 日志有界', async () => {
    const def = path.join(ASSETS_OUT, 'def-heavy', 'scripts', 'entity_defs', 'Unit1.def');
    const baseText = fs.readFileSync(def, 'utf8');
    const uri = `file://${def}`;
    client.openDocument(uri, 'kbengine-def', 1, baseText);
    const typeText = `${baseText}\n  <Type> `;
    client.changeDocument(uri, 2, typeText);
    const compLine = typeText.split('\n').length - 1;
    const compCol = '  <Type> '.length;
    const params = completionParams(uri, compLine, compCol);
    const tsCompDoc = makeTextDocument(typeText, { fileName: def, languageId: 'kbengine-def', uri: Uri.file(def) });
    Object.assign(tsCompDoc, { version: 2 });
    // 预热后计时
    await client.request('textDocument/completion', params);
    await defCompletion.provideCompletionItems(tsCompDoc, new Position(compLine, compCol));

    // 3.1 连发 burst:并发 50 × 4 批(Rust 协议往返 / TS 直调 / compare 通道各 200)
    const burst = async (call: () => Promise<unknown>, total: number, concurrency: number): Promise<number[]> => {
      const latencies: number[] = [];
      let errors = 0;
      for (let done = 0; done < total; done += concurrency) {
        const batch = Array.from({ length: Math.min(concurrency, total - done) }, async () => {
          const started = performance.now();
          try {
            await call();
          } catch {
            errors += 1;
          }
          return performance.now() - started;
        });
        latencies.push(...await Promise.all(batch));
      }
      once('S3.burstErrors', errors);
      return latencies;
    };
    metric('S3.burstRustCompletion', await burst(
      () => client.request('textDocument/completion', params), 200, 50
    ));
    metric('S3.burstTsCompletion', await burst(
      () => defCompletion.provideCompletionItems(tsCompDoc, new Position(compLine, compCol)), 200, 50
    ));
    metric('S3.burstShadowCompare', await burst(
      () => gate.compare('textDocument/completion', params, { isIncomplete: false, items: [] }, uri), 200, 50
    ));

    // 3.2 编辑风暴:150 轮 didChange(v++)→ 双轨重查(逐轮墙钟)。
    // 触发行注入在追加的 <Properties> 段内部(Rust 开标签判面在该栈顶才接管
    // 属性面;stormProp 应同时出现在双侧结果里,作风暴后一致性探针)。
    const serverRss = startRssSampler(serverRssReader(client));
    const stormRounds: number[] = [];
    let lastRustLabels: string[] = [];
    let lastTsLabels: string[] = [];
    for (let n = 0; n < 150; n += 1) {
      const version = 10 + n;
      const stormText = baseText.replace(
        '</root>',
        `  <Properties>\n    <stormProp${n} type="UINT32" flags="BASE"/>\n  <\n  </Properties>\n</root>`
      );
      const probeLine = stormText.split('\n').findIndex(l => l.trim() === '<');
      const started = performance.now();
      client.changeDocument(uri, version, stormText);
      const rustRaw = await client.request('textDocument/completion', completionParams(uri, probeLine, 4)) as LspCompletionFace | null;
      const tsDoc = makeTextDocument(stormText, { fileName: def, languageId: 'kbengine-def', uri: Uri.file(def) });
      Object.assign(tsDoc, { version });
      const tsItems = await defCompletion.provideCompletionItems(tsDoc, new Position(probeLine, 4));
      stormRounds.push(performance.now() - started);
      if (n === 149) {
        lastRustLabels = rustRaw ? (rustRaw.items ?? []).map(item => String(item.label)) : [];
        lastTsLabels = tsItemsToLsp(tsItems).items.map(item => item.label);
      }
    }
    metric('S3.editStormRound', stormRounds);
    once('S3.stormFinalRustHasStormProp149', lastRustLabels.includes('stormProp149') ? 1 : 0);
    once('S3.stormFinalTsHasStormProp149', lastTsLabels.includes('stormProp149') ? 1 : 0);
    once('S3.stormFinalRustLabelCount', lastRustLabels.length);
    once('S3.stormFinalTsLabelCount', lastTsLabels.length);

    // 3.3 内存 soak:1200 次顺序 compare(轮换 20 个 def)+ 双进程 RSS
    const soakRss = startRssSampler(serverRssReader(client));
    const selfRss = startRssSampler(() => process.memoryUsage().rss);
    const soakStartRss = process.memoryUsage().rss;
    const soakDefs = sampledDefs().slice(0, 20);
    const sentinel = Object.freeze({ isIncomplete: false, items: [{ label: 'SENTINEL' }] });
    for (let n = 0; n < 1200; n += 1) {
      const target = soakDefs[n % soakDefs.length];
      const targetUri = `file://${target.file}`;
      const result = await gate.compare(
        'textDocument/completion',
        completionParams(targetUri, 0, 0),
        sentinel,
        targetUri
      );
      if (n % 100 === 0 && result !== sentinel) {
        once('S3.tsResultIdentityBroken', `at#${n}`);
      }
    }
    const soakSelfPeak = Math.max(...selfRss.stop(), process.memoryUsage().rss);
    rssReport('S3.soakServerRss', soakRss.stop().filter(v => !Number.isNaN(v)));
    once('S3.soakSelfPeakRssMb', mb(soakSelfPeak), ' MB');
    once('S3.soakSelfPeakDeltaMb', mb(soakSelfPeak - soakStartRss), ' MB');
    const post = gate.diffLog.summary();
    once('S3.diffLogAfterSoak', JSON.stringify(post));
    once('S3.diffLogBounded500', post.total <= 500 ? 1 : 0);
  }, 900000);
});

// ---- 参数构造 --------------------------------------------------------------

const hoverParams = (uri: string, line: number, character: number): unknown => ({
  textDocument: { uri },
  position: { line, character }
});

const completionParams = (uri: string, line: number, character: number): unknown => ({
  textDocument: { uri },
  position: { line, character }
});
