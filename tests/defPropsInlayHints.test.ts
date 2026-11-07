import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDefPropsInlayItems,
  findDefPropsAnchorSites,
  DefPropsInlayHintsProvider
} from '../src/defPropsInlayHints';
import type { PropertyDefinitionInfo } from '../src/entityMapping';
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

// C-22 交付③:def 属性只读视图 inlay。锚只认整行注释里的精确 token;
// 属性面 = 文件所属实体的 .def 根级声明;无实体/无属性/开关关零产出;
// 注解链与 hover/stub 同源(UINT8→int,空工作区直查);解析落 Any 只显
// 名不带类型,不伪造;子键与组件槽成员不进总览。

const CELL_FILE = '/proj/assets/scripts/cell/avatar.py';
const PLAIN_FILE = '/proj/scripts/common/util.py';

const py = (body: string[]): string => body.join('\n');

const anchorFixture = py([
  'class Avatar:',
  '    def __init__(self):',
  '        # kode:props-from-def',
  '        pass',
  '',
  '    def foo(self):',
  '        x = "# kode:props-from-def"',
  '        pass',
  ''
]);

describe('def 属性只读视图 inlay(C-22 交付③,注释锚形态)', () => {
  it('findDefPropsAnchorSites:整行注释含 token 才是锚;字符串/普通行不算', () => {
    const sites = findDefPropsAnchorSites(anchorFixture);
    expect(sites).toEqual([{ line: 2, character: 29 }]);

    // 代码行里的同词字符串不触发;无 token 的普通注释不触发
    expect(findDefPropsAnchorSites('x = "# kode:props-from-def"\n')).toEqual([]);
    expect(findDefPropsAnchorSites('# just a comment\n')).toEqual([]);
  });

  it('buildDefPropsInlayItems:头部段 + 逐属性段;Any 只显名;子键/组件槽滤除', () => {
    const [site] = findDefPropsAnchorSites(anchorFixture);
    const property = (over: Partial<PropertyDefinitionInfo>): PropertyDefinitionInfo => ({
      defFile: '/proj/assets/scripts/entity_defs/Avatar.def',
      line: 3,
      identity: {
        ownerKind: 'entity',
        ownerName: 'Avatar',
        sourceKind: 'local',
        sourceChain: [],
        symbolName: 'hp',
        propertyPath: 'hp'
      },
      domains: ['base'],
      persistent: true,
      typeName: 'UINT16',
      ...over
    });
    const item = buildDefPropsInlayItems(site, [
      property({}),
      property({
        line: 9,
        persistent: false,
        typeName: 'NOT_A_REAL_TYPE',
        identity: {
          ownerKind: 'entity',
          ownerName: 'Avatar',
          sourceKind: 'local',
          sourceChain: [],
          symbolName: 'bag',
          propertyPath: 'bag'
        }
      }),
      // FIXED_DICT 子键:路径带 . → 滤除
      property({
        identity: {
          ownerKind: 'entity',
          ownerName: 'Avatar',
          sourceKind: 'local',
          sourceChain: [],
          symbolName: 'items',
          propertyPath: 'equip.items'
        }
      }),
      // 组件槽成员 → 滤除
      property({
        identity: {
          ownerKind: 'entity',
          ownerName: 'Avatar',
          sourceKind: 'local',
          sourceChain: [],
          symbolName: 'items',
          propertyPath: 'items',
          componentSlotName: 'Inventory'
        }
      })
    ], '');
    expect(item).toEqual({
      position: { line: 2, character: 29 },
      kind: 'Type',
      parts: [
        {
          text: 'def 属性(2) ',
          tooltip: 'def 声明属性只读视图(纯渲染,非代码)。事实源: .def;跳转: 属性上 F12 直达声明行'
        },
        { text: 'hp: int', tooltip: 'Avatar.def:3 · base · 持久化' },
        { text: ' · ' },
        { text: 'bag', tooltip: 'Avatar.def:9 · base' }
      ]
    });

    // 无根级属性 → 不出
    expect(buildDefPropsInlayItems(site, [], '')).toBeNull();
  });
});

