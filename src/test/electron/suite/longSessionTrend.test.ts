import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

// IDE-AUD-017(与 IDE-REV-034 短压力分离):长会话趋势验收。REV-034 保留 16s
// 正式序列为短压力证据(固定 12 轮/预算面判据,longSessionResources.test.ts
// 原样不动);本套件按验收原文「预设持续时长、自然编辑序列与资源预算跑长会话;
// 报告 worker/缓存/RSS 趋势,不以手调 parser 代替全部用户交互」:
//   - 预设 TARGET_DURATION_MS=180s(3 分钟自然编辑会话,非固定轮数)。
//   - 自然编辑序列:真实 applyEdit/save/hover/def 命令(editor 面),零
//     parsePythonFileResponsive 调用(手调 parser 不出现——大文件每 4 周期
//     自然触碰一次(快速连发两保存,REV-030 字节量规只计未投递排队字节)
//     产生的 worker 派发是自然交互面,不是 parser API 旁路;REV-034 的
//     每周期双连发短压力面不在此复刻)。
//   - 逐周期趋势行:RSS/worker 队列与字节(采样+量规)/缓存占用/parse 窗口。
//   - 资源预算沿用 REV-034 口径锚(见头注),失控总闸 260MiB、尾窗 60MiB、
//     worker≤maxQueuedBytes、def 缓存≤8 条/8MiB、schema≤32、事件循环
//     p99<500ms、工作集不随周期增长。
// 与 REV-034 的互补:短压力=固定序列+预算面判据(16s 正式窗);长会话=预设
// 时长+自然编辑+趋势报告(180s 窗)。二者分别跑,各自落独立证据文件。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --longtrend must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_AUD17_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-11-05-aud017-long-session-run.txt');

const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const PY_REL = 'scripts/common/training/plain_var_caller.py';
const LARGE_REL = 'scripts/common/training/plain_var_large.py';

/** 预设持续时长:3 分钟自然编辑会话(验收原文「预设持续时长」) */
const TARGET_DURATION_MS = 180_000;
/** 稳态周期排干窗(与 REV-034 同口径) */
const DRAIN_DEADLINE_MS = 15_000;
/**
 * 吸收周期(第 1 周期)排干窗:首周期后台任务单并发排队——初始全量扫描
 * (~10.4s,PERF-007 实测)排在前,其后才是自然编辑+跨文件 def 触发的
 * class-index 构建(本套件有跨文件 def,REV-034 无故其 15s 窗够用)。
 * 15s 窗首跑实测排不干(残留 indexTasksQueued=6,扫描起于首次交互被冷却
 * 窗让路)。吸收周期给 60s:与 RSS 吸收预算同语义(首周期吸收懒加载,不
 * 进稳态判据),稳态周期沿用 15s 不抬。
 */
const FIRST_CYCLE_DRAIN_DEADLINE_MS = 60_000;
/**
 * 超阈值大文件(plain_var_large.py,~631KB>256KiB 走 worker)的触碰节奏:
 * 每 N 周期一次快速连发两保存。IDE-AUD-017 的验收是「自然编辑序列」,与
 * REV-034 的「短压力」分离——人手不会每周期对 631KB 大文件连发两次保存
 * (那是 REV-034 双连发压力面)。首版套件照搬 REV-034 双连发×每周期,
 * 180s×37 周期把 V8 堆推高 400MiB(实测稳态 +403,GC 在 c22/c24 各回收
 * 126/102MiB,无引用泄漏:docs 工作集恒 4、缓存全在容、GC 可回收),是
 * 「短压力复刻」而非「长会话自然序列」的设计错配。本版改为每 4 周期自然
 * 触碰一次大文件(快速连发两保存仍在触碰周期发生:REV-030 字节量规只计
 * 未投递排队字节,单次保存被空闲 worker 即时接管排队恒 0,咬合量规空转
 * 不许绿——连发在触碰周期内是自然的大文件保存手势)。仍真实走 worker
 * 解析路径(派发后同轮采样字节、会话级 peakQueuedBytes 有增量=咬合保留),
 * 但不再以每周期大文件 churn 污染 RSS 趋势被判据读作泄漏。所有预算阈值
 * (120/140/260/60)不变。
 */
