// RUST-425 重建期 tail latency 门禁 bench(HR-QA-013):
//   KODE_REBUILD_TAIL=1 pnpm exec vitest run --config vitest.bench.config.ts \
//     tests/perf/hotReloadRebuildTail.bench.ts
//
// 断言位:Rust Core 正在重建索引(索引队列深水)时,语言服务 serving 三面
// (definition/completion/diagnostic)与热更新(didChange)的 tail latency 不
// 大幅恶化,且语义面仍正确(已知落点/零诊断/正例诊断/热更后补全反映新属性)。
// 墙钟界走 rebuildTailBounds.ts 宽松上界(KODE_REBUILD_BOUND_* 可覆盖);
// 语义面在 bench 内硬断言(任一语义退化=红),不只在速度门。
//
// 车道结构(与 servingGate.bench.ts 同形态,rebuild 段为本批新增):
//   spawn  → 稳态镜像(500 基座) → steady 三面 p99 基线
//          → beginBackgroundScan(8000) → 8000 didOpen 洪泛(索引队列深水)
//          → barrier($/kode/health,FIFO 证明全部已入队) → rebuild 三面 p99
//            + 热更(didChange 新属性,补全须反映) + scanComplete
//          → 排空轮询(ingest.queued 归零) → gate 收口
// 诚实边界(写进 docs/perf/hot-reload-rebuild-tail.md):
//   * 重建=索引队列深水(大 didOpen 洪泛),非后台线程——Core 是单线程内联
//     pump;单任务不可抢占(1.6MB def ~150ms 阻塞全环)是已知缺口,本门如实
//     记录但不掩盖(宽松界只捕数量级回退)。
//   * 池竞争面(kode-pool)只服务 $/kode/rpc,不在 serving 路径;本门不伪造
//     池竞争,只在 doc 里说明(面与 RUST-425 三轴对账)。
//   * 墙钟界 ~10x 余量吸收共享 runner 抖动(PERF-015);跨机器不比较绝对值。
//   * 语义命中面(内容新鲜度/零诊断/正例诊断)硬断言,不属界表。
//
// 缺省(无 KODE_REBUILD_TAIL=1)整套 skip——bench 目录整跑时不重复本观测面。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { performance } from 'perf_hooks';

import { KodeCoreClient } from '../../src/backend/kodeCoreClient';
import { rebuildTailViolations, resolveRebuildTailBounds } from './rebuildTailBounds';

