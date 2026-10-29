import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// IDE-ACC-011:删除文件后的导航清理验收(真实编辑器,真实 fs 删除)。
// GoneEntity 双段:CellMethods <onGone>(实现在 scripts/cell/GoneEntity.py,
// 待删)+ BaseMethods <onPing>(实现在 scripts/base/GoneEntity.py,留守且
// ping 里调 self.cell.onGone()=<onGone> 的引用点)。会话启动时两实现都在档
// 并被索引(基线先证命中),套件中途 fs.rmSync 删除 cell 实现——watcher 的
// onDidDelete 必须把旧路径清出导航面:
// ①定义列表:def→python F12 于 <onGone> 不再返回旧 cell 路径;
// ②实现列表:Go to Implementations 于 <onGone> 不再返回旧 cell 路径
// (todo 验收原文的「定义与实现列表均不再返回旧路径」两面);
// ③清理是定向的,不牵连:references 于 <onGone> 仍返回留守 base 文件的
// 调用点;python→def F12 从留守 base 实现仍命中 <onPing>。
// 证据行落 KODE_ACC11_OUT(缺省 docs/perf/2026-10-29-acc011-delete-nav-run.txt)。

const ROOT = process.env.KODE_DEL_ROOT;
assert.ok(ROOT, 'runTest.js --delfile must set KODE_DEL_ROOT');
const OUT_FILE = process.env.KODE_ACC11_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc011-delete-nav-run.txt');

const DEF_PATH = path.join(ROOT!, 'scripts', 'entity_defs', 'GoneEntity.def');
const BASE_PATH = path.join(ROOT!, 'scripts', 'base', 'GoneEntity.py');
const CELL_PATH = path.join(ROOT!, 'scripts', 'cell', 'GoneEntity.py');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 行锚+符号双定位(与 field 系列同口径) */
function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  return new vscode.Position(line, lines[line].indexOf(symbol) + Math.floor(symbol.length / 2));
}

async function locationsAt(
  command: 'vscode.executeDefinitionProvider' | 'vscode.executeImplementationProvider'
    | 'vscode.executeReferenceProvider',
  uri: vscode.Uri, position: vscode.Position
): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand(command, uri, position);
  return (Array.isArray(raw) ? raw : []) as vscode.Location[];
}

