import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { readSharedFileSnapshot } from '../src/sharedFileSnapshot';
import { mapFindingsToDiagnostics } from '../src/processTopologyDiagnostics';
import { validateProcessTopologyInRust } from '../src/backend/processTopologyRust';
import { DiagnosticScheduler } from '../src/diagnosticScheduler';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// KODE-PERF-006:测量进程拓扑全量诊断成本(CPU 与事件循环延迟)。
//
// 全量诊断 = 任一 def/清单变更都触发的整拓扑重算(拓扑是全局输入):
//   input 阶段:collectTopologyDefInputs 读全部 def(宿主同步阻塞段);
//   rpc   阶段:validateProcessTopologyInRust 经 Rust 校验(异步,不阻塞宿主);
//   map   阶段:mapFindingsToDiagnostics + 每条 finding 的 specToDiagnostic
//           (computeLineStarts 每 spec 重算,宿主同步阻塞段);
//   publish 阶段:按文件分组 set 到诊断集合(宿主同步)。
//
// 宿主事件循环延迟 = 同步阻塞段时长(input+map+publish 的连续同步执行,
// 循环在此期间无法处理其它任务);Rust RPC 是异步段(await 期间循环自由),
// 单列 wall-clock 不混入宿主延迟。
//
// 本测试是测量面(打印数值供 perf 报告),断言只放宽松上界抓真实回归,
// 不设紧阈值——机器负载抖动(同类计时测试在 load~186 时曾红)不误报。
// 批量 def 输入 / 连续编辑 / 取消 三场景各测 CPU(process.cpuUsage)与
// 阻塞段时长;Rust 真实 RPC 段仅在 kode-server 二进制在场时测量(skip)。

const MANIFEST = [
  '<root>',
  '  <process name="cellapp" role="cell" />',
  '  <process name="baseapp" role="base" />',
  '  <process name="loginapp" role="login" />',
  '  <process name="dbmgr" role="dbmgr" />',
  '  <process name="logger" role="logger" />',
  '</root>',
  ''
].join('\n');

/** 生成一个 ~25 行真实形态实体 def(带属性/方法,闭包走查有内容可查)。 */
function makeDef(name: string, index: number): string {
  const props = ['hp', 'mp', 'pos', 'dir', 'name', 'level', 'exp']
    .map((p, i) => `    <${p} type="INT${(i % 3) + 1}"/>`)
    .join('\n');
  const methods = ['attack', 'moveTo', 'useSkill', 'pickup', 'die']
    .map(m =>
      [
        `    <${m}>`,
        '      <Arglist>',
        '        <Arg>INT32</Arg>',
        '        <Arg>STRING</Arg>',
        '      </Arglist>',
        `    </${m}>`
      ].join('\n')
    )
    .join('\n');
  return [
    '<root>',
    '  <Properties>',
    props,
    '  </Properties>',
    '  <BaseMethods>',
    methods,
    '  </BaseMethods>',
    '  <CellMethods>',
    methods,
    '  </CellMethods>',
    '</root>',
    ''
  ].join('\n');
}

/** 构建 N 实体 workspace(清单 + entities.xml + N 个 def),返回根目录。 */
function buildWorkspace(nDefs: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ptperf-'));
  fs.writeFileSync(path.join(root, 'process_topology.xml'), MANIFEST, 'utf-8');
  const scripts = path.join(root, 'scripts');
  const entityDefs = path.join(scripts, 'entity_defs');
  fs.mkdirSync(entityDefs, { recursive: true });
  const entities: string[] = [];
  for (let i = 0; i < nDefs; i += 1) {
    const name = `Entity${i}`;
    fs.writeFileSync(path.join(entityDefs, `${name}.def`), makeDef(name, i), 'utf-8');
    entities.push(`    <${name} hasCell="true" hasBase="true" hasClient="true"/>`);
  }
  fs.writeFileSync(
    path.join(scripts, 'entities.xml'),
    ['<root>', ...entities, '</root>', ''].join('\n'),
    'utf-8'
  );
  return root;
}

/** 读一个 def(与 extension.ts readTextForPath 同口径:快照→磁盘补载)。 */
function readDefText(root: string, name: string): string {
  const fsPath = path.join(root, 'scripts', 'entity_defs', `${name}.def`);
  return readSharedFileSnapshot(fsPath)?.content ?? '';
}

