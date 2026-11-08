// 服务态性能测量(2026-11-08 用户令「直接切到 rust…特别是性能问题」;
// bench 配置不进门禁,与 KODE-PERF-007 同口径):
//   cargo build -p kode-server
//   npx vitest run --config vitest.bench.config.ts tests/perf/servingState.bench.ts
//
// 量测面 = 服务轨道真实链路(真实 kode-server 二进制 + 真实 client):
//   ①spawn:二进制拉起 + initialize 握手墙钟(激活路径成本);
//   ②mirror:语料全量镜像(300 与 3000 def 两档)总量/单文档分位;
//   ③firstRequest:镜像后首查(definition/completion/diagnostic)RTT;
//   ④steady:热态三面各 100 样本 P50/P95/P99/max(与 2026-11-04 v0.2
//     基线的 TS provider 数字对照,基线见 docs/perf/2026-baseline.md);
//   ⑤editRoundTrip:didChange 镜像 + diagnostic 请求的每编辑服务成本
//     (诊断服务腿的真实每键成本);
//   ⑥memory:kode-server 进程 RSS(/proc/<pid>/status VmRSS)在
//     start/mirror/steady 三检查点的快照。
// 只观测不改行为;二进制缺失整套跳过(单测基线不背工具链依赖)。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../../src/kodeCoreClient';

const OUT_FILE =
  process.env.KODE_SERVING_OUT ?? path.resolve(__dirname, '../../docs/perf/serving-state-run.txt');

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
    `V02-SERVING-METRIC ${name} n=${values.length} ` +
      `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
      `p99=${percentile(values, 0.99)}ms max=${percentile(values, 1)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`V02-SERVING-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
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
// bench 需要较新二进制(诊断面切流后):build 缺失时尝试现场编译一次。
if (!hasBinary && spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, stdio: 'ignore' });
}
const suite = fs.existsSync(binaryPath) ? describe : describe.skip;

// ---- 合成语料工作区 ---------------------------------------------------------

const defTextOf = (name: string): string =>
  [
    '<root>',
    `\t<Properties>`,
    ...Array.from({ length: 10 }, (_, i) =>
      [
        `\t\t<${name}_p${i}>`,
        `\t\t\t<Type> ${i % 3 === 0 ? 'UINT32' : i % 3 === 1 ? 'STRING' : 'SKILL_SLOT'} </Type>`,
        `\t\t\t<Flags> ${['BASE', 'CELL_PUBLIC', 'ALL_CLIENTS'][i % 3]} </Flags>`,
        i === 0 ? `\t\t\t<DetailLevel> NEAR </DetailLevel>` : null,
        `\t\t</${name}_p${i}>`
      ]
        .filter(line => line !== null)
        .join('\n')
    ),
    `\t</Properties>`,
    `\t<BaseMethods>`,
    ...Array.from({ length: 5 }, (_, i) =>
      [`\t\t<onBase${i}>`, `\t\t\t<Arg> UINT32 </Arg>`, `\t\t</onBase${i}>`].join('\n')
    ),
    `\t</BaseMethods>`,
    `\t<CellMethods>`,
    ...Array.from({ length: 5 }, (_, i) =>
      [`\t\t<onCell${i}>`, `\t\t\t<Arg> UINT32 </Arg>`, `\t\t</onCell${i}>`].join('\n')
    ),
    `\t</CellMethods>`,
    `\t<ClientMethods>`,
    ...Array.from({ length: 5 }, (_, i) => [`\t\t<onClient${i}>`, `\t\t</onClient${i}>`].join('\n')),
    `\t</ClientMethods>`,
    `\t<DetailLevels>`,
    `\t\t<NEAR> 400 </NEAR>`,
    `\t\t<MEDIUM> 300 </MEDIUM>`,
    `\t\t<FAR> 200 </FAR>`,
    `\t</DetailLevels>`,
    `</root>`
  ].join('\n');

const TYPES_XML = [
  '<root>',
  '\t<SKILL_SLOT>',
  '\t\t<FIXED_DICT>',
  '\t\t\t<ImplementedBy>skill_slot_impl</ImplementedBy>',
  '\t\t\t<Properties>',
  '\t\t\t\t<slot>',
  '\t\t\t\t\t<Type> UINT8 </Type>',
  '\t\t\t\t</slot>',
  '\t\t\t\t<skillId>',
  '\t\t\t\t\t<Type> UINT32 </Type>',
  '\t\t\t\t</skillId>',
  '\t\t\t</Properties>',
  '\t\t</FIXED_DICT>',
  '\t</SKILL_SLOT>',
  '\t<ITEM_QUALITY> UINT8 </ITEM_QUALITY>',
  '</root>'
].join('\n');

const ENTITIES_XML = ['<root>', '\t<Monster config="kbengine_monster_defaults"/>', '</root>'].join('\n');
const ALIAS_XML = ['<root>', '\t<ITEM_LIST>', '\t\t<ARRAY>', '\t\t\tof="ITEM_QUALITY"', '\t\t</ARRAY>', '\t</ITEM_LIST>', '</root>'].join('\n');

interface ServingWorkspace {
  dir: string;
  defUris: string[];
  corpusUris: string[];
  defTexts: string[];
}

/** 生成合成语料(defCount 个 .def + 三类 XML),返回 file:// URI 清单 */
const makeServingWorkspace = (dir: string, defCount: number): ServingWorkspace => {
  fs.rmSync(dir, { recursive: true, force: true });
  const defs = path.join(dir, 'scripts', 'entity_defs');
  fs.mkdirSync(defs, { recursive: true });
  const defUris: string[] = [];
  const defTexts: string[] = [];
  for (let i = 0; i < defCount; i += 1) {
    const name = `Entity${i}`;
    const file = path.join(defs, `${name}.def`);
    const text = defTextOf(name);
    fs.writeFileSync(file, text);
    defUris.push(`file://${file}`);
    defTexts.push(text);
  }
  const corpusUris = [
    `file://${path.join(defs, 'types.xml')}`,
    `file://${path.join(defs, 'entities.xml')}`,
    `file://${path.join(defs, 'alias.xml')}`
  ];
  fs.writeFileSync(path.join(defs, 'types.xml'), TYPES_XML);
  fs.writeFileSync(path.join(defs, 'entities.xml'), ENTITIES_XML);
  fs.writeFileSync(path.join(defs, 'alias.xml'), ALIAS_XML);
  return { dir, defUris, corpusUris, defTexts };
};

