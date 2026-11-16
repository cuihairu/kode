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
// 语义断言面(2026-11-15 审计 P1-2):steady it 内钉五面——已知声明落点
// (SKILL_SLOT→types.xml)、必有补全项(开标签位全部属性名)、诊断反例
// (干净语料零诊断)与正例(未注册类型 Error 点名)、编辑后结果变化(插入
// 属性进补全面+编辑流零诊断)。「所有语义请求回 null 的替身」在此红。

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

// RUST-242:稳态窗进程 CPU 占比观测——/proc/<pid>/stat 第 14/15 字段
// (utime+stime,clock tick;Linux USER_HZ 恒 100)。进程退出/非 Linux
// 返回 null=观测缺失,收尾如实跳过(不冒充违规也不冒充合规)。
const serverCpuSeconds = (pid: number): number | null => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 可含空格/括号:从最后一个 ')' 之后取字段,utime=第 14 个、
    // stime=第 15 个(1 基,含 state)。
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(afterComm[11]);
    const stime = Number(afterComm[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
      return null;
    }
    return (utime + stime) / 100;
  } catch {
    return null;
  }
};

const repoRoot = path.resolve(__dirname, '../..');
// KODE_SERVING_BINARY:红队替身入口(语义断言面的 prove-red 用——
// 「所有语义请求回 null/空」的替身必须把本门打红;缺省真二进制)。
const binaryPath =
  process.env.KODE_SERVING_BINARY ?? path.join(repoRoot, 'target', 'debug', 'kode-server');
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

