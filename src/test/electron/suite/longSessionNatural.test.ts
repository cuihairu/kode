import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

import {
  drainablePendingWork,
  type PendingWorkSnapshot
} from '../../../pendingWorkDrain';

// IDE-AUD-017:把短资源压力与长会话验收分开。REV-034 的 16 秒正式序列
// (docs/perf/2026-10-30-rev034-long-session-run.txt)保留为短压力证据;
// 本套件另跑一场「自然编辑长会话」——预设持续时长、拟真编辑序列(逐行
// 插入=打字粒度的真实编辑事件,不是手调 parser 分流),观察 worker/缓存/
// RSS 趋势面。
//
// ──预先写明的口径(证据头先落再测;不是看着曲线补的数)──
//   时长  ≥240s(4 分钟,短压力正式段的 ~14 倍);
//   编辑  ≥120 笔真实单行插入(打字粒度 applyEdit,跨 ≥6 文档轮换,
//         含 >256KiB worker 通道大文件),间隔 1.5s≈自然节奏,穿插
//         hover/definition 查询与页签开关;
//   采样  每 5s 一帧:RSS / 请求侧在途(排干口径,IDE-AUD-019 面) /
//         worker 队列与字节 / 缓存容量 / parse 计数;
//   预算  ①整场 RSS 净增 ≤150MiB(实测锚:长会话稳态漂移 25-40);
//         ②尾四分之一窗(最后 60s)RSS 漂移 ≤50MiB(稳态不爬坡);
//         ③收口请求侧在途/排队=0(排干口径,缓存容量不要求归零);
//         ④正式段 budgetRejects 增量=0(排队字节触顶=资源越界,如实红);
//         ⑤worker 队列字节逐帧 ≤ 预算 maxQueuedBytes(量规自带预算);
//   记录  事件循环 p99 与宿主负载逐帧落证据(共享机争用如实注记,
//         不设门槛——资源预算判 RSS/队列/排干,时延门槛归 --final 双指标)。
// 证据落 KODE_AUD17_OUT(缺省 docs/perf/2026-11-05-aud017-long-natural-run.txt)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --longnatural must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_AUD17_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-11-05-aud017-long-natural-run.txt');

/** 预设持续时长(不含暖机;暖机单独 20s) */
const SESSION_MS = 240_000;
const WARMUP_MS = 20_000;
const EDIT_INTERVAL_MS = 1_500;
const SAMPLE_INTERVAL_MS = 5_000;
const MIN_EDITS = 120;
/** 大文件(>256KiB worker 通道)在文档池中的位置(轮换第 3 个文档) */
const LARGE_DOC_INDEX = 2;
const RSS_NET_BOUND_MIB = 150;
const RSS_TAIL_BOUND_MIB = 50;

const LARGE_REL = 'scripts/common/training/plain_var_large.py';
const PY_REL = 'scripts/common/training/plain_var_caller.py';
const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';