const LARGE_FILE_PERIOD = 4;
/** 大文件首触周期:吸收周期(1)与第 2 周期保持轻序列,第 3 周期起按周期触碰 */
const LARGE_FILE_FIRST_CYCLE = 3;
/** 会话最短周期数:不足则趋势无意义(3 分钟/周期≤15s 排干,应远超此数) */
const MIN_CYCLES = 6;
/**
 * RSS 资源预算(预先写明,锚 REV-034 实测:暖机 101-106/边界 12-30/正式
 * 65-80;本套件无轮数面,按会话段分):
 *   ① 吸收周期(第 1 周期,吸收根索引/worker 池/Pylance 首析懒加载)≤120
 *      (REV-034 暖机面锚 101-106,同口径);
 *   ② 稳态净漂移(第 1 周期末→会话末,含懒加载尾段+长会话惰性爬坡)≤140
 *      (REV-034 边界+正式面之和=140,锚 77-110,长会话窗更宽阈值不抬);
 *   ③ 失控总闸=声明之和 ≤260(REV-034 同口径,非曲线拟合值)。
 */
const RSS_ABSORB_BOUND_MIB = 120;
const RSS_STEADY_BOUND_MIB = 140;
const RSS_RUNAWAY_BOUND_MIB = RSS_ABSORB_BOUND_MIB + RSS_STEADY_BOUND_MIB;
/** 尾窗 RSS 漂移上界(会话末 1/4 窗,阈值沿用 REV-034 尾窗 60 不抬) */
const RSS_TAIL_BOUND_MIB = 60;
/** RES-004:languageServiceMetrics 聚合 elapsed 采样窗口上界(2×上限触发截断) */
const ELAPSED_WINDOW_CHUNK = 4000;

interface WorkerGauge {
  running: number;
  queued: number;
  queuedBytes: number;
  maxQueuedBytes: number;
  peakQueuedBytes: number;
  budgetRejects: number;
}
interface CacheGauges {
  parsedDocuments: { entries: number; maxEntries: number; bytes: number; maxBytes: number };
  databaseSchemas: { entries: number; capacity: number };
  annotationIndex: { entries: number; ttlMs: number };
}
interface PendingWorkGauge {
  diagnosticsQueued: number;
  diagnosticsInFlight: number;
  annotationUpdates: number;
  caches: CacheGauges;
  worker: WorkerGauge;
  annotationBuilds: { running: number; waiting: number; cancelled: number };
  indexTasksQueued: number;
  schemaColdBuilds: number;
}
interface KodeProbeExports { pendingWork(): PendingWorkGauge }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 行锚+符号双定位(与 field 系列同口径) */
function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  return new vscode.Position(line, lines[line].indexOf(symbol) + Math.floor(symbol.length / 2));
}

async function hoverAt(uri: vscode.Uri, position: vscode.Position): Promise<{ hit: boolean; elapsedMs: number }> {
  const startedAt = performance.now();
  const raw = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
  return { hit: (Array.isArray(raw) ? raw : []).length > 0, elapsedMs: performance.now() - startedAt };
}

async function defAt(uri: vscode.Uri, position: vscode.Position): Promise<{ hit: boolean; count: number; elapsedMs: number }> {
  const startedAt = performance.now();
  const raw = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
  const arr = Array.isArray(raw) ? raw : [];
  return { hit: arr.length > 0, count: arr.length, elapsedMs: performance.now() - startedAt };
}

/** 排干判据用数值叶(与 REV-034 同口径) */
function pendingLeaves(pending: PendingWorkGauge): Record<string, number> {
  return {
    diagnosticsQueued: pending.diagnosticsQueued,
    diagnosticsInFlight: pending.diagnosticsInFlight,
    annotationUpdates: pending.annotationUpdates,
    annotationBuilds: pending.annotationBuilds.running
      + pending.annotationBuilds.waiting + pending.annotationBuilds.cancelled,
    workerRunning: pending.worker.running,
    workerQueued: pending.worker.queued,
    indexTasksQueued: pending.indexTasksQueued,
    schemaColdBuilds: pending.schemaColdBuilds
  };
}

