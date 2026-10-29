import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

import { getFileReadTotals } from '../../../fileReadMetrics';

// IDE-ACC-003:首次事件 CodeLens 的大仓行为验收(真实编辑器)。
// 两面:①冷启动对普通文件(无事件调用)请求 CodeLens,不得打开全仓文档
// (EVT-012 后唯一全仓扫描入口是共享索引,它走 fs 读,不 openTextDocument);
// ②事件文件的首次 CodeLens 须出真实命中——回调镜「事件回调 · EV_TRAIN」与
// 监听数镜恰为「3 处监听」(夹具 1 调用方+2 监听类,计数锚定夹具内容)。
// 本套件文件名字典序先于 fieldBaseline/plainVariableHover,首例即宿主冷态。
// 证据行 KEY=VALUE 落 KODE_ACC3_OUT
// (缺省 docs/perf/2026-10-29-acc003-event-codelens-run.txt;独立于 plainVariableHover
// 的 KODE_ACC_OUT——两套件共用一个 env 会被后跑套件的 writeFileSync 覆盖)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --field must set KODE_FIELD_WORKSPACE');
const OUT_FILE = process.env.KODE_ACC3_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc003-event-codelens-run.txt');

const ORDINARY_REL = 'scripts/common/training/plain_var_caller.py';
const EVENTS_REL = 'scripts/common/training/event_caller_demo.py';
const LISTENER_REL = 'scripts/common/training/event_listener_demo.py';

interface LensLike { command?: { title?: string; command?: string } }

async function codeLensesFor(fileRel: string): Promise<{ lenses: LensLike[]; elapsedMs: number; docsOpened: number }> {
  const uri = vscode.Uri.file(path.join(WORKSPACE!, fileRel));
  const docsBefore = vscode.workspace.textDocuments.length;
  await vscode.workspace.openTextDocument(uri);
  const startedAt = performance.now();
  const lenses = await vscode.commands.executeCommand(
    'vscode.executeCodeLensProvider', uri
  ) as LensLike[];
  const elapsedMs = performance.now() - startedAt;
  const docsOpened = vscode.workspace.textDocuments.length - docsBefore;
  return { lenses, elapsedMs, docsOpened };
}

const eventLensTitles = (lenses: LensLike[]): string[] =>
  lenses
    .map(lens => lens.command?.title ?? '')
    .filter(title => title.includes('事件回调') || title.includes('处监听'));

describe('IDE-ACC-003:首次事件 CodeLens 的大仓行为(真实编辑器)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
  });

  it('冷启动普通文件:CodeLens 请求不开全仓文档、零事件镜', async function () {
    // 夹具在档(runTest field 模式生成):普通文件=ACC-001 调用方(无事件调用)
    const ordinaryPath = path.join(WORKSPACE!, ORDINARY_REL);
    assert.ok(fs.existsSync(ordinaryPath), '普通文件夹具缺失');
    const readsBefore = getFileReadTotals();

    const { lenses, elapsedMs, docsOpened } = await codeLensesFor(ORDINARY_REL);
    const readsAfter = getFileReadTotals();

    // 普通文件无事件调用:不得出任何事件面镜(早退路径不触索引)
    assert.deepStrictEqual(eventLensTitles(lenses), [], `普通文件不应出事件镜: ${JSON.stringify(lenses)}`);
    // 核心:EVT-012 后 CodeLens 路径不 openTextDocument 全仓——打开的文档数
    // 上界给到 4(请求目标自身+宿主自身行为余量),与 5000 文件大仓相差三个量级
    assert.ok(docsOpened <= 4, `CodeLens 请求打开了 ${docsOpened} 个文档(应近零)`);

    const lines = [
      `acc003.ordinary.elapsedMs=${elapsedMs.toFixed(3)}`,
      `acc003.ordinary.lensCount=${lenses.length}`,
      `acc003.ordinary.eventLensCount=${eventLensTitles(lenses).length}`,
      `acc003.ordinary.docsOpened=${docsOpened}`,
      `acc003.ordinary.textDocuments=${vscode.workspace.textDocuments.length}`,
      `acc003.ordinary.readsDelta=${readsAfter.reads - readsBefore.reads}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
    console.log('[acc003 ordinary] evidence:\n' + lines.join('\n'));
  });

  it('首次事件 CodeLens:真实命中断言(回调镜+恰 3 处监听)且不开全仓文档', async function () {
    this.timeout(120_000);
    const eventsPath = path.join(WORKSPACE!, EVENTS_REL);
    const listenerPath = path.join(WORKSPACE!, LISTENER_REL);
    assert.ok(fs.existsSync(eventsPath), '事件调用方夹具缺失');
    assert.ok(fs.existsSync(listenerPath), '事件监听方夹具缺失');

    const readsBefore = getFileReadTotals();
    const { lenses, elapsedMs, docsOpened } = await codeLensesFor(EVENTS_REL);
    const readsAfter = getFileReadTotals();
    const titles = eventLensTitles(lenses);

    // 真实命中:回调镜(夹具 on_train 经 addEvent 注册)+ 监听数镜恰 3 处
    // (调用方 1 + 监听方两个类,计数锚定夹具内容而非非空即过)
    assert.ok(
      titles.includes('事件回调 · EV_TRAIN'),
      `缺回调镜「事件回调 · EV_TRAIN」,实得: ${JSON.stringify(titles)}`
    );
    assert.ok(
      titles.includes('3 处监听'),
      `监听数镜应为「3 处监听」(1 调用方+2 监听类),实得: ${JSON.stringify(titles)}`
    );
    // 首次事件 CodeLens 即便触发共享索引首扫(大仓 5000 文件),也走 fs 读
    // 而非 openTextDocument——文档打开数仍近零
    assert.ok(docsOpened <= 4, `首次事件 CodeLens 打开了 ${docsOpened} 个文档(应近零)`);

    const lines = [
      `acc003.events.elapsedMs=${elapsedMs.toFixed(3)}`,
      `acc003.events.lensCount=${lenses.length}`,
      `acc003.events.eventLensCount=${titles.length}`,
      `acc003.events.titles=${JSON.stringify(titles)}`,
      `acc003.events.docsOpened=${docsOpened}`,
      `acc003.events.textDocuments=${vscode.workspace.textDocuments.length}`,
      `acc003.events.readsDelta=${readsAfter.reads - readsBefore.reads}`,
      `acc003.events.readsBytesDelta=${readsAfter.bytes - readsBefore.bytes}`
    ];
    fs.appendFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
    console.log('[acc003 events] evidence:\n' + lines.join('\n'));
  });
});
