import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

// IDE-ACC-006:连续输入后的补全与诊断验收(真实编辑器)。
// def 把 mA/mB 都声明在 BaseMethods,python 经 self.cell 调用必出「段错配」
// Warning 且消息点名被调方法——输入风暴交替改写被调方法名,风暴结束后
// 诊断集合必须只剩最终版本(点名 mB),中间版本(mA)一个不留(DIA-005
// 版本令牌 + DIA-006 时间片的端到端验收)。补全面在风暴后于 self.h 前缀
// 取 def 属性 hp;宿主延迟(monitorEventLoopDelay 风暴后窗口 p99)与
// pendingWork 量规均须回落。证据行落 KODE_ACC6_OUT
// (缺省 docs/perf/2026-10-29-acc006-storm-run.txt)。

const ROOT = process.env.KODE_STORM_ROOT;
assert.ok(ROOT, 'runTest.js --storm must set KODE_STORM_ROOT');
const OUT_FILE = process.env.KODE_ACC6_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc006-storm-run.txt');

const PY_PATH = path.join(ROOT!, 'scripts', 'base', 'StormEntity.py');
const STORM_STEPS = 12;

interface KodeProbeExports { pendingWork(): Record<string, number> }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 风暴第 step 步的全文(step 交替被调方法,后半段追加 self.h 行,末步定格最终版) */
const stormText = (step: number): string => {
  const method = step % 2 === 0 ? 'mA' : 'mB';
  const lines = ['class StormEntity:', '    def tick(self):', `        self.cell.${method}()`];
  if (step >= 6) { lines.push('        x = self.h'); }
  if (step === STORM_STEPS - 1) {
    // 最终版:被调方法定格 mB(与上一步同方法但内容仍前进一版,防「最后
    // 一步无变化不 bump 版本」的口径空转)
    lines[2] = '        self.cell.mB()  # final';
  }
  return lines.join('\n');
};

describe('IDE-ACC-006:连续输入后的补全与诊断(真实编辑器)', () => {
  let probe: KodeProbeExports;

  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    probe = extension.exports as KodeProbeExports;
    assert.ok(typeof probe.pendingWork === 'function', 'activate 未返回 pendingWork 量规');
    assert.ok(fs.existsSync(PY_PATH), 'StormEntity.py 夹具缺失');
  });

  it('输入风暴后:诊断只剩最新版本、补全命中、宿主延迟与待处理量回落', async function () {
    this.timeout(180_000);
    const uri = vscode.Uri.file(PY_PATH);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    // ①输入风暴:整文替换连打 12 版(每版 bump 一次文档版本)
    const versionBefore = document.version;
    const stormStartedAt = Date.now();
    for (let step = 0; step < STORM_STEPS; step++) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        stormText(step)
      );
      const applied = await vscode.workspace.applyEdit(edit);
      assert.ok(applied, `风暴第 ${step} 步 applyEdit 失败`);
    }
    const stormMs = Date.now() - stormStartedAt;
    const finalText = document.getText();
    assert.ok(finalText.includes('self.cell.mB()  # final'), '最终版内容不符');
    assert.ok(finalText.includes('x = self.h'), '最终版缺 self.h 行');
    // 版本前进量只作方向断言(宿主对连打整文替换的版本记账会合并/多记,
    // 两轮实测 11/13,波动属宿主口径;风暴本质=12 笔真实文档变更)
    const versionDelta = document.version - versionBefore;
    assert.ok(versionDelta >= 1, '风暴未推进文档版本');

    // ②风暴后宿主延迟窗口:从最后一笔编辑起监测,覆盖诊断收敛全程
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();

    // ③诊断收敛:轮询直到段错配诊断点名 mB(最终版本),上限 20s
    let mismatchFinal: vscode.Diagnostic | null = null;
    let waitedMs = 0;
    while (!mismatchFinal && waitedMs < 20_000) {
      const all = vscode.languages.getDiagnostics(uri);
      mismatchFinal = all.find(d => d.message.includes('self.cell.mB 段错配')) ?? null;
      if (!mismatchFinal) { await sleep(300); waitedMs += 300; }
    }
    assert.ok(mismatchFinal, `20s 内未见最终版段错配诊断(mB)`);

    // 落潮窗(诊断/索引/去抖排干)
    await sleep(2500);
    histogram.disable();
    const delayP99Ms = histogram.percentile(99) / 1e6;
    const finalDiagnostics = vscode.languages.getDiagnostics(uri);
    const stale = finalDiagnostics.filter(d => d.message.includes('mA'));
    // 只显示最新版本结果:中间版本(mA)诊断一个不留
    assert.strictEqual(
      stale.length, 0,
      `风暴结束后残留旧版本诊断: ${stale.map(d => d.message).join(' | ')}`
    );
    // 最终版段错配仍在档(不是「全没了」而是「只剩最新」)
    assert.ok(
      finalDiagnostics.some(d => d.message.includes('self.cell.mB 段错配')),
      '最终版段错配诊断丢失'
    );

    // ④补全面:风暴后于 self.h 前缀取 def 属性
    const lines = document.getText().split('\n');
    const selfHLine = lines.findIndex(text => text.includes('x = self.h'));
    assert.ok(selfHLine >= 0, '最终版缺 self.h 行(补全定位)');
    const completionRaw = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(selfHLine, lines[selfHLine].indexOf('self.h') + 'self.h'.length)
    );
    const completion = completionRaw as vscode.CompletionList;
    const labels = (completion?.items ?? []).map(item =>
      typeof item.label === 'string' ? item.label : item.label.label
    );
    assert.ok(
      labels.includes('hp'),
      `补全应含 def 属性 hp,实得: ${labels.join(',')}`
    );

    // ⑤待处理量回落:诊断/索引/去抖全排干
    const pending = probe.pendingWork();
    const nonzero = Object.entries(pending).filter(([, value]) => value > 0);
    assert.deepStrictEqual(
      nonzero, [],
      `风暴落潮后待处理量未归零: ${JSON.stringify(pending)}`
    );

    const evidence = [
      `acc006.storm.steps=${STORM_STEPS}`,
      `acc006.storm.versionDelta=${versionDelta}`,
      `acc006.storm.ms=${stormMs}`,
      `acc006.diag.convergeMs=${waitedMs}`,
      `acc006.diag.finalCount=${finalDiagnostics.length}`,
      `acc006.diag.staleMACount=${stale.length}`,
      `acc006.completion.hpPresent=${labels.includes('hp')}`,
      `acc006.completion.itemCount=${labels.length}`,
      `acc006.loop.p99Ms=${delayP99Ms.toFixed(3)}`,
      `acc006.pendingWork=${JSON.stringify(pending)}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc006] evidence:\n' + evidence.join('\n'));
    assert.ok(delayP99Ms < 100, `风暴后宿主延迟 p99=${delayP99Ms}ms 未回落`);
  });
});
