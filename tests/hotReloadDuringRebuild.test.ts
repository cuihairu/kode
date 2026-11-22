/**
 * RUST-425(HR-QA-013)Rust Core 索引重建在途,热更新可继续工作(真实二进制):
 * 在 kode-server 全仓镜像+索引重建(scan 在途,服务面 Warming)期间,并行
 * 驱动三面——
 *  ①语言服务 hover(Rust 服务面,量 P99 尾延迟;Warming 期查询走
 *    drain_index_for_request 时间预算路径,正是本任务关切);
 *  ②热更新模块身份解析(hotReloadModuleIdentity,TS 纯核,确定性名);
 *  ③热更新 apply 回环(受控真实接收端 referenceReceiver,accepted/applied
 *    +自写产物 digest 双证)。
 * 断言=①P99 低于交互预算(INTERACTIVE_SERVE_BUDGET_MS=2000,与 QA-005 同界,
 *   CI 慢 runner 余量)且 ≤ REBUILD_RATIO=10× 暖态基线 P99(「不大幅恶化」
 *   相对界:重建闭环后再跑同形 hover 循环取基线)②身份解析确定性正确
 *   (全名/短名/根归属/语言)③apply 回环全程 applied(无死锁/不误报)。
 * 重建在途窗口=暖门 Warming(beginBackgroundScan→scanComplete),流量中点用
 *   warmState 自证仍在 Warming(mirrorDocument 只 await 帧写背压、不等服务端
 *   索引完成,不能当重建完成判据)。
 * 门禁=真实二进制缺省 skip(与 tests/largeRepoBudgetE2E.test.ts 同形);
 *   cargo build -p kode-server 后 npx vitest run tests/hotReloadDuringRebuild.test.ts。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { performance } from 'perf_hooks';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { serveHoverFromRust, setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { resolveHotReloadModuleIdentity } from '../src/backend/hotReloadModuleIdentity';
import { makeTextDocument } from './helpers/vscodeStub';
import { createHotReloadReceiverRoundtripHarness } from './helpers/hotReloadReceiverHarness';

const repoRoot = join(__dirname, '..');
const serverBinary = join(repoRoot, 'target', 'debug', 'kode-server');
// 交互预算:Warming 期语言服务 P99 尾延迟上限(与 QA-005 同界)。
const INTERACTIVE_BUDGET_MS = 2000;
const ENTITY_COUNT = 200;
const BASE_COUNT = 10;
const PROPS_PER = 20;
const TRAFFIC_ROUNDS = 25;
// 「不大幅恶化」相对界:重建在途 P99 ≤ 10× 暖态基线 P99(宽松,CI 负载
// 抖动余量);绝对交互预算(2000ms)仍是硬上界,两者都过才收。
const REBUILD_RATIO = 10;

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
  const root = mkdtempSync(join(tmpdir(), 'kode-rust425-repo-'));
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
const harness = createHotReloadReceiverRoundtripHarness();
afterEach(() => {
  setKodeCoreShadowGate(null);
});
afterAll(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.dispose().catch(() => undefined)));
  harness.dispose();
});

suite('RUST-425 索引重建在途热更新可继续工作(真实二进制,合成仓 210 def)', () => {
  const repo = makeLargeRepo();
  const readDef = (name: string): string => readFileSync(repo.defPath(name), 'utf8');

  it('重建在途三面并行:热更身份/apply 全程成功,hover P99 在交互预算内', async () => {
    const { gate, client } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);

    // 脚本树(热更身份解析面):脚本根=scripts,实体模块 entities/fight/FightAI。
    const scriptsRoot = join(repo.root, 'scripts');
    const fightDir = join(scriptsRoot, 'entities', 'fight');
    mkdirSync(fightDir, { recursive: true });
    const fightFile = join(fightDir, 'FightAI.py');
    writeFileSync(fightFile, 'class FightAI:\n    pass\n');

    // 启动全仓镜像+索引重建:beginBackgroundScan 后服务面进 Warming(重建在途),
    // scanComplete 前保持 Warming——这是「重建在途」的真实信号(mirrorDocument
    // 只 await 帧写背压,不等服务端索引完成,不能当重建完成判据)。
    const mirrorPromise = (async () => {
      for (const name of repo.entityNames) {
        await gate.mirrorDocument(repo.defPath(name), 'kbengine-def', 1, readDef(name));
      }
    })();
    const scan = await gate.beginBackgroundScan(repo.entityNames.length);
    expect(scan, 'scan 启动应有应答').not.toBeNull();
    const wsAfterBegin = await client.warmState();
    expect(wsAfterBegin.state, 'begin 后应进 Warming(重建在途)').toBe('warming');

    // 三面并行流量:每轮=hover(Rust)+模块身份(TS)+apply 回环(HTTP)。
    const hoverSamples: number[] = [];
    const applyStatuses: string[] = [];
    let midTrafficWarming = false;
    let coldWhileWarming = 0;
    const engineDir = mkdtempSync(join(tmpdir(), 'kode-rust425-engine-'));
    harness.engineDirs.push(engineDir);
    const receiver = await harness.start('apply', 'applied', ['--artifact-dir', engineDir]);
    // apply 面文件必须落在接收端 root 内(接收端逐文件读盘+sha256 核验)。
    const reloadFile = join(receiver.root, 'FightAI.py');
    const reloadContent = 'class FightAI:\n    pass\n';
    writeFileSync(reloadFile, reloadContent);

    for (let round = 0; round < TRAFFIC_ROUNDS; round += 1) {
      // ①Rust 服务面 hover(在途重建上量 P99)
      const name = repo.entityNames[(10 + round * 7) % repo.entityNames.length];
      const text = readDef(name);
      const pos = hpPos(text);
      const t0 = performance.now();
      const hover = await serveHoverFromRust(hoverDoc(repo.defPath(name), text, 1 + round), pos);
      hoverSamples.push(performance.now() - t0);
      expect(hover, `重建在途 hover ${name} 应命中`).not.toBeNull();
      // ②热更模块身份解析(确定性名)
      const identity = resolveHotReloadModuleIdentity({
        fileUri: `file://${fightFile}`,
        scriptRoot: scriptsRoot,
        workspaceId: 'rust425',
        rootId: 'scripts',
        allowRootLevelStem: false
      });
      expect(identity.ok, '重建在途模块身份应解析成功').toBe(true);
      if (identity.ok) {
        expect(identity.identity.fullModule).toBe('entities.fight.FightAI');
        expect(identity.identity.requestModule).toBe('fight.FightAI');
        expect(identity.identity.rootId).toBe('scripts');
        expect(identity.identity.language).toBe('python');
      }
      // ③热更 apply 回环(受控真实接收端,自写产物+digest 双证)
      const body = {
        files: [reloadFile],
        targetId: 'baseapp-1',
        sender_digests: { [reloadFile]: harness.sha256(reloadContent) }
      };
      const response = await harness.postReload(receiver.port, body);
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body) as { status: string };
      expect(['accepted', 'applied']).toContain(parsed.status);
      applyStatuses.push(parsed.status);
      // 流量中点自证:服务面仍在 Warming=流量确在重建在途窗口内(非真空断言)。
      if (round === TRAFFIC_ROUNDS >> 1) {
        const wsMid = await client.warmState();
        midTrafficWarming = wsMid.state === 'warming';
        coldWhileWarming = wsMid.coldWhileWarming;
      }
    }

    // 重建闭环:镜像完成+scan 收尾。
    await mirrorPromise;
    const done = await gate.scanComplete(repo.entityNames.length, 0);
    expect(done, 'scan 闭环应有应答').not.toBeNull();
    const wsEnd = await client.warmState();
    expect(wsEnd.state, 'scan 收尾后应进 Warm').toBe('warm');

    // 暖态基线:同语料同探针,重建完成后同形 hover 循环(P99 对比基准)。
    const baselineSamples: number[] = [];
    for (let round = 0; round < TRAFFIC_ROUNDS; round += 1) {
      const name = repo.entityNames[(10 + round * 7) % repo.entityNames.length];
      const text = readDef(name);
      const pos = hpPos(text);
      const t0 = performance.now();
      const hover = await serveHoverFromRust(hoverDoc(repo.defPath(name), text, 100 + round), pos);
      baselineSamples.push(performance.now() - t0);
      expect(hover, `暖态基线 hover ${name} 应命中`).not.toBeNull();
    }

    const hoverSorted = [...hoverSamples].sort((a, b) => a - b);
    const baselineSorted = [...baselineSamples].sort((a, b) => a - b);
    const p99 = percentile(hoverSorted, 99);
    const baselineP99 = percentile(baselineSorted, 99);
    const ratio = p99 / Math.max(baselineP99, 1);
    console.log(`[rust425] ${report('rebuildHover', hoverSamples)}`);
    console.log(`[rust425] ${report('baselineHover', baselineSamples)}`);
    console.log(`[rust425] midTrafficWarming=${midTrafficWarming} coldWhileWarming=${coldWhileWarming} ratio=${ratio.toFixed(2)} apply=${applyStatuses.join(',')}`);
    expect(midTrafficWarming, '流量中点服务面应仍在 Warming(重建在途)').toBe(true);
    expect(p99, `重建在途 hover P99=${p99.toFixed(1)}ms 应低于交互预算 ${INTERACTIVE_BUDGET_MS}ms`).toBeLessThan(INTERACTIVE_BUDGET_MS);
    expect(ratio, `重建在途/暖态 P99 比=${ratio.toFixed(2)} 应≤ ${REBUILD_RATIO}(不大幅恶化)`).toBeLessThanOrEqual(REBUILD_RATIO);
    expect(applyStatuses, 'apply 回环全程应有回执').toHaveLength(TRAFFIC_ROUNDS);
    expect(applyStatuses.every(status => status === 'applied'), 'apply 全程 applied(digest 双证),无一失败').toBe(true);
  }, 180_000);
});
