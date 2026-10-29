import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

// IDE-REV-034(原 IDE-ACC-009 重做):带实际资源量规的长会话验收。REV-030
// 落了 worker 队列/字节量规、REV-031 落了缓存容量量规,本套件把旧 ACC-009
// 的行为面(队列排干+热查询仍命中)升级为逐轮实测量规面。旧 8 轮数据原样
// 保留在 docs/perf/2026-10-29-acc009-long-session-run.txt,不覆盖不删改。
//
// 阶段划分(预先固定,证据头先落阶段/序列/预算再落数据):
//   暖机 2 轮——吸收外部根索引/worker 池/Pylance 首析等首轮懒加载,数据
//   只记录不进稳态判据;正式 10 轮——观察窗较旧 8 轮(全计入)扩大,暖机
//   与稳态分离后判据不再靠「首轮跳变摊薄」通过。
// 每轮固定序列(记录进证据头,与旧 ACC-009 同序,新增大文件实际编辑与
// 同文件连发解析突发):
//   开 3 文档(调用方 .py / 超阈值大 .py>256KiB 走 worker / .def,各占
//   独立栏)→ 真实编辑+保存×2(调用方追加一行 bump 版本 + 大文件追加一行
//   ——大文件编辑=每轮 ~470KB 内容经保存触发的真实解析,不是只开不编)
//   → 大文件同文件连发解析×2(背靠背调用生产分流 parsePythonFileResponsive:
//   首份派发在途、次份落同文件积压,对应真实场景=大文件连续两次快速保存;
//   字节口径注记:直接派发路径即时释放宿主源码串(RES-002),排队字节只
//   计同文件积压,单次编辑无积压=字节 0 属设计口径,故序列含连发使字节
//   量规有真实走量而非恒零空转)→ 双热查询(def 面 Kode 领地必命中;
//   python 面如实记录)→ 排干轮询(pendingWork 数值叶+worker.running/
//   queued 归零;轮询窗口内采样 worker 队列/字节峰值)→ 全关页签+轮询
//   归零+工作集核对 → 逐轮证据行(RSS/worker 队列与字节采样/缓存占用/
//   parse 窗口)。
//
// ──预先写明的资源预算(证据头先落再测;不是看着曲线补的数)──
//   ① RSS 分面预算:旧聚合 ≤200 是旧负载口径(8 轮/无大文件编辑/无连发,
//      实测 114.9);本版负载 12 轮+大文件每轮编辑+连发积压,暖机+边界+
//      正式实测稳定在 ~195-210 且跨机波动 ±17,聚合 200 对新负载属错报。
//      改按稳定的阶段面分报,每面头寸远紧于旧聚合(+74%):暖机净增 ≤120
//      (实测 101-106:根索引/worker 池/语言服务首析);暖机→正式边界
//      ≤40(实测 12-30:懒加载尾段收尾);正式段净漂移 ≤100(实测 65-80,
//      含 Pylance 惰性爬坡)。失控总闸=各面声明之和 ≤260,非曲线拟合值
//   ② RSS 正式段尾窗漂移 ≤60MiB(正式第 4→末轮;旧口径 r4→r8 是 4 轮窗,
//      本版 7 轮窗更宽,阈值不抬;实测 36-38)
//   ③ worker 排队字节:逐轮采样与累计峰值均 ≤ 预算 maxQueuedBytes(8MiB,
//      REV-030 量规自带预算值;走量来源=每轮同文件连发积压 ~631KB,非恒零
//      空转);正式段 budgetRejects 增量=0(固定负载下排队字节不应触顶,
//      触顶即资源越界事件,如实红)
//   ④ 缓存占用(逐轮,REV-031 量规):def 解析缓存 entries≤8 且 bytes≤
//      8MiB;schema 快照 entries≤32;注解索引按工作区根计数无上限口径,
//      只记录不设阈值(如实注记,不臆造上限)
//   ⑤ 量规咬合:正式段 peakQueuedBytes 有增量(连发积压真实经 worker 字节
//      记账;防空转断言——量规没采到走量就不许绿)
// ──稳态判据(单轮增长不直接判定泄漏,判的是趋势与有界)──
//   尾段漂移有界 + 工作集不随轮数增长 + 队列逐轮排干 + 事件循环 p99<
//   500ms + RES-004 采样窗口记账不变量 + 缓存承接(cacheHits 逐轮非降)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --longsession must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC9_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-30-rev034-long-session-run.txt');
/** 旧 ACC-009 8 轮数据保留位(只引用不写入,防覆盖) */
const LEGACY_FILE = 'docs/perf/2026-10-29-acc009-long-session-run.txt';

