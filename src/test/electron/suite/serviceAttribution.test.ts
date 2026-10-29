import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

// IDE-ACC-008:与 Python 语言服务(Pylance)共同启用的归因验收(同机同项目)。
// 同一 --attribution 装配(与 --field 同工作区:demo 资产+5000 文件外部根)
// 双跑两面:enabled=Kode+Pylance 联合场 / disabled(KODE_FIELD_MODE=disabled,
// devPath 指空目录,扩展完全不加载)=Pylance-only 场。两面跑同一组突发请求:
// ①def 文件 hover(.def 是 Kode 独占领地——Pylance 无 .def provider,禁用面
// 必须零命中,启用面必须全命中:这批 hover 的成本只能归 Kode);
// ②python 文件 hover(Pylance 领地——两面都必须命中:Kode 在场不得挤占
// Python 服务的可用性);③宿主 RSS。单一 Kode ID:启用面断言全宿主恰一个
// cuihairu.kode-kbengine 实例(无重复装配),禁用面断言恰零(禁得干净)。
// 证据按面合并进同一文件(# enabled/# disabled 两块,后跑的一面保留先跑面),
// 跨面差值归因(dRss=Kode 宿主内存成本等)在 docs/perf 对照文档里计算,
// 本文件只落原始数。证据落 KODE_ACC8_OUT
// (缺省 docs/perf/2026-10-29-acc008-service-attribution-run.txt)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --attribution must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC8_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc008-service-attribution-run.txt');
const MODE = process.env.KODE_FIELD_MODE === 'disabled' ? 'disabled' : 'enabled';

const KODE_ID = 'cuihairu.kode-kbengine';
const PYLANCE_ID = 'ms-python.vscode-pylance';
const DEF_REL = 'scripts/entity_defs/TrainingAvatar.def';
const PY_REL = 'scripts/common/training/plain_var_caller.py';
const BURST_ROUNDS = 20;
const WARMUP_ROUNDS = 2;

const MARK_ENABLED = '# enabled face: kode + pylance';
const MARK_DISABLED = '# disabled face: pylance only';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 行锚+符号双定位(与 field 系列同口径,防子串撞位) */
function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  const character = lines[line].indexOf(symbol) + Math.floor(symbol.length / 2);
  return new vscode.Position(line, character);
}

async function hoverBurst(
  uri: vscode.Uri, position: vscode.Position
): Promise<{ hits: number; p50Ms: number; p95Ms: number; maxMs: number }> {
  for (let i = 0; i < WARMUP_ROUNDS; i++) {
    await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
  }
  const samples: number[] = [];
  let hits = 0;
  for (let i = 0; i < BURST_ROUNDS; i++) {
    const startedAt = performance.now();
    const raw = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
    samples.push(performance.now() - startedAt);
    if ((Array.isArray(raw) ? raw : []).length > 0) { hits += 1; }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { hits, p50Ms: at(50), p95Ms: at(95), maxMs: sorted[sorted.length - 1] };
}

/** 打开+前置 .py 触发 onLanguage:python,等 Pylance 激活到位(两面都必须在场)。
 * 返回 .py 文档与函数定义行锚位(后续 burst 复用)。 */
async function awaitPylance(): Promise<{ version: string; pyUri: vscode.Uri; pyPosition: vscode.Position }> {
  const pylance = vscode.extensions.getExtension(PYLANCE_ID);
  assert.ok(pylance, 'Pylance 未装配于 harness VS Code(.vscode-test/extensions)');
  const pyDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(WORKSPACE!, PY_REL))
  );
  const pyPosition = symbolPosition(
    pyDocument.getText().split('\n'), 'def get_annotated_data', 'get_annotated_data'
  );
  const deadline = Date.now() + 30_000;
  while (!pylance.isActive && Date.now() < deadline) { await sleep(250); }
  assert.ok(pylance.isActive, '30s 内 Pylance 未激活(python 语言服务缺位,归因不成立)');
  // Pylance 分析是惰性的:激活≠已出内容。前置到编辑器+轮询首个非空 python
  // hover(≤25s),把冷分析窗排除在 burst 测量外——burst 量的是稳态服务成本。
  await vscode.window.showTextDocument(pyDocument);
  let warmMs = 0;
  for (; warmMs < 25_000; warmMs += 500) {
    const raw = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider', pyDocument.uri, pyPosition
    );
    if ((Array.isArray(raw) ? raw : []).length > 0) { break; }
    await sleep(500);
  }
  assert.ok(
    warmMs < 25_000,
    '25s 内 Pylance 未产出任何 python hover 内容(python 面未被服务,归因不成立)'
  );
  return {
    version: pylance.packageJSON.version ?? '(unknown)',
    pyUri: pyDocument.uri,
    pyPosition
  };
}