/** 收集全部 def 输入(与 extension.ts collectTopologyDefInputs 同口径)。 */
function collectDefInputs(
  root: string,
  nDefs: number
): Array<{ name: string; category: string; filePath: string; text: string }> {
  const defs: Array<{ name: string; category: string; filePath: string; text: string }> = [];
  for (let i = 0; i < nDefs; i += 1) {
    const name = `Entity${i}`;
    const filePath = path.join(root, 'scripts', 'entity_defs', `${name}.def`);
    const text = readDefText(root, name);
    if (text !== '') {
      defs.push({ name, category: 'entity', filePath, text });
    }
  }
  return defs;
}

/** specToDiagnostic 的行起始偏移表(与 extension.ts computeLineStarts 同算法)。 */
function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 按 spec 换算诊断区间(与 extension.ts specToDiagnostic 同口径:整行定位)。 */
function specLineSpan(text: string, line: number): { start: number; end: number } {
  const starts = lineStarts(text);
  const lineIndex = Math.min(Math.max(line - 1, 0), Math.max(starts.length - 1, 0));
  return { start: starts[lineIndex], end: starts[lineIndex + 1] ?? text.length };
}

/** findings 生成:每 def 产 `perDef` 条定位到该 def 的发现(与 Rust D1-D3 同形)。 */
function findingsFor(root: string, nDefs: number, perDef: number) {
  const findings: Array<{
    target: string;
    filePath: string;
    line: number;
    severity: number;
    message: string;
    code: string;
    related: Array<{ filePath: string; line: number; message: string }>;
  }> = [];
  for (let i = 0; i < nDefs; i += 1) {
    const filePath = path.join(root, 'scripts', 'entity_defs', `Entity${i}.def`);
    for (let f = 0; f < perDef; f += 1) {
      findings.push({
        target: 'def',
        filePath,
        line: 3 + f,
        severity: 2,
        message: `Entity${i} 属性越界(测量合成)`,
        code: 'kbengine.processTopologyPerfSynth',
        related: [{ filePath: '<manifest>', line: 1, message: '合成关联' }]
      });
    }
  }
  return findings;
}

/** 一段同步工作的 CPU 增量(ms)与墙钟(ms)。 */
function measureSync<T>(work: () => T): { result: T; cpuMs: number; wallMs: number } {
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  const result = work();
  const wallMs = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  return { result, cpuMs: (cpu.user + cpu.system) / 1000, wallMs };
}

const KODE_SERVER = '/home/cui/workspaces/kode/target/debug/kode-server';

