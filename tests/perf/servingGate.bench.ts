// Rust 服务态门禁 bench(2026-11-15 用户审计 P1-3:perf-gate 此前只跑 TS
// v02Baseline,真实 kode-server 的服务面从未进合并门):
//   KODE_SERVING_GATE=1 pnpm exec vitest run --config vitest.bench.config.ts \
//     tests/perf/servingGate.bench.ts
//
// 缺省(无 KODE_SERVING_GATE=1)整套 skip——bench 目录被整跑时不重复 serving
// 观测面;测量形态与 servingState.bench.ts 同源(spawn/mirror/steady/RSS),
// 收尾按 servingBounds.ts 宽松上界断言(KODE_SERVING_BOUND_* 可覆盖)。
// 本文件是门:任一面超界 = perf-gate job 红 = 合并阻塞面。
// 断言位:各测量面只记账 violations,收尾 it 统一断言全集——任何一面超界
// 都让门红,不只最后一面。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { performance } from 'perf_hooks';

import { KodeCoreClient } from '../../src/backend/kodeCoreClient';
import { resolveServingBounds, servingGateViolations } from './servingBounds';

const OUT_FILE =
  process.env.KODE_SERVING_GATE_OUT ??
  path.resolve(__dirname, '../../docs/perf/serving-gate-run.txt');

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

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`SERVING-GATE-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const metric = (name: string, samples: number[]): void => {
  emit(
    `SERVING-GATE-METRIC ${name} n=${samples.length} ` +
      `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms ` +
      `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`
  );
};

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

/** kode-server 进程 RSS(/proc/<pid>/status VmRSS kB → MB);不可得返回 null */
const serverRssMb = (pid: number): number | null => {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return match ? mb(Number(match[1]) * 1024) : null;
  } catch {
    return null;
  }
};

const repoRoot = path.resolve(__dirname, '../..');
const binaryPath = path.join(repoRoot, 'target', 'debug', 'kode-server');
const hasBinary = fs.existsSync(binaryPath);
// 门模式需要较新二进制:build 缺失时现场编译一次(CI 的 perf-gate job 在
// 本 bench 前已有显式 cargo build 步,这里兜底本地直跑)。
if (!hasBinary && spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, stdio: 'ignore' });
}
const suite =
  process.env.KODE_SERVING_GATE === '1' && fs.existsSync(binaryPath) ? describe : describe.skip;

const DEF_COUNT = Number(process.env.KODE_SERVING_FILES ?? '3000');

// ---- 合成语料(servingState.bench.ts 同生成器形态;拷贝不 import 防 suite 注册) ----

const defTextOf = (name: string): string =>
  [
    '<root>',
    '\t<Properties>',
    ...Array.from({ length: 10 }, (_, i) =>
      [
        `\t\t<${name}_p${i}>`,
        `\t\t\t<Type> ${i % 3 === 0 ? 'UINT32' : i % 3 === 1 ? 'STRING' : 'SKILL_SLOT'} </Type>`,
        `\t\t\t<Flags> ${['BASE', 'CELL_PUBLIC', 'ALL_CLIENTS'][i % 3]} </Flags>`,
        `\t\t</${name}_p${i}>`
      ].join('\n')
    ),
    '\t</Properties>',
    '\t<BaseMethods>',
    ...Array.from({ length: 5 }, (_, i) =>
      [`\t\t<onBase${i}>`, `\t\t\t<Arg> UINT32 </Arg>`, `\t\t</onBase${i}>`].join('\n')
    ),
    '\t</BaseMethods>',
    '</root>'
  ].join('\n');

const TYPES_XML = ['<root>', '\t<SKILL_SLOT> UINT8 </SKILL_SLOT>', '</root>'].join('\n');
const ENTITIES_XML = ['<root>', '\t<Monster/>', '</root>'].join('\n');
const ALIAS_XML = [
  '<root>',
  '\t<ITEM_LIST>',
  '\t\t<ARRAY>',
  '\t\t\tof="SKILL_SLOT"',
  '\t\t</ARRAY>',
  '\t</ITEM_LIST>',
  '</root>'
].join('\n');

interface GateWorkspace {
  dir: string;
  corpusUris: string[];
  defUris: string[];
  defTexts: string[];
}

const makeWorkspace = (dir: string, defCount: number): GateWorkspace => {
  fs.rmSync(dir, { recursive: true, force: true });
  const defs = path.join(dir, 'scripts', 'entity_defs');
  fs.mkdirSync(defs, { recursive: true });
  const defUris: string[] = [];
  const defTexts: string[] = [];
  for (let i = 0; i < defCount; i += 1) {
    const name = `Gate${i}`;
    const file = path.join(defs, `${name}.def`);
    const text = defTextOf(name);
    fs.writeFileSync(file, text);
    defUris.push(`file://${file}`);
    defTexts.push(text);
  }
  fs.writeFileSync(path.join(defs, 'types.xml'), TYPES_XML);
  fs.writeFileSync(path.join(defs, 'entities.xml'), ENTITIES_XML);
  fs.writeFileSync(path.join(defs, 'alias.xml'), ALIAS_XML);
  // 与 servingState 同账本:三类 XML 先行镜像(servingState 镜像面=corpus+defs,
  // 健康面文档数=defCount+3;漏镜像三类=健康面差 3,门跑即红——2026-11-15 实证)。
  const corpusUris = ['types.xml', 'entities.xml', 'alias.xml'].map(base =>
    `file://${path.join(defs, base)}`
  );
  return { dir, corpusUris, defUris, defTexts };
};