describe('IDE-ACC-011:删除实现文件后的导航清理(真实编辑器)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    // 夹具不变量:def+两实现都在档(删除动作由用例本体完成)
    assert.ok(fs.existsSync(DEF_PATH), 'def 夹具缺失');
    assert.ok(fs.existsSync(BASE_PATH), 'base 实现夹具缺失');
    assert.ok(fs.existsSync(CELL_PATH), 'cell 实现夹具缺失(待删目标缺席)');
  });

  it('删除 cell 实现后:定义与实现列表不再返回旧路径,引用与留守导航不牵连', async function () {
    this.timeout(120_000);
    const defDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(DEF_PATH));
    const defLines = defDocument.getText().split('\n');
    const onGonePosition = symbolPosition(defLines, '<onGone>', 'onGone');
    const baseDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(BASE_PATH));
    const onPingImplPosition = symbolPosition(
      baseDocument.getText().split('\n'), 'def onPing', 'onPing'
    );

    // ①基线:删除前四个导航面都命中(证明 cell 实现已入索引,删除面有东西可清)
    const baselineDef = await locationsAt(
      'vscode.executeDefinitionProvider', defDocument.uri, onGonePosition
    );
    assert.ok(
      baselineDef.some(loc => loc.uri.fsPath === CELL_PATH),
      `基线 def→python F12 于 <onGone> 未命中 cell 实现: ${baselineDef.map(l => l.uri.fsPath).join(',')}`
    );
    const baselineImpl = await locationsAt(
      'vscode.executeImplementationProvider', defDocument.uri, onGonePosition
    );
    assert.ok(
      baselineImpl.some(loc => loc.uri.fsPath === CELL_PATH),
      `基线实现列表于 <onGone> 未含 cell 实现: ${baselineImpl.map(l => l.uri.fsPath).join(',')}`
    );
    const baselineRefs = await locationsAt(
      'vscode.executeReferenceProvider', defDocument.uri, onGonePosition
    );
    assert.ok(
      baselineRefs.some(loc => loc.uri.fsPath === BASE_PATH),
      `基线引用于 <onGone> 未含 base 调用点: ${baselineRefs.map(l => l.uri.fsPath).join(',')}`
    );
    const baselineReverse = await locationsAt(
      'vscode.executeDefinitionProvider', baseDocument.uri, onPingImplPosition
    );
    assert.ok(
      baselineReverse.some(loc => loc.uri.fsPath === DEF_PATH),
      '基线留守面 python→def F12 于 onPing 未命中 def'
    );

    // ②真实 fs 删除(非编辑器 API 旁路;cell 文档从未打开,无脏缓冲拦路)
    fs.rmSync(CELL_PATH);
    assert.ok(!fs.existsSync(CELL_PATH), '删除后旧文件仍在磁盘');

    // ③轮询清理收敛:定义与实现列表都不再返回旧路径(每次都是真 provider 调用)
    let attempts = 0;
    let defClean = false;
    let implClean = false;
    let refsKept = false;
    for (; attempts < 24 && !(defClean && implClean && refsKept); attempts++) {
      const defLocations = await locationsAt(
        'vscode.executeDefinitionProvider', defDocument.uri, onGonePosition
      );
      defClean = !defLocations.some(loc => loc.uri.fsPath === CELL_PATH);
      const implLocations = await locationsAt(
        'vscode.executeImplementationProvider', defDocument.uri, onGonePosition
      );
      implClean = !implLocations.some(loc => loc.uri.fsPath === CELL_PATH);
      const refLocations = await locationsAt(
        'vscode.executeReferenceProvider', defDocument.uri, onGonePosition
      );
      refsKept = refLocations.some(loc => loc.uri.fsPath === BASE_PATH)
        && !refLocations.some(loc => loc.uri.fsPath === CELL_PATH);
      if (!(defClean && implClean && refsKept)) { await sleep(500); }
    }
    assert.ok(
      defClean,
      `${attempts} 次尝试后定义列表仍返回旧 cell 路径(删除未清理索引)`
    );
    assert.ok(
      implClean,
      `${attempts} 次尝试后实现列表仍返回旧 cell 路径(删除未清理索引)`
    );
    assert.ok(
      refsKept,
      `${attempts} 次尝试后引用面未收敛(留守 base 调用点丢失或仍含旧路径)`
    );

    // ④留守导航不牵连:python→def F12 从 base 实现仍命中 <onPing>
    const reverseAfter = await locationsAt(
      'vscode.executeDefinitionProvider', baseDocument.uri, onPingImplPosition
    );
    assert.ok(
      reverseAfter.some(loc => loc.uri.fsPath === DEF_PATH),
      '删除 cell 实现后留守面 python→def F12 于 onPing 失效(清理牵连无辜)'
    );

    const defAfter = await locationsAt(
      'vscode.executeDefinitionProvider', defDocument.uri, onGonePosition
    );
    const implAfter = await locationsAt(
      'vscode.executeImplementationProvider', defDocument.uri, onGonePosition
    );
    const evidence = [
      'acc011.baseline.defHitsCell=true',
      `acc011.baseline.defLocations=${baselineDef.length}`,
      `acc011.baseline.implLocations=${baselineImpl.length}`,
      `acc011.baseline.refHitsBase=true`,
      `acc011.baseline.refLocations=${baselineRefs.length}`,
      `acc011.delete.attempts=${attempts}`,
      `acc011.after.defLocations=${defAfter.length}`,
      `acc011.after.defHitsCell=${defAfter.some(loc => loc.uri.fsPath === CELL_PATH)}`,
      `acc011.after.implLocations=${implAfter.length}`,
      `acc011.after.implHitsCell=${implAfter.some(loc => loc.uri.fsPath === CELL_PATH)}`,
      `acc011.after.refHitsBase=${refsKept}`,
      `acc011.after.reverseBasePingHitsDef=${reverseAfter.some(loc => loc.uri.fsPath === DEF_PATH)}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc011] evidence:\n' + evidence.join('\n'));
  });
});
