import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  drainablePendingWork,
  type PendingWorkSnapshot
} from '../../../backend/pendingWorkDrain';
import {
  evaluateFinalMarks,
  pooledP95,
  type BurstRun,
  type FinalMarksPolicy
} from '../../../finalMarksVerdict';

// IDE-ACC-010:按场景纠正最终完成标记——热态双指标分判面(真实编辑器,
// field 同装配:demo 资产+5000 文件外部根)。验收原文「热态 Hover P95≤30ms、
// Definition P95≤50ms 分别判定」:
// ①热态 Hover:def 面 <reqAttack> 3 暖机+30 连发 executeHoverProvider,
//   全命中且 P95 ≤ 30ms 单独判定;
// ②热态 Definition:同锚 3 暖机+30 连发 executeDefinitionProvider,
//   全命中且 P95 ≤ 50ms 单独判定;
// 两指标各自出 pass/fail 且双双 assert(IDE-AUD-020:延迟越界必须导致
// 验收失败,不互相兜底、不只写日志)。采样/争用口径预登记(IDE-AUD-020):
// 每突发开始采样 /proc/loadavg 1 分钟负载,超过 loadLimit(=2×核数,预登记)
// 的突发不入池化但必须留痕;P95=纳入突发的原始样本池化分位(总体口径),
// 不是「三轮最优」事后择优;全被闸排除=not-assessed,失败/未测保留开放。
// 排干断言用真实 pendingWork 结构逐项核对 queued/running(IDE-AUD-019:
// caches/worker/annotationBuilds 嵌套对象不与 0 比较,缓存容量不要求归零)。
// 首命中轮询窗把首扫/惰性装载排除在测量外(热态口径)。证据行落
// KODE_ACC10_OUT(缺省 docs/perf/2026-10-29-acc010-final-marks-run.txt)。
// 逐项通过/失败/未测的完成标记对账表在
// docs/perf/2026-10-29-acc010-final-marks.md(本套件出双指标数字)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --final must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC10_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc010-final-marks-run.txt');

const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const WARMUP_ROUNDS = 3;
const BURST_REPS = 3;
const BURST_ROUNDS = 30;
const HOVER_P95_BOUND_MS = 30;
const DEFINITION_P95_BOUND_MS = 50;
// IDE-AUD-020 预登记争用闸:突发开始 1 分钟负载 ≤ 2×核数 才入池化口径
const LOAD_LIMIT = 2 * os.cpus().length;
const POLICY: FinalMarksPolicy = {
  hoverBoundMs: HOVER_P95_BOUND_MS,
  definitionBoundMs: DEFINITION_P95_BOUND_MS,
  loadLimit: LOAD_LIMIT
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const readLoad1 = (): number => {
  try {
    return Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  } catch {
    return Number.NaN;
  }
};

function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  return new vscode.Position(line, lines[line].indexOf(symbol) + Math.floor(symbol.length / 2));
}

/** 首命中轮询窗(≤25s):把首扫/惰性装载排除在测量外,窗口只等「能命中」。 */
async function awaitFirstHit(
  command: 'vscode.executeHoverProvider' | 'vscode.executeDefinitionProvider',
  uri: vscode.Uri, position: vscode.Position
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const raw = await vscode.commands.executeCommand(command, uri, position);
    if ((Array.isArray(raw) ? raw : []).length > 0) { return; }
    await sleep(500);
  }
  assert.fail(`首命中轮询窗内 ${command} 无命中(索引未就绪或锚失效)`);
}

