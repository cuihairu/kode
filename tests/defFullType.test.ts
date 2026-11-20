// RUST-136 增量③:**Full Type** 生产悬停面。
// 两臂:①纯核(defFullType 模块 = Rust expand_type_token / full_type_of_property
// 同算法,输入=快照 CustomTypeInfo 条目);②生产面(临时根 + KBEngineHoverProvider
// 走 getEntityCustomTypesSnapshot 真快照,断言悬停 markdown 行序)。对拍真源仍是
// kodeHoverParity.test.ts(语料 golden),本面只保生产渲染。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDefFullTypeTable,
  defFullTypeTable,
  expandDefTypeToken,
  fullTypeOfDefDeclaration,
  fullTypeOfDefProperty,
  resetDefFullTypeTables
} from '../src/backend/defFullType';
import type { CustomTypeInfo, CustomTypePropertyInfo, CustomTypeStructureNode } from '../src/definitionWorkspace';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

const root = (): CustomTypeInfo => ({
  name: 'ROOT',
  filePath: '/ws/scripts/entity_defs/types.xml',
  line: 1,
  implementedByLine: 2,
  startOffset: 0,
  endOffset: 0,
  aliasType: 'FIXED_DICT',
  rawValue: 'FIXED_DICT',
  structure: { name: 'FIXED_DICT', rawValue: 'FIXED_DICT', children: [], line: 1 },
  properties: [],
  pythonFilePath: undefined
});

const withName = (name: string): CustomTypeInfo => ({ ...root(), name });

const ofChild = (element: string): CustomTypeStructureNode => ({
  name: element,
  rawValue: element,
  children: [],
  line: 1
});

// 合成属性:有 <Type> 子元素(真实快照 typeStructure 非 undefined)才进 FD 字段表
const propertyWith = (
  name: string,
  typeName: string,
  line: number,
  of: string | null = null
): CustomTypePropertyInfo => ({
  name,
  typeName,
  typeStructure: {
    name: typeName,
    rawValue: of ? `${typeName} <of> ${of} </of>` : typeName,
    children: of ? [{ tag: 'of', value: ofChild(of) }] : [],
    line: line - 1
  },
  line
});

const builtinProperty = (
  name: string,
  typeName: string,
  line = 6
): CustomTypePropertyInfo => propertyWith(name, typeName, line, null);

const arrayProperty = (
  name: string,
  of: string | null,
  line = 5
): CustomTypePropertyInfo => propertyWith(name, 'ARRAY', line, of);

// 合成 ARRAY 声明条目(结构树含 <of> 子元素;属性式 <of> 属性形态不入 rawValue)
const arrayDecl = (name: string, of: string): CustomTypeInfo => ({
  ...withName(name),
  aliasType: 'ARRAY',
  rawValue: `ARRAY <of> ${of} </of>`,
  structure: {
    name: 'ARRAY',
    rawValue: `ARRAY <of> ${of} </of>`,
    children: [{ tag: 'of', value: ofChild(of) }],
    line: 1
  }
});

beforeEach(() => resetDefFullTypeTables());
afterEach(() => resetDefFullTypeTables());