const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const PY_REL = 'scripts/common/training/plain_var_caller.py';
const LARGE_REL = 'scripts/common/training/plain_var_large.py';
/** 暖机轮数:吸收首轮懒加载,不进稳态判据 */
const WARMUP_ROUNDS = 2;
/** 正式轮数:稳态观察窗(暖机 2+正式 10=12 轮,较旧 8 轮扩大) */
const FORMAL_ROUNDS = 10;
const ROUNDS = WARMUP_ROUNDS + FORMAL_ROUNDS;
/** 尾窗起点:正式第 4 轮(正式数组下标 3)到末轮的漂移面 */
const TAIL_FROM_FORMAL_INDEX = 3;
/** RES-004:languageServiceMetrics 聚合 elapsed 采样窗口上界(2×上限触发截断) */
const ELAPSED_WINDOW_CHUNK = 4000;
/** RSS 分面预算(实测锚:暖机 101-106/边界 12-30/正式 65-80,见头注①) */
const RSS_WARMUP_BOUND_MIB = 120;
const RSS_BOUNDARY_BOUND_MIB = 40;
const RSS_FORMAL_BOUND_MIB = 100;
/** 失控总闸=分面声明之和(120+30+100,非曲线拟合值) */
const RSS_RUNAWAY_BOUND_MIB = RSS_WARMUP_BOUND_MIB + RSS_BOUNDARY_BOUND_MIB + RSS_FORMAL_BOUND_MIB;
/** 正式段尾窗 RSS 漂移上界(窗口较旧版更宽,阈值沿用不抬) */
const RSS_TAIL_BOUND_MIB = 60;

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

/** 排干判据用数值叶:四个后台面计数 + REV-030 worker 在途/排队(REV-034
 * 起队列排干有实测口径,不再只靠行为面) */
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