// 探针:p2 属性 <Type> 行(0 基第 11 行)SKILL_SLOT 词内(词起点列 10,
// 探 +1)。SKILL_SLOT 在 types.xml 第 1 行注册 → definition 必须命中该
// 已知声明落点(内建类型 UINT32 无落点恒 null,不能当断言面)。
const DEF_PROBE = { line: 11, character: 11 };
/** 补全上下文文档:开标签探针行「\t\t<」插在 </Properties> 之前(标签栈顶
 * =Properties,成员补全真上下文;旧夹具把「<」放文档尾,栈空恒 null——
 * 2026-11-15 审计 P1-2 实证,gate 此前量的是恒空面)。 */
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
    // 端到端镜像计时必须含服务端入库(P1-4 审计修正):didOpen 是通知,
    // 旧口径在 health() 屏障前停表,数字只反映客户端投递。health 请求与
    // 通知同管道 FIFO——其应答回来即证明此前的 didOpen 已全部处理入库。
    const health = await client.health();
    expect(health.documents).toHaveLength(DEF_COUNT + 3);
    const total = performance.now() - t0;
    once(`mirror${DEF_COUNT}.total`, total);
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

  it('steady:满语料三面热态 p99、每编辑与驻留与 CPU 占比在界(基线 p99 1-4.5ms/116MB,界 15-40ms/400MB/CPU 200%)', async () => {
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
    const compProbes: Array<{ line: number; character: number }> = [];
    for (let i = 0; i < Math.min(10, ws.defUris.length); i += 1) {
      const { text, probe } = completionDocOf(ws.defTexts[i]);
      const uri = `${ws.defUris[i]}.comp.def`;
      compUris.push(uri);
      compTexts.push(text);
      compProbes.push(probe);
      await client.openDocument(uri, 'kbengine-def', 1, text);
    }
    // 诊断正例夹具:未注册自定义类型(干净语料全零诊断,本文件承载反例)。
    const brokenUri = `${ws.defUris[0]}.broken.def`;
    const brokenText = ws.defTexts[0].replace('SKILL_SLOT', 'NOT_A_KNOWN_TYPE');
    await client.openDocument(brokenUri, 'kbengine-def', 1, brokenText);
    // CPU 观测基线(RUST-242):测量循环开始前取进程 CPU 累计与墙钟起点,
    // 稳态窗=下列全部量测面(镜像已在窗外,与 RSS 口径一致)。
    const steadyHealth = await client.health();
    const steadyCpuBaseline = serverCpuSeconds(steadyHealth.pid);
    const steadyWallStartMs = performance.now();
    // 语义面首响应捕获(P1-2 审计修正:gate 此前只量速度不断内容,
    // 「语义请求全 null 的替身」照样 5/5 通过;现钉已知落点/必有项/正反例,
    // 断言在热循环外统一执行,不给计时面掺断言开销)。
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
        const diagResponse = await client.request('textDocument/diagnostic', { textDocument: { uri: defUri } });
        diagSamples.push(performance.now() - t);
        if (round === 0 && i === 0) {
          diagHit = diagResponse;
        }
      }
    }
    // 每编辑服务成本(didChange+diagnostic 往返 ×50,界=editRoundTripDiagnosticP99Ms);
    // 编辑=在 </Properties> 前插入配平属性块(名逐轮唯一,类型已知,保持零诊断)。
    const editSamples: number[] = [];
    let editVersion = 1;
    for (let i = 0; i < 50; i += 1) {
      editVersion += 1;
      const lines = compTexts[0].split('\n');
      const at = openTagLineOf(compTexts[0]);
      const block = [
        `\t\t<GateEdit_p${i}>`,
        '\t\t\t<Type> UINT8 </Type>',
        '\t\t\t<Flags> BASE </Flags>',
        `\t\t</GateEdit_p${i}>`
      ];
      compTexts[0] = [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
      await client.openDocument(compUris[0], 'kbengine-def', editVersion, compTexts[0]);
      const t = performance.now();
      await client.request('textDocument/diagnostic', {
        textDocument: { uri: compUris[0] }
      });
      editSamples.push(performance.now() - t);
    }
    // ── 语义断言面(P1-2):任一断言红=语义能力退化=门红,不只是速度门 ──
    // ① 已知声明落点:SKILL_SLOT → types.xml 第 1 行注册位。
    expect(defHit, 'definition 命中已知声明落点(替身 null 在此红)').toMatchObject({
      uri: expect.stringContaining('types.xml')
    });
    expect((defHit as { range: { start: { line: number } } }).range.start.line).toBe(1);
    // ② 必有补全项:开标签位成员补全须含本实体全部属性名。
    const compItems = (compHit as { items?: Array<{ label: string }> }).items;
    expect(compHit, 'completion 非空(替身 null 在此红)').not.toBeNull();
    const labels = new Set((compItems ?? []).map(item => item.label));
    for (let i = 0; i < 10; i += 1) {
      expect(labels.has(`Gate0_p${i}`), `补全缺必有项 Gate0_p${i}`).toBe(true);
    }
    // ③ 诊断反例:干净语料零诊断。
    expect(diagHit, '干净 def 零诊断(反例)').toMatchObject({ items: [] });
    // ④ 诊断正例:未注册自定义类型 → Error 级且消息点名。
    const brokenDiag = (await client.request('textDocument/diagnostic', {
      textDocument: { uri: brokenUri }
    })) as { items: Array<{ severity: number; message: string }> };
    expect(brokenDiag.items.length, '破型 def 必须有诊断(正例)').toBeGreaterThan(0);
    expect(brokenDiag.items.every(item => item.severity === 1)).toBe(true);
    expect(brokenDiag.items.some(item => item.message.includes('NOT_A_KNOWN_TYPE'))).toBe(true);
    // ⑤ 编辑后结果变化:50 轮属性插入后,补全面必须出现新插入的属性名,
    //    且编辑流未引入诊断(配平插入=零诊断)。
    const editedComp = (await client.request('textDocument/completion', {
      textDocument: { uri: compUris[0] },
      position: { line: openTagLineOf(compTexts[0]), character: 3 }
    })) as { items: Array<{ label: string }> };
    expect(
      (editedComp.items ?? []).map(item => item.label),
      '编辑后补全面必须反映插入的属性(编辑前基线无 GateEdit)'
    ).toContain('GateEdit_p49');
    expect(labels.has('GateEdit_p0'), '编辑前基线不含编辑后属性(增量真实性)').toBe(false);
    const editedDiag = (await client.request('textDocument/diagnostic', {
      textDocument: { uri: compUris[0] }
    })) as { items: unknown[] };
    expect(editedDiag.items, '配平编辑流零诊断').toHaveLength(0);
    metric('editRoundTrip.diagnostic', editSamples);
    metric('steady.definition', defSamples);
    metric('steady.completion', compSamples);
    metric('steady.diagnostic', diagSamples);
    const health = await client.health();
    const rssSteady = serverRssMb(health.pid);
    once('rss.afterSteady', rssSteady ?? -1, ' MB');
    // CPU 占比收尾(RUST-242):稳态窗 CPU 增量/墙钟×100;/proc 缺失或
    // 采样不可比(进程已换/回退)如实跳过,不冒充违规也不冒充合规。
    const cpuAfter = serverCpuSeconds(steadyHealth.pid);
    const wallSec = (performance.now() - steadyWallStartMs) / 1000;
    const cpuPercent =
      cpuAfter !== null && steadyCpuBaseline !== null && wallSec > 0 && cpuAfter >= steadyCpuBaseline
        ? ((cpuAfter - steadyCpuBaseline) / wallSec) * 100
        : null;
    once('cpu.steadyPercent', cpuPercent ?? -1, ' %');
    violations.push(
      ...servingGateViolations(bounds, {
        steadyDefinitionP99Ms: percentile(defSamples, 0.99),
        steadyCompletionP99Ms: percentile(compSamples, 0.99),
        steadyDiagnosticP99Ms: percentile(diagSamples, 0.99),
        steadyRssMb: rssSteady ?? 0,
        editRoundTripDiagnosticP99Ms: percentile(editSamples, 0.99),
        ...(cpuPercent !== null ? { steadyCpuPercentMax: cpuPercent } : {})
      })
    );
    await client.dispose();
  });

  it('gate:全部界收口(任一面超界=红=合并阻塞面)', () => {
    expect(violations).toEqual([]);
  });
});
