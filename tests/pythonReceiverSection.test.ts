import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EntityMappingManager,
  filterMethodDefinitionsBySection
} from '../src/entityMapping';
import {
  KBEngineHoverProvider,
  PythonDefinitionProvider,
  RpcCodeLensProvider
} from '../src/languageProviders';
import {
  findPythonReceiverCalls,
  getPythonReceiverCallAtPosition
} from '../src/pythonLanguageUtils';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 接收者感知(用户令 2026-10-21):self.cell.X(...) → X 必须是 .def 的
// CellMethods 段定义(仅此类候选通过),self.base.X → BaseMethods,self.client.X
// → ClientMethods;无前缀 self.X/X 维持现行规则。链前缀从调用行文本解析,
// 只认 self. 形态;前缀段过滤在形参闸门之前做。覆盖 F12 跳转、CodeLens、
// Hover 三面,各补正反用例(段不符→不跳/不出镜/不标注;段符合→正常)。
// manager 用真实 EntityMappingManager + 临时目录真 .def(与 crossDefMethodLookup
// 同款装配),段过滤走 resolveMethodDefinition 第三参。

const pyDoc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

describe('接收者调用行解析(纯逻辑)', () => {
  it('self.cell.reborn 光标落在方法名 → cell / CellMethods / reborn', () => {
    const line = '        self.cell.reborn(1)';
    const character = line.indexOf('reborn');
    expect(getPythonReceiverCallAtPosition(line, character)).toEqual({
      line: 0,
      character,
      receiver: 'cell',
      section: 'CellMethods',
      methodName: 'reborn'
    });
  });

  it('self.base / self.client 分别映射 BaseMethods / ClientMethods', () => {
    const baseLine = 'self.base.heal()';
    expect(getPythonReceiverCallAtPosition(baseLine, baseLine.indexOf('heal'))).toMatchObject({
      receiver: 'base',
      section: 'BaseMethods',
      methodName: 'heal'
    });
    const clientLine = 'self.client.showTip(msg)';
    expect(
      getPythonReceiverCallAtPosition(clientLine, clientLine.indexOf('showTip'))
    ).toMatchObject({ receiver: 'client', section: 'ClientMethods', methodName: 'showTip' });
  });

  it('光标落在接收者段/其他位置 → null;无前缀 self.X → null', () => {
    const line = 'self.cell.reborn(1)';
    expect(getPythonReceiverCallAtPosition(line, line.indexOf('cell'))).toBeNull();
    expect(getPythonReceiverCallAtPosition(line, line.indexOf('self'))).toBeNull();
    expect(getPythonReceiverCallAtPosition('self.reborn(1)', 5)).toBeNull();
  });

  it('只认 self. 形态:局部接收者 entity.cell.X 不识别', () => {
    const line = 'entity.cell.reborn(1)';
    expect(getPythonReceiverCallAtPosition(line, line.indexOf('reborn'))).toBeNull();
    expect(findPythonReceiverCalls(line)).toEqual([]);
  });

  it('全文档扫描:每行每处一条,行列口径与光标解析一致', () => {
    const calls = findPythonReceiverCalls(
      'def tick(self):\n    self.cell.reborn(1)\n    self.base.heal()\n'
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ line: 1, section: 'CellMethods', methodName: 'reborn' });
    expect(calls[1]).toMatchObject({ line: 2, section: 'BaseMethods', methodName: 'heal' });
  });
});

describe('filterMethodDefinitionsBySection(段过滤本体的次序契约)', () => {
  const definitions = [
    { section: 'BaseMethods', name: 'heal' },
    { section: 'CellMethods', name: 'reborn' }
  ] as const;

  it('段闸在场只留段相符候选(剔除而非降权),缺省原样通过', () => {
    expect(filterMethodDefinitionsBySection(definitions, 'CellMethods')).toEqual([
      { section: 'CellMethods', name: 'reborn' }
    ]);
    expect(filterMethodDefinitionsBySection(definitions, 'BaseMethods')).toEqual([
      { section: 'BaseMethods', name: 'heal' }
    ]);
    expect(filterMethodDefinitionsBySection(definitions)).toHaveLength(2);
  });
});

