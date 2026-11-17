import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { buildDependencyGraphInRust } from '../src/backend/dependencyGraphRust';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { serveHoverFromRust, setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { makeTextDocument } from './helpers/vscodeStub';

// QA-005(旧 KSEM-QA-05)大仓及图资源预算:合成仓(200 继承实体+10 基类,
// 每实体 20 属性)下四臂测量 —— ①冷态全仓装载(镜像 210 文件+首 hover)、
// ②热态连续 hover 20 轮分位数、③索引重建(gate 重启后全仓镜像+scan 闭环)、
// ④大图展开(依赖图构建与长 RPC 并发下的交互保护)。预登记阈值全部为
// 「预算上限」语义:热态/长并发下的 hover P99 一律低于交互预算
// INTERACTIVE_SERVE_BUDGET_MS=2000;装载/重建/图构建为冷路径,上限 30000ms
// (硬上限,实测明细落 docs/perf/2026-11-18-large-repo-budget-run.txt)。
// 样本全量进分位数,不挑最快一轮。内存面:rust 服务器无 RSS 回传,资源
// 预算以耗时+图规模(nodes/edges)钉,口径边界在 perf 文档注明。
const repoRoot = join(__dirname, '..');
const serverBinary = join(repoRoot, 'target', 'debug', 'kode-server');
const ENTITY_COUNT = 200;
const BASE_COUNT = 10;
const PROPS_PER = 20;
const INTERACTIVE_BUDGET_MS = 2000;
const COLD_LIMIT_MS = 30_000;

const suite = existsSync(serverBinary) ? describe : describe.skip;

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(((sorted.length - 1) * p) / 100))];

const report = (label: string, values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  return `${label} n=${sorted.length} P50=${percentile(sorted, 50).toFixed(1)} P95=${percentile(sorted, 95).toFixed(1)} P99=${percentile(sorted, 99).toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`;
};

const propBlock = (name: string): string =>
  `\t\t<${name}>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> ALL_CLIENTS </Flags>\n\t\t\t<Default> 1 </Default>\n\t\t</${name}>`;

interface LargeRepo {
  root: string;
  defPath: (name: string) => string;
  entityNames: string[];
}

function makeLargeRepo(): LargeRepo {
  const root = mkdtempSync(join(tmpdir(), 'kode-qa005-repo-'));
  const defsDir = join(root, 'scripts', 'entity_defs');
  mkdirSync(defsDir, { recursive: true });
  const defPath = (name: string): string => join(defsDir, `${name}.def`);
  const registry: string[] = [];
  for (let b = 0; b < BASE_COUNT; b++) {
    const props = Array.from({ length: PROPS_PER }, (_, i) => propBlock(`baseProp${b}_${i}`)).join('\n');
    writeFileSync(defPath(`Base${b}`), `<root>\n\t<Type>Base${b}</Type>\n\t<Properties>\n${props}\n\t</Properties>\n</root>\n`);
    registry.push(`Base${b}`);
  }
  for (let e = 0; e < ENTITY_COUNT; e++) {
    const name = `Ent${e}`;
    const props = Array.from({ length: PROPS_PER }, (_, i) => propBlock(i === 0 ? 'hp' : `prop${e}_${i}`)).join('\n');
    writeFileSync(defPath(name), `<root>\n\t<Type>${name}</Type>\n\t<Parent> Base${e % BASE_COUNT} </Parent>\n\t<Properties>\n${props}\n\t</Properties>\n</root>\n`);
    registry.push(name);
  }
  writeFileSync(join(root, 'scripts', 'entities.xml'), `<root>\n${registry.map(n => `\t<${n}/>`).join('\n')}\n</root>\n`);
  return { root, defPath, entityNames: registry };
}

function realGate(): { gate: KodeCoreGate; client: KodeCoreClient } {
  const client = new KodeCoreClient({ binaryPath: serverBinary });
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'rust', serverPath: serverBinary, shadowTimeoutMs: 30000 });
  return { gate, client };
}

const hoverDoc = (path: string, text: string, version: number) =>
  makeTextDocument(text, { fileName: path, languageId: 'kbengine-def', version });

const hpPos = (text: string): { line: number; character: number } => {
  const lines = text.split('\n');
  const i = lines.findIndex(l => /\bhp\b/.test(l) && !/<Type>|<Flags>|<Default>/.test(l));
  expect(i, 'def 应含 hp 属性词').toBeGreaterThanOrEqual(0);
  return { line: i, character: lines[i].indexOf('hp') + 1 };
};

const gates: KodeCoreGate[] = [];
afterEach(() => {
  setKodeCoreShadowGate(null);
});
afterAll(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.dispose().catch(() => undefined)));
});