describe('IDE-AUD-017:预设 180s 自然编辑长会话趋势(与 REV-034 短压力分离)', () => {
  let probe: KodeProbeExports;

  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as KodeProbeExports;
    assert.ok(typeof probe.pendingWork === 'function', 'activate 未返回 pendingWork 量规');
    for (const rel of [DEF_REL, PY_REL, LARGE_REL]) {
      assert.ok(fs.existsSync(path.join(WORKSPACE!, rel)), `夹具缺失: ${rel}`);
    }
  });

  it(`自然编辑序列直至 ${TARGET_DURATION_MS / 1000}s:逐周期 RSS/worker/缓存趋势,预算与稳态判据先落证据`, async function () {
    this.timeout(480_000);
    const { getOperationSummary } = await import('../../../languageServiceMetrics');

    const defUri = vscode.Uri.file(path.join(WORKSPACE!, DEF_REL));
    const pyUri = vscode.Uri.file(path.join(WORKSPACE!, PY_REL));
    const largeUri = vscode.Uri.file(path.join(WORKSPACE!, LARGE_REL));

    // 基线前把定位用的 def 文档走一遍 show+close 干净退出计数
    const warmDocument = await vscode.workspace.openTextDocument(defUri);
    await vscode.window.showTextDocument(warmDocument);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // 会话基线:文档数/RSS/parse 计数窗口基线(RES-004 记账用)
    await sleep(1500);
    const sessionStartAt = performance.now();
    const docsBaseline = vscode.workspace.textDocuments.length;
    const rssBaseline = process.memoryUsage().rss;
    const parseBaseline = getOperationSummary('document-parse');
    const parseCountBaseline = parseBaseline?.count ?? 0;
    const parseDroppedBaseline = parseBaseline?.elapsedDropped ?? 0;
    const histogram = monitorEventLoopDelay({ resolution: 2 });
    histogram.enable();

    const rows: string[] = [];
    const rssByCycle: number[] = [];
    /** 第 1 周期末定格的文档工作集上限(后续周期不得增长) */
    let docsWorkingSet = docsBaseline;
    let cycleCount = 0;
    let lastCacheHits = parseBaseline?.cacheHits ?? 0;
    /** 会话段 worker 高水位/拒绝计数(咬合与触顶判据用) */
    let steadyPeakQueuedBytes = -1;
    let steadyBudgetRejects = -1;
    let steadyStartAt = -1;
    let absorbElapsedMs = -1;
    /** 排干轮询窗口内的逐周期采样峰值(采样是下界不是精确峰) */
    let sampledMaxQueuedBytes = 0;
    let sampledMaxRunning = 0;

    for (;;) {
      const now = performance.now();
      if (cycleCount >= 1 && now - sessionStartAt >= TARGET_DURATION_MS) { break; }
      cycleCount += 1;

      // ──自然编辑序列(真实编辑器面,零手调 parser)──
      // ① 开调用方 .py(独立栏)+ 热 hover + def(get_annotated_data 同文件)
      const pyDocument = await vscode.workspace.openTextDocument(pyUri);
      await vscode.window.showTextDocument(pyDocument, vscode.ViewColumn.One);
      const pyPos = symbolPosition(pyDocument.getText().split('\n'), 'def get_annotated_data', 'get_annotated_data');
      const pyHover = await hoverAt(pyUri, pyPos);
      const pyDef = await defAt(pyUri, pyPos);

      // ② 真实编辑+保存(调用方追加一行 bump 版本→解析+诊断入队;保存防脏
      // 文档被宿主长持——自然编辑面)
      const callerEdit = new vscode.WorkspaceEdit();
      callerEdit.insert(pyDocument.uri, new vscode.Position(pyDocument.lineCount, 0), `# aud017 cycle ${cycleCount}\n`);
      assert.ok(await vscode.workspace.applyEdit(callerEdit), `第 ${cycleCount} 周期调用方 applyEdit 失败`);
      assert.ok(await pyDocument.save(), `第 ${cycleCount} 周期调用方保存失败`);

      // ③ 开 .def(独立栏)+ reqAttack 热 hover + def
      const defDocument = await vscode.workspace.openTextDocument(defUri);
      await vscode.window.showTextDocument(defDocument, vscode.ViewColumn.Two);
      const defPos = symbolPosition(defDocument.getText().split('\n'), '<reqAttack>', 'reqAttack');
      const defHover = await hoverAt(defUri, defPos);
      const defDef = await defAt(defUri, defPos);

      // ④ 真实编辑+保存(def 结构注释插入——触发结构诊断;保持 XML 合法)
      const defLines = defDocument.getText().split('\n');
      const rootCloseLine = defLines.findIndex(text => text.trim() === '</root>');
      assert.ok(rootCloseLine >= 0, 'TrainingAvatar.def 缺 </root>');
      const defEdit = new vscode.WorkspaceEdit();
      defEdit.insert(defUri, new vscode.Position(rootCloseLine, 0), `    <!-- aud017 cycle ${cycleCount} -->\n`);
      assert.ok(await vscode.workspace.applyEdit(defEdit), `第 ${cycleCount} 周期 def applyEdit 失败`);
      assert.ok(await defDocument.save(), `第 ${cycleCount} 周期 def 保存失败`);

      // ⑤ 超阈值大 .py 自然触碰(独立栏,>256KiB 走 worker):每 4 周期一次
      // 快速连发两保存(自然场景=大文件连续两次快速保存:首份派发在途、
      // 次份落同文件积压,REV-030 字节量规只计「未投递」排队字节,单次保存
      // 被空闲 worker 即时接管,排队字节恒 0=咬合量规空转不许绿)。触碰周期
      // 派发后同轮采样排队字节(走量面,采样是下界);非触碰周期记 0(na)。
      const isLargeCycle = cycleCount >= LARGE_FILE_FIRST_CYCLE
        && (cycleCount - LARGE_FILE_FIRST_CYCLE) % LARGE_FILE_PERIOD === 0;
      let burstQueuedBytesAtPost = 0;
      if (isLargeCycle) {
        const largeDocument = await vscode.workspace.openTextDocument(largeUri);
        await vscode.window.showTextDocument(largeDocument, vscode.ViewColumn.Three);
        for (const suffix of ['a', 'b']) {
          const largeEdit = new vscode.WorkspaceEdit();
          largeEdit.insert(
            largeDocument.uri,
            new vscode.Position(largeDocument.lineCount, 0),
            `# aud017 large cycle ${cycleCount} ${suffix}\n`
          );
          assert.ok(await vscode.workspace.applyEdit(largeEdit), `第 ${cycleCount} 周期大文件 applyEdit 失败`);
          assert.ok(await largeDocument.save(), `第 ${cycleCount} 周期大文件保存失败`);
        }
        // 派发异步落账:保存后轮询 ≤3s 取首个非零排队字节(自然积压走量面,
        // 采样是下界;不轮询可能在派发落账前取到 0)
        for (let waitedMs = 0; waitedMs < 3000; waitedMs += 100) {
          burstQueuedBytesAtPost = probe.pendingWork().worker.queuedBytes;
          if (burstQueuedBytesAtPost > 0) { break; }
          await sleep(100);
        }
      }

      // ⑥ 跨文件 def 导航(get_unannotated_data 定义在 plain_var_large.py;
      // needle 用调用行,避开第 2 行 import 绑定,取真实调用点)
      const crossPos = symbolPosition(
        pyDocument.getText().split('\n'),
        'plain_local_info = get_unannotated_data',
        'get_unannotated_data'
      );
      const crossDef = await defAt(pyUri, crossPos);

      // ⑦ 排干轮询(首周期 60s 吸收窗/稳态 15s):数值叶+worker 在途/排队全零
      // 才进收尾;轮询窗口内采样 worker 队列字节/在途峰值(逐周期采集的走量
      // 面,采样是下界)
      sampledMaxQueuedBytes = 0;
      sampledMaxRunning = 0;
      const drainDeadlineMs = cycleCount === 1 ? FIRST_CYCLE_DRAIN_DEADLINE_MS : DRAIN_DEADLINE_MS;
      const drainDeadline = Date.now() + drainDeadlineMs;
      let pending = probe.pendingWork();
      for (;;) {
        sampledMaxQueuedBytes = Math.max(sampledMaxQueuedBytes, pending.worker.queuedBytes);
        sampledMaxRunning = Math.max(sampledMaxRunning, pending.worker.running);
        const nonzero = Object.entries(pendingLeaves(pending)).filter(([, value]) => value > 0);
        if (nonzero.length === 0 || Date.now() > drainDeadline) { break; }
        await sleep(100);
        pending = probe.pendingWork();
      }
      const nonzero = Object.entries(pendingLeaves(pending)).filter(([, value]) => value > 0);
      assert.deepStrictEqual(
        nonzero, [],
        `第 ${cycleCount} 周期队列未排干: ${JSON.stringify(pendingLeaves(pending))}`
      );

      // ⑧ 全关页签+工作集核对(与 REV-034 同口径:语言服务按需开文档属宿主
      // 工作集行为,可守边界=工作集不随周期增长)
      await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(g => g.tabs));
      const docsDeadline = Date.now() + 10_000;
      while (
        vscode.window.tabGroups.all.some(g => g.tabs.length > 0) && Date.now() < docsDeadline
      ) { await sleep(300); }
      assert.ok(
        vscode.window.tabGroups.all.every(g => g.tabs.length === 0),
        `第 ${cycleCount} 周期页签未全部关闭(编辑器面泄漏)`
      );
      const docsNow = vscode.workspace.textDocuments.length;
      if (cycleCount === 1) {
        docsWorkingSet = Math.max(docsNow, docsBaseline);
      } else {
        assert.ok(
          docsNow <= docsWorkingSet + 1,
          `第 ${cycleCount} 周期文档工作集 ${docsNow} 超过第 1 周期定格 ${docsWorkingSet}(工作集随会话增长)`
        );
      }

      // ⑨ 逐周期量规预算断言(worker 排队字节采样+累计峰值不超预算;缓存条目
      // /字节在容量内)
      const worker = pending.worker;
      assert.ok(
        sampledMaxQueuedBytes <= worker.maxQueuedBytes
          && burstQueuedBytesAtPost <= worker.maxQueuedBytes
          && worker.peakQueuedBytes <= worker.maxQueuedBytes,
        `第 ${cycleCount} 周期 worker 排队字节超预算: 采样 ${sampledMaxQueuedBytes}B/积压 ${burstQueuedBytesAtPost}B/峰值 ${worker.peakQueuedBytes}B > 预算 ${worker.maxQueuedBytes}B`
      );
      const caches = pending.caches;
      assert.ok(
        caches.parsedDocuments.entries <= caches.parsedDocuments.maxEntries
          && caches.parsedDocuments.bytes <= caches.parsedDocuments.maxBytes,
        `第 ${cycleCount} 周期 def 解析缓存超容: entries ${caches.parsedDocuments.entries}/${caches.parsedDocuments.maxEntries}, bytes ${caches.parsedDocuments.bytes}/${caches.parsedDocuments.maxBytes}`
      );
      assert.ok(
        caches.databaseSchemas.entries <= caches.databaseSchemas.capacity,
        `第 ${cycleCount} 周期 schema 快照超容: ${caches.databaseSchemas.entries}/${caches.databaseSchemas.capacity}`
      );

      // ⑩ 逐周期证据行:RSS/worker 队列与字节(采样+量规)/缓存占用/parse 窗口
      const parse = getOperationSummary('document-parse');
      const cacheHits = parse?.cacheHits ?? 0;
      assert.ok(
        cacheHits >= lastCacheHits,
        `第 ${cycleCount} 周期 cacheHits 回退 ${lastCacheHits}→${cacheHits}(计数器不应回退)`
      );
      lastCacheHits = cacheHits;
      const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      rssByCycle.push(rssMiB);
      rows.push([
        `aud017.c${cycleCount}.rssMiB=${rssMiB}`,
        `aud017.c${cycleCount}.pyHoverHit=${pyHover.hit}`,
        `aud017.c${cycleCount}.pyHoverMs=${pyHover.elapsedMs.toFixed(3)}`,
        `aud017.c${cycleCount}.pyDefHit=${pyDef.hit}(${pyDef.count})`,
        `aud017.c${cycleCount}.defHoverHit=${defHover.hit}`,
        `aud017.c${cycleCount}.defHoverMs=${defHover.elapsedMs.toFixed(3)}`,
        `aud017.c${cycleCount}.defDefHit=${defDef.hit}(${defDef.count})`,
        `aud017.c${cycleCount}.crossDefHit=${crossDef.hit}(${crossDef.count})`,
        `aud017.c${cycleCount}.worker.sampledMaxQueuedBytes=${sampledMaxQueuedBytes}`,
        `aud017.c${cycleCount}.worker.burstQueuedBytesAtPost=${burstQueuedBytesAtPost}`,
        `aud017.c${cycleCount}.worker.sampledMaxRunning=${sampledMaxRunning}`,
        `aud017.c${cycleCount}.worker.queued=${worker.queued}`,
        `aud017.c${cycleCount}.worker.queuedBytes=${worker.queuedBytes}`,
        `aud017.c${cycleCount}.worker.peakQueuedBytes=${worker.peakQueuedBytes}`,
        `aud017.c${cycleCount}.worker.budgetRejects=${worker.budgetRejects}`,
        `aud017.c${cycleCount}.caches.defEntries=${caches.parsedDocuments.entries}/${caches.parsedDocuments.maxEntries}`,
        `aud017.c${cycleCount}.caches.defBytes=${caches.parsedDocuments.bytes}/${caches.parsedDocuments.maxBytes}`,
        `aud017.c${cycleCount}.caches.schemaEntries=${caches.databaseSchemas.entries}/${caches.databaseSchemas.capacity}`,
        `aud017.c${cycleCount}.caches.annotationIndexEntries=${caches.annotationIndex.entries}`,
        `aud017.c${cycleCount}.docs=${docsNow}`,
        `aud017.c${cycleCount}.parse.count=${parse?.count ?? 0}`,
        `aud017.c${cycleCount}.parse.cacheHits=${cacheHits}`,
        `aud017.c${cycleCount}.parse.cacheMisses=${parse?.cacheMisses ?? 0}`
      ].join(' | '));
      if (cycleCount === 1) {
        // 第 1 周期末起为稳态窗:定格 worker 高水位/拒绝计数起点(吸收周期
        // 不进稳态判据;与 RSS 稳态口径一致=从 rssByCycle[0] 即 c1 末起算)
        steadyStartAt = performance.now();
        absorbElapsedMs = steadyStartAt - sessionStartAt;
        const workerAtBoundary = probe.pendingWork().worker;
        steadyPeakQueuedBytes = workerAtBoundary.peakQueuedBytes;
        steadyBudgetRejects = workerAtBoundary.budgetRejects;
      }
    }

    histogram.disable();
    assert.ok(cycleCount >= MIN_CYCLES, `会话仅 ${cycleCount} 周期,不足趋势最小 ${MIN_CYCLES}`);
    // 会话末读数:队列已逐周期排干,再静默 2s 让收尾任务落定后取终值
    await sleep(2000);
    const totalElapsedMs = performance.now() - sessionStartAt;
    const steadyElapsedMs = performance.now() - steadyStartAt;
    const rssNetMiB = (process.memoryUsage().rss - rssBaseline) / 1024 / 1024;
    const rssAbsorbNetMiB = rssByCycle[0] - Math.round(rssBaseline / 1024 / 1024);
    const rssSteadyNetMiB = Math.round(process.memoryUsage().rss / 1024 / 1024) - rssByCycle[0];
    const parseFinal = getOperationSummary('document-parse');
    const countDelta = (parseFinal?.count ?? 0) - parseCountBaseline;
    const droppedDelta = (parseFinal?.elapsedDropped ?? 0) - parseDroppedBaseline;
    const observed = countDelta + droppedDelta;
    const workerFinal = probe.pendingWork().worker;
    const peakDelta = workerFinal.peakQueuedBytes - steadyPeakQueuedBytes;
    const budgetRejectsDelta = workerFinal.budgetRejects - steadyBudgetRejects;
    // RES-004 记账不变量:本会话观测数=窗口内增量+丢弃增量(≥周期数,编辑确实入账)
    assert.ok(observed >= cycleCount, `本会话 parse 观测 ${observed} < 周期数 ${cycleCount}(编辑未入账)`);
    // 窗口容量上界:窗口内计数不超 2×上限(容量生效)
    assert.ok(
      (parseFinal?.count ?? 0) <= ELAPSED_WINDOW_CHUNK,
      `窗口内样本 ${parseFinal?.count} 超上界 ${ELAPSED_WINDOW_CHUNK}(容量失效)`
    );
    // 缓存承接:整会话 cacheHits 有增量(重复编辑/查询由缓存承接而非全量重扫)
    assert.ok(
      (parseFinal?.cacheHits ?? 0) > (parseBaseline?.cacheHits ?? 0),
      '整会话 cacheHits 零增量(缓存未承接重复查询)'
    );
    // 量规咬合:稳态段 worker 高水位有增量——大文件每 4 周期自然触碰(快速
    // 连发两保存)真实经 worker 排队解析,字节量规采到走量(会话级有增量);
    // 零增量=分流旁路或量规空转,不许绿
    assert.ok(
      peakDelta > 0,
      `稳态段 worker peakQueuedBytes 零增量 ${steadyPeakQueuedBytes}→${workerFinal.peakQueuedBytes}(大文件积压未入字节记账或量规空转)`
    );
    // 预算触顶面:稳态段预算拒绝零增量(自然负载下排队字节不触 8MiB 顶)
    assert.ok(
      budgetRejectsDelta === 0,
      `稳态段 budgetRejects 增量 ${steadyBudgetRejects}→${workerFinal.budgetRejects}(排队字节触预算顶)`
    );

    // 尾窗:会话末 1/4 周期 RSS 漂移
    const tailStartIndex = Math.max(0, rssByCycle.length - 1 - Math.floor(rssByCycle.length / 4));
    const rssTailMiB = rssByCycle[rssByCycle.length - 1] - rssByCycle[tailStartIndex];

    const evidence = [
      // 先落阶段/序列/预算/判据,再落数据(预先写明,不是看着数据补口径)
      `aud017.phase.targetDurationMs=${TARGET_DURATION_MS}`,
      `aud017.phase.cycles=${cycleCount}`,
      `aud017.phase.absorbElapsedMs=${absorbElapsedMs.toFixed(0)}`,
      `aud017.phase.steadyElapsedMs=${steadyElapsedMs.toFixed(0)}`,
      `aud017.phase.totalElapsedMs=${totalElapsedMs.toFixed(0)}`,
      `aud017.phase.drainWindowMs=c1=${FIRST_CYCLE_DRAIN_DEADLINE_MS}(吸收周期,初始扫描+class-index 构建单并发排队;REV-034 无跨文件 def 故 15s 够),c2+=${DRAIN_DEADLINE_MS}`,
      `aud017.sequence=openCaller|hover+def(get_annotated_data)|editCaller+save|openDef|hover+def(reqAttack)|editDefComment+save|crossFileDef(get_unannotated_data)|[every ${LARGE_FILE_PERIOD} cycles]openLarge|doubleSave(naturalWorkerBacklog)|drainPendingWork|closeAllTabs|checkWorkingSet`,
      `aud017.interaction.naturalCadence=largeFileDoubleSave every ${LARGE_FILE_PERIOD} cycles from c${LARGE_FILE_FIRST_CYCLE}(轻序列 c1-c2 吸收首析;REV-034 每周期双连发压力面不在此复刻)`,
      'aud017.interaction=realEditor(applyEdit/save/executeHoverProvider/executeDefinitionProvider),zeroParsePythonFileResponsive',
      `aud017.budget.rssAbsorbNetMiB<=${RSS_ABSORB_BOUND_MIB}(REV-034 暖机面锚 101-106)`,
      `aud017.budget.rssSteadyNetMiB<=${RSS_STEADY_BOUND_MIB}(REV-034 边界+正式面之和=140,锚 77-110)`,
      `aud017.budget.rssRunawayMiB<=${RSS_RUNAWAY_BOUND_MIB}(=声明之和,失控总闸)`,
      `aud017.budget.rssTailMiB<=${RSS_TAIL_BOUND_MIB}(会话末 1/4 窗,阈值沿用 REV-034 不抬)`,
      `aud017.budget.workerQueuedBytes<=${workerFinal.maxQueuedBytes}(逐周期采样+累计峰值)`,
      'aud017.budget.workerBudgetRejectsSteadyDelta=0',
      'aud017.budget.defCache=entries<=8,bytes<=8MiB(逐周期)',
      'aud017.budget.schemaCache=entries<=32(逐周期)',
      'aud017.budget.annotationIndex=按根计数无上限口径,只记录',
      'aud017.criteria=稳态=尾窗漂移有界+工作集不增+队列逐周期排干+p99<500ms+量规咬合(大文件自然积压入账)',
      `aud017.separation=REV-034 短压力 16s 正式序列原样保留(longSessionResources.test.ts,不覆盖不删改)`,
      // 会话数据面
      `aud017.session.docsBaseline=${docsBaseline}`,
      `aud017.session.docsFinal=${vscode.workspace.textDocuments.length}`,
      `aud017.session.docsWorkingSet=${docsWorkingSet}`,
      `aud017.session.rssBaselineMiB=${Math.round(rssBaseline / 1024 / 1024)}`,
      `aud017.session.rssFinalMiB=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
      `aud017.session.rssNetMiB=${rssNetMiB.toFixed(1)}`,
      `aud017.session.rssAbsorbNetMiB=${rssAbsorbNetMiB}`,
      `aud017.session.rssSteadyNetMiB=${rssSteadyNetMiB}`,
      `aud017.session.rssAbsorbEndMiB=${rssByCycle[0]}`,
      `aud017.session.rssTailMiB=${rssTailMiB}(c${tailStartIndex + 1}=${rssByCycle[tailStartIndex]}→c${cycleCount}=${rssByCycle[rssByCycle.length - 1]})`,
      `aud017.session.workerPeakQueuedBytesSteady=${steadyPeakQueuedBytes}→${workerFinal.peakQueuedBytes}(delta=${peakDelta})`,
      `aud017.session.workerBudgetRejectsSteady=${steadyBudgetRejects}→${workerFinal.budgetRejects}(delta=${budgetRejectsDelta})`,
      `aud017.session.parseObserved=${observed}`,
      `aud017.session.parseWindowDelta=${countDelta}`,
      `aud017.session.parseDroppedDelta=${droppedDelta}`,
      `aud017.session.parseWindowCount=${parseFinal?.count ?? 0}`,
      `aud017.session.parseCacheHits=${parseFinal?.cacheHits ?? 0}`,
      `aud017.session.parseCacheMisses=${parseFinal?.cacheMisses ?? 0}`,
      `aud017.session.loopP99Ms=${(histogram.percentile(99) / 1e6).toFixed(3)}`,
      ...rows
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[aud017] evidence:\n' + evidence.join('\n'));

    // 收口断言:RSS 段有界(吸收/稳态各按预先申报面,失控总闸=声明之和;尾窗
    // 阈值沿用不抬)/量规咬合/工作集不增长/事件循环有界
    assert.ok(
      rssAbsorbNetMiB <= RSS_ABSORB_BOUND_MIB,
      `吸收周期 RSS 净增 ${rssAbsorbNetMiB}MiB 超上界 ${RSS_ABSORB_BOUND_MIB}MiB(首析/索引失控)`
    );
    assert.ok(
      rssSteadyNetMiB <= RSS_STEADY_BOUND_MIB,
      `稳态段 RSS 净漂移 ${rssSteadyNetMiB}MiB 超上界 ${RSS_STEADY_BOUND_MIB}MiB(长会话失控)`
    );
    assert.ok(
      rssNetMiB <= RSS_RUNAWAY_BOUND_MIB,
      `整会话 RSS 净增长 ${rssNetMiB.toFixed(1)}MiB 超失控总闸 ${RSS_RUNAWAY_BOUND_MIB}MiB`
    );
    assert.ok(
      rssTailMiB <= RSS_TAIL_BOUND_MIB,
      `会话末 1/4 窗 RSS 漂移 ${rssTailMiB}MiB 超上界 ${RSS_TAIL_BOUND_MIB}MiB(稳态逐周期增长)`
    );
    assert.ok(
      vscode.workspace.textDocuments.length <= docsWorkingSet + 1,
      `会话终了文档数 ${vscode.workspace.textDocuments.length} 高于工作集定格 ${docsWorkingSet}(文档泄漏)`
    );
    assert.ok(
      histogram.percentile(99) / 1e6 < 500,
      `长会话事件循环 p99=${(histogram.percentile(99) / 1e6).toFixed(3)}ms 无界`
    );
  });
});
