import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineCompletionProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  validateDocument
} from '../src/languageProviders';
import { KBENGINE_FLAGS, KBENGINE_RELOAD_FUNCTIONS, DETAIL_LEVELS } from '../src/kbengineMetadata';
import { KBENGINE_HOOKS } from '../src/hooks';
import {
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Hover,
  Location,
  Position,
  Range,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// languageProviders 的语言特性纯逻辑:def 补全/悬停/校验/定义跳转。
// TextDocument 用测试工厂的最小实现(真实文本定位语义),workspace 引用
// 解析走真实临时文件树。真实编辑器集成由 mocha 层覆盖。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lang-'));
  (globalThis as { __langRoot?: string }).__langRoot = root;
  const write = (relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasClient="false"/>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <Components>',
    '    <healthPack>',
    '      <Type>HealthComp</Type>',
    '    </healthPack>',
    '  </Components>',
    '  <BaseMethods>',
    '    <onSave>',
    '      <Arg>UINT32</Arg>',
    '      <Exposed/>',
    '    </onSave>',
    '  </BaseMethods>',
    '  <ClientMethods>',
    '    <say/>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Parent>Hero</Parent>',
    '  <Properties>',
    '    <ferocity>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </ferocity>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/interfaces/MoveIface.def', [
    '<root>',
    '  <Properties>',
    '    <stride>',
    '      <Type>UINT8</Type>',
    '      <Flags>ALL_CLIENTS</Flags>',
    '    </stride>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/components/HealthComp.def', [
    '<root>',
    '  <Properties>',
    '    <regen>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PRIVATE</Flags>',
    '    </regen>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '  <DOLL>',
    '    <Type>UINT32</Type>',
    '    <implementedBy>item.doll</implementedBy>',
    '  </DOLL>',
    '  <PHONE>',
    '    <Type>UINT32</Type>',
    '    <implementedBy>item.phone</implementedBy>',
    '  </PHONE>',
    '</root>'
  ].join('\n'));
  write('user_type/item/phone.py', 'class Phone(object):\n    pass\n');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  const root = (globalThis as { __langRoot?: string }).__langRoot;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
});

const langRoot = (): string =>
  (globalThis as { __langRoot?: string }).__langRoot as string;

// `|` 标记光标位置。
const cursorOf = (template: string): { text: string; position: Position } => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return { text, position: new Position(line, character) };
};

const defDocument = (template: string, name = 'Sample.def'): { document: MinimalTextDocument; position: Position } => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, { fileName: p(langRoot(), 'scripts', 'entity_defs', name) }),
    position
  };
};

const labelsOf = (items: CompletionItem[]): string[] => items.map(item => item.label);