describe('defFullType 纯核:FD 展开(与 Rust expand_type_token 同算法)', () => {
  const table = buildDefFullTypeTable([
    {
      ...withName('POSITION'),
      // 快照按名 localeCompare 排序:z 先于 x;展开须还原文档序
      properties: [
        builtinProperty('z', 'FLOAT', 40),
        builtinProperty('x', 'FLOAT', 33),
        builtinProperty('y', 'FLOAT', 36)
      ]
    },
    {
      ...withName('SKILL_SLOT'),
      properties: [
        arrayProperty('slot_list', 'UINT32', 18),
        builtinProperty('count', 'UINT32', 23)
      ]
    }
  ]);

  it('FIXED_DICT 字段按原文行序展开(快照按名排序,须还原)', () => {
    expect(expandDefTypeToken(table, 'POSITION', 0)).toBe(
      'FIXED_DICT { x: FLOAT, y: FLOAT, z: FLOAT }'
    );
  });

  it('ARRAY 字段走 <of> 元素展开,ARRAY 缺 <of> 如实停在 ARRAY', () => {
    expect(expandDefTypeToken(table, 'SKILL_SLOT', 0)).toBe(
      'FIXED_DICT { slot_list: ARRAY<UINT32>, count: UINT32 }'
    );
    const noOf = buildDefFullTypeTable([
      { ...withName('EMPTY_ARR'), properties: [arrayProperty('items', null, 8)] }
    ]);
    expect(expandDefTypeToken(noOf, 'EMPTY_ARR', 0)).toBe('FIXED_DICT { items: ARRAY }');
  });

  it('空 FIXED_DICT / 缺席 / 内建 → 原文 token', () => {
    const empty = buildDefFullTypeTable([{ ...withName('VOID_DICT'), properties: [] }]);
    expect(expandDefTypeToken(empty, 'VOID_DICT', 0)).toBe('VOID_DICT');
    expect(expandDefTypeToken(table, 'GHOST', 0)).toBe('GHOST');
    expect(expandDefTypeToken(table, 'UINT32', 0)).toBe('UINT32');
  });

  it('自引用环被深度护栏截断(≥3 层按原文)', () => {
    const cyclic = buildDefFullTypeTable([
      { ...withName('SELF'), properties: [propertyWith('self', 'SELF', 4)] }
    ]);
    // 深度护栏(≥3):SELF 三层展开后第四层按原文 token 呈现
    expect(expandDefTypeToken(cyclic, 'SELF', 0)).toBe(
      'FIXED_DICT { self: FIXED_DICT { self: FIXED_DICT { self: SELF } } }'
    );
  });

  it('ARRAY 声明本体展开到元素型', () => {
    const arrays = buildDefFullTypeTable([
      withName('ITEM_ID'),
      arrayDecl('ITEM_IDS', 'ITEM_ID')
    ]);
    expect(expandDefTypeToken(arrays, 'ITEM_IDS', 0)).toBe('ARRAY<ITEM_ID>');
  });
});

describe('defFullType 纯核:fullType 判据(展开=原文 → null)', () => {
  const table = buildDefFullTypeTable([
    { ...withName('SKILL_SLOT'), properties: [arrayProperty('slot_list', 'UINT32', 18)] },
    withName('ITEM_ID'),
    arrayDecl('ITEM_IDS', 'ITEM_ID'),
    withName('POSITION')
  ]);

  it('属性面:展开异于原文才出值;ARRAY 指引走 <of>', () => {
    expect(fullTypeOfDefProperty(table, 'SKILL_SLOT', undefined)).toBe(
      'FIXED_DICT { slot_list: ARRAY<UINT32> }'
    );
    expect(fullTypeOfDefProperty(table, 'ARRAY', 'UINT32')).toBe('ARRAY<UINT32>');
    // 别名尾/内建/缺席/空 FD → null
    expect(fullTypeOfDefProperty(table, 'ITEM_ID', undefined)).toBeNull();
    expect(fullTypeOfDefProperty(table, 'UINT32', undefined)).toBeNull();
    expect(fullTypeOfDefProperty(table, 'GHOST', undefined)).toBeNull();
    expect(fullTypeOfDefProperty(table, 'ARRAY', null)).toBeNull();
    expect(fullTypeOfDefProperty(table, null, 'UINT32')).toBeNull();
    // 空文本类型(无 <Type> 的标量属性)
    expect(fullTypeOfDefProperty(table, '', undefined)).toBeNull();
  });

  it('声明面:展开异于原名才出值', () => {
    expect(fullTypeOfDefDeclaration(table, 'SKILL_SLOT')).toBe(
      'FIXED_DICT { slot_list: ARRAY<UINT32> }'
    );
    expect(fullTypeOfDefDeclaration(table, 'ITEM_IDS')).toBe('ARRAY<ITEM_ID>');
    expect(fullTypeOfDefDeclaration(table, 'ITEM_ID')).toBeNull();
    expect(fullTypeOfDefDeclaration(table, 'UINT16')).toBeNull();
  });

  it('alias.xml 条目不入表(Rust root_types_table 只吃 types_files)', () => {
    const entries = [
      { ...withName('GHOST'), filePath: '/ws/scripts/entity_defs/alias.xml', aliasType: 'UINT16' },
      { ...withName('REAL'), aliasType: 'UINT16' }
    ];
    const table = buildDefFullTypeTable(entries);
    expect(table.has('GHOST')).toBe(false);
    expect(expandDefTypeToken(table, 'GHOST', 0)).toBe('GHOST');
    // 同名双源:alias.xml 让位 types.xml(Rust 表只有 types_files)
    const dup = buildDefFullTypeTable([
      { ...withName('DUP'), filePath: '/ws/scripts/entity_defs/alias.xml' },
      {
        ...withName('DUP'),
        properties: [builtinProperty('k', 'UINT8', 3)]
      }
    ]);
    expect(expandDefTypeToken(dup, 'DUP', 0)).toBe('FIXED_DICT { k: UINT8 }');
  });
});

