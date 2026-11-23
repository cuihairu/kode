// RUST-416(旧 HR-QA-004)真 UI 线程交互验证(500 文件突发面):
// S8 纯核面与段基准量的都是流水线核(Node,无 UI);本套件补其缺失段=真编辑器
// 宿主里 500 个 .py 依序落盘的突发窗口内,真实交互面是否被冻结。两个真实面:
//  ① 真渲染器命令往返——executeCommand('setContext',...) 在扩展宿主无处理器,
//     只能落在工作台(渲染进程主线程)命令服务上执行,往返即度量 UI 线程的
//     响应间隔,冻结窗内被如实拉长;
//  ② 扩展宿主事件环延迟——monitorEventLoopDelay(与 IDE-ACC-006 同惯例),
//     另采突发前闲置基线窗作相对对照(满载宿主下绝对界会冤枉)。
// 突发写入由子进程执行(父进程=扩展宿主线程不掺 fs 活,测的才是宿主侧反应);
// 前置条件经 activate 导出的 hotReloadQueue 确定性核验(批量预览滞留 Δ≥文件
// 数,零真实发送=无外部服务依赖),不靠计时轮询猜「突发已过」。
//
// 证据行落 docs/perf/hot-reload-segment-run.txt(HRS-METRIC 行,与 RUST-414
// 同账)。断言面:不冻结=无秒级停顿(burstLoopMax<1000ms)+渲染器保持可交互
// (p99<500ms,max<1500ms);基线/burst/落潮三窗数值如实入证据,不当断言吞掉。
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import * as vscode from 'vscode';

const ROOT = process.env.KODE_HRBURST_ROOT;
assert.ok(ROOT, 'runTest.js --hrburst must set KODE_HRBURST_ROOT');
const BURST_DIR = path.join(ROOT!, 'scripts', 'entities', 'burst');
const OUT_FILE = process.env.KODE_HRBURST_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/hot-reload-segment-run.txt');

const ROUNDS = 3;
const SETTLE_MS = 2500;
const PREVIEW_DEADLINE_MS = 30_000;
const SAMPLES = 8;

interface SavePipelineQueueSnapshot {
  pending: readonly string[];
  previewHeld: readonly string[];
  wave: readonly string[];
}

