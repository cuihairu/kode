import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// IDE-ACC-012:重命名后的目标迁移验收(真实编辑器,宿主 workspace.fs.rename)。
// RenamedEntity 双段:CellMethods <onMove>(实现在 scripts/cell/RenamedEntity.py,
// 套件中途经宿主 rename API 挪到平铺 scripts/RenamedEntity.py——归属约定按
// basename 找候选,平铺形态在候选序列内)+ BaseMethods <onPing>(实现在
// scripts/base/RenamedEntity.py,留守且 ping 调 self.cell.onMove()=<onMove>
// 的引用点)。会话启动时 cell 实现在约定目录并已入索引(基线先证命中),
// 重命名后索引必须迁移到新 URI:
// ①定义列表:def→python F12 于 <onMove> 只返回新 URI,不返回旧 cell 路径;
// ②实现列表:Go to Implementations 于 <onMove> 只返回新 URI;
// ③引用列表:无重复目标——不含旧 cell 路径,且 (路径,区间) 键无重复
// (todo 验收原文的「引用列表不存在重复新旧目标」面);
// ④迁移不牵连留守面:references 于 <onMove> 仍返回 base 调用点,
// def→python F12 于 <onPing> 仍命中 base,python→def F12 从新 URI 的
// onMove 实现仍命中 def。
// 证据行落 KODE_ACC12_OUT(缺省 docs/perf/2026-10-29-acc012-rename-nav-run.txt)。

const ROOT = process.env.KODE_RENAME_ROOT;
assert.ok(ROOT, 'runTest.js --rename must set KODE_RENAME_ROOT');
const OUT_FILE = process.env.KODE_ACC12_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc012-rename-nav-run.txt');

const DEF_PATH = path.join(ROOT!, 'scripts', 'entity_defs', 'RenamedEntity.def');
const BASE_PATH = path.join(ROOT!, 'scripts', 'base', 'RenamedEntity.py');
const CELL_PATH = path.join(ROOT!, 'scripts', 'cell', 'RenamedEntity.py');
const MOVED_PATH = path.join(ROOT!, 'scripts', 'RenamedEntity.py');

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

/** (路径,区间) 键序列——重复目标检测面 */
function locationKeys(locations: vscode.Location[]): string[] {
  return locations.map(loc => `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character
    }-${loc.range.end.line}:${loc.range.end.character}`);
}