/** 双面合并落盘:后跑的一面保留先跑面的块(固定 enabled 在前) */
function mergeEvidence(mode: 'enabled' | 'disabled', lines: string[]): void {
  let enabledBlock: string[] = [];
  let disabledBlock: string[] = [];
  if (fs.existsSync(OUT_FILE)) {
    const text = fs.readFileSync(OUT_FILE, 'utf8');
    const enabledAt = text.indexOf(MARK_ENABLED);
    const disabledAt = text.indexOf(MARK_DISABLED);
    if (enabledAt >= 0 && disabledAt > enabledAt) {
      enabledBlock = text.slice(enabledAt + MARK_ENABLED.length, disabledAt).trim().split('\n');
      disabledBlock = text.slice(disabledAt + MARK_DISABLED.length).trim().split('\n');
    }
  }
  if (mode === 'enabled') { enabledBlock = lines; } else { disabledBlock = lines; }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    [MARK_ENABLED, ...enabledBlock, '', MARK_DISABLED, ...disabledBlock, ''].join('\n'),
    'utf8'
  );
  console.log(`[acc008 ${mode}] evidence merged into ${OUT_FILE}`);
}

describe('IDE-ACC-008:与 Python 语言服务共同启用(启用/禁用归因,同机同项目)', () => {
  before(() => {
    assert.ok(fs.existsSync(path.join(WORKSPACE!, DEF_REL)), 'TrainingAvatar.def 夹具缺失');
    assert.ok(fs.existsSync(path.join(WORKSPACE!, PY_REL)), 'plain_var_caller.py 夹具缺失');
  });

  it('启用面:单一 Kode ID+Pylance 同场,def 面 Kode 全命中、python 面仍被服务', async function () {
    if (MODE !== 'enabled') { this.skip(); }
    this.timeout(120_000);
    // 单一 Kode ID:全宿主恰一个实例(无 dev/marketplace 双装配,无重复注册)
    const kodeInstances = vscode.extensions.all.filter(e => e.id === KODE_ID).length;
    assert.strictEqual(kodeInstances, 1, `Kode 扩展实例数应为 1,实得 ${kodeInstances}(重复装配)`);
    const extension = vscode.extensions.getExtension(KODE_ID);
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();

    const pylance = await awaitPylance();
    const defDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(WORKSPACE!, DEF_REL))
    );
    const defPosition = symbolPosition(defDocument.getText().split('\n'), '<reqAttack>', 'reqAttack');
    const defBurst = await hoverBurst(defDocument.uri, defPosition);
    const pyBurst = await hoverBurst(pylance.pyUri, pylance.pyPosition);
    // def 面=Kode 独占领地:联合场必须全命中(20/20)
    assert.strictEqual(defBurst.hits, BURST_ROUNDS, `def hover 命中 ${defBurst.hits}/${BURST_ROUNDS}`);
    // python 面=Pylance 领地:Kode 在场不得挤占其可用性(20/20)
    assert.strictEqual(pyBurst.hits, BURST_ROUNDS, `python hover 命中 ${pyBurst.hits}/${BURST_ROUNDS}`);

    mergeEvidence('enabled', [
      `acc008.mode=enabled`,
      `acc008.kode.instances=${kodeInstances}`,
      `acc008.kode.version=${extension.packageJSON.version ?? '(unknown)'}`,
      `acc008.pylance.active=true`,
      `acc008.pylance.version=${pylance.version}`,
      `acc008.host.rssMiB=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
      `acc008.defBurst.hit=${defBurst.hits}/${BURST_ROUNDS}`,
      `acc008.defBurst.p50Ms=${defBurst.p50Ms.toFixed(3)}`,
      `acc008.defBurst.p95Ms=${defBurst.p95Ms.toFixed(3)}`,
      `acc008.defBurst.maxMs=${defBurst.maxMs.toFixed(3)}`,
      `acc008.pyBurst.hit=${pyBurst.hits}/${BURST_ROUNDS}`,
      `acc008.pyBurst.p50Ms=${pyBurst.p50Ms.toFixed(3)}`,
      `acc008.pyBurst.p95Ms=${pyBurst.p95Ms.toFixed(3)}`,
      `acc008.pyBurst.maxMs=${pyBurst.maxMs.toFixed(3)}`
    ]);
  });

  it('禁用面:Kode 恰零实例,def 面零命中(Kode 领地裸)、python 面仍被 Pylance 服务', async function () {
    if (MODE !== 'disabled') { this.skip(); }
    this.timeout(120_000);
    // 禁得干净:全宿主零 Kode 实例(devPath 已指空目录)
    const kodeInstances = vscode.extensions.all.filter(e => e.id === KODE_ID).length;
    assert.strictEqual(kodeInstances, 0, `禁用面 Kode 实例数应为 0,实得 ${kodeInstances}`);
    assert.ok(!vscode.extensions.getExtension(KODE_ID), '禁用面不应存在 Kode 扩展句柄');

    const pylance = await awaitPylance();
    const defDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(WORKSPACE!, DEF_REL))
    );
    const defPosition = symbolPosition(defDocument.getText().split('\n'), '<reqAttack>', 'reqAttack');
    const defBurst = await hoverBurst(defDocument.uri, defPosition);
    const pyBurst = await hoverBurst(pylance.pyUri, pylance.pyPosition);
    // def 面零命中=归因锚:这批 hover 在启用面的命中只能来自 Kode
    assert.strictEqual(defBurst.hits, 0, `def hover 在 Pylance-only 场命中 ${defBurst.hits}(归因锚失效)`);
    // python 面=Pylance 单独服务仍在(两套服务可分离)
    assert.strictEqual(pyBurst.hits, BURST_ROUNDS, `python hover 命中 ${pyBurst.hits}/${BURST_ROUNDS}`);

    mergeEvidence('disabled', [
      `acc008.mode=disabled`,
      `acc008.kode.instances=${kodeInstances}`,
      `acc008.pylance.active=true`,
      `acc008.pylance.version=${pylance.version}`,
      `acc008.host.rssMiB=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
      `acc008.defBurst.hit=${defBurst.hits}/${BURST_ROUNDS}`,
      `acc008.defBurst.p50Ms=${defBurst.p50Ms.toFixed(3)}`,
      `acc008.defBurst.p95Ms=${defBurst.p95Ms.toFixed(3)}`,
      `acc008.defBurst.maxMs=${defBurst.maxMs.toFixed(3)}`,
      `acc008.pyBurst.hit=${pyBurst.hits}/${BURST_ROUNDS}`,
      `acc008.pyBurst.p50Ms=${pyBurst.p50Ms.toFixed(3)}`,
      `acc008.pyBurst.p95Ms=${pyBurst.p95Ms.toFixed(3)}`,
      `acc008.pyBurst.maxMs=${pyBurst.maxMs.toFixed(3)}`
    ]);
  });
});