// 探针位置:defTextOf 每 def 首属性 `<Type> UINT32 </Type>` 在第 3 行(0 基),
// 词 UINT32 起点 = 3 tab + `<Type> `(7) = 10。
const DEF_PROBE = { line: 3, character: 12 };
// 补全探针:末尾 `\t\t<`(开标签上下文,属性面),探针在该行行尾(字符 3)。
const COMPLETION_TEXT_SUFFIX = '\n\t\t<';
const COMPLETION_PROBE = (text: string): { line: number; character: number } => ({
  line: text.split('\n').length - 1,
  character: 3
});

const diagParamsOf = (uri: string) => ({ textDocument: { uri } });
const defParamsOf = (uri: string) => ({
  textDocument: { uri },
  position: { line: DEF_PROBE.line, character: DEF_PROBE.character }
});

suite('服务态性能测量(真实 kode-server,bench 不进门禁)', () => {
  const SMALL = makeServingWorkspace(path.join(os.tmpdir(), 'kode-serving-small'), 300);
  const LARGE = makeServingWorkspace(path.join(os.tmpdir(), 'kode-serving-large'), 3000);
  const clients: KodeCoreClient[] = [];

  const makeClient = async (): Promise<KodeCoreClient> => {
    const client = new KodeCoreClient({ binaryPath });
    clients.push(client);
    return client;
  };

  const mirrorAll = async (
    client: KodeCoreClient,
    ws: ServingWorkspace,
    perDoc: number[] | null
  ): Promise<number> => {
    const t0 = performance.now();
    for (const uri of ws.corpusUris) {
      const file = uri.slice('file://'.length);
      const text = fs.readFileSync(file, 'utf8');
      const t = performance.now();
      await client.openDocument(uri, 'xml', 1, text);
      perDoc?.push(performance.now() - t);
    }
    for (let i = 0; i < ws.defUris.length; i += 1) {
      const t = performance.now();
      await client.openDocument(ws.defUris[i], 'kbengine-def', 1, ws.defTexts[i]);
      perDoc?.push(performance.now() - t);
    }
    return performance.now() - t0;
  };

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      await client.dispose().catch(() => undefined);
    }
    fs.rmSync(SMALL.dir, { recursive: true, force: true });
    fs.rmSync(LARGE.dir, { recursive: true, force: true });
  });

  it('spawn:二进制拉起 + initialize 握手(激活路径成本)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const client = await makeClient();
      const t0 = performance.now();
      await client.start();
      samples.push(performance.now() - t0);
      const health = await client.health();
      expect(health.initialized).toBe(true);
      await client.dispose();
    }
    metric('spawn.start', samples);
  });

  it('mirror.300:语料全量镜像(小工作区)总量 + 单文档分位 + 首查 RTT', async () => {
    const client = await makeClient();
    await client.start();
    const perDoc: number[] = [];
    const total = await mirrorAll(client, SMALL, perDoc);
    once('mirror300.total', total);
    metric('mirror300.perDoc', perDoc);
    const health = await client.health();
    expect(health.documents).toHaveLength(300 + 3);
    // 首查 RTT(镜像已入库 = 服务端已解析;首查含请求路径冷开销)
    const firstDef0 = performance.now();
    await client.request('textDocument/definition', defParamsOf(SMALL.defUris[0]));
    once('firstRequest.definition', performance.now() - firstDef0);
    const text = SMALL.defTexts[0] + COMPLETION_TEXT_SUFFIX;
    await client.openDocument(SMALL.defUris[0] + '.comp.def', 'kbengine-def', 1, text);
    const firstComp0 = performance.now();
    await client.request('textDocument/completion', {
      textDocument: { uri: SMALL.defUris[0] + '.comp.def' },
      position: COMPLETION_PROBE(text)
    });
    once('firstRequest.completion', performance.now() - firstComp0);
    const firstDiag0 = performance.now();
    await client.request('textDocument/diagnostic', diagParamsOf(SMALL.defUris[0]));
    once('firstRequest.diagnostic', performance.now() - firstDiag0);
    await client.dispose();
  });

  it('mirror.3000:语料全量镜像(大工作区)总量 + RSS 三检查点 + 稳态/每编辑成本', async () => {
    const client = await makeClient();
    await client.start();
    const health0 = await client.health();
    const rssStart = serverRssMb(health0.pid);
    once('rss.afterStart', rssStart ?? -1, ' MB');

    const total = await mirrorAll(client, LARGE, null);
    once('mirror3000.total', total);
    const health1 = await client.health();
    expect(health1.documents).toHaveLength(3000 + 3);
    const rssMirror = serverRssMb(health1.pid);
    once('rss.afterMirror3000', rssMirror ?? -1, ' MB');

    // 稳态:三面各 100 样本(轮转 10 个文档,覆盖不同索引槽位)
    const defSamples: number[] = [];
    const compSamples: number[] = [];
    const diagSamples: number[] = [];
    const completionTexts: string[] = [];
    const completionUris: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const text = LARGE.defTexts[i] + COMPLETION_TEXT_SUFFIX;
      const uri = `${LARGE.defUris[i]}.comp.def`;
      completionUris.push(uri);
      completionTexts.push(text);
      await client.openDocument(uri, 'kbengine-def', 1, text);
    }
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 10; i += 1) {
        const defUri = LARGE.defUris[(round * 10 + i) % LARGE.defUris.length];
        let t = performance.now();
        await client.request('textDocument/definition', defParamsOf(defUri));
        defSamples.push(performance.now() - t);
        t = performance.now();
        await client.request('textDocument/completion', {
          textDocument: { uri: completionUris[i] },
          position: COMPLETION_PROBE(completionTexts[i])
        });
        compSamples.push(performance.now() - t);
        t = performance.now();
        await client.request('textDocument/diagnostic', diagParamsOf(defUri));
        diagSamples.push(performance.now() - t);
      }
    }
    // 纯传输地板:health 服务端近零工作,RTT 即链路地板(与三面 RTT 对照,
    // 分离「传输开销」vs「服务端算力」)。
    const healthSamples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t = performance.now();
      await client.request('$/kode/health');
      healthSamples.push(performance.now() - t);
    }
    metric('steady.healthFloor', healthSamples);

    metric('steady.definition', defSamples);
    metric('steady.completion', compSamples);
    metric('steady.diagnostic', diagSamples);

    // 每编辑成本:didChange 镜像 + diagnostic 请求(诊断服务腿真实每键成本)
    const editSamples: number[] = [];
    const mirrorSamples: number[] = [];
    const editUri = LARGE.defUris[0];
    let editVersion = 1;
    for (let i = 0; i < 50; i += 1) {
      editVersion += 1;
      const text = LARGE.defTexts[0] + `\n\t<!-- edit ${i} -->`;
      let t = performance.now();
      await client.changeDocument(editUri, editVersion, text);
      mirrorSamples.push(performance.now() - t);
      t = performance.now();
      await client.request('textDocument/diagnostic', diagParamsOf(editUri));
      editSamples.push(performance.now() - t);
    }
    metric('editRoundTrip.mirrorDidChange', mirrorSamples);
    metric('editRoundTrip.diagnostic', editSamples);

    // 管流水线分离实验:20 路并发 diagnostic 请求不逐个 await(Promise.all),
    // 总墙钟/20 = 摊销单请求成本。若摊销 << 串行 P50,则串行 RTT 由 IPC 帧
    // 往返主导(而非服务端算力),批量化/管线化是优化杠杆。
    const pipelineUris = LARGE.defUris.slice(0, 20);
    const tPipeline = performance.now();
    await Promise.all(pipelineUris.map(uri => client.request('textDocument/diagnostic', diagParamsOf(uri))));
    once('pipeline.diagnostic20.total', performance.now() - tPipeline);
    once('pipeline.diagnostic20.amortized', (performance.now() - tPipeline) / pipelineUris.length);

    const rssEnd = serverRssMb((await client.health()).pid);
    once('rss.afterSteady', rssEnd ?? -1, ' MB');
    if (rssStart !== null && rssMirror !== null) {
      once('rss.mirrorDeltaMb', Math.round((rssMirror - rssStart) * 100) / 100, ' MB');
    }
    emit('V02-SERVING-NOTE ts 对照基线见 docs/perf/2026-baseline.md(hover P50 0.01-0.73ms large 热态;big-py hover P50 3.38ms)');
    await client.dispose();
  });
});