const OUT_FILE =
  process.env.KODE_REBUILD_TAIL_OUT ??
  path.resolve(__dirname, '../../docs/perf/hot-reload-rebuild-tail-run.txt');

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
  emit(`REBUILD-TAIL-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const metric = (name: string, samples: number[]): void => {
  emit(
    `REBUILD-TAIL-METRIC ${name} n=${samples.length} ` +
      `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms ` +
      `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`
  );
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const repoRoot = path.resolve(__dirname, '../..');
const binaryPath =
  process.env.KODE_REBUILD_TAIL_BINARY ?? path.join(repoRoot, 'target', 'debug', 'kode-server');
const hasBinary = fs.existsSync(binaryPath);
if (!hasBinary && spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, stdio: 'ignore' });
}
const suite =
  process.env.KODE_REBUILD_TAIL === '1' && fs.existsSync(binaryPath) ? describe : describe.skip;

// 基座 = 稳态镜像规模(与 servingGate DEF_COUNT 同量级);洪泛 = 重建期深水
// 队列规模。缺省 500/8000:300 次 serving 请求×16 泵=4800 排空 + 3 次热更
// 窗口×~450=1350,总 ~6150 < 8000,重建期全程 ingest.queued>0(实证证据在
// barrier/serving末/热更末三次采样)。
const BASE = Number(process.env.KODE_REBUILD_TAIL_BASE ?? '500');
const FLOOD = Number(process.env.KODE_REBUILD_TAIL_FLOOD ?? '8000');
// 热更窗口必须过 DID_CHANGE_DEBOUNCE_MS(300)才落队列;350ms 留裕量。
const HOT_SETTLE_MS = 350;

// ---- 合成语料(servingGate.bench.ts 同生成器形态;拷贝不 import 防 suite 注册) ----

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

interface RebuildWorkspace {
  dir: string;
  corpusUris: string[];
  defUris: string[];
  defTexts: string[];
  /** 洪泛 def(重建期深水);不存文本(只入队刷新,不 serving) */
  floodUris: string[];
}

const makeWorkspace = (dir: string, baseCount: number, floodCount: number): RebuildWorkspace => {
  fs.rmSync(dir, { recursive: true, force: true });
  const defs = path.join(dir, 'scripts', 'entity_defs');
  fs.mkdirSync(defs, { recursive: true });
  const defUris: string[] = [];
  const defTexts: string[] = [];
  for (let i = 0; i < baseCount; i += 1) {
    const name = `Rebase${i}`;
    const file = path.join(defs, `${name}.def`);
    const text = defTextOf(name);
    fs.writeFileSync(file, text);
    defUris.push(`file://${file}`);
    defTexts.push(text);
  }
  const floodUris: string[] = [];
  for (let i = 0; i < floodCount; i += 1) {
    const file = path.join(defs, `Rebuild${i}.def`);
    // 洪泛文件同样写盘(刷新任务真实读盘,非假任务)。
    fs.writeFileSync(file, defTextOf(`Rebuild${i}`));
    floodUris.push(`file://${file}`);
  }
  fs.writeFileSync(path.join(defs, 'types.xml'), TYPES_XML);
  fs.writeFileSync(path.join(defs, 'entities.xml'), ENTITIES_XML);
  fs.writeFileSync(path.join(defs, 'alias.xml'), ALIAS_XML);
  const corpusUris = ['types.xml', 'entities.xml', 'alias.xml'].map(base =>
    `file://${path.join(defs, base)}`
  );
  return { dir, corpusUris, defUris, defTexts, floodUris };
};

// 探针:p2 属性 <Type> 行(0 基第 11 行)SKILL_SLOT 词内——SKILL_SLOT 在
// types.xml 第 1 行注册 → definition 必须命中已知声明落点。
const DEF_PROBE = { line: 11, character: 11 };
/** 补全上下文文档:开标签探针行「\t\t<」插在 </Properties> 之前 */
const completionDocOf = (defText: string): {
  text: string;
  probe: { line: number; character: number };
} => {
  const lines = defText.split('\n');
  const at = lines.indexOf('\t</Properties>');
  const text = [...lines.slice(0, at), '\t\t<', ...lines.slice(at)].join('\n');
  return { text, probe: { line: at, character: 3 } };
};
/** 当前文本里开标签探针行号(编辑插入行后重算,防漂移)。 */
const openTagLineOf = (text: string): number => text.split('\n').lastIndexOf('\t\t<');

