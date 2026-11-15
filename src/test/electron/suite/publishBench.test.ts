import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// RUST-022 publish 端到端:PERF-005 记 Untested 的「publish to editor」段——
// 服务层分段数字不含 UI 序列化与 provider 派发,本套件在真编辑器里量诊断从
// 「编辑落定」到「诊断集合可见」的全链时延:
//   open.publish = openTextDocument+showTextDocument 起 → 首个预期诊断可见
//   edit.publish = applyEdit 落定起 → 新版本方法名的段错配诊断可见(交替
//                  mB/mA 采样;上一版本诊断已不在集合,谓词只认新名,
//                  不存在旧名假命中)
// 等待面=onDidChangeDiagnostics 事件先到即取 + 25ms 轮询兜底(量化误差
// ≤ 轮询粒度)。诊断不出=断言红(20s 上限),不会静默装通过。证据
// PUB-METRIC/PUB-SAMPLE 行落 KODE_PUBBENCH_OUT(缺省 docs/perf/publish-run.txt)。

const ROOT = process.env.KODE_PUBBENCH_ROOT;
assert.ok(ROOT, 'runTest.js --pubbench must set KODE_PUBBENCH_ROOT');
const OUT_FILE = process.env.KODE_PUBBENCH_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/publish-run.txt');

const PY_PATH = path.join(ROOT!, 'scripts', 'base', 'PublishBenchEntity.py');
const POLL_MS = 25;
const DEADLINE_MS = 20_000;
const EDIT_ROUNDS = 6;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const mismatchAt = (method: string): ((d: vscode.Diagnostic) => boolean) =>
  // 谓词只认 `self.cell.<method> ` 前缀(locale 无关):en 文案=
  // "self.cell.mA section mismatch: ...",zh 文案="self.cell.mA 段错配:..."
  // (l10n/bundle.l10n.zh-cn.json),两种 locale 都以 self.cell.<方法名>+空格
  // 开头;方法名互斥,mA/mB 诊断不会互相假命中。
  d => d.message.includes(`self.cell.${method} `);

const dumpDiagnostics = (uri: vscode.Uri): string => {
  const all = vscode.languages.getDiagnostics(uri);
  return all.length === 0
    ? '(collection empty)'
    : all.map(d => `"${d.message.slice(0, 80)}"`.replace(/\n/g, ' ')).join(' | ');
};

/** 等待谓词诊断可见:先查现状,再事件+轮询双通道 */
const waitDiagnostic = async (
  uri: vscode.Uri,
  predicate: (d: vscode.Diagnostic) => boolean
): Promise<{ found: vscode.Diagnostic | null; waitedMs: number }> => {
  const immediate = vscode.languages.getDiagnostics(uri).find(predicate) ?? null;
  if (immediate) {
    return { found: immediate, waitedMs: 0 };
  }
  const startedAt = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const subscription = vscode.languages.onDidChangeDiagnostics(event => {
      if (event.uris.some(u => u.toString() === uri.toString())) {
        check();
      }
    });
    const timer = setInterval(() => {
      if (Date.now() - startedAt > DEADLINE_MS) {
        finish(null);
        return;
      }
      check();
    }, POLL_MS);
    const finish = (found: vscode.Diagnostic | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      subscription.dispose();
      resolve({ found, waitedMs: Date.now() - startedAt });
    };
    const check = (): void => {
      const found = vscode.languages.getDiagnostics(uri).find(predicate) ?? null;
      if (found) {
        finish(found);
      }
    };
  });
};

describe('RUST-022 publish 端到端(诊断→编辑器可见)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.ok(fs.existsSync(PY_PATH), 'PublishBenchEntity.py 夹具缺失');
  });

  it('open→首个诊断可见(任一诊断即发布面)', async function () {
    this.timeout(60_000);
    fs.writeFileSync(OUT_FILE, '');
    const uri = vscode.Uri.file(PY_PATH);
    const startedAt = Date.now();
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    // 冷开口径:def 注册表是激活后异步装载,先于装载完成的 open 不会在注册
    // 完成时补触发段错配面(实测:open 后只见 receiverNone 警告,段错配要
    // 等首个编辑事件)——open 面因此量「首个任何诊断可见」=发布管道本身;
    // 段错配专面时延由 edit.publish 各轮覆盖(注册表暖态,首编辑 142ms 可见)。
    const { found, waitedMs } = await waitDiagnostic(uri, () => true);
    assert.ok(found, `20s 内未见任何诊断发布;现 collection: ${dumpDiagnostics(uri)}`);
    const openMs = Date.now() - startedAt;
    const line = `PUB-METRIC open.publish(any) n=1 ms=${openMs} waitMs=${waitedMs} `
      + `message=${found.message.slice(0, 60)}`;
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, line + '\n');
    console.log('[pubbench] ' + line);
  });

  it('edit→新版本段错配诊断可见(交替采样)', async function () {
    this.timeout(90_000);
    const uri = vscode.Uri.file(PY_PATH);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    const samples: number[] = [];
    for (let round = 1; round <= EDIT_ROUNDS; round++) {
      // 首轮从 mB 起:初始集合已有 mA(open 测试产物),改写后等 mB=真实
      // 发布事件;此后交替,目标方法在上一轮后必然缺席(无旧名假命中)
      const method = round % 2 === 1 ? 'mB' : 'mA';
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(2, 0, 2, document.lineAt(2).text.length),
        `        self.cell.${method}()`
      );
      const applied = await vscode.workspace.applyEdit(edit);
      assert.ok(applied, `第 ${round} 轮 applyEdit 失败`);
      const { found, waitedMs } = await waitDiagnostic(uri, mismatchAt(method));
      assert.ok(
        found,
        `第 ${round} 轮 20s 内未见 ${method} 段错配诊断;现 collection: ${dumpDiagnostics(uri)}`
      );
      samples.push(waitedMs);
      fs.appendFileSync(
        OUT_FILE,
        `PUB-SAMPLE edit.publish round=${round} method=${method} waitMs=${waitedMs}\n`
      );
      console.log(`[pubbench] round=${round} method=${method} waitMs=${waitedMs}`);
      await sleep(150);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.min(sorted.length - 1, Math.ceil(0.5 * sorted.length) - 1)];
    const max = sorted[sorted.length - 1];
    const summary = `PUB-METRIC edit.publish n=${samples.length} p50=${p50}ms max=${max}ms `
      + `samples=${samples.join('/')}`;
    fs.appendFileSync(OUT_FILE, summary + '\n');
    console.log('[pubbench] ' + summary);

    // 落潮窗后集合只留最终版本(EDIT_ROUNDS 偶数 → 末轮=mA;storm 同口径)
    await sleep(2000);
    const finalMethod = EDIT_ROUNDS % 2 === 0 ? 'mA' : 'mB';
    const stale = vscode.languages.getDiagnostics(uri).filter(
      d => d.message.includes(`self.cell.`) && !d.message.includes(`self.cell.${finalMethod} `)
    );
    assert.deepStrictEqual(
      stale.map(d => d.message), [],
      '落潮后残留旧版本段错配诊断'
    );
  });
});
