import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// IDE-ACC-004:多根同名实体跳转验收(真实编辑器,双 folder 工作区)。
// A/B 两根各注册同名实体 TwinEntity,但 def 段(A=BaseMethods/B=CellMethods)、
// 形参(A=1×UINT16/B=2×STRING)与实现落点(A=base/B=cell)全不同——根配对
// (IDE-IDX-003 调用文件根优先)若退化成最后注册者覆盖,三个断言面会立即
// 互相矛盾。三面逐根验收:目标(F12 落点)、签名(hover 内 def 形参)、
// hover 标注本身——全部属于发起查询的那一根。
// 证据行 KEY=VALUE 落 KODE_ACC4_OUT
// (缺省 docs/perf/2026-10-29-acc004-multiroot-nav-run.txt)。

const ROOT_A = process.env.KODE_MULTIROOT_A;
const ROOT_B = process.env.KODE_MULTIROOT_B;
assert.ok(ROOT_A && ROOT_B, 'runTest.js --multiroot must set KODE_MULTIROOT_A/B');
const OUT_FILE = process.env.KODE_ACC4_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc004-multiroot-nav-run.txt');

interface RootSpec {
  label: 'A' | 'B';
  root: string;
  /** def→python F12 的落点目录(def 段决定:BaseMethods→base,CellMethods→cell) */
  implDir: 'base' | 'cell';
  /** 本根 def 段名(hover 标注直接点名;对方根不含) */
  sectionToken: string;
  /** 本根签名独有片段(解析到内建类型:A 的 1×UINT16→arg1: int,B 的
   *  2×STRING→arg2: str——arg2 只有 2 形参的 B 根才有) */
  sigToken: string;
  /** 对方根签名/标注独有片段(出现即串根) */
  otherToken: string;
}

const ROOTS: RootSpec[] = [
  { label: 'A', root: ROOT_A!, implDir: 'base', sectionToken: 'BaseMethods', sigToken: 'arg1: int', otherToken: 'str' },
  { label: 'B', root: ROOT_B!, implDir: 'cell', sectionToken: 'CellMethods', sigToken: 'arg2: str', otherToken: 'int' }
];

/** 打开文件并返回「行含 needle 的行号与该行内 symbol 首字符列」 */
async function openAt(fileRelUnderRoot: string, root: string, needle: string, symbol: string)
  : Promise<{ uri: vscode.Uri; line: number; character: number }> {
  const uri = vscode.Uri.file(path.join(root, fileRelUnderRoot));
  const document = await vscode.workspace.openTextDocument(uri);
  const lines = document.getText().split('\n');
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `${fileRelUnderRoot} 缺行: ${needle}`);
  const character = lines[line].indexOf(symbol);
  assert.ok(character >= 0, `${fileRelUnderRoot}:${line} 缺符号 ${symbol}`);
  return { uri, line, character };
}

const hoverText = (raw: unknown): string => {
  const hover = raw as vscode.Hover | undefined;
  if (!hover) { return ''; }
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  return contents
    .map(item => (item as vscode.MarkdownString).value ?? String(item))
    .join('\n');
};