interface KodeProbeExports {
  hotReloadQueue(): SavePipelineQueueSnapshot;
  pendingWork(): Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const percentile = (samples: readonly number[], p: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[index]!;
};

const loopDelayMs = (histogram: IntervalHistogram, p: number): number =>
  histogram.percentile(p) / 1e6;

/** 真渲染器命令往返:扩展宿主发命令→工作台主线程(UI 线程)执行→回执。
 * setContext 无扩展宿主侧处理器,只能落在渲染进程命令服务上,故往返真过
 * UI 线程;冻结窗内该间隔被如实拉长。挂起护栏:渲染器冻结致命令不归时
 * 如实记 3000ms(超界即失败),不无限挂死测量窗。 */
const renderRoundTripMs = async (): Promise<number> => {
  const started = performance.now();
  return Promise.race([
    vscode.commands
      .executeCommand('setContext', 'kode.hrburst.probe', started)
      .then(() => performance.now() - started),
    sleep(3000).then(() => 3000)
  ]);
};

/** 子进程写 500 个文件:内容带轮次 nonce(每轮都是真变更事件,不与发送面
 * 同内容去重口径纠缠;预览滞留零发送,lastSentByUri 恒空本就无去重)。 */
const WRITER_SOURCE = `
const fs = require('fs');
const path = require('path');
const dir = process.env.KODE_HRBURST_DIR;
const round = process.env.KODE_HRBURST_ROUND || '0';
const names = fs.readdirSync(dir).filter(name => name.endsWith('.py')).sort();
for (const name of names) {
  fs.writeFileSync(path.join(dir, name), 'class Burst:\\n    def tick(self):\\n        return ' + round + '\\n');
}
process.stdout.write('written ' + names.length + '\\n');
`;

describe('RUST-416 真 UI 线程交互验证(500 文件突发,旧 HR-QA-004)', () => {
  let probe: KodeProbeExports;
  let fileCount = 0;

  before(async function () {
    this.timeout(120_000);
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as KodeProbeExports;
    assert.ok(typeof probe.hotReloadQueue === 'function', 'activate 未返回 hotReloadQueue 量规');
    const names = fs.readdirSync(BURST_DIR).filter(name => name.endsWith('.py')).sort();
    fileCount = names.length;
    assert.ok(fileCount >= 400, `突发夹具过少:${fileCount}`);
    // 落潮等待:激活面(索引/诊断)的后台任务先排干,免得基线与突发窗混入
    // 无关负载。只判易摆动的队列字段(缓存体量类量规常驻非零不计)。
    const churny = (): number => {
      const work = probe.pendingWork() as Record<string, unknown>;
      return ((work.indexTasksQueued as number) ?? 0)
        + ((work.diagnosticsQueued as number) ?? 0)
        + ((work.diagnosticsInFlight as number) ?? 0);
    };
    const settleStart = Date.now();
    while (Date.now() - settleStart < 60_000) {
      if (churny() === 0) {
        break;
      }
      await sleep(500);
    }
    console.log(`[hrburst] activate settle ms=${Date.now() - settleStart} files=${fileCount}`);
  });

  it('500 文件突发窗内:渲染器命令往返与宿主事件环延迟均无秒级停顿,突发确入预览滞留', async function () {
    this.timeout(300_000);
    const lines: string[] = [];
    let aggBurstUi: number[] = [];
    let aggBurstUiMax = 0;
    let aggBurstLoopMax = 0;

    for (let round = 1; round <= ROUNDS; round += 1) {
      const heldBefore = probe.hotReloadQueue().previewHeld.length;

      // ①基线(突发前):闲置宿主事件环窗+真渲染器往返 8 拍,记录不作断言
      // (满载宿主基线自会抬高,相对对照留证据面)。
      const baseHistogram = monitorEventLoopDelay({ resolution: 1 });
      baseHistogram.enable();
      const base: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        base.push(await renderRoundTripMs());
        await sleep(50);
      }
      await sleep(500);
      baseHistogram.disable();
      const baseLoopP99 = loopDelayMs(baseHistogram, 99);
      const baseLoopMax = loopDelayMs(baseHistogram, 100);

      // ②突发窗:事件环监测开表,子进程写盘,宿主侧同期采渲染器往返
      const burstHistogram = monitorEventLoopDelay({ resolution: 1 });
      burstHistogram.enable();
      const burstSamples: number[] = [];
      let childDone = false;
      let writerOut = '';
      // 扩展宿主里 process.execPath=electron 二进制,须以 ELECTRON_RUN_AS_NODE
      // 起纯 node 语义子进程(同二进制,-e 直读),否则 -e 不被执行。
      const child = spawn(process.execPath, ['-e', WRITER_SOURCE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          KODE_HRBURST_DIR: BURST_DIR,
          KODE_HRBURST_ROUND: String(round)
        }
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        writerOut += chunk.toString();
      });
      const childExit = new Promise<number>(resolve => {
        child.on('error', () => resolve(-1));
        child.on('exit', code => resolve(code === null ? -1 : code));
      });
      void childExit.then(code => {
        childDone = true;
        return code;
      });

      let heldAfter = heldBefore;
      let burstDone = false;
      const deadline = Date.now() + PREVIEW_DEADLINE_MS;
      while (!burstDone && Date.now() < deadline) {
        burstSamples.push(await renderRoundTripMs());
        heldAfter = probe.hotReloadQueue().previewHeld.length;
        if (heldAfter - heldBefore >= fileCount && childDone) {
          burstDone = true;
          break;
        }
        await sleep(100);
      }
      const exitCode = await childExit;
      await sleep(SETTLE_MS);
      burstHistogram.disable();

      // ③落潮面:突发后宿主事件环窗+渲染器往返 8 拍(风暴后回落方向,
      // 与 IDE-ACC-006 同惯例)。
      const recoveryHistogram = monitorEventLoopDelay({ resolution: 1 });
      recoveryHistogram.enable();
      const recSamples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        recSamples.push(await renderRoundTripMs());
        await sleep(50);
      }
      recoveryHistogram.disable();

      const burstUiP99 = percentile(burstSamples, 0.99);
      const burstUiMax = Math.max(...burstSamples);
      const recUiP99 = percentile(recSamples, 0.99);
      const burstLoopP99 = loopDelayMs(burstHistogram, 99);
      const burstLoopMax = loopDelayMs(burstHistogram, 100);
      const recLoopP99 = loopDelayMs(recoveryHistogram, 99);
      const recLoopMax = loopDelayMs(recoveryHistogram, 100);
      const heldDelta = heldAfter - heldBefore;
      aggBurstUi = aggBurstUi.concat(burstSamples);
      aggBurstUiMax = Math.max(aggBurstUiMax, burstUiMax);
      aggBurstLoopMax = Math.max(aggBurstLoopMax, burstLoopMax);

      lines.push(
        `HRS-METRIC RUST416.r${round} files=${fileCount} heldDelta=${heldDelta} ` +
        `samples=${burstSamples.length} baseLoopP99=${baseLoopP99.toFixed(2)} baseLoopMax=${baseLoopMax.toFixed(2)} ` +
        `baseUiP50=${percentile(base, 0.5).toFixed(2)} baseUiP99=${percentile(base, 0.99).toFixed(2)} ` +
        `burstLoopP99=${burstLoopP99.toFixed(2)} burstLoopMax=${burstLoopMax.toFixed(2)} ` +
        `burstUiP50=${percentile(burstSamples, 0.5).toFixed(2)} burstUiP90=${percentile(burstSamples, 0.9).toFixed(2)} ` +
        `burstUiP99=${burstUiP99.toFixed(2)} burstUiMax=${burstUiMax.toFixed(2)} ` +
        `recLoopP99=${recLoopP99.toFixed(2)} recLoopMax=${recLoopMax.toFixed(2)} recUiP99=${recUiP99.toFixed(2)}`
      );
      // 逐轮先落证据(断言红也要留数值面,不当断言吞掉)
      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.appendFileSync(OUT_FILE, lines.join('\n') + '\n');
      lines.length = 0;
      console.log(`[hrburst] r${round} evidence appended`);
      console.log(`[hrburst] r${round} burstUiRaw=${JSON.stringify(burstSamples.map(sample => Math.round(sample)))} baseRaw=${JSON.stringify(base.map(sample => Math.round(sample)))} recRaw=${JSON.stringify(recSamples.map(sample => Math.round(sample)))}`);

      // 断言:①写盘子进程如实完成(写盘本身的硬前提);②突发确进预览滞留
      // (前置条件,确定性);③宿主事件环无秒级停顿(不冻结=无 ≥1s 单停顿);
      // ④渲染器命令往返有界(UI 线程保持可交互);⑤落潮面同有界。
      assert.ok(burstSamples.length > 0, `round ${round} 突发窗零采样`);
      assert.ok(exitCode === 0, `round ${round} 写盘子进程失败 code=${exitCode}`);
      assert.ok(
        writerOut.includes(`written ${fileCount}`),
        `round ${round} 写盘未全: ${writerOut.trim()}`
      );
      assert.ok(
        heldDelta >= fileCount,
        `突发未全进预览滞留: Δ=${heldDelta} < ${fileCount}(round ${round})`
      );
      assert.ok(
        burstLoopMax < 1000,
        `round ${round} 宿主事件环 max=${burstLoopMax.toFixed(1)}ms 应 <1000ms(无秒级停顿)`
      );
      assert.ok(
        burstUiP99 < 500,
        `round ${round} 渲染器往返 p99=${burstUiP99.toFixed(1)}ms 应 <500ms`
      );
      assert.ok(
        burstUiMax < 1500,
        `round ${round} 渲染器往返 max=${burstUiMax.toFixed(1)}ms 应 <1500ms`
      );
      assert.ok(
        recLoopMax < 1000,
        `round ${round} 落潮宿主事件环 max=${recLoopMax.toFixed(1)}ms 应 <1000ms`
      );
      assert.ok(
        recUiP99 < 500,
        `round ${round} 落潮渲染器往返 p99=${recUiP99.toFixed(1)}ms 应 <500ms`
      );
    }

    const aggBurstUiP99 = percentile(aggBurstUi, 0.99);
    lines.push(
      `HRS-METRIC RUST416.agg files=${fileCount} rounds=${ROUNDS} samples=${aggBurstUi.length} ` +
      `burstUiP99=${aggBurstUiP99.toFixed(2)} burstUiMax=${aggBurstUiMax.toFixed(2)} ` +
      `burstLoopMax=${aggBurstLoopMax.toFixed(2)}`
    );
    lines.push(
      'HRS-NOTE RUST416 真 UI 线程交互验证(500 文件突发):真编辑器宿主里 500 个 .py 依序改写' +
      '经真磁盘监视面进批量预览滞留;①真渲染器命令往返(setContext 落工作台命令服务)量 UI 线程' +
      '响应,②monitorEventLoopDelay 量扩展宿主事件环(突发前另采闲置基线窗作相对对照);' +
      '突发写入由子进程执行,前置条件经 hotReloadQueue 确定性核验(预览滞留 Δ≥文件数),' +
      '零真实发送无外部服务依赖;不冻结判据=无秒级停顿(burstLoopMax<1000ms)+渲染器保持可交互'
    );

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.appendFileSync(OUT_FILE, lines.join('\n') + '\n');
    console.log(`[hrburst] evidence:\n${lines.join('\n')}`);

    // 聚合兜底断言(三窗一致而非单窗侥幸)
    assert.ok(
      aggBurstUiP99 < 500,
      `三窗聚合渲染器往返 p99=${aggBurstUiP99.toFixed(1)}ms 应 <500ms`
    );
  });
});
