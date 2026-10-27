import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDefParamInlayItems,
  findDefParamSites,
  DefParamInlayHintsProvider
} from '../src/defParamInlayHints';
import { EntityMappingManager } from '../src/entityMapping';
import {
  Range,
  Position,
  Uri,
  configurationOverrides,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// def 函数形参 inlay(定义点,用户令 2026-10-27 任务2):entity 脚本区块内
// `def foo(self, a, b):` 未标注形参后渲染 def <Arg> 类型,<ReturnType>
// 存在时顺带 -> 提示。四边界:def 未声明 <Arg> 不出 / 已有标注不覆盖 /
// 区块外不出 / ReturnType 与跨行 def 同规则。类型解析走
// resolveEntityAnnotationType 同链,空工作区下内建直查(UINT8→int)。

const CELL_FILE = '/proj/assets/scripts/cell/avatar.py';
const PLAIN_FILE = '/proj/scripts/common/util.py';

const py = (body: string[]): string => body.join('\n');

const cellFixture = py([
  'class Avatar:',
  '    def foo(self, a, b):',
  '        pass',
  '',
  '    def annotated(self, a: int, b):',
  '        pass',
  '',
  '    def defaults(self, a=1, *args, **kwargs):',
  '        pass',
  '',
  '    def multiline(self,',
  '                  a,',
  '                  b):',
  '        pass',
  ''
]);

describe('def 函数形参 inlay(定义点,用户令 2026-10-27 任务2)', () => {
  it('findDefParamSites:区块文件给类方法点位,区块外零产出,跨行 def 不出', () => {
    const sites = findDefParamSites(cellFixture, CELL_FILE);
    const names = sites.map(site => site.methodName);
    // 跨行 def(同行括号不闭合)与现有 inlay 同规则:不出
    expect(names).toEqual(['foo', 'annotated', 'defaults']);

    const foo = sites[0];
    expect(foo.section).toBe('CellMethods');
    expect(foo.line).toBe(1);
    expect(foo.params.map(param => param.name)).toEqual(['a', 'b']);
    expect(foo.closeParenCharacter).toBe(22);

    // 区块外普通方法不出(不做推导)
    expect(findDefParamSites(cellFixture, PLAIN_FILE)).toEqual([]);
  });

  it('def 未声明 <Arg> 不出:声明形参序列为空时零形参提示', () => {
    const [foo] = findDefParamSites(cellFixture, CELL_FILE);
    expect(buildDefParamInlayItems(foo, { declaredArgs: [] }, '')).toEqual([]);
    expect(buildDefParamInlayItems(foo, { declaredArgs: undefined }, '')).toEqual([]);
  });

  it('未标注形参与 def <Arg> 逐位配对出 `: 类型`;已有标注不覆盖', () => {
    const [foo, annotated] = findDefParamSites(cellFixture, CELL_FILE);
    const items = buildDefParamInlayItems(
      foo,
      { declaredArgs: ['UINT8', 'UNKNOWN_TYPE_XYZ'] },
      ''
    );
    // b 位类型解析落 Any(未知)→ 该位不出;a 位出 UINT8→int
    expect(items).toEqual([
      { position: { line: 1, character: 19 }, text: ': int', kind: 'Parameter' }
    ]);

    // a: int 已手写标注不覆盖,只有 b 出
    const annotatedItems = buildDefParamInlayItems(
      annotated,
      { declaredArgs: ['UINT8', 'UINT8'] },
      ''
    );
    expect(annotatedItems).toHaveLength(1);
    expect(annotatedItems[0].text).toBe(': int');
    // b 的位置:annotated 行 `    def annotated(self, a: int, b):`
    expect(annotatedItems[0].position).toEqual({ line: 4, character: 33 });
  });

  it('默认值形参提示锚在名字后(= 前);*args/**kwargs 位不出', () => {
    const sites = findDefParamSites(cellFixture, CELL_FILE);
    const defaults = sites.find(site => site.methodName === 'defaults')!;
    // declaredArgs 只声明两 Arg:a 对 a=1(锚在 = 前),第二位是 *args 不出
    const items = buildDefParamInlayItems(defaults, { declaredArgs: ['UINT8', 'UINT8'] }, '');
    expect(items).toEqual([
      { position: { line: 7, character: 24 }, text: ': int', kind: 'Parameter' }
    ]);
  });

  it('<ReturnType> 存在时闭括号后出 -> 提示;未声明不出', () => {
    const [foo] = findDefParamSites(cellFixture, CELL_FILE);
    const withReturn = buildDefParamInlayItems(
      foo,
      { declaredArgs: ['UINT8'], declaredReturnType: 'UINT8' },
      ''
    );
    expect(withReturn).toEqual([
      { position: { line: 1, character: 19 }, text: ': int', kind: 'Parameter' },
      { position: { line: 1, character: 23 }, text: ' -> int', kind: 'Type' }
    ]);
    // 未声明 ReturnType:只有形参提示
    expect(
      buildDefParamInlayItems(foo, { declaredArgs: ['UINT8'] }, '')
    ).toEqual([
      { position: { line: 1, character: 19 }, text: ': int', kind: 'Parameter' }
    ]);
    // ReturnType 声明了但解析落 Any:不出
    expect(
      buildDefParamInlayItems(
        foo,
        { declaredArgs: ['UINT8'], declaredReturnType: 'UNKNOWN_TYPE_XYZ' },
        ''
      )
    ).toEqual([
      { position: { line: 1, character: 19 }, text: ': int', kind: 'Parameter' }
    ]);
  });
});

// 真实索引装配(与 typeInlayHints 的 RPC 用例同款):真 .def 走
// parseDefFileSemantics → pushMethod → resolveMethodDefinition 全链,锁
// <Arg>/<ReturnType> 到达定义点 inlay 的端到端口径(含开关关闭零动作)。
describe('DefParamInlayHintsProvider(真实索引装配)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  const setupWorkspace = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defparam-inlay-'));
    roots.push(root);
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const defFile = put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <CellMethods>',
      '    <reborn>',
      '      <Arg>UINT8</Arg>',
      '      <Arg>UINT16</Arg>',
      '      <ReturnType>UINT32</ReturnType>',
      '    </reborn>',
      '    <purge>',
      '      <ReturnType>UINT8</ReturnType>',
      '    </purge>',
      '    <oops>',
      '      <Arg>NOT_A_REAL_TYPE</Arg>',
      '    </oops>',
      '  </CellMethods>',
      '</root>'
    ].join('\n'));
    put('scripts/base/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    const cellPy = put('scripts/cell/Avatar.py', [
      'class Avatar(kbe.KBEntity):',
      '    def reborn(self, level, extra):',
      '        pass',
      '',
      '    def purge(self):',
      '        pass',
      '',
      '    def oops(self, mystery):',
      '        pass',
      ''
    ].join('\n'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'defparam-inlay', index: 0 }];
    workspace.findFiles = async (glob?: string) => (glob === '**/*.def' || glob === `**/${path.basename(defFile)}` ? [Uri.file(defFile)] : []);
    return cellPy;
  };

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
    configurationOverrides.delete('kbengine');
  });

  const hintsOf = async (text: string, fileName: string): Promise<unknown[]> => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    managers.push(manager);
    const provider = new DefParamInlayHintsProvider(manager);
    const document = makeTextDocument(text, { fileName, languageId: 'python' }) as MinimalTextDocument;
    return provider.provideInlayHints(
      document as never,
      new Range(new Position(0, 0), new Position(99, 0)) as never
    ) as unknown[];
  };

  it('def 声明的形参逐位出类型提示,ReturnType 出 -> 提示;未声明/不可解析不出', async () => {
    const cellPy = setupWorkspace();
    const text = fs.readFileSync(cellPy, 'utf8');
    const hints = (await hintsOf(text, cellPy)).map(hint => {
      const h = hint as { position: { line: number; character: number }; label: string; kind: number };
      return { line: h.position.line, character: h.position.character, label: h.label, kind: h.kind };
    });
    expect(hints).toEqual([
      // reborn(self, level, extra):level/extra → : int;闭括号后 -> int
      { line: 1, character: 26, label: ': int', kind: 2 },
      { line: 1, character: 33, label: ': int', kind: 2 },
      { line: 1, character: 34, label: ' -> int', kind: 1 },
      // purge(self):无 <Arg> 只有 -> int
      { line: 4, character: 19, label: ' -> int', kind: 1 }
    ]);
    // oops 的 Arg 类型不可解析 → 零提示(上面 toEqual 已隐含)
  });

  it('开关关:kbengine.inlayHints.defParams=false 零产出', async () => {
    const cellPy = setupWorkspace();
    configurationOverrides.set('kbengine', { 'inlayHints.defParams': false });
    const text = fs.readFileSync(cellPy, 'utf8');
    expect(await hintsOf(text, cellPy)).toEqual([]);
  });
});