describe('接收者段闸三面(真实索引装配)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  const setupWorkspace = (): { root: string; defFile: string; basePy: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-receiver-'));
    roots.push(root);
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    // reborn 只在 CellMethods 段声明;heal 只在 BaseMethods 段声明
    const defFile = put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <CellMethods>',
      '    <reborn>',
      '      <Arg>UINT8</Arg>',
      '    </reborn>',
      '  </CellMethods>',
      '  <BaseMethods>',
      '    <heal/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    const basePy = put('scripts/base/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    put('scripts/cell/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'receiver', index: 0 }];
    workspace.findFiles = async (glob?: string) => (glob === '**/*.def' || glob === `**/${path.basename(defFile)}` ? [Uri.file(defFile)] : []);
    return { root, defFile, basePy };
  };

  const makeManager = (): EntityMappingManager => {
    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    return manager;
  };

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
  });

  it('解析层:段符合→命中对应区块声明;段不符→null;无前缀→现行规则不变', async () => {
    const { defFile, basePy } = setupWorkspace();
    const manager = makeManager();

    const cellHit = await manager.resolveMethodDefinition(basePy, 'reborn', 'CellMethods');
    expect(cellHit).toMatchObject({ defFile, line: 3, section: 'CellMethods' });

    // 段不符:reborn 只在 CellMethods,按 BaseMethods 段闸 → 不出候选
    expect(await manager.resolveMethodDefinition(basePy, 'reborn', 'BaseMethods')).toBeNull();
    // heal 只在 BaseMethods,按 CellMethods 段闸 → 不出候选
    expect(await manager.resolveMethodDefinition(basePy, 'heal', 'CellMethods')).toBeNull();

    // 无前缀维持现行规则:按名命中(owner 打分)
    expect(await manager.resolveMethodDefinition(basePy, 'heal')).toMatchObject({
      section: 'BaseMethods'
    });
    // 对象级同口径
    expect(await manager.resolveMethodDefinitionForClass('Avatar', 'reborn', 'CellMethods'))
      .toMatchObject({ section: 'CellMethods' });
    expect(await manager.resolveMethodDefinitionForClass('Avatar', 'reborn', 'BaseMethods'))
      .toBeNull();
  });

  it('F12:self.cell.reborn → 跳 CellMethods 声明;self.base.reborn 段不符 → 不跳', async () => {
    const { defFile, basePy } = setupWorkspace();
    const manager = makeManager();
    const provider = new PythonDefinitionProvider(manager);

    const cellDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.cell.reborn(1)\n',
      basePy
    );
    const rebornChar = '        self.cell.'.length;
    const jump = await provider.provideDefinition(cellDoc, new Position(2, rebornChar));
    expect(jump).toMatchObject({
      uri: { fsPath: defFile },
      range: { start: { line: 2 } }
    });

    // 段不符:self.base.reborn(reborn 不是 BaseMethods 声明)→ 不跳
    const baseDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.base.reborn(1)\n',
      basePy
    );
    const baseChar = '        self.base.'.length;
    expect(
      await provider.provideDefinition(baseDoc, new Position(2, baseChar))
    ).toBeNull();

    // 段不符反例:self.cell.heal(heal 不是 CellMethods 声明)→ 不跳
    const healDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.cell.heal()\n',
      basePy
    );
    const healChar = '        self.cell.'.length;
    expect(
      await provider.provideDefinition(healDoc, new Position(2, healChar))
    ).toBeNull();
  });

  it('CodeLens:self.cell.reborn 调用行出镜;段不符调用不出镜;声明面不受影响', async () => {
    const { basePy } = setupWorkspace();
    const manager = makeManager();
    const provider = new RpcCodeLensProvider(manager);

    const doc = pyDoc(
      [
        'class Avatar(kbe.KBEntity):',
        '    def tick(self):',
        '        self.cell.reborn(1)',
        '        self.base.reborn(1)',
        '    def heal(self, hp):',
        '        pass'
      ].join('\n'),
      basePy
    );
    const lenses = (await provider.provideCodeLenses(doc)) as Array<{
      range: { start: { line: number; character: number } };
      command?: { title: string; arguments?: unknown[] };
    }>;
    // reborn 的 CellMethods 调用镜 1 枚(第 2 行);base 段不符不出镜;
    // heal 声明无前缀走现行规则且 BaseMethods 命中,声明镜 1 枚
    expect(lenses).toHaveLength(2);
    const callLens = lenses.find(lens => lens.range.start.line === 2);
    expect(callLens?.range.start).toEqual({ line: 2, character: '        self.cell.'.length });
    expect(callLens?.command?.title).toContain('CellMethods');
    expect(lenses.some(lens => lens.range.start.line === 3)).toBe(false);
    const declLens = lenses.find(lens => lens.range.start.line === 4);
    expect(declLens?.command?.title).toContain('BaseMethods');
  });

  it('Hover:self.cell.reborn → 段内标注;段不符 → 不标注(落回普通 hover 链)', async () => {
    const { basePy } = setupWorkspace();
    const manager = makeManager();

    const cellDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.cell.reborn(1)\n',
      basePy
    );
    const rebornChar = '        self.cell.'.length;
    const hover = (await Promise.resolve(
      new KBEngineHoverProvider(manager).provideHover(cellDoc, new Position(2, rebornChar))
    )) as { contents: unknown } | null;
    const rawContents = hover?.contents ?? [];
    const text = (Array.isArray(rawContents) ? rawContents : [rawContents])
      .map(part => (part as { value?: string }).value ?? String(part))
      .join('\n');
    expect(text).toContain('reborn');
    expect(text).toContain('CellMethods');
    expect(text).toContain('接收者 self.cell');

    // 段不符:self.base.reborn(reborn 不是 BaseMethods 声明)→ 不标注
    const baseDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.base.reborn(1)\n',
      basePy
    );
    const baseChar = '        self.base.'.length;
    expect(
      await Promise.resolve(
        new KBEngineHoverProvider(manager).provideHover(baseDoc, new Position(2, baseChar))
      )
    ).toBeNull();
  });
});