describe('defFullType 根键控表缓存', () => {
  it('同一 entries 引用复用表快照;引用换代即重算', () => {
    const entries = [withName('POSITION')];
    const first = defFullTypeTable('/ws-a', entries);
    expect(defFullTypeTable('/ws-a', entries)).toBe(first);
    const rebuilt = defFullTypeTable('/ws-a', [...entries, withName('SKILL_SLOT')]);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.has('SKILL_SLOT')).toBe(true);
    // 跨根互不影响
    expect(defFullTypeTable('/ws-b', entries)).not.toBe(first);
    resetDefFullTypeTables();
    expect(defFullTypeTable('/ws-a', entries)).not.toBe(first);
  });

  it('空工作区根返回空表,不缓存', () => {
    expect(defFullTypeTable('', [withName('POSITION')])).toBeDefined();
    expect(defFullTypeTable('', [withName('POSITION')]).size).toBe(0);
  });
});

// ---- 生产面:临时根 + provider 真快照 ----

describe('RUST-136 增量③:生产悬停 **Full Type** 面', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fulltype-'));
  const entityDefs = path.join(tempRoot, 'scripts', 'entity_defs');
  const write = (relative: string, content: string): void => {
    const target = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  beforeAll(() => {
    write('scripts/entities.xml', [
      '<root>',
      '  <Hero hasBase="true" hasCell="true"/>',
      '</root>'
    ].join('\n'));
    write('scripts/entity_defs/types.xml', [
      '<root>',
      '  <POSITION>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type> FLOAT </Type>',
      '      </x>',
      '      <y>',
      '        <Type> FLOAT </Type>',
      '      </y>',
      '    </Properties>',
      '  </POSITION>',
      '  <ITEM_ID> UINT16 </ITEM_ID>',
      '</root>'
    ].join('\n'));
    write('scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <pos>',
      '      <Type> POSITION </Type>',
      '    </pos>',
      '    <ids>',
      '      <Type> ITEM_ID </Type>',
      '    </ids>',
      '    <slotList>',
      '      <Type>',
      '        ARRAY',
      '        <of> UINT32 </of>',
      '      </Type>',
      '    </slotList>',
      '    <hp>',
      '      <Type> UINT32 </Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(tempRoot), name: 'ws', index: 0 }];
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  const hoverOn = (
    template: string,
    fileName: string
  ): { markdown: string; contents: unknown } => {
    const marker = '|';
    const idx = template.indexOf(marker);
    expect(idx, '测试模板须带 | 光标标记').toBeGreaterThanOrEqual(0);
    const text = template.replace(marker, '');
    const before = text.slice(0, idx);
    const line = before.split('\n').length - 1;
    const lastNewline = before.lastIndexOf('\n');
    const character = line === 0 ? idx : idx - (lastNewline + 1);
    const provider = new KBEngineHoverProvider();
    const doc = makeTextDocument(text, {
      fileName: path.join(entityDefs, fileName),
      languageId: 'kbengine-def'
    });
    const hover = provider.provideHover(doc, new Position(line, character));
    if (!hover) {
      return { markdown: '', contents: null };
    }
    const contents = hover.contents;
    const markdown = Array.isArray(contents)
      ? contents.map(item => item.value).join('')
      : (contents as { value: string }).value;
    return { markdown, contents };
  };

  it('属性面:POSITION 属性展开 FD 字段,紧随 **Type**;内建属性不渲染该行', () => {
    const expanded = hoverOn([
      '<root>',
      '  <Properties>',
      '    <po|s>',
      '      <Type> POSITION </Type>',
      '    </pos>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Hero.def');
    expect(expanded.markdown).toContain('**Type**: `POSITION`');
    expect(expanded.markdown).toContain(
      '**Full Type**: `FIXED_DICT { x: FLOAT, y: FLOAT }`'
    );
    expect(expanded.markdown.indexOf('**Full Type**')).toBeGreaterThan(
      expanded.markdown.indexOf('**Type**')
    );

    const builtin = hoverOn([
      '<root>',
      '  <Properties>',
      '    <h|p>',
      '      <Type> UINT32 </Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Hero.def');
    expect(builtin.markdown).toContain('**Type**: `UINT32`');
    expect(builtin.markdown).not.toContain('**Full Type**');
  });

  it('属性面:ARRAY 指引展开 <of>;别名尾不渲染', () => {
    const array = hoverOn([
      '<root>',
      '  <Properties>',
      '    <slotLi|st>',
      '      <Type>',
      '        ARRAY',
      '        <of> UINT32 </of>',
      '      </Type>',
      '    </slotList>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Hero.def');
    expect(array.markdown).toContain('**Type**: `ARRAY`');
    expect(array.markdown).toContain('**Full Type**: `ARRAY<UINT32>`');

    const aliasTail = hoverOn([
      '<root>',
      '  <Properties>',
      '    <id|s>',
      '      <Type> ITEM_ID </Type>',
      '    </ids>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Hero.def');
    expect(aliasTail.markdown).toContain('**Type**: `ITEM_ID`');
    expect(aliasTail.markdown).not.toContain('**Full Type**');
  });

  it('声明面:types.xml 上悬停出 Full Type 行,在 AliasType 之前', () => {
    const declared = hoverOn([
      '<root>',
      '  <POSI|TION>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type> FLOAT </Type>',
      '      </x>',
      '      <y>',
      '        <Type> FLOAT </Type>',
      '      </y>',
      '    </Properties>',
      '  </POSITION>',
      '  <ITEM_ID> UINT16 </ITEM_ID>',
      '</root>'
    ].join('\n'), 'types.xml');
    expect(declared.markdown).toContain('**AliasType**: `FIXED_DICT`');
    expect(declared.markdown).toContain(
      '**Full Type**: `FIXED_DICT { x: FLOAT, y: FLOAT }`'
    );
    expect(declared.markdown.indexOf('**Full Type**')).toBeLessThan(
      declared.markdown.indexOf('**AliasType**')
    );
  });

  it('声明面:别名尾类型不渲染该行(展开=原名)', () => {
    const aliasTail = hoverOn([
      '<root>',
      '  <ITEM_|ID> UINT16 </ITEM_ID>',
      '</root>'
    ].join('\n'), 'types.xml');
    expect(aliasTail.markdown).toContain('**AliasType**: `UINT16`');
    expect(aliasTail.markdown).not.toContain('**Full Type**');
  });
});