describe('IDE-ACC-004:多根同名实体跳转(真实编辑器,根归属三面)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders?.length, 2, '双根工作区未打开');
  });

  for (const spec of ROOTS) {
    const otherRoot = spec.label === 'A' ? ROOT_B! : ROOT_A!;

    it(`根${spec.label}:def→python F12 落本根 ${spec.implDir}/TwinEntity.py`, async function () {
      this.timeout(60_000);
      const { uri, line, character } = await openAt(
        path.join('scripts', 'entity_defs', 'TwinEntity.def'), spec.root, '<onPing>', 'onPing'
      );
      const raw = await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider', uri, new vscode.Position(line, character)
      );
      const locations = (Array.isArray(raw) ? raw : []) as vscode.Location[];
      assert.ok(locations.length > 0, 'def 方法 F12 无落点');
      const target = locations[0];
      const expected = path.join(spec.root, 'scripts', spec.implDir, 'TwinEntity.py');
      assert.strictEqual(
        target.uri.fsPath, expected,
        `根${spec.label} def F12 应落本根 ${spec.implDir},实落 ${target.uri.fsPath}`
      );
      assert.ok(
        !target.uri.fsPath.startsWith(otherRoot),
        `根${spec.label} def F12 串到对方根: ${target.uri.fsPath}`
      );
      assert.ok(fs.existsSync(target.uri.fsPath), '落点文件磁盘不存在');
      // 落点行是 python def onPing 声明行
      const targetText = fs.readFileSync(target.uri.fsPath, 'utf8').split('\n')[target.range.start.line];
      assert.ok(targetText.includes('def onPing'), `落点行不是 def onPing: ${targetText}`);
      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.appendFileSync(OUT_FILE,
        `acc004.root${spec.label}.defToPython=${path.relative(spec.root, target.uri.fsPath)}:${target.range.start.line}\n`,
        'utf8');
    });

    it(`根${spec.label}:python→def F12 落本根 TwinEntity.def 的 <onPing>`, async function () {
      this.timeout(60_000);
      const { uri, line, character } = await openAt(
        path.join('scripts', spec.implDir, 'TwinEntity.py'), spec.root, 'def onPing', 'onPing'
      );
      const raw = await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider', uri, new vscode.Position(line, character)
      );
      const locations = (Array.isArray(raw) ? raw : []) as vscode.Location[];
      assert.ok(locations.length > 0, 'python def 行 F12 无落点');
      const target = locations[0];
      const expectedDef = path.join(spec.root, 'scripts', 'entity_defs', 'TwinEntity.def');
      assert.strictEqual(
        target.uri.fsPath, expectedDef,
        `根${spec.label} python F12 应落本根 def,实落 ${target.uri.fsPath}`
      );
      assert.ok(
        !target.uri.fsPath.startsWith(otherRoot),
        `根${spec.label} python F12 串到对方根: ${target.uri.fsPath}`
      );
      const defLines = fs.readFileSync(expectedDef, 'utf8').split('\n');
      const targetLine = defLines[target.range.start.line] ?? '';
      assert.ok(targetLine.includes('<onPing>'), `def 落点行不含 <onPing>: ${targetLine}`);
      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.appendFileSync(OUT_FILE,
        `acc004.root${spec.label}.pythonToDef=scripts/entity_defs/TwinEntity.def:${target.range.start.line}\n`,
        'utf8');
    });

    it(`根${spec.label}:hover 标注与签名属于本根(${spec.sectionToken}·${spec.sigToken})`, async function () {
      this.timeout(60_000);
      const { uri, line, character } = await openAt(
        path.join('scripts', spec.implDir, 'TwinEntity.py'), spec.root, 'def onPing', 'onPing'
      );
      const raw = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider', uri, new vscode.Position(line, character)
      );
      const hovers = (Array.isArray(raw) ? raw : []) as vscode.Hover[];
      const text = hovers.map(hoverText).join('\n');
      assert.ok(text.length > 0, 'python def 行无 hover');
      assert.ok(
        text.includes(spec.sectionToken),
        `根${spec.label} hover 应标注本根 def 段 ${spec.sectionToken}: ${text.replace(/\n/g, ' ')}`
      );
      assert.ok(
        text.includes(spec.sigToken),
        `根${spec.label} hover 签名应含本根形参形态 ${spec.sigToken}: ${text.replace(/\n/g, ' ')}`
      );
      assert.ok(
        !text.includes(spec.otherToken),
        `根${spec.label} hover 串到对方根签名(${spec.otherToken}): ${text.replace(/\n/g, ' ')}`
      );
      // hover 标注本身须声明这是实体 def 声明的方法(且实体名正确)
      assert.ok(text.includes('TwinEntity'), 'hover 标注缺实体名 TwinEntity');

      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.appendFileSync(OUT_FILE, [
        `acc004.root${spec.label}.section=${spec.sectionToken}`,
        `acc004.root${spec.label}.sigToken=${spec.sigToken}`,
        `acc004.root${spec.label}.hoverHasOtherToken=${text.includes(spec.otherToken)}`,
        `acc004.root${spec.label}.hoverFirstLine=${text.split('\n')[0]}`
      ].join('\n') + '\n', 'utf8');
    });
  }
});
