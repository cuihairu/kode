import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDefPropsInlayItems,
  findDefPropsAnchorSites,
  DefPropsInlayHintsProvider,
  DEF_PROPS_ANCHOR_TOKEN
} from '../src/defPropsInlayHints';
import { EntityMappingManager, type PropertyDefinitionInfo } from '../src/entityMapping';
import {
  Range,
  Position,
  Uri,
  configurationOverrides,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// C-22 交付③:def 属性只读视图 inlay(注释锚形态,重做版)。Python 侧
// __init__ 之前引擎灌入的 def 属性在源码里不可见;在用户放置的整行注释锚
// `# kode:props-from-def` 行尾以一条 inlay 渲染该文件所属实体的 def 根级
// 属性清单(name: 注解,段悬停给 def 声明出处)。纯渲染层,不写代码不造
// 第二事实源——属性唯一事实源 = .def。口径:整行注释才触发;FIXED_DICT
// 子键(路径带 .)与组件槽成员不进总览;无所属实体/无属性/开关关 → 零
// inlay,不推导不猜;注解链与 hover/stub 同源(resolveEntityAnnotationType),
// 解析落 Any 的属性只显名不带类型,不伪造。

const prop = (overrides: Partial<PropertyDefinitionInfo> & Pick<PropertyDefinitionInfo, 'defFile' | 'line' | 'identity'>): PropertyDefinitionInfo => ({
  domains: [],
  persistent: false,
  ...overrides
});

const identity = (symbolName: string, extra: { propertyPath?: string; componentSlotName?: string } = {}) => ({
  ownerKind: 'entity' as const,
  ownerName: 'Avatar',
  sourceKind: 'def' as const,
  sourceChain: [],
  symbolName,
  ...extra
});

describe('findDefPropsAnchorSites(注释锚提取)', () => {
  it('整行注释含锚 token 才触发;代码行/字符串里的同词不触发', () => {
    const text = [
      'class Avatar:',
      '    # kode:props-from-def',
      '    def __init__(self):',
      '        pass',
      '',
      '    # see also kode:props-from-def docs below',
      '        x = "kode:props-from-def"',
      '        y = 1  # kode:props-from-def'
    ].join('\n');
    const sites = findDefPropsAnchorSites(text);
    expect(sites).toEqual([
      { line: 1, character: text.split('\n')[1].length },
      { line: 5, character: text.split('\n')[5].length }
    ]);
  });

  it('无锚 → 零产出', () => {
    expect(findDefPropsAnchorSites('class Avatar:\n    pass\n')).toEqual([]);
    expect(findDefPropsAnchorSites('')).toEqual([]);
    expect(DEF_PROPS_ANCHOR_TOKEN).toBe('kode:props-from-def');
  });
});

describe('buildDefPropsInlayItems(单锚点 inlay 组装)', () => {
  const defFile = '/proj/scripts/entity_defs/Avatar.def';

  it('头部段 + 逐属性段 name: 注解;未知类型只显名不带类型(不伪造)', () => {
    const properties = [
      prop({ defFile, line: 3, identity: identity('hp'), typeName: 'UINT16', domains: ['base', 'cell'], persistent: true }),
      prop({ defFile, line: 5, identity: identity('mood'), typeName: 'NOT_A_REAL_TYPE' })
    ];
    const item = buildDefPropsInlayItems(
      { line: 7, character: 30 },
      properties,
      ''
    );
    expect(item).not.toBeNull();
    expect(item!.position).toEqual({ line: 7, character: 30 });
    expect(item!.kind).toBe('Type');
    const texts = item!.parts.map(part => part.text);
    expect(texts[0]).toBe('def 属性(2) ');
    expect(texts[1]).toBe('hp: int');
    expect(texts[2]).toBe(' · ');
    // 未知类型落 Any → 只显名,不带 ': any' 伪造
    expect(texts[3]).toBe('mood');
    // 头部段悬停:只读视图说明;属性段悬停:声明出处 def 文件名:行 + 域 + 持久化
    expect(item!.parts[0].tooltip).toContain('只读');
    expect(item!.parts[1].tooltip).toContain('Avatar.def:3');
    expect(item!.parts[1].tooltip).toContain('base/cell');
    expect(item!.parts[1].tooltip).toContain('持久化');
    // 无域无持久化的属性段悬停只有出处
    expect(item!.parts[3].tooltip).toBe('Avatar.def:5');
  });

  it('根级过滤器:FIXED_DICT 子键(路径带 .)与组件槽成员不进总览', () => {
    const properties = [
      prop({ defFile, line: 3, identity: identity('hp'), typeName: 'UINT16' }),
      prop({ defFile, line: 4, identity: identity('name', { propertyPath: 'profile.name' }), typeName: 'UNICODE' }),
      prop({ defFile, line: 6, identity: identity('move', { componentSlotName: 'movement' }), typeName: 'UINT8' })
    ];
    const item = buildDefPropsInlayItems({ line: 0, character: 0 }, properties, '');
    expect(item!.parts.map(part => part.text)).toEqual(['def 属性(1) ', 'hp: int']);
  });

  it('根级属性为零 → null(锚行零 inlay)', () => {
    const properties = [
      prop({ defFile, line: 4, identity: identity('name', { propertyPath: 'profile.name' }), typeName: 'UNICODE' })
    ];
    expect(buildDefPropsInlayItems({ line: 0, character: 0 }, properties, '')).toBeNull();
  });
});

// 真实索引装配(与 defParamInlayHints 的装配用例同款):真 .def 走语义
// 解析全链,锁锚点 inlay 的端到端口径(含开关关闭/非实体文件零动作)。
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
    put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <Properties>',
      '    <hp><Type>UINT16</Type><Flags>ALL_CLIENTS</Flags><Persistent>true</Persistent></hp>',
      '    <level><Type>UINT8</Type></level>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    put('scripts/base/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    const cellPy = put('scripts/cell/Avatar.py', [
      'class Avatar(kbe.KBEntity):',
      '    # kode:props-from-def',
      '    def __init__(self):',
      '        pass',
      '',
      '    def on_something(self):',
      '        # kode:props-from-def',
      '        pass',
      ''
    ].join('\n'));
    const plainPy = put('scripts/common/util.py', [
      'class Util:',
      '    # kode:props-from-def',
      '    pass',
      ''
    ].join('\n'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'defprops-inlay', index: 0 }];
    workspace.findFiles = async (glob?: string) =>
      glob === '**/*.def' || glob === '**/Avatar.def'
        ? [Uri.file(path.join(root, 'scripts/entity_defs/Avatar.def'))]
        : [];
    void plainPy;
    return cellPy;
  };

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
    configurationOverrides.delete('kbengine');
  });

  interface FlatHint {
    line: number;
    character: number;
    texts: string[];
    tooltips: string[];
  }

  const hintsOf = async (text: string, fileName: string): Promise<FlatHint[]> => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    managers.push(manager);
    const provider = new DefPropsInlayHintsProvider(manager);
    const document = makeTextDocument(text, { fileName, languageId: 'python' }) as MinimalTextDocument;
    const hints = (await provider.provideInlayHints(
      document as never,
      new Range(new Position(0, 0), new Position(99, 0)) as never
    )) as unknown as Array<{
      position: { line: number; character: number };
      label: string | Array<{ text: string; tooltip?: { value: string } | string }>;
    }>;
    return hints.map(hint => {
      const parts = Array.isArray(hint.label) ? hint.label : [{ value: String(hint.label) }];
      return {
        line: hint.position.line,
        character: hint.position.character,
        texts: parts.map(part => (part as { value: string }).value),
        tooltips: parts
          .map(part => {
            const tooltip = (part as { tooltip?: { value: string } | string }).tooltip;
            return tooltip ? (typeof tooltip === 'string' ? tooltip : tooltip.value) : '';
          })
          .filter(Boolean)
      };
    });
  };

  it('锚行尾一条 inlay:头部段 + 逐属性段,悬停带 def 声明出处', async () => {
    const cellPy = setupWorkspace();
    const hints = await hintsOf(fs.readFileSync(cellPy, 'utf8'), cellPy);
    // 两个锚各一条(行 1 与行 6),锚行尾对齐
    expect(hints.map(hint => [hint.line, hint.character])).toEqual([
      [1, fs.readFileSync(cellPy, 'utf8').split('\n')[1].length],
      [6, fs.readFileSync(cellPy, 'utf8').split('\n')[6].length]
    ]);
    const texts = hints[0].texts;
    expect(texts[0]).toBe('def 属性(2) ');
    expect(texts.slice(1)).toEqual(['hp: int', ' · ', 'level: int']);
    // hp 段悬停:出处 + 持久化标记(ALL_CLIENTS → cell/client 域面由解析链给)
    expect(hints[0].tooltips.some(tooltip => tooltip.includes('Avatar.def:'))).toBe(true);
  });

  it('开关关:kbengine.inlayHints.defProps=false 零产出', async () => {
    const cellPy = setupWorkspace();
    configurationOverrides.set('kbengine', { 'inlayHints.defProps': false });
    expect(await hintsOf(fs.readFileSync(cellPy, 'utf8'), cellPy)).toEqual([]);
  });

  it('非实体所属文件:锚不触发(无所属实体零 inlay,不推导)', async () => {
    setupWorkspace();
    const utilPy = path.join(workspace.workspaceFolders![0].uri.fsPath, 'scripts/common/util.py');
    expect(await hintsOf(fs.readFileSync(utilPy, 'utf8'), utilPy)).toEqual([]);
  });
});