interface SampleFrame {
  atMs: number;
  rssMiB: number;
  busy: Record<string, number>;
  workerQueued: number;
  workerQueuedBytes: number;
  /** 容量量规真实形态(审核发现修复:此前声明为 number 与量规不符)。 */
  caches: {
    parsedDocuments: { entries: number; maxEntries: number; bytes: number; maxBytes: number };
    databaseSchemas: { entries: number; capacity: number };
    annotationIndex: { entries: number; ttlMs: number };
  };
  load1: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const readLoad1 = (): number => {
  try {
    return Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  } catch {
    return Number.NaN;
  }
};

const rssMiB = (): number => process.memoryUsage().rss / (1024 * 1024);

describe('IDE-AUD-017:自然编辑长会话资源边界(与 16s 短压力分开)', () => {
  let probe: { pendingWork(): PendingWorkSnapshot };

  before(async function (this: Mocha.Context) {
    this.timeout(60_000);
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

  it('预设时长自然编辑序列:RSS/worker/缓存趋势有界,收口排干', async function () {
    this.timeout((SESSION_MS + WARMUP_MS + 120_000)); // 时长预算+收口余量
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();

    // 文档池:6 份真实工作区文档,轮换编辑(py 小文件×4、worker 大文件、def)
    const poolUris: vscode.Uri[] = [PY_REL, DEF_REL, LARGE_REL].map(rel => vscode.Uri.file(path.join(WORKSPACE!, rel)));
    const extraPy = ['scripts/common/training/plain_var_large_annotated.py'];
    for (const rel of extraPy) {
      poolUris.push(vscode.Uri.file(path.join(WORKSPACE!, rel)));
    }
    // 再补两份小 py(临时新文件=真实 fs 创建,走 watcher 进索引,不是旁路)
    for (let i = 0; i < 2; i++) {
      const rel = `scripts/common/training/natural_${i}.py`;
      fs.writeFileSync(path.join(WORKSPACE!, rel), `# IDE-AUD-017 natural session document ${i}\nclass Natural${i}:\n    seed = ${i}\n`, 'utf8');
      poolUris.push(vscode.Uri.file(path.join(WORKSPACE!, rel)));
    }

    const opened: vscode.TextDocument[] = [];
    for (const uri of poolUris) {
      opened.push(await vscode.workspace.openTextDocument(uri));
    }
    await vscode.window.showTextDocument(opened[0], vscode.ViewColumn.One);

    const startedAt = Date.now();
    const frames: SampleFrame[] = [];
    let edits = 0;
    let queries = 0;
    const budgetRejectsStart = probe.pendingWork().worker.budgetRejects;
    const warmupDeadline = startedAt + WARMUP_MS;
    const deadline = startedAt + WARMUP_MS + SESSION_MS;
    let nextEditAt = startedAt + 2_000;
    let nextSampleAt = startedAt + SAMPLE_INTERVAL_MS;
    let docCursor = 0;

    const sample = (): void => {
      const pending = probe.pendingWork();
      frames.push({
        atMs: Date.now() - startedAt,
        rssMiB: rssMiB(),
        busy: drainablePendingWork(pending),
        workerQueued: pending.worker.queued,
        workerQueuedBytes: pending.worker.queuedBytes,
        caches: { ...pending.caches },
        load1: readLoad1()
      });
    };

    // 拟真编辑:光标移到文档中部一行,插入一行(打字粒度)→ 隔笔保存
    const naturalEdit = async (): Promise<void> => {
      docCursor = (docCursor + 1) % opened.length;
      const document = opened[docCursor];
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true
      });
      const line = Math.min(document.lineCount - 1, Math.max(1, Math.floor(document.lineCount / 2)));
      const prefix = document.uri.fsPath.endsWith('.def') ? '  ' : '    ';
      const insertion = document.uri.fsPath.endsWith('.def')
        ? `${prefix}<natural_pad_${edits} />\n`
        : `${prefix}def natural_pad_${edits}(self):\n${prefix}    return ${edits}\n`;
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, '活动编辑器缺位(自然编辑序列中断)');
      await editor.edit(builder => {
        builder.insert(new vscode.Position(line, 0), insertion);
      });
      edits += 1;
      if (edits % 4 === 0) {
        await document.save();
      }
    };

    // 穿插查询:轮换 hover/definition(请求独占任务与共享扫描同场)
    const naturalQuery = async (): Promise<void> => {
      const document = opened[queries % opened.length];
      const position = new vscode.Position(Math.max(1, Math.floor(document.lineCount / 3)), 4);
      if (queries % 2 === 0) {
        await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position);
      } else {
        await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
      }
      queries += 1;
    };

    // 主循环:暖机 → 正式观察窗(编辑/查询/采样全部自然节奏驱动)
    while (Date.now() < deadline) {
      const now = Date.now();
      if (now >= nextEditAt) {
        await naturalEdit();
        if (edits % 3 === 0) {
          await naturalQuery();
        }
        nextEditAt = now + EDIT_INTERVAL_MS;
      }
      if (now >= nextSampleAt) {
        sample();
        nextSampleAt = now + SAMPLE_INTERVAL_MS;
      }
      if (Date.now() < warmupDeadline) {
        await sleep(500);
      } else {
        await sleep(200);
      }
    }
    sample();

    // 收口:页签关闭+排干轮询(90s 上限,共享机高负载下仍可排干的证据窗)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    let drained = false;
    for (let attempt = 0; attempt < 90 && !drained; attempt++) {
      drained = Object.keys(drainablePendingWork(probe.pendingWork())).length === 0;
      if (!drained) {
        await sleep(1_000);
      }
    }
    const finalFrame = probe.pendingWork();
    const busyFinal = drainablePendingWork(finalFrame);
    delay.disable();

    // ──证据与预算核对──
    const formal = frames.filter(f => f.atMs >= WARMUP_MS);
    assert.ok(formal.length >= 20, `采样帧不足(正式段 ${formal.length} 帧,预算 ≥20)`);
    assert.ok(edits >= MIN_EDITS, `自然编辑笔数 ${edits} < 预设 ${MIN_EDITS}`);
    const sessionMs = Date.now() - startedAt;
    assert.ok(sessionMs >= SESSION_MS + WARMUP_MS, `会话时长 ${sessionMs}ms 未达预设 ${SESSION_MS + WARMUP_MS}ms`);

    const rssSeries = formal.map(f => f.rssMiB);
    const netGrowth = rssSeries[rssSeries.length - 1] - rssSeries[0];
    const tailStartIdx = Math.floor(formal.length * 0.75);
    const tailGrowth = rssSeries[rssSeries.length - 1] - rssSeries[tailStartIdx];
    const maxQueuedBytes = formal.map(f => f.workerQueuedBytes);
    const budgetRejectsDelta = finalFrame.worker.budgetRejects - budgetRejectsStart;
    const p99Ms = delay.percentile(99) / 1e6;

    const evidence: string[] = [];
    evidence.push('# IDE-AUD-017 自然编辑长会话趋势报告(与 REV-034 16s 短压力分开)');
    evidence.push(`aud017.startedAt=${new Date(startedAt).toISOString()}`);
    evidence.push(`aud017.sessionMs=${sessionMs} (preset warmup ${WARMUP_MS} + session ${SESSION_MS})`);
    evidence.push(`aud017.edits=${edits} (preset >=${MIN_EDITS}, typing-granularity insertions across ${opened.length} documents, large worker-path doc at pool index ${LARGE_DOC_INDEX})`);
    evidence.push(`aud017.queries=${queries} (hover/definition interleave)`);
    evidence.push(`aud017.frames=${formal.length} (sample interval ${SAMPLE_INTERVAL_MS}ms)`);
    evidence.push(`aud017.rss.startMiB=${rssSeries[0].toFixed(1)}`);
    evidence.push(`aud017.rss.endMiB=${rssSeries[rssSeries.length - 1].toFixed(1)}`);
    evidence.push(`aud017.rss.netGrowthMiB=${netGrowth.toFixed(1)} (bound <=${RSS_NET_BOUND_MIB})`);
    evidence.push(`aud017.rss.tailQuarterGrowthMiB=${tailGrowth.toFixed(1)} (bound <=${RSS_TAIL_BOUND_MIB})`);
    evidence.push(`aud017.rss.series=${rssSeries.map(v => v.toFixed(1)).join(',')}`);
    evidence.push(`aud017.worker.queuedBytesMax=${Math.max(...maxQueuedBytes)} (gauge budget maxQueuedBytes=${finalFrame.worker.maxQueuedBytes})`);
    evidence.push(`aud017.worker.budgetRejectsDelta=${budgetRejectsDelta} (bound 0)`);
    evidence.push(`aud017.caches.first=${JSON.stringify(formal[0].caches)}`);
    evidence.push(`aud017.caches.last=${JSON.stringify(formal[formal.length - 1].caches)} (容量面只报趋势,不要求归零)`);
    evidence.push(`aud017.eventLoop.p99Ms=${p99Ms.toFixed(3)} (记录面,不设门槛;时延门槛归 --final 双指标)`);
    evidence.push(`aud017.hostLoadAvg.first=${formal[0].load1} last=${formal[formal.length - 1].load1} (共享机争用如实注记)`);
    evidence.push(`aud017.drainFinal=${JSON.stringify(busyFinal)} (bound: empty; caches capacity excluded per AUD-019)`);
    for (const frame of formal) {
      evidence.push(
        `aud017.frame.atMs=${frame.atMs.toFixed(0)} rssMiB=${frame.rssMiB.toFixed(1)} ` +
        `busy=${JSON.stringify(frame.busy)} workerQueued=${frame.workerQueued} ` +
        `workerQueuedBytes=${frame.workerQueuedBytes} caches=${JSON.stringify(frame.caches)} load1=${frame.load1}`
      );
    }
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[aud017] evidence:\n' + evidence.slice(0, 25).join('\n'));

    // 预算判定(证据头已先落口径)
    assert.ok(netGrowth <= RSS_NET_BOUND_MIB, `整场 RSS 净增 ${netGrowth.toFixed(1)}MiB 超预算 ${RSS_NET_BOUND_MIB}MiB`);
    assert.ok(tailGrowth <= RSS_TAIL_BOUND_MIB, `尾四分之一窗 RSS 漂移 ${tailGrowth.toFixed(1)}MiB 超预算 ${RSS_TAIL_BOUND_MIB}MiB`);
    assert.ok(Math.max(...maxQueuedBytes) <= finalFrame.worker.maxQueuedBytes, `worker 排队字节峰值越量规预算(maxQueuedBytes=${finalFrame.worker.maxQueuedBytes})`);
    assert.ok(budgetRejectsDelta === 0, `正式段 budgetRejects 增量 ${budgetRejectsDelta}(排队字节触顶=资源越界)`);
    assert.ok(
      Object.keys(busyFinal).length === 0,
      `收口请求侧在途/排队未归零(缓存容量面不要求归零): ${JSON.stringify(busyFinal)}`
    );
  });
});