// 探针:servingState 同位——首属性 <Type> 行(0 基第 3 行)UINT32 词起点。
const DEF_PROBE = { line: 3, character: 12 };
const COMPLETION_TEXT_SUFFIX = '\n\t\t<';
const completionProbe = (text: string): { line: number; character: number } => ({
  line: text.split('\n').length - 1,
  character: 3
});

suite(`Rust 服务态门禁(${DEF_COUNT} def,KODE_SERVING_BOUND_* 宽松上界)`, () => {
  const ws = makeWorkspace(path.join(os.tmpdir(), 'kode-serving-gate'), DEF_COUNT);
  const clients: KodeCoreClient[] = [];
  const violations: string[] = [];

  const makeClient = (): KodeCoreClient => {
    const client = new KodeCoreClient({ binaryPath });
    clients.push(client);
    return client;
  };

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      await client.dispose().catch(() => undefined);
    }
    fs.rmSync(ws.dir, { recursive: true, force: true });
    emit(
      `SERVING-GATE-SUMMARY violations=${violations.length} ` +
        (violations.length > 0 ? violations.join(' | ') : 'all-bounds-met')
    );
  });

  it('spawn:拉起+握手 p99 在界(基线 p99 13.8ms,界 5s=CI 慢 runner 余量)', async () => {
    const bounds = resolveServingBounds();
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const client = makeClient();
      const t0 = performance.now();
      await client.start();
      samples.push(performance.now() - t0);
      const health = await client.health();
      expect(health.initialized).toBe(true);
      await client.dispose();
    }
    metric('spawn.start', samples);
    violations.push(
      ...servingGateViolations(bounds, { spawnStartP99Ms: percentile(samples, 0.99) })
    );
  });

  it('mirror:语料全量镜像总量与 RSS 增量在界(基线 64ms/+110MB,界 10s/+300MB)', async () => {
    const bounds = resolveServingBounds();
    const client = makeClient();
    await client.start();
    // RSS 基点=start 后镜像前采样(镜像后再采基点恒 ~0,闸失效)。
    const pid = (await client.health()).pid;
    const rssBaseline = serverRssMb(pid) ?? 0;
    const t0 = performance.now();
    for (const corpusUri of ws.corpusUris) {
      await client.openDocument(corpusUri, 'xml', 1, fs.readFileSync(corpusUri.slice('file://'.length), 'utf8'));
    }
    for (let i = 0; i < ws.defUris.length; i += 1) {
      await client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
    }
    const total = performance.now() - t0;
    once(`mirror${DEF_COUNT}.total`, total);
    const health = await client.health();
    expect(health.documents).toHaveLength(DEF_COUNT + 3);
    const rssAfter = serverRssMb(health.pid);
    once('rss.afterMirror', rssAfter ?? -1, ' MB');
    violations.push(
      ...servingGateViolations(bounds, {
        mirrorTotalMs: total,
        mirrorRssDeltaMb: Math.max(0, (rssAfter ?? 0) - rssBaseline)
      })
    );
    await client.dispose();
  });

  it('steady:满语料三面热态 p99、每编辑与驻留在界(基线 p99 1-4.5ms/116MB,界 15-40ms/400MB)', async () => {
    const bounds = resolveServingBounds();
    const client = makeClient();
    await client.start();
    // 稳态必须落在满语料上(与 servingState 基线同形:先镜像后量测;
    // 2026-11-15 自审修正——首版漏镜像,10 文档服务器上量稳态,闸名不副实)。
    for (const corpusUri of ws.corpusUris) {
      await client.openDocument(corpusUri, 'xml', 1, fs.readFileSync(corpusUri.slice('file://'.length), 'utf8'));
    }
    for (let i = 0; i < ws.defUris.length; i += 1) {
      await client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
    }
    const compUris: string[] = [];
    const compTexts: string[] = [];
    for (let i = 0; i < Math.min(10, ws.defUris.length); i += 1) {
      const text = ws.defTexts[i] + COMPLETION_TEXT_SUFFIX;
      const uri = `${ws.defUris[i]}.comp.def`;
      compUris.push(uri);
      compTexts.push(text);
      await client.openDocument(uri, 'kbengine-def', 1, text);
    }
    const defSamples: number[] = [];
    const compSamples: number[] = [];
    const diagSamples: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 10; i += 1) {
        const defUri = ws.defUris[(round * 10 + i) % ws.defUris.length];
        let t = performance.now();
        await client.request('textDocument/definition', {
          textDocument: { uri: defUri },
          position: DEF_PROBE
        });
        defSamples.push(performance.now() - t);
        t = performance.now();
        await client.request('textDocument/completion', {
          textDocument: { uri: compUris[i] },
          position: completionProbe(compTexts[i])
        });
        compSamples.push(performance.now() - t);
        t = performance.now();
        await client.request('textDocument/diagnostic', { textDocument: { uri: defUri } });
        diagSamples.push(performance.now() - t);
      }
    }
    // 每编辑服务成本(didChange+diagnostic 往返 ×50,界=editRoundTripDiagnosticP99Ms)
    const editSamples: number[] = [];
    let editVersion = 1;
    for (let i = 0; i < 50; i += 1) {
      editVersion += 1;
      const edited = `${compTexts[0]}<GateEdit_p${i % 10}> UINT8 </GateEdit_p${i % 10}>\n`;
      await client.openDocument(compUris[0], 'kbengine-def', editVersion, edited);
      compTexts[0] = edited;
      const t = performance.now();
      await client.request('textDocument/diagnostic', {
        textDocument: { uri: compUris[0] }
      });
      editSamples.push(performance.now() - t);
    }
    metric('editRoundTrip.diagnostic', editSamples);
    metric('steady.definition', defSamples);
    metric('steady.completion', compSamples);
    metric('steady.diagnostic', diagSamples);
    const health = await client.health();
    const rssSteady = serverRssMb(health.pid);
    once('rss.afterSteady', rssSteady ?? -1, ' MB');
    violations.push(
      ...servingGateViolations(bounds, {
        steadyDefinitionP99Ms: percentile(defSamples, 0.99),
        steadyCompletionP99Ms: percentile(compSamples, 0.99),
        steadyDiagnosticP99Ms: percentile(diagSamples, 0.99),
        steadyRssMb: rssSteady ?? 0,
        editRoundTripDiagnosticP99Ms: percentile(editSamples, 0.99)
      })
    );
    await client.dispose();
  });

  it('gate:全部界收口(任一面超界=红=合并阻塞面)', () => {
    expect(violations).toEqual([]);
  });
});