suite('kode 大仓及图资源预算 e2e(QA-005,真实二进制,合成仓 210 def)', () => {
  const repo = makeLargeRepo();
  const readDef = (name: string): string => readFileSync(repo.defPath(name), 'utf8');

  it('冷态全仓装载:镜像 210 文件+首 hover 在硬上限内', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const t0 = performance.now();
    for (const name of repo.entityNames) {
      await gate.mirrorDocument(repo.defPath(name), 'kbengine-def', 1, readDef(name));
    }
    const mirrorAll = performance.now() - t0;
    expect(mirrorAll, `全仓镜像 ${mirrorAll.toFixed(0)}ms 应低于 ${COLD_LIMIT_MS}ms`).toBeLessThan(COLD_LIMIT_MS);
    const text = readDef('Ent0');
    const pos = hpPos(text);
    const t1 = performance.now();
    const hover = await serveHoverFromRust(hoverDoc(repo.defPath('Ent0'), text, 1), pos);
    const firstHover = performance.now() - t1;
    expect(hover, '大仓首 hover 应命中').not.toBeNull();
    expect(firstHover, `首 hover ${firstHover.toFixed(0)}ms 应低于 ${COLD_LIMIT_MS}ms`).toBeLessThan(COLD_LIMIT_MS);
    console.log(`[qa005] coldMirrorAll n=210 ${mirrorAll.toFixed(1)}ms`);
    console.log(`[qa005] coldFirstHover n=1 ${firstHover.toFixed(1)}ms`);
  }, 120_000);

  it('热态连续 hover:20 轮跨实体轮转,P99 低于交互预算', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const durations: number[] = [];
    for (let i = 0; i < 20; i++) {
      const name = repo.entityNames[(10 + i) % repo.entityNames.length];
      const text = readDef(name);
      const pos = hpPos(text);
      const t0 = performance.now();
      const hover = await serveHoverFromRust(hoverDoc(repo.defPath(name), text, 1 + i), pos);
      durations.push(performance.now() - t0);
      expect(hover, `热态 hover ${name} 应命中`).not.toBeNull();
    }
    const sorted = [...durations].sort((a, b) => a - b);
    expect(percentile(sorted, 99), `热态 P99=${percentile(sorted, 99).toFixed(1)}ms 应低于 ${INTERACTIVE_BUDGET_MS}ms`).toBeLessThan(INTERACTIVE_BUDGET_MS);
    console.log(`[qa005] ${report('warmHover', durations)}`);
  }, 120_000);

  it('索引重建:gate 重启后全仓镜像+scan 闭环在硬上限内', async () => {
    const first = realGate();
    gates.push(first.gate);
    setKodeCoreShadowGate(first.gate);
    for (const name of repo.entityNames) {
      await first.gate.mirrorDocument(repo.defPath(name), 'kbengine-def', 1, readDef(name));
    }
    await first.gate.dispose().catch(() => undefined);

    const second = realGate();
    gates.push(second.gate);
    setKodeCoreShadowGate(second.gate);
    const t0 = performance.now();
    for (const name of repo.entityNames) {
      await second.gate.mirrorDocument(repo.defPath(name), 'kbengine-def', 2, readDef(name));
    }
    const scan = await second.gate.beginBackgroundScan(repo.entityNames.length);
    expect(scan, 'scan 启动应有应答').not.toBeNull();
    const done = await second.gate.scanComplete(repo.entityNames.length, 0);
    expect(done, 'scan 闭环应有应答').not.toBeNull();
    const rebuild = performance.now() - t0;
    expect(rebuild, `重建 ${rebuild.toFixed(0)}ms 应低于 ${COLD_LIMIT_MS}ms`).toBeLessThan(COLD_LIMIT_MS);
    console.log(`[qa005] rebuildMirrorPlusScan n=210 ${rebuild.toFixed(1)}ms`);
  }, 180_000);

  it('大图展开:210 实体依赖图构建,构建期 hover 仍受交互预算保护', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    for (const name of repo.entityNames) {
      await gate.mirrorDocument(repo.defPath(name), 'kbengine-def', 1, readDef(name));
    }
    const tGraph0 = performance.now();
    const graphPromise = buildDependencyGraphInRust(repo.root);
    // 长 RPC(图构建)在途:交互请求立即发出,须在预算内返回(预算保护)
    const text = readDef('Ent7');
    const pos = hpPos(text);
    const t0 = performance.now();
    const hover = await serveHoverFromRust(hoverDoc(repo.defPath('Ent7'), text, 1), pos);
    const hoverDuringGraph = performance.now() - t0;
    expect(hover, '图构建在途 hover 应命中').not.toBeNull();
    expect(hoverDuringGraph, `图构建在途 hover ${hoverDuringGraph.toFixed(0)}ms 应低于交互预算 ${INTERACTIVE_BUDGET_MS}ms`).toBeLessThan(INTERACTIVE_BUDGET_MS);
    const graph = await graphPromise;
    const graphTotal = performance.now() - tGraph0;
    expect(graph, '大仓依赖图应构建成功').not.toBeNull();
    expect(graph!.nodes.length, '图应含全部注册实体').toBeGreaterThanOrEqual(repo.entityNames.length);
    expect(graphTotal, `图构建总链 ${graphTotal.toFixed(0)}ms 应低于 ${COLD_LIMIT_MS}ms`).toBeLessThan(COLD_LIMIT_MS);
    console.log(`[qa005] graph nodes=${graph!.nodes.length} edges=${graph!.edges.length} totalChainMs=${graphTotal.toFixed(1)}`);
  }, 180_000);
});