suite(`Rust 重建期 tail latency 门禁(base=${BASE} flood=${FLOOD},KODE_REBUILD_BOUND_*)`, () => {
  const ws = makeWorkspace(path.join(os.tmpdir(), 'kode-rebuild-tail'), BASE, FLOOD);
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
      `REBUILD-TAIL-SUMMARY violations=${violations.length} ` +
        (violations.length > 0 ? violations.join(' | ') : 'all-bounds-met')
    );
  });

  it('steady:满语料三面 p99 基线(重建前)', async () => {
    const client = makeClient();
    await client.start();
    for (const corpusUri of ws.corpusUris) {
      await client.openDocument(corpusUri, 'xml', 1, fs.readFileSync(corpusUri.slice('file://'.length), 'utf8'));
    }
    for (let i = 0; i < ws.defUris.length; i += 1) {
      await client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
    }
    // 补全面:基座前 10 个 def 的开标签探针副本(与 servingGate 同形)。
    const compUris: string[] = [];
    const compTexts: string[] = [];
    const compProbes: Array<{ line: number; character: number }> = [];
    for (let i = 0; i < Math.min(10, ws.defUris.length); i += 1) {
      const { text, probe } = completionDocOf(ws.defTexts[i]);
      const uri = `${ws.defUris[i]}.comp.def`;
      compUris.push(uri);
      compTexts.push(text);
      compProbes.push(probe);
      await client.openDocument(uri, 'kbengine-def', 1, text);
    }
    // 热更夹具:基座 0 号 def 的开标签探针副本(独立 uri,不扰 serving 样本)。
    const hotDoc = completionDocOf(ws.defTexts[0]);
    const hotUri = `${ws.defUris[0]}.hot.def`;
    await client.openDocument(hotUri, 'kbengine-def', 1, hotDoc.text);
    // 诊断正例夹具:未注册自定义类型。
    const brokenUri = `${ws.defUris[0]}.broken.def`;
    const brokenText = ws.defTexts[0].replace('SKILL_SLOT', 'NOT_A_KNOWN_TYPE');
    await client.openDocument(brokenUri, 'kbengine-def', 1, brokenText);

    const health = await client.health();
    expect(health.documents).toHaveLength(BASE + 3 + 10 + 2);

    let defHit: unknown;
    let compHit: unknown;
    let diagHit: unknown;
    const defSamples: number[] = [];
    const compSamples: number[] = [];
    const diagSamples: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 10; i += 1) {
        const defUri = ws.defUris[(round * 10 + i) % ws.defUris.length];
        let t = performance.now();
        const defResponse = await client.request('textDocument/definition', {
          textDocument: { uri: defUri },
          position: DEF_PROBE
        });
        defSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          defHit = defResponse;
        }
        t = performance.now();
        const compResponse = await client.request('textDocument/completion', {
          textDocument: { uri: compUris[i] },
          position: compProbes[i]
        });
        compSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          compHit = compResponse;
        }
        t = performance.now();
        const diagResponse = await client.request('textDocument/diagnostic', {
          textDocument: { uri: defUri }
        });
        diagSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          diagHit = diagResponse;
        }
      }
    }
    // ── 语义断言面(稳态正确性,重建期面在 rebuild it 再断言一次)──
    expect(defHit, 'definition 命中已知声明落点').toMatchObject({
      uri: expect.stringContaining('types.xml')
    });
    expect((defHit as { range: { start: { line: number } } }).range.start.line).toBe(1);
    const compItems = (compHit as { items?: Array<{ label: string }> }).items;
    expect(compHit, 'completion 非空').not.toBeNull();
    const labels = new Set((compItems ?? []).map(item => item.label));
    for (let i = 0; i < 10; i += 1) {
      expect(labels.has(`Rebase0_p${i}`), `补全缺必有项 Rebase0_p${i}`).toBe(true);
    }
    expect(diagHit, '干净 def 零诊断(反例)').toMatchObject({ items: [] });
    const brokenDiag = (await client.request('textDocument/diagnostic', {
      textDocument: { uri: brokenUri }
    })) as { items: Array<{ severity: number; message: string }> };
    expect(brokenDiag.items.length, '破型 def 必须有诊断(正例)').toBeGreaterThan(0);
    expect(brokenDiag.items.every(item => item.severity === 1)).toBe(true);

    metric('steady.definition', defSamples);
    metric('steady.completion', compSamples);
    metric('steady.diagnostic', diagSamples);
    violations.push(
      ...rebuildTailViolations(resolveRebuildTailBounds(), {
        steadyDefinitionP99Ms: percentile(defSamples, 0.99),
        steadyCompletionP99Ms: percentile(compSamples, 0.99),
        steadyDiagnosticP99Ms: percentile(diagSamples, 0.99)
      })
    );
    await client.dispose();
  });

  it('rebuild:深水重建期三面 p99 + 热更新鲜度 + 排空墙钟', async () => {
    const client = makeClient();
    await client.start();
    // 稳态语料先镜像(与 steady it 同形,本 it 自足——sibling it 不共享夹具)。
    for (const corpusUri of ws.corpusUris) {
      await client.openDocument(corpusUri, 'xml', 1, fs.readFileSync(corpusUri.slice('file://'.length), 'utf8'));
    }
    for (let i = 0; i < ws.defUris.length; i += 1) {
      await client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
    }
    const compUris: string[] = [];
    const compProbes: Array<{ line: number; character: number }> = [];
    for (let i = 0; i < Math.min(10, ws.defUris.length); i += 1) {
      const { text, probe } = completionDocOf(ws.defTexts[i]);
      const uri = `${ws.defUris[i]}.comp.def`;
      compUris.push(uri);
      compProbes.push(probe);
      await client.openDocument(uri, 'kbengine-def', 1, text);
    }
    const hotDoc = completionDocOf(ws.defTexts[0]);
    const hotUri = `${ws.defUris[0]}.hot.def`;
    let hotText = hotDoc.text;
    await client.openDocument(hotUri, 'kbengine-def', 1, hotText);

    // ── 重建开闸:暖门标记 + 8000 didOpen 洪泛(索引队列深水)──
    await client.beginBackgroundScan(FLOOD);
    const floodT0 = performance.now();
    for (let i = 0; i < ws.floodUris.length; i += 1) {
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri: ws.floodUris[i],
          languageId: 'kbengine-def',
          version: 1,
          text: defTextOf(`Rebuild${i}`)
        }
      });
    }
    // 屏障:health 请求与 8000 didOpen 同管道 FIFO——其应答回来即证明全部
    // didOpen 已处理入队(ingest.queued 深水)。health 不泵索引(dispatch 臂
    // 只回 health_report),屏障不消耗深水队列。
    const barrier = await client.health();
    const floodEnqueuedMs = performance.now() - floodT0;
    expect(barrier.documents).toHaveLength(BASE + 3 + 10 + 1 + FLOOD);
    const queuedAtBarrier = barrier.ingest.queued;
    expect(queuedAtBarrier, '洪泛后索引队列必须深水(重建确在进行)').toBeGreaterThan(0);
    once('rebuild.queuedAtBarrier', queuedAtBarrier, ' tasks');
    once('rebuild.rejectedQueueFullAtBarrier', barrier.ingest.rejectedQueueFull, ' tasks');
    once('rebuild.floodEnqueuedMs', floodEnqueuedMs);

    // ── 重建期 serving 三面(与 steady 同形;深水队列在位)──
    let defHit: unknown;
    let compHit: unknown;
    let diagHit: unknown;
    const defSamples: number[] = [];
    const compSamples: number[] = [];
    const diagSamples: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 10; i += 1) {
        const defUri = ws.defUris[(round * 10 + i) % ws.defUris.length];
        let t = performance.now();
        const defResponse = await client.request('textDocument/definition', {
          textDocument: { uri: defUri },
          position: DEF_PROBE
        }, { timeoutMs: 30000 });
        defSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          defHit = defResponse;
        }
        t = performance.now();
        const compResponse = await client.request('textDocument/completion', {
          textDocument: { uri: compUris[i] },
          position: compProbes[i]
        }, { timeoutMs: 30000 });
        compSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          compHit = compResponse;
        }
        t = performance.now();
        const diagResponse = await client.request('textDocument/diagnostic', {
          textDocument: { uri: defUri }
        }, { timeoutMs: 30000 });
        diagSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          diagHit = diagResponse;
        }
      }
    }
    const queuedAtServingEnd = (await client.health()).ingest.queued;
    expect(queuedAtServingEnd, 'serving 测量末重建仍在进行(队列未排空)').toBeGreaterThan(0);
    once('rebuild.queuedAtServingEnd', queuedAtServingEnd, ' tasks');

    // ── 热更 arm:didChange 新属性(重建期,深水队列在位)──
    // 3 次编辑:每次在开标签探针前插唯一属性块,过 300ms 风暴窗口后补全须
    // 反映新属性(freshen self-key 插入跳越,深水队前不排队)。
    const hotSamples: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      const at = openTagLineOf(hotText);
      const block = [
        `\t\t<HotReload_p${n}>`,
        '\t\t\t<Type> UINT8 </Type>',
        '\t\t\t<Flags> BASE </Flags>',
        `\t\t</HotReload_p${n}>`
      ];
      const lines = hotText.split('\n');
      hotText = [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
      await client.changeDocument(hotUri, 2 + n, hotText);
      await sleep(HOT_SETTLE_MS);
      const t = performance.now();
      const comp = (await client.request('textDocument/completion', {
        textDocument: { uri: hotUri },
        position: { line: openTagLineOf(hotText), character: 3 }
      }, { timeoutMs: 30000 })) as { items: Array<{ label: string }> };
      hotSamples.push(performance.now() - t);
      const hotLabels = new Set((comp.items ?? []).map(item => item.label));
      expect(
        hotLabels.has(`HotReload_p${n}`),
        `热更后补全面必须反映新属性 HotReload_p${n}(重建期 freshen 跳越)`
      ).toBe(true);
    }
    const queuedAtHotEnd = (await client.health()).ingest.queued;
    expect(queuedAtHotEnd, '热更末重建仍在进行(队列未排空)').toBeGreaterThan(0);
    once('rebuild.queuedAtHotEnd', queuedAtHotEnd, ' tasks');

    // ── 暖门收口 + 排空轮询(ingest.queued 归零)──
    await client.scanComplete(FLOOD, 0);
    const warm = await client.warmState();
    once('rebuild.coldWhileWarming', warm.coldWhileWarming, ' requests');
    // 观测面(非门面):排空速率样本——O(n²) 下 8000 档 15s 不会排空,如实记录
    // 仍在队数即可(不设门,不空等)。
    const pureDrainT0 = performance.now();
    let drainElapsed = performance.now() - floodT0;
    for (let i = 0; i < 75; i += 1) {
      const h = await client.health();
      if (h.ingest.queued === 0) {
        drainElapsed = performance.now() - floodT0;
        break;
      }
      if (performance.now() - floodT0 > 15000) {
        drainElapsed = performance.now() - floodT0;
        once('rebuild.queuedAtDrainTimeout', h.ingest.queued, ' tasks');
        break;
      }
      await sleep(200);
    }
    const pureDrainMs = performance.now() - pureDrainT0;
    const healthEnd = await client.health();
    const executed = healthEnd.ingest.executed;
    const enqueued = healthEnd.ingest.enqueued;

    // ── 语义断言面(重建期正确性,与稳态同形)──
    expect(defHit, '重建期 definition 命中已知声明落点').toMatchObject({
      uri: expect.stringContaining('types.xml')
    });
    expect((defHit as { range: { start: { line: number } } }).range.start.line).toBe(1);
    const compItems = (compHit as { items?: Array<{ label: string }> }).items;
    expect(compHit, '重建期 completion 非空').not.toBeNull();
    const labels = new Set((compItems ?? []).map(item => item.label));
    for (let i = 0; i < 10; i += 1) {
      expect(labels.has(`Rebase0_p${i}`), `重建期补全缺必有项 Rebase0_p${i}`).toBe(true);
    }
    expect(diagHit, '重建期干净 def 零诊断(反例)').toMatchObject({ items: [] });

    metric('rebuild.definition', defSamples);
    metric('rebuild.completion', compSamples);
    metric('rebuild.diagnostic', diagSamples);
    metric('rebuild.hotReloadFresh', hotSamples);
    // 排空墙钟=观测面非门面(诚实边界①):排空速率受 scheduler pick_next
    // 全队列重排 O(q log q) 拖累=重建排空 O(n²)(8000 档每任务 ~5ms、
    // 2000 档 ~18ms 实测)——属排空吞吐问题,非 RUST-425 判定面(判定面=
    // serving 尾延迟+热更新鲜度,两者与排空速率正交,serving 泵被 16ms 墙钟
    // 预算封顶故不被该 O(n²) 拖累)。门只断言 RUST-425 判定面。
    once('rebuild.drainTotal', drainElapsed);
    once('rebuild.pureDrain', pureDrainMs);
    once('rebuild.executed', executed, ' tasks');
    once('rebuild.enqueued', enqueued, ' tasks');
    violations.push(
      ...rebuildTailViolations(resolveRebuildTailBounds(), {
        rebuildDefinitionP99Ms: percentile(defSamples, 0.99),
        rebuildCompletionP99Ms: percentile(compSamples, 0.99),
        rebuildDiagnosticP99Ms: percentile(diagSamples, 0.99),
        hotReloadFreshCompletionP99Ms: percentile(hotSamples, 0.99)
      })
    );
    await client.dispose();
  });

  it('gate:全部界收口(任一面超界=红=合并阻塞面)', () => {
    expect(violations).toEqual([]);
  });
});
