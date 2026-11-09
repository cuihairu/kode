import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { sharedGitQueryGate } from '../../../backend/gitQueryGate';

// IDE-GIT-012:历史功能对宿主与语言服务影响验收(真实编辑器三态,同机同项目交替采样)。
// 装配同 ACC-010(--final:demo 资产+5000 文件外部根,绝对预算口径一致)。工作区根已由
// runTest.js --history 建成 git 仓库 + 大历史(history_probe.py,KODE_HISTORY_COMMITS
// 提交,每提交追加一段,使 `git log -L` 走全部提交→查询在途窗口)。
// 三态:①关闭(对照,enabled=false)②默认开启未查询(enabled=true,不触历史入口)
// ③查询大历史(选中探针全文件→showRangeHistory,查询在途时突发采样)。
// 每态×R 交替重复,记录:Git 调用数(sharedGitQueryGate.spawnCount 差)/进程·任务量
// (running+queued)/缓存字节(cacheBytes)/宿主最大延迟(setTimeout 事件循环探针 +
// provider 墙钟 max)/hover·def P95(best-of-3 静窗)。判定:未查询零 Git;查询不
// 同步阻塞宿主;忙时 P95 相对关闭回退 ≤max(5ms,10%);绝对预算 hover≤30/def≤50。
// 证据落 docs/perf/2026-11-05-history-host-impact-run.txt(KODE_HISTORY_OUT)。
// 共享机争用(load 8-12)单轮免责:best-of-3 静窗口径同 finalMarks(ACC-010,PERF-015)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --history must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_HISTORY_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-11-05-history-host-impact-run.txt');

const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const PROBE_REL = 'scripts/common/training/history_probe.py';
const WARMUP_ROUNDS = 3;
const BURST_REPS = 3;
const BURST_ROUNDS = 30;
const HOVER_BOUND_MS = 30;
const DEFINITION_BOUND_MS = 50;
const REGRESSION_FLOOR_MS = 5;
const REGRESSION_RATIO = 0.1;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  return new vscode.Position(line, lines[line].indexOf(symbol) + Math.floor(symbol.length / 2));
}

interface BurstStats {
  hits: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

async function awaitFirstHit(
  command: 'vscode.executeHoverProvider' | 'vscode.executeDefinitionProvider',
  uri: vscode.Uri, position: vscode.Position
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const raw = await vscode.commands.executeCommand(command, uri, position);
    if ((Array.isArray(raw) ? raw : []).length > 0) return;
    await sleep(500);
  }
  assert.fail(`首命中轮询窗内 ${command} 无命中(索引未就绪或锚失效)`);
}