describe('KODE-PERF-006 进程拓扑全量诊断成本(测量面)', () => {
  it('批量 def 输入:input 阶段随 N 线性,宿主同步阻塞段如实度量', () => {
    const roots: string[] = [];
    try {
      for (const nDefs of [100, 500, 1000]) {
        const root = buildWorkspace(nDefs);
        roots.push(root);
        readDefText(root, 'Entity0'); // 预热(冷盘读不混入)
        const { result, cpuMs, wallMs } = measureSync(() => collectDefInputs(root, nDefs));
        expect(result).toHaveLength(nDefs);
        // eslint-disable-next-line no-console
        console.log(
          `[KODE-PERF-006 input] defs=${nDefs} cpu=${cpuMs.toFixed(1)}ms wall=${wallMs.toFixed(1)}ms`
        );
        if (nDefs === 1000) {
          expect(wallMs).toBeLessThan(5000); // 宽松上界,抓真实回归
        }
      }
    } finally {
      for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('批量 def 输入:map 阶段随 findings 线性,每 spec 行号换算如实度量', () => {
    const roots: string[] = [];
    try {
      for (const nDefs of [100, 500, 1000]) {
        const root = buildWorkspace(nDefs);
        roots.push(root);
        const findings = findingsFor(root, nDefs, 2);
        const resolveManifest = () => path.join(root, 'process_topology.xml');
        const { result, cpuMs, wallMs } = measureSync(() => {
          const specs = mapFindingsToDiagnostics(findings, resolveManifest);
          const spans: number[] = [];
          for (const spec of specs) {
            const text = readDefText(root, path.basename(spec.filePath, '.def'));
            spans.push(specLineSpan(text, spec.line).end);
          }
          return { specs, spans };
        });
        expect(result.specs).toHaveLength(nDefs * 2);
        // eslint-disable-next-line no-console
        console.log(
          `[KODE-PERF-006 map] defs=${nDefs} findings=${nDefs * 2} cpu=${cpuMs.toFixed(1)}ms wall=${wallMs.toFixed(1)}ms`
        );
        if (nDefs === 1000) {
          expect(wallMs).toBeLessThan(5000);
        }
      }
    } finally {
      for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('连续编辑:同 URI 排队合并,编辑风暴不放大重算(仅最新版本算)', async () => {
    const scheduler = new DiagnosticScheduler();
    let publishedCount = 0;
    const makeDoc = (version: number) => ({
      uri: { toString: () => 'file:///x.def' },
      version
    });
    for (let version = 1; version <= 200; version += 1) {
      scheduler.requestQueued(makeDoc(version), {
        layer: 'local',
        compute: () => [],
        publish: () => {
          publishedCount += 1;
        }
      });
    }
    const cpuBefore = process.cpuUsage();
    const t0 = performance.now();
    await scheduler.flushQueued(); // 同节拍一次冲刷:200 个排队任务合并
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpuBefore);
    const stats = scheduler.getStats();
    // eslint-disable-next-line no-console
    console.log(
      `[KODE-PERF-006 coalesce] queued=200 cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms ` +
        `wall=${wallMs.toFixed(1)}ms computed=${stats.computed} published=${stats.published} ` +
        `coalescedStale=${stats.coalescedStale}`
    );
    expect(stats.computed).toBeLessThanOrEqual(2); // 合并后至多 1 次计算(零让出)
    expect(publishedCount).toBeLessThanOrEqual(2);
  });

  it('取消:计算在途版本前进,旧结果按守卫丢弃不发布(代价廉价)', async () => {
    const scheduler = new DiagnosticScheduler();
    let publishedCount = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    // 活文档(与 vscode.TextDocument 同语义):.version 随编辑就地前进。
    // 关键——同一对象引用传给两代请求,守卫读的就是前进后的版本。
    const doc = { uri: { toString: () => 'file:///y.def' }, version: 1 };
    // 版本 1 异步计算在途(挂起直到 release,模拟慢 RPC)
    scheduler.request(doc, {
      layer: 'local',
      computeAsync: async () => {
        await gate;
        return [];
      },
      publish: () => {
        publishedCount += 1;
      }
    });
    // 文档前进到版本 2(连续编辑),排队:在途的版本 1 计算完成后必须按守卫丢弃
    doc.version = 2;
    scheduler.requestQueued(doc, {
      layer: 'local',
      compute: () => [],
      publish: () => {
        publishedCount += 1;
      }
    });
    const cpuBefore = process.cpuUsage();
    const t0 = performance.now();
    release!();
    await scheduler.pendingComputations(); // 版本 1 结果落定 → 守卫丢弃
    await scheduler.flushQueued(); // 版本 2 计算并发布
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpuBefore);
    const stats = scheduler.getStats();
    // eslint-disable-next-line no-console
    console.log(
      `[KODE-PERF-006 cancel] cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms ` +
        `wall=${wallMs.toFixed(1)}ms staleDropped=${stats.staleDropped} published=${stats.published}`
    );
    expect(stats.staleDropped).toBeGreaterThanOrEqual(1); // 版本 1 旧结果被弃
    expect(publishedCount).toBe(1); // 只发布版本 2,旧结果未发布
  });
});

describe('KODE-PERF-006 Rust 真实 RPC 段(二进制在场才测)', () => {
  const hasBinary = fs.existsSync(KODE_SERVER);

  it.skipIf(!hasBinary)('Rust 校验 RPC round-trip 随 def 数线性,异步不阻塞宿主', async () => {
    const roots: string[] = [];
    try {
      for (const nDefs of [100, 500, 1000]) {
        const root = buildWorkspace(nDefs);
        roots.push(root);
        const defs = collectDefInputs(root, nDefs);
        const manifestText = fs.readFileSync(path.join(root, 'process_topology.xml'), 'utf-8');
        const entitiesXmlText = fs.readFileSync(
          path.join(root, 'scripts', 'entities.xml'),
          'utf-8'
        );
        const gate = new KodeCoreGate({ now: Date.now });
        gate.setConfig({ backend: 'shadow', serverPath: KODE_SERVER, shadowTimeoutMs: 2000 });
        setKodeCoreShadowGate(gate);
        try {
          const wallBefore = performance.now();
          const result = await validateProcessTopologyInRust({
            manifestText,
            entitiesXmlText,
            defs
          });
          const wallMs = performance.now() - wallBefore;
          // eslint-disable-next-line no-console
          console.log(
            `[KODE-PERF-006 rpc] defs=${nDefs} findings=${result?.findings.length ?? 0} wall=${wallMs.toFixed(1)}ms`
          );
        } finally {
          setKodeCoreShadowGate(null);
          gate.setConfig({ backend: 'shadow', serverPath: '', shadowTimeoutMs: 2000 }); // 停 Rust 子进程
        }
      }
    } finally {
      for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