async function burst(
  command: 'vscode.executeHoverProvider' | 'vscode.executeDefinitionProvider',
  uri: vscode.Uri, position: vscode.Position
): Promise<BurstRun> {
  for (let i = 0; i < WARMUP_ROUNDS; i++) {
    await vscode.commands.executeCommand(command, uri, position);
  }
  // IDE-AUD-020:争用闸采样点=突发开始时刻的宿主 1 分钟负载
  const startLoad1 = readLoad1();
  const samples: number[] = [];
  let hits = 0;
  for (let i = 0; i < BURST_ROUNDS; i++) {
    const startedAt = performance.now();
    const raw = await vscode.commands.executeCommand(command, uri, position);
    samples.push(performance.now() - startedAt);
    if ((Array.isArray(raw) ? raw : []).length > 0) { hits += 1; }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { samples, p95Ms: pooledP95(samples), p50Ms: at(50), maxMs: sorted[sorted.length - 1], hits, reps: BURST_ROUNDS, startLoad1 };
}

describe('IDE-ACC-010:最终完成标记——热态 Hover/Definition 双指标分判(真实编辑器)', () => {
  let probe: { pendingWork(): PendingWorkSnapshot };

  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as unknown as { pendingWork(): PendingWorkSnapshot };
    assert.ok(typeof probe.pendingWork === 'function', 'activate 未返回 pendingWork 量规');
    assert.ok(
      vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === WORKSPACE),
      'field 工作区不在宿主(workspace 装配不符)'
    );
  });

  it('热态 Hover P95≤30 与 Definition P95≤50 分别判定,各自全命中', async function () {
    this.timeout(120_000);
    const defUri = vscode.Uri.file(path.join(WORKSPACE!, DEF_REL));
    const defDocument = await vscode.workspace.openTextDocument(defUri);
    const anchor = symbolPosition(defDocument.getText().split('\n'), '<reqAttack>', 'reqAttack');

    // 双指标先过首命中窗(排除首扫),再排干后台量(热态前提=扫描不在途,
    // 突发不与在途任务抢周期——ACC-008 教训:def 突发撞上外部根扫描会出
    // 百毫秒级 P95 尖峰)
    await awaitFirstHit('vscode.executeHoverProvider', defUri, anchor);
    await awaitFirstHit('vscode.executeDefinitionProvider', defUri, anchor);
    for (let attempt = 0; attempt < 50; attempt++) {
      // IDE-AUD-019:真实 pendingWork 结构逐项核对 queued/running——
      // caches/worker 嵌套对象与容量量规不参与排干口径
      const busy = drainablePendingWork(probe.pendingWork());
      if (Object.keys(busy).length === 0) { break; }
      await sleep(500);
    }
    const pendingAtMeasure = probe.pendingWork();
    const drainLeft = drainablePendingWork(pendingAtMeasure);
    assert.ok(
      Object.keys(drainLeft).length === 0,
      `排干窗内在途/排队量未归零(容量面不要求归零): ${JSON.stringify(drainLeft)} / raw=${JSON.stringify(pendingAtMeasure)}`
    );

    // IDE-AUD-020 预登记采样口径:每突发开始采样宿主负载,超闸突发不入池化
    // 但留痕;P95=纳入突发的原始样本池化分位(总体口径),不是三轮最优事后
    // 择优。共享机(load avg 常年 8-12,co-tenant CPU 户在场)的争用窗由此
    // 预登记排除,排除本身落在证据里,不是静默丢弃。
    const hoverBursts: BurstRun[] = [];
    const definitionBursts: BurstRun[] = [];
    for (let i = 0; i < BURST_REPS; i++) {
      hoverBursts.push(await burst('vscode.executeHoverProvider', defUri, anchor));
      definitionBursts.push(await burst('vscode.executeDefinitionProvider', defUri, anchor));
    }
    const hover = evaluateFinalMarks(hoverBursts, definitionBursts, POLICY).hover;
    const definition = evaluateFinalMarks(hoverBursts, definitionBursts, POLICY).definition;
    const loadAvg = fs.readFileSync('/proc/loadavg', 'utf8').trim();

    const evidence: string[] = [];
    for (let i = 0; i < BURST_REPS; i++) {
      evidence.push(
        `acc010.hover.burst${i + 1}.hits=${hoverBursts[i].hits}/${BURST_ROUNDS}`,
        `acc010.hover.burst${i + 1}.p50Ms=${hoverBursts[i].p50Ms?.toFixed(3)}`,
        `acc010.hover.burst${i + 1}.p95Ms=${hoverBursts[i].p95Ms.toFixed(3)}`,
        `acc010.hover.burst${i + 1}.maxMs=${hoverBursts[i].maxMs?.toFixed(3)}`,
        `acc010.hover.burst${i + 1}.startLoad1=${hoverBursts[i].startLoad1}`,
        `acc010.definition.burst${i + 1}.hits=${definitionBursts[i].hits}/${BURST_ROUNDS}`,
        `acc010.definition.burst${i + 1}.p50Ms=${definitionBursts[i].p50Ms?.toFixed(3)}`,
        `acc010.definition.burst${i + 1}.p95Ms=${definitionBursts[i].p95Ms.toFixed(3)}`,
        `acc010.definition.burst${i + 1}.maxMs=${definitionBursts[i].maxMs?.toFixed(3)}`,
        `acc010.definition.burst${i + 1}.startLoad1=${definitionBursts[i].startLoad1}`
      );
    }
    evidence.push(
      `acc010.policy=${JSON.stringify({ ...POLICY, cores: os.cpus().length })} (pre-registered: pooled-P95 over bursts with startLoad1<=loadLimit, excluded bursts kept on record; not best-of-N)`,
      `acc010.hover.verdict=${hover.verdict}`,
      `acc010.hover.pooledP95Ms=${hover.pooledP95Ms === null ? 'null' : hover.pooledP95Ms.toFixed(3)}`,
      `acc010.hover.excluded=${JSON.stringify(hover.excluded.map(b => ({ p95Ms: b.p95Ms, startLoad1: b.startLoad1 })))}`,
      `acc010.hover.pass=${hover.pass}${hover.reason ? ` (${hover.reason})` : ''}`,
      `acc010.definition.verdict=${definition.verdict}`,
      `acc010.definition.pooledP95Ms=${definition.pooledP95Ms === null ? 'null' : definition.pooledP95Ms.toFixed(3)}`,
      `acc010.definition.excluded=${JSON.stringify(definition.excluded.map(b => ({ p95Ms: b.p95Ms, startLoad1: b.startLoad1 })))}`,
      `acc010.definition.pass=${definition.pass}${definition.reason ? ` (${definition.reason})` : ''}`,
      `acc010.hostLoadAvg=${loadAvg}`,
      `acc010.pendingWorkAtMeasure=${JSON.stringify(pendingAtMeasure)}`,
      `acc010.pendingWorkAfterBurst=${JSON.stringify(probe.pendingWork())}`
    );
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc010] evidence:\n' + evidence.join('\n'));

    // IDE-AUD-019:突发后请求侧在途/排队复检(容量面不要求归零)
    const drainAfterBurst = drainablePendingWork(probe.pendingWork());
    assert.ok(
      Object.keys(drainAfterBurst).length === 0,
      `突发后请求侧在途/排队量未归零: ${JSON.stringify(drainAfterBurst)}`
    );

    // IDE-AUD-020:命中与延迟双 assert——hover 与 definition 各自独立,
    // 延迟越界/非全命中/not-assessed 都直接判失败,不互相兜底、不只写日志
    for (let i = 0; i < BURST_REPS; i++) {
      assert.ok(
        hoverBursts[i].hits === BURST_ROUNDS,
        `热态 Hover 第 ${i + 1} 轮命中 ${hoverBursts[i].hits}/${BURST_ROUNDS}(非全命中)`
      );
      assert.ok(
        definitionBursts[i].hits === BURST_ROUNDS,
        `热态 Definition 第 ${i + 1} 轮命中 ${definitionBursts[i].hits}/${BURST_ROUNDS}(非全命中)`
      );
    }
    assert.ok(
      hover.pass,
      `热态 Hover 延迟验收失败: ${hover.reason || 'verdict=' + hover.verdict}(门槛 ${HOVER_P95_BOUND_MS}ms,池化 P95=${hover.pooledP95Ms}ms,排除=${JSON.stringify(hover.excluded)})`
    );
    assert.ok(
      definition.pass,
      `热态 Definition 延迟验收失败: ${definition.reason || 'verdict=' + definition.verdict}(门槛 ${DEFINITION_P95_BOUND_MS}ms,池化 P95=${definition.pooledP95Ms}ms,排除=${JSON.stringify(definition.excluded)})`
    );
  });
});