// 真实索引装配(与 defParamInlayHints 同款):真 .def 走索引 →
// listPropertyDefinitionsForFile 全链,锁锚点 inlay 的端到端口径
// (含开关关闭零动作、无实体文件零动作)。
describe('DefPropsInlayHintsProvider(真实索引装配)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  const setupWorkspace = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defprops-inlay-'));
    roots.push(root);
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const defFile = put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE_AND_CLIENT</Flags>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '    <nameTmp>',
      '      <Type>PYTHON</Type>',
      '      <Flags>BASE</Flags>',
      '    </nameTmp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    put('scripts/base/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    const cellPy = put('scripts/cell/Avatar.py', [
      'class Avatar(kbe.KBEntity):',
      '    def __init__(self):',
      '        # kode:props-from-def',
      '        pass',
      ''
    ].join('\n'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'defprops-inlay', index: 0 }];
    workspace.findFiles = async (glob?: string) => (glob === '**/*.def' || glob === `**/${path.basename(defFile)}` ? [Uri.file(defFile)] : []);
    return cellPy;
  };

  afterEach(() => {
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
    configurationOverrides.delete('kbengine');
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  });

  const hintsOf = async (text: string, fileName: string): Promise<unknown[]> => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    managers.push(manager);
    const provider = new DefPropsInlayHintsProvider(manager);
    const document = makeTextDocument(text, { fileName, languageId: 'python' }) as MinimalTextDocument;
    return provider.provideInlayHints(
      document as never,
      new Range(new Position(0, 0), new Position(99, 0)) as never
    ) as unknown[];
  };

  it('锚行尾出属性总览;PYTHON(不可解析)只显名;域/持久化进悬停', async () => {
    const cellPy = setupWorkspace();
    const text = fs.readFileSync(cellPy, 'utf8');
    const hints = (await hintsOf(text, cellPy)).map(hint => {
      const h = hint as {
        position: { line: number; character: number };
        label: Array<{ value: string; tooltip?: { value?: string } }>;
        kind: number;
        paddingLeft?: boolean;
      };
      return {
        line: h.position.line,
        character: h.position.character,
        parts: h.label.map(part => ({ value: part.value, tooltip: part.tooltip?.value })),
        kind: h.kind,
        paddingLeft: h.paddingLeft
      };
    });
    expect(hints).toEqual([{
      line: 2,
      character: 29,
      parts: [
        {
          value: 'def 属性(2) ',
          tooltip: 'def 声明属性只读视图(纯渲染,非代码)。事实源: .def;跳转: 属性上 F12 直达声明行'
        },
        { value: 'hp: int', tooltip: 'Avatar.def:3 · base/client · 持久化' },
        { value: ' · ' },
        { value: 'nameTmp', tooltip: 'Avatar.def:8 · base' }
      ],
      kind: 1,
      paddingLeft: true
    }]);
  });

  it('开关关:kbengine.inlayHints.defProps=false 零产出', async () => {
    const cellPy = setupWorkspace();
    configurationOverrides.set('kbengine', { 'inlayHints.defProps': false });
    const text = fs.readFileSync(cellPy, 'utf8');
    expect(await hintsOf(text, cellPy)).toEqual([]);
  });

  it('无锚注释(普通 __init__)与非实体文件:零产出', async () => {
    const cellPy = setupWorkspace();
    const noAnchor = 'class Avatar(kbe.KBEntity):\n    def __init__(self):\n        pass\n';
    expect(await hintsOf(noAnchor, cellPy)).toEqual([]);
    expect(await hintsOf('x = 1\n', PLAIN_FILE)).toEqual([]);
    // 有锚但文件不属任何实体 → 不推导不猜
    expect(await hintsOf('# kode:props-from-def\n', PLAIN_FILE)).toEqual([]);
  });

  it('视图口外的锚行不出 hint(inlay 按可视区要)', async () => {
    const cellPy = setupWorkspace();
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    managers.push(manager);
    const provider = new DefPropsInlayHintsProvider(manager);
    const text = fs.readFileSync(cellPy, 'utf8');
    const document = makeTextDocument(text, { fileName: cellPy, languageId: 'python' }) as MinimalTextDocument;
    const narrow = await provider.provideInlayHints(
      document as never,
      new Range(new Position(0, 0), new Position(1, 0)) as never
    );
    expect(narrow).toEqual([]);
  });
});