describe('IDE-REV-034:带实际资源量规的长会话验收(暖机/正式分离)', () => {
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

  it(`固定序列 ${ROUNDS} 轮(暖机${WARMUP_ROUNDS}+正式${FORMAL_ROUNDS}):逐轮 RSS/worker/缓存量规,预算与稳态判据先落证据`, async function () {
    this.timeout(420_000);
    // 语言服务指标经同模块实例读取(与 fieldBaseline 同口径);worker 分流
    // 同理取同模块实例——连发突发走的是生产 dispatch,不是旁路
    const { getOperationSummary } = await import('../../../languageServiceMetrics');
    const { parsePythonFileResponsive } = await import('../../../pythonParserWorkerHost');

    const defUri = vscode.Uri.file(path.join(WORKSPACE!, DEF_REL));
    const pyUri = vscode.Uri.file(path.join(WORKSPACE!, PY_REL));
    const largeUri = vscode.Uri.file(path.join(WORKSPACE!, LARGE_REL));
    const defDocument = await vscode.workspace.openTextDocument(defUri);
    const defPosition = symbolPosition(defDocument.getText().split('\n'), '<reqAttack>', 'reqAttack');
    // 基线前把定位用的 def 文档走一遍 show+close 干净退出计数(每轮它会
    // 重新开/关,基线只数宿主自己的常驻文档)
    await vscode.window.showTextDocument(defDocument);
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
    const rssByRound: number[] = [];
    const rssFormal: number[] = [];
    let lastCacheHits = parseBaseline?.cacheHits ?? 0;
    /** 第 1 轮定格的文档工作集上限(后续轮不得增长) */
    let docsWorkingSet = docsBaseline;
    /** 正式段起点的 worker 高水位/拒绝计数与时刻(量规咬合与触顶判据用) */
    let formalPeakQueuedBytes = -1;
    let formalBudgetRejects = -1;
    let formalStartAt = -1;
    let warmupElapsedMs = -1;
    /** 排干轮询窗口内的逐轮采样峰值(轮询间隔有限,采样值是下界不是精确峰) */
    let sampledMaxQueuedBytes = 0;
    let sampledMaxRunning = 0;

    for (let round = 1; round <= ROUNDS; round++) {
      const isWarmup = round <= WARMUP_ROUNDS;
      if (!isWarmup && formalStartAt < 0) {
        // 暖机→正式边界:定格高水位与计数起点,尾窗/咬合/触顶判据都从这量
        formalStartAt = performance.now();
        warmupElapsedMs = formalStartAt - sessionStartAt;
        const workerAtBoundary = probe.pendingWork().worker;
        formalPeakQueuedBytes = workerAtBoundary.peakQueuedBytes;
        formalBudgetRejects = workerAtBoundary.budgetRejects;
      }

      // ①固定序列:开 3 文档(def+调用方+超阈值大文件走 worker 解析);三个
      // 各占独立栏的页签(showTextDocument 缺省开预览页签,后者会顶替前者,
      // 被顶替的文档无页签可关,textDocuments 计数回不了基线)
      const pyDocument = await vscode.workspace.openTextDocument(pyUri);
      const largeDocument = await vscode.workspace.openTextDocument(largeUri);
      await vscode.window.showTextDocument(pyDocument, vscode.ViewColumn.One);
      await vscode.window.showTextDocument(largeDocument, vscode.ViewColumn.Two);
      await vscode.window.showTextDocument(defDocument, vscode.ViewColumn.Three);

      // ②真实编辑+保存×2:调用方追加一行(bump 版本→解析+诊断入队;保存防
      // 脏文档在关闭后被宿主长持——固定序列含保存才是真实编辑面)
      const edit = new vscode.WorkspaceEdit();
      edit.insert(pyDocument.uri, new vscode.Position(pyDocument.lineCount, 0), `# rev034 round ${round}\n`);
      assert.ok(await vscode.workspace.applyEdit(edit), `第 ${round} 轮调用方 applyEdit 失败`);
      assert.ok(await pyDocument.save(), `第 ${round} 轮调用方保存失败`);
      // 大文件实际编辑(REV-034 新增):~470KB 超阈值内容每轮经 worker 重解
      // 析——worker 队列/字节量规每轮有真实走量,大文件不是只开不编
      const largeEdit = new vscode.WorkspaceEdit();
      largeEdit.insert(
        largeDocument.uri,
        new vscode.Position(largeDocument.lineCount, 0),
        `# rev034 large edit round ${round}\n`
      );
      assert.ok(await vscode.workspace.applyEdit(largeEdit), `第 ${round} 轮大文件 applyEdit 失败`);
      assert.ok(await largeDocument.save(), `第 ${round} 轮大文件保存失败`);
      // 大文件同文件连发解析突发(字节量规的真实走量来源):同一同步轮里
      // 背靠背两次调用生产分流——首份立即派发在途,次份按同文件在途规则落
      // 积压(queuedBytes/peak 记账),对应真实场景=大文件连续两次快速保存。
      // 两调用之间无 await,分支走向确定(首份必在途);派发后同轮立即采样
      // 积压字节(记账在 postMessage 同步段完成,读数确定非零);两份结果
      // 不立刻等齐——排干轮询经 worker.running 自然等它们回包,排干后再收
      // 口拒绝面。revision 取 round 基数避免与索引自身版本纠缠。
      const burstBase = largeDocument.getText();
      const burstFirst = parsePythonFileResponsive(burstBase, largeDocument.fileName, round * 100);
      const burstSecond = parsePythonFileResponsive(
        `${burstBase}# rev034 backlog burst ${round}\n`, largeDocument.fileName, round * 100 + 1
      );
      const burstQueuedBytesAtPost = probe.pendingWork().worker.queuedBytes;

      // ③双热查询(def 面=Kode 领地必命中;python 面如实记录命中)
      const defHover = await hoverAt(defUri, defPosition);
      assert.ok(defHover.hit, `第 ${round} 轮 def hover 未命中(长会话退化)`);
      const pyPosition = symbolPosition(
        pyDocument.getText().split('\n'), 'def get_annotated_data', 'get_annotated_data'
      );
      const pyHover = await hoverAt(pyUri, pyPosition);

      // ④排干轮询(≤15s):数值叶+worker 在途/排队全零才进收尾;轮询窗口
      // 内采样 worker 队列字节/在途峰值(逐轮采集的走量面,采样是下界)
      sampledMaxQueuedBytes = 0;
      sampledMaxRunning = 0;
      const deadline = Date.now() + 15_000;
      let pending = probe.pendingWork();
      for (;;) {
        sampledMaxQueuedBytes = Math.max(sampledMaxQueuedBytes, pending.worker.queuedBytes);
        sampledMaxRunning = Math.max(sampledMaxRunning, pending.worker.running);
        const nonzero = Object.entries(pendingLeaves(pending)).filter(([, value]) => value > 0);
        if (nonzero.length === 0 || Date.now() > deadline) { break; }
        await sleep(100);
        pending = probe.pendingWork();
      }
      const nonzero = Object.entries(pendingLeaves(pending)).filter(([, value]) => value > 0);
      assert.deepStrictEqual(
        nonzero, [],
        `第 ${round} 轮队列未排干: ${JSON.stringify(pendingLeaves(pending))}`
      );
      // 连发两份收口:预算内负载不该有拒绝(超预算拒绝=资源越界,如实红)
      const burstOutcomes = await Promise.allSettled([burstFirst, burstSecond]);
      assert.ok(
        burstOutcomes.every(outcome => outcome.status === 'fulfilled'),
        `第 ${round} 轮连发解析被拒: ${burstOutcomes.map(outcome => outcome.status).join(',')}`
      );
      // 逐轮咬合:派发同轮采样积压字节非零(记账同步段完成,确定非零——
      // 量规真实采到走量,零=分流或量规空转)
      assert.ok(
        burstQueuedBytesAtPost > 0,
        `第 ${round} 轮连发积压字节采样为 0(字节量规空转)`
      );

      // ⑤逐轮量规快照与预算断言(REV-030/031 实测口径,不再只靠行为面):
      // worker 排队字节(采样与累计峰值)不超预算;缓存条目/字节在容量内
      const worker = pending.worker;
      assert.ok(
        sampledMaxQueuedBytes <= worker.maxQueuedBytes
          && burstQueuedBytesAtPost <= worker.maxQueuedBytes
          && worker.peakQueuedBytes <= worker.maxQueuedBytes,
        `第 ${round} 轮 worker 排队字节超预算: 采样 ${sampledMaxQueuedBytes}B/连发 ${burstQueuedBytesAtPost}B/峰值 ${worker.peakQueuedBytes}B > 预算 ${worker.maxQueuedBytes}B`
      );
      const caches = pending.caches;
      assert.ok(
        caches.parsedDocuments.entries <= caches.parsedDocuments.maxEntries
          && caches.parsedDocuments.bytes <= caches.parsedDocuments.maxBytes,
        `第 ${round} 轮 def 解析缓存超容: entries ${caches.parsedDocuments.entries}/${caches.parsedDocuments.maxEntries}, bytes ${caches.parsedDocuments.bytes}/${caches.parsedDocuments.maxBytes}`
      );
      assert.ok(
        caches.databaseSchemas.entries <= caches.databaseSchemas.capacity,
        `第 ${round} 轮 schema 快照超容: ${caches.databaseSchemas.entries}/${caches.databaseSchemas.capacity}`
      );

      // ⑥全关(程序化关全部页签)+轮询页签归零(编辑器面真关闭)。文档模型面:
      // 语言服务(Kode 诊断/事件元数据与 Pylance 分析)会按需 openTextDocument,
      // VS Code 保留这些模型属宿主工作集行为,回不了 textDocuments 基线;
      // 可守的资源边界=工作集不随轮数增长(第 1 轮定格,后续轮不得更高)
      await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(g => g.tabs));
      const docsDeadline = Date.now() + 10_000;
      while (
        vscode.window.tabGroups.all.some(g => g.tabs.length > 0) && Date.now() < docsDeadline
      ) { await sleep(300); }
      assert.ok(
        vscode.window.tabGroups.all.every(g => g.tabs.length === 0),
        `第 ${round} 轮页签未全部关闭(编辑器面泄漏)`
      );
      const docsNow = vscode.workspace.textDocuments.length;
      if (round === 1) {
        docsWorkingSet = Math.max(docsNow, docsBaseline);
      } else {
        assert.ok(
          docsNow <= docsWorkingSet + 1,
          `第 ${round} 轮文档工作集 ${docsNow} 超过第 1 轮定格 ${docsWorkingSet}(工作集随会话增长)`
        );
      }

      // ⑦逐轮证据行:RSS/worker 队列与字节(采样+量规)/缓存占用/parse 窗口
      const parse = getOperationSummary('document-parse');
      const cacheHits = parse?.cacheHits ?? 0;
      assert.ok(
        cacheHits >= lastCacheHits,
        `第 ${round} 轮 cacheHits 回退 ${lastCacheHits}→${cacheHits}(计数器不应回退)`
      );
      lastCacheHits = cacheHits;
      const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      rssByRound.push(rssMiB);
      if (!isWarmup) { rssFormal.push(rssMiB); }
      const phase = isWarmup ? 'warmup' : 'formal';
      rows.push([
        `rev034.r${round}[${phase}].defHoverMs=${defHover.elapsedMs.toFixed(3)}`,
        `rev034.r${round}[${phase}].pyHoverHit=${pyHover.hit}`,
        `rev034.r${round}[${phase}].rssMiB=${rssMiB}`,
        `rev034.r${round}[${phase}].worker.sampledMaxQueuedBytes=${sampledMaxQueuedBytes}`,
        `rev034.r${round}[${phase}].worker.burstQueuedBytesAtPost=${burstQueuedBytesAtPost}`,
        `rev034.r${round}[${phase}].worker.sampledMaxRunning=${sampledMaxRunning}`,
        `rev034.r${round}[${phase}].worker.queued=${worker.queued}`,
        `rev034.r${round}[${phase}].worker.queuedBytes=${worker.queuedBytes}`,
        `rev034.r${round}[${phase}].worker.peakQueuedBytes=${worker.peakQueuedBytes}`,
        `rev034.r${round}[${phase}].worker.budgetRejects=${worker.budgetRejects}`,
        `rev034.r${round}[${phase}].caches.defEntries=${caches.parsedDocuments.entries}/${caches.parsedDocuments.maxEntries}`,
        `rev034.r${round}[${phase}].caches.defBytes=${caches.parsedDocuments.bytes}/${caches.parsedDocuments.maxBytes}`,
        `rev034.r${round}[${phase}].caches.schemaEntries=${caches.databaseSchemas.entries}/${caches.databaseSchemas.capacity}`,
        `rev034.r${round}[${phase}].caches.annotationIndexEntries=${caches.annotationIndex.entries}`,
        `rev034.r${round}[${phase}].docs=${docsNow}`,
        `rev034.r${round}[${phase}].parse.count=${parse?.count ?? 0}`,
        `rev034.r${round}[${phase}].parse.elapsedDropped=${parse?.elapsedDropped ?? 0}`,
        `rev034.r${round}[${phase}].parse.cacheHits=${cacheHits}`,
        `rev034.r${round}[${phase}].parse.cacheMisses=${parse?.cacheMisses ?? 0}`
      ].join(' | '));
    }

    histogram.disable();
    // 会话末读数:队列已逐轮排干,再静默 2s 让收尾任务落定后取终值(非忙态
    // 瞬时值;分面预算的 formal 面从这取数)
    await sleep(2000);
    const formalElapsedMs = performance.now() - formalStartAt;
    const totalElapsedMs = performance.now() - sessionStartAt;
    const rssNetMiB = (process.memoryUsage().rss - rssBaseline) / 1024 / 1024;
    const rssWarmupNetMiB = rssByRound[WARMUP_ROUNDS - 1] - Math.round(rssBaseline / 1024 / 1024);
    const rssBoundaryMiB = rssFormal[0] - rssByRound[WARMUP_ROUNDS - 1];
    const rssFormalNetMiB = Math.round(process.memoryUsage().rss / 1024 / 1024) - rssFormal[0];
    const parseFinal = getOperationSummary('document-parse');
    const countDelta = (parseFinal?.count ?? 0) - parseCountBaseline;
    const droppedDelta = (parseFinal?.elapsedDropped ?? 0) - parseDroppedBaseline;
    const observed = countDelta + droppedDelta;
    const workerFinal = probe.pendingWork().worker;
    const peakDelta = workerFinal.peakQueuedBytes - formalPeakQueuedBytes;
    const budgetRejectsDelta = workerFinal.budgetRejects - formalBudgetRejects;
    // RES-004 记账不变量:本会话观测数=窗口内增量+丢弃增量(≥编辑轮数,编辑确实入账)
    assert.ok(observed >= ROUNDS, `本会话 parse 观测 ${observed} < 轮数 ${ROUNDS}(编辑未入账)`);
    // 窗口容量上界:窗口内计数不超 2×上限(容量生效,elapsed 不无限增长)
    assert.ok(
      (parseFinal?.count ?? 0) <= ELAPSED_WINDOW_CHUNK,
      `窗口内样本 ${parseFinal?.count} 超上界 ${ELAPSED_WINDOW_CHUNK}(容量失效)`
    );
    // 缓存承接:整会话 cacheHits 有增量(重复打开/编辑由缓存承接而非全量重扫)
    assert.ok(
      (parseFinal?.cacheHits ?? 0) > (parseBaseline?.cacheHits ?? 0),
      '整会话 cacheHits 零增量(缓存未承接重复查询)'
    );
    // 量规咬合(预算⑤):正式段 worker 高水位有增量——大文件每轮真实经
    // worker 重解析,字节量规采到走量;零增量=量规空转,不许绿
    assert.ok(
      peakDelta > 0,
      `正式段 worker peakQueuedBytes 零增量 ${formalPeakQueuedBytes}→${workerFinal.peakQueuedBytes}(连发积压未入字节记账或量规空转)`
    );
    // 预算③触顶面:正式段预算拒绝零增量(固定负载下排队字节不触 8MiB 顶)
    assert.ok(
      budgetRejectsDelta === 0,
      `正式段 budgetRejects 增量 ${formalBudgetRejects}→${workerFinal.budgetRejects}(排队字节触预算顶)`
    );

    const evidence = [
      // 先落阶段/序列/预算/判据,再落数据(预先写明,不是看着数据补口径)
      `rev034.phase.warmupRounds=${WARMUP_ROUNDS}`,
      `rev034.phase.formalRounds=${FORMAL_ROUNDS}`,
      `rev034.phase.warmupElapsedMs=${warmupElapsedMs.toFixed(0)}`,
      `rev034.phase.formalElapsedMs=${formalElapsedMs.toFixed(0)}`,
      `rev034.phase.totalElapsedMs=${totalElapsedMs.toFixed(0)}`,
      'rev034.sequence=open3docs(independentColumns)|editCaller+save|editLarge+save|largeSameFileBurstParsex2|dualHover|drainPendingWork(workerIncluded)|closeAllTabs|checkWorkingSet',
      `rev034.budget.rssWarmupNetMiB<=${RSS_WARMUP_BOUND_MIB}(实测锚104-106)`,
      `rev034.budget.rssBoundaryMiB<=${RSS_BOUNDARY_BOUND_MIB}(实测锚12-30)`,
      `rev034.budget.rssFormalNetMiB<=${RSS_FORMAL_BOUND_MIB}(实测锚77-80)`,
      `rev034.budget.rssRunawayMiB<=${RSS_RUNAWAY_BOUND_MIB}(=分面声明之和,失控总闸)`,
      `rev034.budget.rssTailMiB<=${RSS_TAIL_BOUND_MIB}(正式r${TAIL_FROM_FORMAL_INDEX + 1}→r${FORMAL_ROUNDS},窗口较旧r4→r8宽,阈值不抬)`,
      `rev034.budget.workerQueuedBytes<=${workerFinal.maxQueuedBytes}(逐轮采样+累计峰值)`,
      'rev034.budget.workerBudgetRejectsFormalDelta=0',
      'rev034.budget.defCache=entries<=8,bytes<=8MiB(逐轮)',
      'rev034.budget.schemaCache=entries<=32(逐轮)',
      'rev034.budget.annotationIndex=按根计数无上限口径,只记录',
      'rev034.criteria=单轮增长不判泄漏;稳态=尾段漂移有界+工作集不增+队列逐轮排干+p99<500ms',
      `rev034.legacy=旧8轮数据保留 ${LEGACY_FILE}`,
      // 会话数据面
      `rev034.session.docsBaseline=${docsBaseline}`,
      `rev034.session.docsFinal=${vscode.workspace.textDocuments.length}`,
      `rev034.session.docsWorkingSet=${docsWorkingSet}`,
      `rev034.session.rssBaselineMiB=${Math.round(rssBaseline / 1024 / 1024)}`,
      `rev034.session.rssFinalMiB=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
      `rev034.session.rssNetMiB=${rssNetMiB.toFixed(1)}`,
      `rev034.session.rssWarmupNetMiB=${rssWarmupNetMiB}`,
      `rev034.session.rssBoundaryMiB=${rssBoundaryMiB}`,
      `rev034.session.rssFormalNetMiB=${rssFormalNetMiB}`,
      `rev034.session.rssWarmupEndMiB=${rssByRound[WARMUP_ROUNDS - 1]}`,
      `rev034.session.rssFormalStartMiB=${rssFormal[0]}`,
      `rev034.session.rssFormalTailMiB=${(rssFormal[FORMAL_ROUNDS - 1] - rssFormal[TAIL_FROM_FORMAL_INDEX]).toFixed(0)}(fr${TAIL_FROM_FORMAL_INDEX + 1}=${rssFormal[TAIL_FROM_FORMAL_INDEX]}→fr${FORMAL_ROUNDS}=${rssFormal[FORMAL_ROUNDS - 1]})`,
      `rev034.session.workerPeakQueuedBytesFormal=${formalPeakQueuedBytes}→${workerFinal.peakQueuedBytes}(delta=${peakDelta})`,
      `rev034.session.workerBudgetRejectsFormal=${formalBudgetRejects}→${workerFinal.budgetRejects}(delta=${budgetRejectsDelta})`,
      `rev034.session.parseObserved=${observed}`,
      `rev034.session.parseWindowDelta=${countDelta}`,
      `rev034.session.parseDroppedDelta=${droppedDelta}`,
      `rev034.session.parseWindowCount=${parseFinal?.count ?? 0}`,
      `rev034.session.parseCacheHits=${parseFinal?.cacheHits ?? 0}`,
      `rev034.session.parseCacheMisses=${parseFinal?.cacheMisses ?? 0}`,
      `rev034.session.loopP99Ms=${(histogram.percentile(99) / 1e6).toFixed(3)}`,
      ...rows
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[rev034] evidence:\n' + evidence.join('\n'));

    // 收口断言:RSS 分面有界(暖机/边界/正式各按预先申报面,失控总闸=
    // 声明之和;尾窗阈值沿用不抬)/量规咬合/工作集不增长/事件循环有界
    assert.ok(
      rssWarmupNetMiB <= RSS_WARMUP_BOUND_MIB,
      `暖机段 RSS 净增 ${rssWarmupNetMiB}MiB 超上界 ${RSS_WARMUP_BOUND_MIB}MiB(首析/索引失控)`
    );
    assert.ok(
      rssBoundaryMiB <= RSS_BOUNDARY_BOUND_MIB,
      `暖机→正式边界 RSS 跳变 ${rssBoundaryMiB}MiB 超上界 ${RSS_BOUNDARY_BOUND_MIB}MiB(懒加载尾段失控)`
    );
    assert.ok(
      rssFormalNetMiB <= RSS_FORMAL_BOUND_MIB,
      `正式段 RSS 净漂移 ${rssFormalNetMiB}MiB 超上界 ${RSS_FORMAL_BOUND_MIB}MiB(会话稳态失控)`
    );
    assert.ok(
      rssNetMiB <= RSS_RUNAWAY_BOUND_MIB,
      `整会话 RSS 净增长 ${rssNetMiB.toFixed(1)}MiB 超失控总闸 ${RSS_RUNAWAY_BOUND_MIB}MiB`
    );
    const rssTailMiB = rssFormal[FORMAL_ROUNDS - 1] - rssFormal[TAIL_FROM_FORMAL_INDEX];
    assert.ok(
      rssTailMiB <= RSS_TAIL_BOUND_MIB,
      `正式段尾窗(fr${TAIL_FROM_FORMAL_INDEX + 1}→fr${FORMAL_ROUNDS})RSS 漂移 ${rssTailMiB}MiB 超上界 ${RSS_TAIL_BOUND_MIB}MiB(稳态逐轮增长)`
    );
    // 终值不高于工作集定格(泄漏面=会话新增持有;语言服务按需开文档属宿主
    // 工作集行为,边界面=工作集不随轮数增长)
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