describe('def tag completion', () => {
  const provider = new KBEngineCompletionProvider();
  const complete = (template: string, name = 'Sample.def'): CompletionItem[] => {
    const { document, position } = defDocument(template, name);
    const items = provider.provideCompletionItems(document, position);
    return Array.isArray(items) ? items as CompletionItem[] : [];
  };

  it('offers the top-level tags below an empty root', () => {
    expect(labelsOf(complete('<root>\n  <|'))).toEqual([
      'Parent', 'Interfaces', 'Components', 'Properties',
      'BaseMethods', 'CellMethods', 'ClientMethods', 'DetailLevels', 'Volatile'
    ]);
  });

  it('offers property child tags inside an existing property', () => {
    expect(labelsOf(complete([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <|',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n')))).toEqual([
      'Type', 'Flags', 'Default', 'Persistent', 'Identifier',
      'Index', 'DatabaseLength', 'DetailLevel', 'Utype'
    ]);
  });

  it('offers nothing when opening a new property inside Properties', () => {
    expect(complete([
      '<root>',
      '  <Properties>',
      '    <|',
      '  </Properties>',
      '</root>'
    ].join('\n'))).toEqual([]);
  });

  it('splits method child tags by section', () => {
    const base = labelsOf(complete([
      '<root>',
      '  <BaseMethods>',
      '    <onSave>',
      '      <|',
      '    </onSave>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n')));
    expect(base).toEqual(['Arg', 'Utype', 'Exposed']);

    const client = labelsOf(complete([
      '<root>',
      '  <ClientMethods>',
      '    <say>',
      '      <|',
      '    </say>',
      '  </ClientMethods>',
      '</root>'
    ].join('\n')));
    expect(client).toEqual(['Arg', 'Utype']);
  });

  it('offers interface reference tags inside Interfaces', () => {
    expect(labelsOf(complete([
      '<root>',
      '  <Interfaces>',
      '    <|',
      '  </Interfaces>',
      '</root>'
    ].join('\n')))).toEqual(['Interface', 'interface', 'Type', 'type']);
  });

  it('offers volatile fields and detail level structures', () => {
    expect(labelsOf(complete([
      '<root>',
      '  <Volatile>',
      '    <|',
      '  </Volatile>',
      '</root>'
    ].join('\n')))).toEqual(['position', 'yaw', 'pitch', 'roll', 'optimized']);

    expect(labelsOf(complete([
      '<root>',
      '  <DetailLevels>',
      '    <|',
      '  </DetailLevels>',
      '</root>'
    ].join('\n')))).toEqual(['NEAR', 'MEDIUM', 'FAR']);

    expect(labelsOf(complete([
      '<root>',
      '  <DetailLevels>',
      '    <NEAR>',
      '      <|',
      '    </NEAR>',
      '  </DetailLevels>',
      '</root>'
    ].join('\n')))).toEqual(['radius', 'hyst']);
  });

  it('offers nothing inside Components and Parent sections', () => {
    expect(complete([
      '<root>',
      '  <Components>',
      '    <|',
      '  </Components>',
      '</root>'
    ].join('\n'))).toEqual([]);
    expect(complete([
      '<root>',
      '  <Parent>',
      '    <|',
      '  </Parent>',
      '</root>'
    ].join('\n'))).toEqual([]);
  });

  it('forces the ARRAY element tag to of', () => {
    expect(labelsOf(complete([
      '<root>',
      '  <Properties>',
      '    <bag>',
      '      <Type>ARRAY <|',
      '    </bag>',
      '  </Properties>',
      '</root>'
    ].join('\n')))).toEqual(['of']);
  });

  it('completes known types with builtins, custom types and entity references', () => {
    const items = complete([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UI|',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    const names = labelsOf(items);

    expect(names).toContain('UINT32');
    expect(names).toContain('ITEM_ID');
    expect(names).toContain('Hero');
    const custom = items.find(item => item.label === 'ITEM_ID');
    expect(custom?.detail).toBe('Custom type');
    const entity = items.find(item => item.label === 'Hero');
    expect(entity?.detail).toBe('Entity type');
    expect(items.every(item => item.kind === CompletionItemKind.Class)).toBe(true);
  });

  it('lists every flag without prefix filtering', () => {
    const items = complete([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Flags>C|',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    expect(items).toHaveLength(KBENGINE_FLAGS.length);
    expect(labelsOf(items)).toContain('CELL_PUBLIC');
    expect(items.every(item => item.kind === CompletionItemKind.Enum)).toBe(true);
  });

  it('lists the three detail levels as constants', () => {
    const items = complete([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <DetailLevel>N|',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    expect(labelsOf(items)).toEqual([...DETAIL_LEVELS]);
    expect(items.every(item => item.kind === CompletionItemKind.Constant)).toBe(true);
  });

  it('completes hook names by prefix inside method sections', () => {
    const items = complete([
      '<root>',
      '  <BaseMethods>',
      '    <onS|',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => item.label.toLowerCase().startsWith('ons'))).toBe(true);
    expect(items.every(item => item.kind === CompletionItemKind.Method)).toBe(true);
  });

  it('completes KBEngine reload functions and importlib.reload', () => {
    const expected = KBENGINE_RELOAD_FUNCTIONS.filter(fn => fn.name.startsWith('KBEngine.'));

    const kbItems = complete('self.cellData = KBEngine.|\n', 'Avatar.py');
    expect(labelsOf(kbItems)).toHaveLength(expected.length);
    expect(kbItems.every(item => !item.label.includes('.'))).toBe(true);

    const importlibItems = complete('importlib.|\n', 'Avatar.py');
    expect(labelsOf(importlibItems)).toEqual(['reload']);
  });

  it('returns nothing for ordinary def lines', () => {
    expect(complete([
      '<root>',
      '  <Properties>some text|</Properties>',
      '</root>'
    ].join('\n'))).toEqual([]);
  });
});

describe('hover', () => {
  const provider = new KBEngineHoverProvider();
  const hoverOn = (template: string, name = 'Sample.def'): string => {
    const { document, position } = defDocument(template, name);
    const hover = provider.provideHover(document, position) as Hover | null;
    if (!hover) {
      return '';
    }
    const contents = hover.contents;
    return Array.isArray(contents) ? contents.map(item => item.value).join('') : contents.value;
  };

  it('returns null away from any word', () => {
    expect(hoverOn('<root>|  </root>')).toBe('');
  });

  it('documents def tags from the tag table', () => {
    expect(hoverOn([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Persis|tent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'))).toContain('**Persistent**');
  });

  it('documents builtin types, flags and detail levels', () => {
    const typeDoc = hoverOn([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT3|2</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(typeDoc).toContain('**UINT32**');

    const flagDoc = hoverOn([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Flags>CELL_PUBLI|C</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(flagDoc).toContain('**CELL_PUBLIC**');

    const levelDoc = hoverOn([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <DetailLevel>NEA|R</DetailLevel>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(levelDoc).toContain('**NEAR**');
  });

  it('documents lifecycle hooks by their metadata', () => {
    const hook = KBENGINE_HOOKS.find(candidate => candidate.name.startsWith('onS'));
    expect(hook).toBeDefined();
    const name = hook!.name;
    const half = Math.ceil(name.length / 2);

    const doc = hoverOn([
      '<root>',
      `  <BaseMethods>`,
      `    <${name.slice(0, half)}|${name.slice(half)}/>`,
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    expect(doc).toContain(`**${name}**`);
  });

  it('describes property symbols with their declared fields', () => {
    const doc = hoverOn([
      '<root>',
      '  <Properties>',
      '    <h|p>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Default>10</Default>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    expect(doc).toContain('**hp**');
    expect(doc).toContain('属性区块中的自定义定义');
    expect(doc).toContain('**Type**: `UINT32`');
    expect(doc).toContain('**Flags**: `BASE`');
    expect(doc).toContain('**Default**: `10`');
  });

  it('describes method symbols with arg count and exposed marker', () => {
    const doc = hoverOn([
      '<root>',
      '  <BaseMethods>',
      '    <onSa|ve>',
      '      <Arg>UINT32</Arg>',
      '      <Exposed/>',
      '    </onSave>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    expect(doc).toContain('**onSave**');
    expect(doc).toContain('**参数个数**: 1');
    expect(doc).toContain('**Args**: `UINT32`');
    expect(doc).toContain('**Exposed**: `true`');
  });

  it('describes entity references inside a Type value', () => {
    const doc = hoverOn([
      '<root>',
      '  <Properties>',
      '    <target>',
      '      <Type>Monste|r</Type>',
      '    </target>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    expect(doc).toContain('**Monster**');
    expect(doc).toContain('Entity type');
    expect(doc).toContain('**Definition**: `Monster.def`');
  });

  it('describes custom types inside a Type value', () => {
    const doc = hoverOn([
      '<root>',
      '  <Properties>',
      '    <itemId>',
      '      <Type>ITEM_I|D</Type>',
      '    </itemId>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    expect(doc).toContain('**ITEM_ID**');
    expect(doc).toContain('**AliasType**: `UINT16`');
  });
});

describe('validateDocument diagnostics', () => {
  // 诊断校验与光标无关,直接以全文为输入。
  const validate = (text: string, name = 'Diag.def'): Diagnostic[] => {
    const document = makeTextDocument(text, { fileName: p(langRoot(), 'scripts', 'entity_defs', name) });
    const collection = new DiagnosticCollection();
    validateDocument(document, collection);
    return collection.get(document.uri);
  };

  it('reports unknown flag values as errors', () => {
    const diags = validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>NOT_A_FLAG</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('未知的 KBEngine Flags 值: NOT_A_FLAG');
  });

  it('accepts normalized and legacy flag spellings', () => {
    expect(validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>base</Flags>',
      '    </hp>',
      '    <mana>',
      '      <Type>UINT32</Type>',
      '      <Flags>CELL_AND_CLIENT</Flags>',
      '    </mana>',
      '  </Properties>',
      '</root>'
    ].join('\n'))).toEqual([]);
  });

  it('reports unknown detail levels as errors', () => {
    const diags = validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <DetailLevel>SUPER</DetailLevel>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('未知的 DetailLevel: SUPER');
  });

  it('reports unregistered custom types as errors', () => {
    const diags = validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>NOT_A_TYPE</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('自定义类型 NOT_A_TYPE 未在 types.xml 中注册');
  });

  it('warns when a registered custom type misses its python file', () => {
    const diags = validate([
      '<root>',
      '  <Properties>',
      '    <doll>',
      '      <Type>DOLL</Type>',
      '      <Flags>BASE</Flags>',
      '    </doll>',
      '    <phone>',
      '      <Type>PHONE</Type>',
      '      <Flags>BASE</Flags>',
      '    </phone>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    // DOLL 无 user_type/item/doll.py → Warning;PHONE 有 → 无诊断
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(diags[0].message).toContain('user_type/DOLL.py');
  });

  it('reports properties missing Type or Flags definitions', () => {
    const diags = validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Default>0</Default>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
    expect(errors.map(d => d.message)).toEqual([
      '属性 hp 缺少 <Type> 定义',
      '属性 hp 缺少 <Flags> 定义'
    ]);
  });

  it('reports duplicate methods with warning plus info pair', () => {
    const diags = validate([
      '<root>',
      '  <BaseMethods>',
      '    <onSave><Exposed/></onSave>',
      '    <onSave><Exposed/></onSave>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    expect(diags.map(d => d.severity)).toEqual([
      DiagnosticSeverity.Warning,
      DiagnosticSeverity.Information
    ]);
    expect(diags[0].message).toContain('方法区块中存在重复定义: onSave');
    expect(diags[1].message).toContain('onSave 在 方法区块 中已定义');
  });

  it('dedupes properties per flag scope', () => {
    const sameScope = validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(sameScope.map(d => d.severity)).toEqual([
      DiagnosticSeverity.Warning,
      DiagnosticSeverity.Information
    ]);
    expect(sameScope[0].message).toContain('属性区块中存在重复定义: hp (Base)');
    expect(sameScope[1].message).toContain('已在 Base 作用域定义');

    const crossScope = validate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>CELL_PUBLIC</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(crossScope).toEqual([]);
  });

  it('clears existing diagnostics when diagnostics are disabled', () => {
    const document = makeTextDocument('<root>\n</root>', {
      fileName: p(langRoot(), 'scripts', 'entity_defs', 'Toggle.def')
    });
    const collection = new DiagnosticCollection();
    collection.set(document.uri, [new Diagnostic(
      new Range(new Position(0, 0), new Position(0, 1)),
      'stale',
      DiagnosticSeverity.Error
    )]);

    const configStub = stubWorkspace.getConfiguration;
    stubWorkspace.getConfiguration = (() => ({
      get: (_key: string, defaultValue: unknown) => (defaultValue === true ? false : defaultValue)
    })) as unknown as typeof stubWorkspace.getConfiguration;
    try {
      validateDocument(document, collection);
    } finally {
      stubWorkspace.getConfiguration = configStub;
    }

    expect(collection.get(document.uri)).toEqual([]);
  });

  it('reports nothing for malformed documents', () => {
    expect(validate('<root><Properties</root>', 'Bad.def')).toEqual([]);
  });
});

describe('definition navigation', () => {
  const provider = new KBEngineDefinitionProvider();
  const locate = (template: string, name: string): Location | null | undefined => {
    const { document, position } = defDocument(template, name);
    return provider.provideDefinition(document, position) as Location | null;
  };

  it('jumps from an entities.xml registration to the def file', () => {
    const location = locate([
      '<root>',
      '  <Hero| hasBase="true"/>',
      '</root>'
    ].join('\n'), 'entities.xml');

    expect(location?.uri.fsPath).toBe(p(langRoot(), 'scripts', 'entity_defs', 'Hero.def'));
    expect(location?.range.start).toEqual(new Position(0, 0));
  });

  it('jumps from a self-closing Interfaces tag to the interface def', () => {
    const location = locate([
      '<root>',
      '  <Interfaces>',
      '    <MoveI|face/>',
      '  </Interfaces>',
      '</root>'
    ].join('\n'), 'Hero.def');

    expect(location?.uri.fsPath).toBe(
      p(langRoot(), 'scripts', 'entity_defs', 'interfaces', 'MoveIface.def')
    );
  });

  it('jumps from a Type value to the component def', () => {
    const location = locate([
      '<root>',
      '  <Components>',
      '    <healthPack>',
      '      <Type>HealthCo|mp</Type>',
      '    </healthPack>',
      '  </Components>',
      '</root>'
    ].join('\n'), 'Hero.def');

    expect(location?.uri.fsPath).toBe(
      p(langRoot(), 'scripts', 'entity_defs', 'components', 'HealthComp.def')
    );
    expect(location?.range.start).toEqual(new Position(0, 0));
  });

  it('jumps from a Type value to the types.xml declaration line', () => {
    const location = locate([
      '<root>',
      '  <Properties>',
      '    <itemId>',
      '      <Type>ITEM_I|D</Type>',
      '    </itemId>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Hero.def');

    expect(location?.uri.fsPath).toBe(p(langRoot(), 'scripts', 'entity_defs', 'types.xml'));
    // ITEM_ID 声明在 1-based 第 2 行 → Position(line-1)
    expect(location?.range.start.line).toBe(1);
  });

  it('returns null for unknown words in def documents', () => {
    expect(locate([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>unknownwor|d</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Hero.def')).toBeNull();
  });

  it('returns null for python documents', () => {
    const py = makeTextDocument('self.hp = 1  # note\n', {
      fileName: p(langRoot(), 'scripts', 'Avatar.py'),
      languageId: 'python'
    });

    expect(provider.provideDefinition(py, new Position(0, 19))).toBeNull();
  });
});