describe('IDE-ACC-012:重命名实现文件后的目标迁移(真实编辑器)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    // 夹具不变量:def+base+cell 都在约定位(重命名动作由用例本体完成)
    assert.ok(fs.existsSync(DEF_PATH), 'def 夹具缺失');
    assert.ok(fs.existsSync(BASE_PATH), 'base 实现夹具缺失');
    assert.ok(fs.existsSync(CELL_PATH), 'cell 实现夹具缺失(重命名目标缺席)');
    assert.ok(!fs.existsSync(MOVED_PATH), '平铺位已被占用(夹具形态不符)');
  });

  it('重命名 cell 实现到平铺位后:定义与实现列表只返回新 URI,引用无重复目标,留守导航不牵连', async function () {
    this.timeout(120_000);
    const defDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(DEF_PATH));
    const defLines = defDocument.getText().split('\n');
    const onMovePosition = symbolPosition(defLines, '<onMove>', 'onMove');
    const onPingPosition = symbolPosition(defLines, '<onPing>', 'onPing');

    // ①基线:重命名前 cell 实现在约定目录且已入索引(迁移面有起点可证)
    const baselineDef = await locationsAt(
      'vscode.executeDefinitionProvider', defDocument.uri, onMovePosition
    );
    assert.ok(
      baselineDef.some(loc => loc.uri.fsPath === CELL_PATH),
      `基线 def→python F12 于 <onMove> 未命中 cell 实现: ${baselineDef.map(l => l.uri.fsPath).join(',')}`
    );
    const baselineImpl = await locationsAt(
      'vscode.executeImplementationProvider', defDocument.uri, onMovePosition
    );
    assert.ok(
      baselineImpl.some(loc => loc.uri.fsPath === CELL_PATH),
      `基线实现列表于 <onMove> 未含 cell 实现: ${baselineImpl.map(l => l.uri.fsPath).join(',')}`
    );
    const baselineRefs = await locationsAt(
      'vscode.executeReferenceProvider', defDocument.uri, onMovePosition
    );
    assert.ok(
      baselineRefs.some(loc => loc.uri.fsPath === BASE_PATH),
      `基线引用于 <onMove> 未含 base 调用点: ${baselineRefs.map(l => l.uri.fsPath).join(',')}`
    );

    // ②宿主 rename API 真改路径(非编辑器外旁路;cell 文档从未打开,无脏缓冲)
    await vscode.workspace.fs.rename(
      vscode.Uri.file(CELL_PATH), vscode.Uri.file(MOVED_PATH), { overwrite: false }
    );
    assert.ok(fs.existsSync(MOVED_PATH), '重命名后新路径不在磁盘');
    assert.ok(!fs.existsSync(CELL_PATH), '重命名后旧路径仍在磁盘');

    // ③轮询迁移收敛:定义/实现只返回新 URI,引用无重复目标且留守调用点保留
    let attempts = 0;
    let defMigrated = false;
    let implMigrated = false;
    let refsClean = false;
    let refKeys: string[] = [];
    for (; attempts < 24 && !(defMigrated && implMigrated && refsClean); attempts++) {
      const defLocations = await locationsAt(
        'vscode.executeDefinitionProvider', defDocument.uri, onMovePosition
      );
      defMigrated = defLocations.some(loc => loc.uri.fsPath === MOVED_PATH)
        && !defLocations.some(loc => loc.uri.fsPath === CELL_PATH);
      const implLocations = await locationsAt(
        'vscode.executeImplementationProvider', defDocument.uri, onMovePosition
      );
      implMigrated = implLocations.some(loc => loc.uri.fsPath === MOVED_PATH)
        && !implLocations.some(loc => loc.uri.fsPath === CELL_PATH);
      const refLocations = await locationsAt(
        'vscode.executeReferenceProvider', defDocument.uri, onMovePosition
      );
      refKeys = locationKeys(refLocations);
      refsClean = refLocations.some(loc => loc.uri.fsPath === BASE_PATH)
        && !refLocations.some(loc => loc.uri.fsPath === CELL_PATH)
        && new Set(refKeys).size === refKeys.length;
      if (!(defMigrated && implMigrated && refsClean)) { await sleep(500); }
    }
    assert.ok(
      defMigrated,
      `${attempts} 次尝试后定义列表未迁移到新 URI(仍含旧路径或缺新路径)`
    );
    assert.ok(
      implMigrated,
      `${attempts} 次尝试后实现列表未迁移到新 URI(仍含旧路径或缺新路径)`
    );
    assert.ok(
      refsClean,
      `${attempts} 次尝试后引用面未收敛(留守 base 调用点丢失/仍含旧路径/存在重复目标)`
    );

    // ④留守与反向导航不牵连:<onPing> 定义仍命中 base;新 URI 的 onMove
    // 实现 python→def F12 仍命中 def(迁移不断 def↔python 双向链)
    const pingAfter = await locationsAt(
      'vscode.executeDefinitionProvider', defDocument.uri, onPingPosition
    );
    assert.ok(
      pingAfter.some(loc => loc.uri.fsPath === BASE_PATH),
      `重命名后留守面 def→python F12 于 <onPing> 未命中 base: ${pingAfter.map(l => l.uri.fsPath).join(',')}`
    );
    const movedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(MOVED_PATH));
    const movedLines = movedDocument.getText().split('\n');
    const onMoveImplPosition = symbolPosition(movedLines, 'def onMove', 'onMove');
    const reverseAfter = await locationsAt(
      'vscode.executeDefinitionProvider', movedDocument.uri, onMoveImplPosition
    );
    assert.ok(
      reverseAfter.some(loc => loc.uri.fsPath === DEF_PATH),
      '重命名后 python→def F12 从新 URI 实现未命中 def(迁移断双向链)'
    );

    const defAfter = await locationsAt(
      'vscode.executeDefinitionProvider', defDocument.uri, onMovePosition
    );
    const implAfter = await locationsAt(
      'vscode.executeImplementationProvider', defDocument.uri, onMovePosition
    );
    const evidence = [
      'acc012.baseline.defHitsCell=true',
      `acc012.baseline.defLocations=${baselineDef.length}`,
      `acc012.baseline.implLocations=${baselineImpl.length}`,
      'acc012.baseline.refHitsBase=true',
      `acc012.baseline.refLocations=${baselineRefs.length}`,
      `acc012.rename.attempts=${attempts}`,
      `acc012.after.defLocations=${defAfter.length}`,
      `acc012.after.defHitsMoved=${defAfter.some(loc => loc.uri.fsPath === MOVED_PATH)}`,
      `acc012.after.defHitsCell=${defAfter.some(loc => loc.uri.fsPath === CELL_PATH)}`,
      `acc012.after.implLocations=${implAfter.length}`,
      `acc012.after.implHitsMoved=${implAfter.some(loc => loc.uri.fsPath === MOVED_PATH)}`,
      `acc012.after.refHitsBase=${refsClean}`,
      `acc012.after.refUniqueKeys=${new Set(refKeys).size === refKeys.length}`,
      `acc012.after.pingHitsBase=${pingAfter.some(loc => loc.uri.fsPath === BASE_PATH)}`,
      `acc012.after.reverseMovedHitsDef=${reverseAfter.some(loc => loc.uri.fsPath === DEF_PATH)}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc012] evidence:\n' + evidence.join('\n'));
  });
});
