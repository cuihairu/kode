import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getFileReadTotals } from '../../../fileReadMetrics';
import { getOperationSummary } from '../../../languageServiceMetrics';

// IDE-ACC-007:hover/导航取消后的收敛验收(真实编辑器,大仓)。
// 取消梯次本身由 fieldBaseline「请求级取消路径」覆盖;本套件收口验收的
// 是取消之后的收敛面:①实际取消的请求全部有界返回且不回内容;②取消后
// 落潮窗内请求侧不再产生新读盘(请求独占任务停止);③残留任务量规请求侧
// 归零(共享扫描位 indexTasksQueued 不要求归零——它是共享面,允许在途);
// ④共享扫描在取消之后仍然存活:现场改一笔被跟踪文件,document-parse
// 计数必须前进(取消请求不得牵连后台扫描停摆)。证据行落 KODE_ACC7_OUT
// (缺省 docs/perf/2026-10-29-acc007-cancel-converge-run.txt)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --field must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC7_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc007-cancel-converge-run.txt');

const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const TOUCH_REL = 'scripts/common/training/plain_var_caller.py';

interface KodeProbeApi {
  probeHover(
    target: { file: string; line: number; character: number },
    cancelAfterMs?: number,
    preCancel?: boolean
  ): Promise<{ elapsedMs: number; cancelled: boolean; returnedHover: boolean; preview: string }>;
  probeHoverGatedCancel(target: {
    file: string;
    line: number;
    character: number;
  }): Promise<{
    gateEnteredAtMs: number;
    cancelledAtMs: number;
    settledBeforeCancel: boolean;
    elapsedMs: number;
    cancelled: boolean;
    returnedHover: boolean;
    preview: string;
  }>;
  pendingWork(): Record<string, number>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 行锚+符号双定位(与 plainVariableHover 同口径,防子串撞位) */
async function probeAt(
  probe: KodeProbeApi, relPath: string, lineNeedle: string, symbol: string,
  cancelAfterMs?: number, preCancel?: boolean
): Promise<{ elapsedMs: number; cancelled: boolean; returnedHover: boolean; preview: string }> {
  const filePath = path.join(WORKSPACE!, relPath);
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const line = lines.findIndex(text => text.includes(lineNeedle));
  assert.ok(line >= 0, `夹具缺行: ${lineNeedle}`);
  const character = lines[line].indexOf(symbol) + Math.floor(symbol.length / 2);
  return probe.probeHover({ file: filePath, line, character }, cancelAfterMs, preCancel);
}

describe('IDE-ACC-007:hover/导航取消后的收敛(真实编辑器)', () => {
  let probe: KodeProbeApi;

  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as KodeProbeApi;
    assert.ok(typeof probe.probeHover === 'function', 'activate 未返回 probeHover 探针');
    assert.ok(fs.existsSync(path.join(WORKSPACE!, DEF_REL)), 'TrainingAvatar.def 夹具缺失');
    assert.ok(fs.existsSync(path.join(WORKSPACE!, TOUCH_REL)), '触碰夹具缺失');
  });

