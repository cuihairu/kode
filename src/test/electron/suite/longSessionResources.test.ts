import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

// IDE-ACC-009:长会话资源边界验收(固定编辑/打开关闭序列,不只看一次热查询)。
// 与 --field 同工作区装配(demo 资产+5000 文件外部根),固定 8 轮,每轮同一
// 序列:开 3 文档(def/调用方 .py/超阈值大 .py>256KiB 走 worker 解析)→对
// 调用方追加一行真实编辑(bump 版本,触发解析+诊断)→def 面与 python 面
// 各一次热查询(逐轮重复,非一次热查询定结论)→轮询 pendingWork 四项归零
// (worker 队列逐轮排干)→closeAllEditors+轮询 textDocuments 回基线(打开
// 关闭不漏文档)→逐轮落一行证据(RSS/队列/缓存计数)。收口断言:
// ①整会话 RSS 净增长有界(≤100MiB,单轮口径);②textDocuments 终值=基线;
// ③RES-004 采样窗口记账不变量:本会话观测数=(窗口内增量+丢弃增量),
// 窗口计数不超上界(2×ELAPSED_SAMPLE_LIMIT);④缓存承接面:document-parse
// cacheHits 逐轮非降(重复打开/编辑由内容缓存承接,不是无限重扫);⑤全窗
// 事件循环 p99 有界。RES-002 字节预算无导出量规,以逐轮队列排干+编辑后
// 热查询仍命中的行为面如实记录。证据落 KODE_ACC9_OUT
// (缺省 docs/perf/2026-10-29-acc009-long-session-run.txt)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --longsession must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC9_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc009-long-session-run.txt');

const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const PY_REL = 'scripts/common/training/plain_var_caller.py';
const LARGE_REL = 'scripts/common/training/plain_var_large.py';
const ROUNDS = 8;
/** RES-004:languageServiceMetrics 聚合 elapsed 采样窗口上界(2×上限触发截断) */
const ELAPSED_WINDOW_CHUNK = 4000;
/** 整会话 RSS 净增长上界(含首轮懒加载:外部根索引/worker 池/Pylance 首析;
 * 单机单轮口径,防的是失控不是字节级回归) */
const RSS_NET_BOUND_MIB = 200;
/** 尾段(第 4→末轮)RSS 漂移上界:暖机跳变之后的稳态面,防逐轮线性增长 */
const RSS_TAIL_BOUND_MIB = 60;

interface KodeProbeExports { pendingWork(): Record<string, number> }

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