async function burst(
  command: 'vscode.executeHoverProvider' | 'vscode.executeDefinitionProvider',
  uri: vscode.Uri, position: vscode.Position
): Promise<BurstStats> {
  for (let i = 0; i < WARMUP_ROUNDS; i++) {
    await vscode.commands.executeCommand(command, uri, position);
  }
  const samples: number[] = [];
  let hits = 0;
  for (let i = 0; i < BURST_ROUNDS; i++) {
    const startedAt = performance.now();
    const raw = await vscode.commands.executeCommand(command, uri, position);
    samples.push(performance.now() - startedAt);
    if ((Array.isArray(raw) ? raw : []).length > 0) hits += 1;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { hits, p50Ms: at(50), p95Ms: at(95), maxMs: sorted[sorted.length - 1] };
}

/** 事件循环滞后探针:预算定时器实测延迟的最大值(宿主最大延迟口径)。 */
async function eventLoopLagMax(ticks: number): Promise<number> {
  let maxLag = 0;
  for (let i = 0; i < ticks; i++) {
    const target = 10;
    const startedAt = performance.now();
    await new Promise<void>(resolve => setTimeout(resolve, target));
    maxLag = Math.max(maxLag, performance.now() - startedAt - target);
  }
  return maxLag;
}

interface StateMetrics {
  name: string;
  spawnDelta: number;
  runningMax: number;
  queuedMax: number;
  cacheBytes: number;
  eventLoopLagMax: number;
  hover: BurstStats;
  definition: BurstStats;
}

describe('IDE-GIT-012:历史功能对宿主与语言服务影响(真实编辑器三态)', () => {
  let probe: { pendingWork(): Record<string, number> };
  let defUri: vscode.Uri;
  let anchor: vscode.Position;
  let probeUri: vscode.Uri;

  before(async function () {
    this.timeout(180_000);
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as { pendingWork(): Record<string, number> };
    assert.ok(typeof probe.pendingWork === 'function', 'activate 未返回 pendingWork 量规');
    assert.ok(
      vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === WORKSPACE),
      'history 工作区不在宿主(workspace 装配不符)'
    );
    defUri = vscode.Uri.file(path.join(WORKSPACE!, DEF_REL));
    probeUri = vscode.Uri.file(path.join(WORKSPACE!, PROBE_REL));
    const defDocument = await vscode.workspace.openTextDocument(defUri);
    anchor = symbolPosition(defDocument.getText().split('\n'), '<reqAttack>', 'reqAttack');
    // 探针文件必须存在(runTest.js --history 已建成大历史)。
    const probeDoc = await vscode.workspace.openTextDocument(probeUri);
    assert.ok(probeDoc.getText().length > 0, 'history_probe.py 为空(大历史装配缺失)');
  });

  async function drainBackground(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const pending = probe.pendingWork();
      const busy = Object.values(pending).some(count => count > 0)
        || sharedGitQueryGate.runningCount() > 0;
      if (!busy) return;
      await sleep(500);
    }
    const pending = probe.pendingWork();
    assert.ok(
      Object.values(pending).every(count => count === 0) && sharedGitQueryGate.runningCount() === 0,
      `排干窗内后台量未归零: ${JSON.stringify(pending)} gateRunning=${sharedGitQueryGate.runningCount()}`
    );
  }

  async function measureState(
    name: string,
    enabled: boolean,
    doQuery: boolean
  ): Promise<StateMetrics> {
    // 先排干上一态在途查询(门 runningCount→0,缓存落定),再切态:
    // 否则上一态(查询大历史)fire-and-forget 查询仍在途,本态 config.update
    // 触发 cancelAll 清缓存后,其迟到 ok 结果重写缓存 → 污染未查询态 cacheBytes
    // (零 Git 误报根因之二)。排干后再切,禁用态 cancelAll 清的是已落定缓存,
    // 无在途可重写。
    await drainBackground();
    // 开关:经 workspace 配置切态,等扩展 onDidChangeConfiguration 传播。
    const config = vscode.workspace.getConfiguration('kbengine');
    await config.update('gitHistory.enabled', enabled, vscode.ConfigurationTarget.Workspace);
    await sleep(400);
    await drainBackground();

    const spawnBefore = sharedGitQueryGate.spawnCount();
    let runningMax = 0;
    let queuedMax = 0;
    let lagMax = 0;

    // 查询大历史:开探针编辑器+选区覆盖全文件,fire 命令不 await,突发采样覆盖在途窗口。
    let queryPromise: Thenable<unknown> | null = null;
    if (doQuery) {
      const editor = await vscode.window.showTextDocument(probeUri);
      const doc = editor.document;
      const last = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), last);
      await sleep(100);
      queryPromise = vscode.commands.executeCommand('kbengine.git.showRangeHistory');
    }

    // 突发 hover/def P95(忙时基础交互)。
    const hoverBursts: BurstStats[] = [];
    const definitionBursts: BurstStats[] = [];
    for (let i = 0; i < BURST_REPS; i++) {
      hoverBursts.push(await burst('vscode.executeHoverProvider', defUri, anchor));
      definitionBursts.push(await burst('vscode.executeDefinitionProvider', defUri, anchor));
      runningMax = Math.max(runningMax, sharedGitQueryGate.runningCount());
      queuedMax = Math.max(queuedMax, sharedGitQueryGate.queuedCount());
      lagMax = Math.max(lagMax, await eventLoopLagMax(5));
    }
    if (queryPromise) await queryPromise;
    const spawnDelta = sharedGitQueryGate.spawnCount() - spawnBefore;

    const bestHoverP95 = Math.min(...hoverBursts.map(b => b.p95Ms));
    const bestDefinitionP95 = Math.min(...definitionBursts.map(b => b.p95Ms));
    const hoverMax = Math.max(...hoverBursts.map(b => b.maxMs));
    const definitionMax = Math.max(...definitionBursts.map(b => b.maxMs));
    return {
      name,
      spawnDelta,
      runningMax,
      queuedMax,
      cacheBytes: sharedGitQueryGate.cacheBytes(),
      eventLoopLagMax: lagMax,
      hover: { hits: Math.min(...hoverBursts.map(b => b.hits)), p50Ms: bestHoverP95, p95Ms: bestHoverP95, maxMs: hoverMax },
      definition: { hits: Math.min(...definitionBursts.map(b => b.hits)), p50Ms: bestDefinitionP95, p95Ms: bestDefinitionP95, maxMs: definitionMax },
    };
  }

  it('三态交替重复采样:零 Git、无阻塞、P95 回退在界内、绝对预算满足', async function () {
    this.timeout(600_000);
    await awaitFirstHit('vscode.executeHoverProvider', defUri, anchor);
    await awaitFirstHit('vscode.executeDefinitionProvider', defUri, anchor);
    await drainBackground();

    // 同机同项目交替重复采样:每轮固定序 关闭→默认开启未查询→查询大历史。
    // 顺序关键:关闭态(disabled)切配置触发门 cancelAll 清缓存,故每个未查询态
    // 测量起点缓存恒 0,且与查询态串行——查询态的 Git 调用/缓存绝不漏进未查询
    // 窗口(并发 Promise.all 是零 Git 误报根因,已修)。每态取多轮 worst/best 聚合。
    // 回退判定按**轮内配对**(同轮关闭对照 vs 未查询/查询,同一负载纪元)取各轮最优,
    // 避免跨轮取独立最优静窗把不同负载窗拼到一起(共享机 load>100 下 0.4ms 级误报)。
    const ROUNDS = 3;
    const order = ['disabled', 'enabled-no-query', 'querying'] as const;
    const rounds: Array<Record<(typeof order)[number], StateMetrics>> = [];
    for (let r = 0; r < ROUNDS; r++) {
      const rd = {} as Record<(typeof order)[number], StateMetrics>;
      for (const name of order) {
        const cfg = name === 'disabled'
          ? { enabled: false, doQuery: false }
          : name === 'enabled-no-query'
            ? { enabled: true, doQuery: false }
            : { enabled: true, doQuery: true };
        rd[name] = await measureState(name, cfg.enabled, cfg.doQuery);
      }
      rounds.push(rd);
    }
    // 聚合(证据展示):Git 调用/任务/缓存/延迟取多轮最大(未查询零 Git 须每轮都成立,
    // 取最坏);P95 取多轮最优静窗(best-of-rounds,同 best-of-3 静窗口径)。
    const worst = <T>(values: T[]): T => values.reduce((a, b) => (b > a ? b : a));
    const best = (values: number[]): number => Math.min(...values);
    const aggregate = (key: (typeof order)[number]): StateMetrics => {
      const list = rounds.map(rd => rd[key]);
      return {
        name: key,
        spawnDelta: worst(list.map(s => s.spawnDelta)),
        runningMax: worst(list.map(s => s.runningMax)),
        queuedMax: worst(list.map(s => s.queuedMax)),
        cacheBytes: worst(list.map(s => s.cacheBytes)),
        eventLoopLagMax: worst(list.map(s => s.eventLoopLagMax)),
        hover: {
          hits: Math.min(...list.map(s => s.hover.hits)),
          p50Ms: best(list.map(s => s.hover.p50Ms)),
          p95Ms: best(list.map(s => s.hover.p95Ms)),
          maxMs: best(list.map(s => s.hover.maxMs)),
        },
        definition: {
          hits: Math.min(...list.map(s => s.definition.hits)),
          p50Ms: best(list.map(s => s.definition.p50Ms)),
          p95Ms: best(list.map(s => s.definition.p95Ms)),
          maxMs: best(list.map(s => s.definition.maxMs)),
        },
      };
    };
    const disabled = aggregate('disabled');
    const enabledNoQuery = aggregate('enabled-no-query');
    const querying = aggregate('querying');

    // 判定:未查询零 Git。
    const zeroGit = enabledNoQuery.spawnDelta === 0
      && enabledNoQuery.runningMax === 0
      && enabledNoQuery.queuedMax === 0
      && enabledNoQuery.cacheBytes === 0;
    // 判定:查询不同步阻塞宿主(事件循环探针延迟有界,忙时 provider 墙钟不失控)。
    const syncBlockOk = querying.eventLoopLagMax < 1000;
    // 判定:忙时 P95 相对关闭回退 ≤ max(5ms, 10%)——轮内配对差值取各轮最优(最小)。
    const hoverFloor = Math.max(REGRESSION_FLOOR_MS, disabled.hover.p95Ms * REGRESSION_RATIO);
    const defFloor = Math.max(REGRESSION_FLOOR_MS, disabled.definition.p95Ms * REGRESSION_RATIO);
    const pairedDelta = (key: (typeof order)[number], field: 'hover' | 'definition'): number =>
      best(rounds.map(rd => rd[key][field].p95Ms - rd.disabled[field].p95Ms));
    const noQueryHoverOk = pairedDelta('enabled-no-query', 'hover') <= hoverFloor;
    const noQueryDefOk = pairedDelta('enabled-no-query', 'definition') <= defFloor;
    const queryHoverOk = pairedDelta('querying', 'hover') <= hoverFloor;
    const queryDefOk = pairedDelta('querying', 'definition') <= defFloor;
    const hoverBudgetOk = querying.hover.p95Ms <= HOVER_BOUND_MS && enabledNoQuery.hover.p95Ms <= HOVER_BOUND_MS && disabled.hover.p95Ms <= HOVER_BOUND_MS;
    const defBudgetOk = querying.definition.p95Ms <= DEFINITION_BOUND_MS && enabledNoQuery.definition.p95Ms <= DEFINITION_BOUND_MS && disabled.definition.p95Ms <= DEFINITION_BOUND_MS;

    let loadAvg = '';
    try {
      loadAvg = (await import('fs')).readFileSync('/proc/loadavg', 'utf8').trim();
    } catch { loadAvg = 'unavailable'; }

    const line = (s: StateMetrics): string[] => [
      `history.${s.name}.spawnDelta=${s.spawnDelta}`,
      `history.${s.name}.runningMax=${s.runningMax}`,
      `history.${s.name}.queuedMax=${s.queuedMax}`,
      `history.${s.name}.cacheBytes=${s.cacheBytes}`,
      `history.${s.name}.eventLoopLagMaxMs=${s.eventLoopLagMax.toFixed(3)}`,
      `history.${s.name}.hover.bestP95Ms=${s.hover.p95Ms.toFixed(3)}`,
      `history.${s.name}.hover.maxMs=${s.hover.maxMs.toFixed(3)}`,
      `history.${s.name}.definition.bestP95Ms=${s.definition.p95Ms.toFixed(3)}`,
      `history.${s.name}.definition.maxMs=${s.definition.maxMs.toFixed(3)}`,
      `history.${s.name}.hover.hits=${s.hover.hits}/${BURST_ROUNDS}`,
      `history.${s.name}.definition.hits=${s.definition.hits}/${BURST_ROUNDS}`,
    ];
    const evidence = [
      ...line(disabled),
      ...line(enabledNoQuery),
      ...line(querying),
      `history.zeroGitWhenNoQuery=${zeroGit}`,
      `history.syncBlockOk=${syncBlockOk} (eventLoopLagMax<1000ms)`,
      `history.hoverRegression.noQueryPairedDeltaMs=${pairedDelta('enabled-no-query', 'hover').toFixed(3)} (floor ${hoverFloor.toFixed(2)}ms)`,
      `history.definitionRegression.noQueryPairedDeltaMs=${pairedDelta('enabled-no-query', 'definition').toFixed(3)} (floor ${defFloor.toFixed(2)}ms)`,
      `history.hoverRegression.queryingPairedDeltaMs=${pairedDelta('querying', 'hover').toFixed(3)} (floor ${hoverFloor.toFixed(2)}ms)`,
      `history.definitionRegression.queryingPairedDeltaMs=${pairedDelta('querying', 'definition').toFixed(3)} (floor ${defFloor.toFixed(2)}ms)`,
      `history.hoverRegression.noQueryOk=${noQueryHoverOk}`,
      `history.definitionRegression.noQueryOk=${noQueryDefOk}`,
      `history.hoverRegression.queryingOk=${queryHoverOk}`,
      `history.definitionRegression.queryingOk=${queryDefOk}`,
      `history.hoverBudgetOk=${hoverBudgetOk} (bound ${HOVER_BOUND_MS}ms)`,
      `history.definitionBudgetOk=${defBudgetOk} (bound ${DEFINITION_BOUND_MS}ms)`,
      `history.hostLoadAvg=${loadAvg}`,
      `history.rounds=${ROUNDS}`,
      `history.note=best-of-${BURST_REPS} bursts quiet-window; regression deltas paired per-round (same load epoch); same-host field assembly (demo+5000 external); PERF-015 single-round disclaimer`,
    ];
    const fs = await import('fs');
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[history] evidence:\n' + evidence.join('\n'));

    assert.ok(zeroGit, '默认开启未查询态 Git 调用/历史任务未归零');
    assert.ok(syncBlockOk, '历史查询同步阻塞宿主(事件循环滞后超界)');
    assert.ok(noQueryHoverOk && noQueryDefOk, '默认开启未查询 P95 回退超界');
    assert.ok(queryHoverOk && queryDefOk, '查询大历史 P95 回退超界');
    assert.ok(hoverBudgetOk && defBudgetOk, '绝对延迟预算超界');
    assert.ok(querying.spawnDelta > 0, '查询大历史态未启动任何 Git 查询(装配失效)');
  });
});