  it('实际取消后:请求有界停止、新增 IO 有界、残留归零、共享扫描继续', async function () {
    this.timeout(120_000);
    // ①实际取消风暴:6 笔中途取消(2ms 处斩,真取消语义)+2 笔预取消,
    // 全部必须有界返回;取消的请求不得回 hover 内容
    const midCancel: Array<{ elapsedMs: number; cancelled: boolean; returnedHover: boolean; preview: string }> = [];
    for (let i = 0; i < 6; i++) {
      midCancel.push(await probeAt(probe, DEF_REL, '<reqAttack>', 'reqAttack', 2));
    }
    const preCancelled = [
      await probeAt(probe, DEF_REL, '<reqAttack>', 'reqAttack', undefined, true),
      await probeAt(probe, DEF_REL, '<reqAttack>', 'reqAttack', undefined, true)
    ];
    for (const result of [...midCancel, ...preCancelled]) {
      assert.ok(result.elapsedMs < 5000, `取消请求必须有界返回: ${result.elapsedMs}ms`);
      if (result.cancelled) {
        assert.ok(!result.returnedHover, `已取消请求不得回 hover 内容: ${result.preview}`);
      }
    }
    const cancelledCount = [...midCancel, ...preCancelled].filter(r => r.cancelled).length;
    assert.strictEqual(preCancelled.every(r => r.cancelled), true, '预取消必须报 cancelled');
    // 实际取消至少发生两次(预取消=确定性真取消:token 已取消进 provider)
    assert.ok(cancelledCount >= 2, `实际取消样本不足: ${cancelledCount}`);

    // ②取消后的新增 IO:落潮窗起点记读盘,2.5s 后复看——请求侧停止读盘
    const readsAtCancel = getFileReadTotals();
    await sleep(2500);
    const readsAfterSettle = getFileReadTotals();
    const newReads = readsAfterSettle.reads - readsAtCancel.reads;

    // ③残留任务量规:请求侧(注解/诊断/schema 冷构建)归零;共享扫描位
    // (indexTasksQueued)不设归零断言——共享面允许在途,只如实记录
    const pending = probe.pendingWork();
    const requestSide = {
      diagnosticsQueued: pending.diagnosticsQueued ?? 0,
      diagnosticsInFlight: pending.diagnosticsInFlight ?? 0,
      annotationUpdates: pending.annotationUpdates ?? 0,
      schemaColdBuilds: pending.schemaColdBuilds ?? 0
    };
    for (const [gauge, value] of Object.entries(requestSide)) {
      assert.strictEqual(value, 0, `取消落潮后请求侧量规 ${gauge} 未归零: ${value}`);
    }

    // ④共享扫描继续:取消之后现场改一笔被跟踪文件,document-parse 计数前进
    // (后台扫描未因请求取消停摆),且最终排干
    const parseCountBefore = getOperationSummary('document-parse')?.count ?? 0;
    fs.appendFileSync(path.join(WORKSPACE!, TOUCH_REL), '\n# acc007 touch: shared scan alive\n', 'utf8');
    let parseCountAfter = parseCountBefore;
    let waitedMs = 0;
    while (parseCountAfter <= parseCountBefore && waitedMs < 15_000) {
      await sleep(500);
      waitedMs += 500;
      parseCountAfter = getOperationSummary('document-parse')?.count ?? 0;
    }
    assert.ok(
      parseCountAfter > parseCountBefore,
      `取消后共享扫描未处理文件变更(document-parse ${parseCountBefore}→${parseCountAfter})`
    );
    await sleep(1500);
    const pendingFinal = probe.pendingWork();

    const evidence = [
      `acc007.cancel.probes=${midCancel.length + preCancelled.length}`,
      `acc007.cancel.cancelledCount=${cancelledCount}`,
      `acc007.cancel.maxElapsedMs=${Math.max(...[...midCancel, ...preCancelled].map(r => r.elapsedMs))}`,
      `acc007.reads.postCancelWindow=${newReads}`,
      `acc007.pending.requestSide=${JSON.stringify(requestSide)}`,
      `acc007.shared.indexTasksQueuedAtSettle=${pending.indexTasksQueued ?? 0}`,
      `acc007.shared.parseCountBefore=${parseCountBefore}`,
      `acc007.shared.parseCountAfter=${parseCountAfter}`,
      `acc007.shared.convergeMs=${waitedMs}`,
      `acc007.pendingWorkFinal=${JSON.stringify(pendingFinal)}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc007] evidence:\n' + evidence.join('\n'));
    // 取消后的新增读盘有界(请求独占任务已停;共享扫描读盘属共享面另记)
    assert.ok(newReads <= 50, `取消落潮窗新增读盘 ${newReads} 次超界`);
    // 共享扫描收尾:文件变更处理后队列排干(允许 0 或已回落)
    assert.ok(
      (pendingFinal.indexTasksQueued ?? 0) <= (pending.indexTasksQueued ?? 0),
      `共享扫描队列不升反升: ${pending.indexTasksQueued}→${pendingFinal.indexTasksQueued}`
    );
  });

  // IDE-REV-032:确定性在途取消——不再靠 2ms 竞速(cancelAfterMs=2 在热缓存
  // hover 快于定时器时根本斩不到),而是门住 provider「已过入口守卫、未出
  // 结果」的在途窗口,门内斩 token:请求确定在开始后、完成前被取消。验收
  // 四面:①取消落在在途窗口内(gateEntered≥0 且 cancel>gateEntered)且不回
  // hover 内容;②请求归属的新增 IO 在取消落潮窗内有界(请求独占任务停止);
  // ③请求侧残留量规归零;④共享扫描在取消之后继续处理文件变更。预取消样本
  // 不充抵——本用例全部样本都是在途真取消。
  it('确定性在途取消(IDE-REV-032):门内斩=开始后完成前取消,请求归属收敛', async function () {
    this.timeout(120_000);
    const OUT_FILE_REV32 = process.env.KODE_REV32_OUT
      ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-30-rev032-hover-midflight-cancel-run.txt');
    const result = await probeAtGated(probe, DEF_REL, '<reqAttack>', 'reqAttack');

    // ①取消落在在途窗口内:请求已开始(到达闸=过入口守卫)、取消时结果尚未
    // 落定(settledBeforeCancel=false 才是「完成前」的结构性证明,毫秒序只作
    // 旁证——同毫秒内先入闸后取消同样合法);放行后有界返回且不回 hover 内容
    assert.ok(result.gateEnteredAtMs >= 0, '请求未到达在途闸:开始后取消的证据缺失');
    assert.ok(
      result.cancelledAtMs >= result.gateEnteredAtMs,
      `取消早于在途闸进入: gate=${result.gateEnteredAtMs}ms cancel=${result.cancelledAtMs}ms`
    );
    assert.strictEqual(
      result.settledBeforeCancel, false,
      '取消时请求已完成:在途窗口证明失守(门未真正挡住结果)'
    );
    assert.strictEqual(result.cancelled, true, '在途取消必须报 cancelled');
    assert.ok(!result.returnedHover, `已取消请求不得回 hover 内容: ${result.preview}`);
    assert.ok(result.elapsedMs < 5000, `取消请求必须有界返回: ${result.elapsedMs}ms`);

    // ②请求归属新增 IO:取消落潮窗内请求独占任务停止读盘
    const readsAtCancel = getFileReadTotals();
    await sleep(2000);
    const readsAfterSettle = getFileReadTotals();
    const newReads = readsAfterSettle.reads - readsAtCancel.reads;

    // ③请求侧残留量规归零(共享扫描位 indexTasksQueued 不设归零断言)
    const pending = probe.pendingWork();
    const requestSide = {
      diagnosticsQueued: pending.diagnosticsQueued ?? 0,
      diagnosticsInFlight: pending.diagnosticsInFlight ?? 0,
      annotationUpdates: pending.annotationUpdates ?? 0,
      schemaColdBuilds: pending.schemaColdBuilds ?? 0
    };
    for (const [gauge, value] of Object.entries(requestSide)) {
      assert.strictEqual(value, 0, `在途取消落潮后请求侧量规 ${gauge} 未归零: ${value}`);
    }

    // ④共享扫描继续:取消后现场改一笔被跟踪文件,document-parse 前进
    const parseCountBefore = getOperationSummary('document-parse')?.count ?? 0;
    fs.appendFileSync(path.join(WORKSPACE!, TOUCH_REL), '\n# rev032 touch: shared scan alive\n', 'utf8');
    let parseCountAfter = parseCountBefore;
    let waitedMs = 0;
    while (parseCountAfter <= parseCountBefore && waitedMs < 15_000) {
      await sleep(500);
      waitedMs += 500;
      parseCountAfter = getOperationSummary('document-parse')?.count ?? 0;
    }
    assert.ok(
      parseCountAfter > parseCountBefore,
      `在途取消后共享扫描未处理文件变更(document-parse ${parseCountBefore}→${parseCountAfter})`
    );

    const evidence = [
      `rev032.gate.gateEnteredAtMs=${result.gateEnteredAtMs}`,
      `rev032.gate.cancelledAtMs=${result.cancelledAtMs}`,
      `rev032.gate.settledBeforeCancel=${result.settledBeforeCancel}`,
      `rev032.gate.elapsedMs=${result.elapsedMs}`,
      `rev032.gate.returnedHover=${result.returnedHover}`,
      `rev032.reads.postCancelWindow=${newReads}`,
      `rev032.pending.requestSide=${JSON.stringify(requestSide)}`,
      `rev032.shared.parseCountBefore=${parseCountBefore}`,
      `rev032.shared.parseCountAfter=${parseCountAfter}`,
      `rev032.shared.convergeMs=${waitedMs}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE_REV32), { recursive: true });
    fs.writeFileSync(OUT_FILE_REV32, evidence.join('\n') + '\n', 'utf8');
    console.log('[rev032] evidence:\n' + evidence.join('\n'));
    assert.ok(newReads <= 50, `在途取消落潮窗新增读盘 ${newReads} 次超界`);
  });
});

/** 行锚+符号双定位后的门内在途取消(与 probeAt 同定位口径) */
async function probeAtGated(
  probe: KodeProbeApi, relPath: string, lineNeedle: string, symbol: string
): Promise<Awaited<ReturnType<KodeProbeApi['probeHoverGatedCancel']>>> {
  const filePath = path.join(WORKSPACE!, relPath);
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const line = lines.findIndex(text => text.includes(lineNeedle));
  assert.ok(line >= 0, `夹具缺行: ${lineNeedle}`);
  const character = lines[line].indexOf(symbol) + Math.floor(symbol.length / 2);
  return probe.probeHoverGatedCancel({ file: filePath, line, character });
}