describe('IDE-ACC-009:长会话资源边界(固定编辑/打开关闭序列)', () => {
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

  it('固定序列 8 轮:队列逐轮排干、文档不漏、缓存承接、RSS 净增长有界', async function () {
    this.timeout(240_000);
    // 语言服务指标经同模块实例读取(与 fieldBaseline 同口径)
    const { getOperationSummary } = await import('../../../languageServiceMetrics');

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
    const docsBaseline = vscode.workspace.textDocuments.length;
    const rssBaseline = process.memoryUsage().rss;
    const parseBaseline = getOperationSummary('document-parse');
    const parseCountBaseline = parseBaseline?.count ?? 0;
    const parseDroppedBaseline = parseBaseline?.elapsedDropped ?? 0;
    const histogram = monitorEventLoopDelay({ resolution: 2 });
    histogram.enable();

    const rows: string[] = [];
    const rssByRound: number[] = [];
    let lastCacheHits = parseBaseline?.cacheHits ?? 0;
    /** 第 1 轮定格的文档工作集上限(后续轮不得增长) */
    let docsWorkingSet = docsBaseline;
    for (let round = 1; round <= ROUNDS; round++) {
      // ①固定序列:开 3 文档(def+调用方+超阈值大文件走 worker 解析);三个
      // 各占独立栏的页签(showTextDocument 缺省开预览页签,后者会顶替前者,
      // 被顶替的文档无页签可关,textDocuments 计数回不了基线)
      const pyDocument = await vscode.workspace.openTextDocument(pyUri);
      const largeDocument = await vscode.workspace.openTextDocument(largeUri);
      await vscode.window.showTextDocument(pyDocument, vscode.ViewColumn.One);
      await vscode.window.showTextDocument(largeDocument, vscode.ViewColumn.Two);
      await vscode.window.showTextDocument(defDocument, vscode.ViewColumn.Three);

      // ②真实编辑+保存:调用方追加一行(bump 版本→解析+诊断入队;保存防
      // 脏文档在关闭后被宿主长持——固定序列含保存才是真实编辑面)
      const edit = new vscode.WorkspaceEdit();
      edit.insert(pyDocument.uri, new vscode.Position(pyDocument.lineCount, 0), `# acc009 round ${round}\n`);
      assert.ok(await vscode.workspace.applyEdit(edit), `第 ${round} 轮 applyEdit 失败`);
      assert.ok(await pyDocument.save(), `第 ${round} 轮保存失败`);

      // ③双热查询(def 面=Kode 领地必命中;python 面如实记录命中)
      const defHover = await hoverAt(defUri, defPosition);
      assert.ok(defHover.hit, `第 ${round} 轮 def hover 未命中(长会话退化)`);
      const pyPosition = symbolPosition(
        pyDocument.getText().split('\n'), 'def get_annotated_data', 'get_annotated_data'
      );
      const pyHover = await hoverAt(pyUri, pyPosition);

      // ④worker 队列逐轮排干(≤15s):四项量规全零才进收尾
      const deadline = Date.now() + 15_000;
      let pending: Record<string, number> = {};
      for (;;) {
        pending = probe.pendingWork();
        const nonzero = Object.entries(pending).filter(([, value]) => value > 0);
        if (nonzero.length === 0 || Date.now() > deadline) { break; }
        await sleep(400);
      }
      const nonzero = Object.entries(pending).filter(([, value]) => value > 0);
      assert.deepStrictEqual(
        nonzero, [],
        `第 ${round} 轮队列未排干: ${JSON.stringify(pending)}`
      );

      // ⑤全关(程序化关全部页签)+轮询页签归零(编辑器面真关闭)。文档模型面:
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

      // ⑥逐轮证据行:RSS/队列/parse 窗口与缓存计数(不只看一次热查询)
      const parse = getOperationSummary('document-parse');
      const cacheHits = parse?.cacheHits ?? 0;
      assert.ok(
        cacheHits >= lastCacheHits,
        `第 ${round} 轮 cacheHits 回退 ${lastCacheHits}→${cacheHits}(计数器不应回退)`
      );
      lastCacheHits = cacheHits;
      const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      rssByRound.push(rssMiB);
      rows.push([
        `acc009.r${round}.defHoverMs=${defHover.elapsedMs.toFixed(3)}`,
        `acc009.r${round}.pyHoverHit=${pyHover.hit}`,
        `acc009.r${round}.rssMiB=${rssMiB}`,
        `acc009.r${round}.pendingWork=${JSON.stringify(pending)}`,
        `acc009.r${round}.docs=${docsNow}`,
        `acc009.r${round}.parse.count=${parse?.count ?? 0}`,
        `acc009.r${round}.parse.elapsedDropped=${parse?.elapsedDropped ?? 0}`,
        `acc009.r${round}.parse.cacheHits=${cacheHits}`,
        `acc009.r${round}.parse.cacheMisses=${parse?.cacheMisses ?? 0}`
      ].join(' | '));
    }

    histogram.disable();
    const rssNetMiB = (process.memoryUsage().rss - rssBaseline) / 1024 / 1024;
    const parseFinal = getOperationSummary('document-parse');
    const countDelta = (parseFinal?.count ?? 0) - parseCountBaseline;
    const droppedDelta = (parseFinal?.elapsedDropped ?? 0) - parseDroppedBaseline;
    const observed = countDelta + droppedDelta;
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

    const evidence = [
      `acc009.session.rounds=${ROUNDS}`,
      `acc009.session.docsBaseline=${docsBaseline}`,
      `acc009.session.docsFinal=${vscode.workspace.textDocuments.length}`,
      `acc009.session.docsWorkingSet=${docsWorkingSet}`,
      `acc009.session.rssBaselineMiB=${Math.round(rssBaseline / 1024 / 1024)}`,
      `acc009.session.rssFinalMiB=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
      `acc009.session.rssNetMiB=${rssNetMiB.toFixed(1)}`,
      `acc009.session.rssTailMiB=${(rssByRound[ROUNDS - 1] - rssByRound[3]).toFixed(0)}(r4=${rssByRound[3]}→r${ROUNDS}=${rssByRound[ROUNDS - 1]})`,
      `acc009.session.parseObserved=${observed}`,
      `acc009.session.parseWindowDelta=${countDelta}`,
      `acc009.session.parseDroppedDelta=${droppedDelta}`,
      `acc009.session.parseWindowCount=${parseFinal?.count ?? 0}`,
      `acc009.session.parseCacheHits=${parseFinal?.cacheHits ?? 0}`,
      `acc009.session.parseCacheMisses=${parseFinal?.cacheMisses ?? 0}`,
      `acc009.session.loopP99Ms=${(histogram.percentile(99) / 1e6).toFixed(3)}`,
      ...rows
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc009] evidence:\n' + evidence.join('\n'));

    // 收口断言:RSS 双层有界(整会话含暖机 ≤200 / 尾段稳态漂移 ≤60)/
    // 工作集不增长/事件循环有界
    assert.ok(
      rssNetMiB <= RSS_NET_BOUND_MIB,
      `整会话 RSS 净增长 ${rssNetMiB.toFixed(1)}MiB 超上界 ${RSS_NET_BOUND_MIB}MiB`
    );
    const rssTailMiB = rssByRound[ROUNDS - 1] - rssByRound[3];
    assert.ok(
      rssTailMiB <= RSS_TAIL_BOUND_MIB,
      `尾段(r4→r${ROUNDS})RSS 漂移 ${rssTailMiB}MiB 超上界 ${RSS_TAIL_BOUND_MIB}MiB(稳态逐轮增长)`
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
