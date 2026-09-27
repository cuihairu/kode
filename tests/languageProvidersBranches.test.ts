import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineCompletionProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  PythonDefinitionProvider,
  validateDocument
} from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import {
  Diagnostic,
  DiagnosticCollection,
  Position,
  Uri,
  configurationOverrides,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// languageProviders 批64 分支补测:补齐各 provider 的假臂(错配闭标补全、
// 非 py/def 文件的 KBEngine./importlib. 补全空回落、悬停开关的关断臂、
// entities.xml 未注册实体的 definition/hover 回落、结构诊断关断后标量诊断
// 保留、DetailLevel 三态、无 Type/无 Arg/无 Exposed 的符号悬停、implementedBy
// 即文档根时的祖查找 null 回落、Arg/Interfaces/Parent 跳转的未命中回落、
// 补全去重的内建优先/自定义优先、PythonDefinitionProvider 全解析失败的
// null 回落)。不可达臂以精确单行/合并区间 ignore 定案,见源码注记。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

let root = '';
let weird = '';

const write = (base: string, relative: string, content: string): void => {
  const target = p(base, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lang-branch-'));
  weird = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lang-weird-'));

  write(root, 'scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <NoDef/>',
    '</root>'
  ].join('\n'));
  // 布局候选取 scripts/entities.xml,这份 assets 下的同名文件不进注册快照
  write(root, 'assets/scripts/entities.xml', [
    '<root>',
    '  <Oddball/>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '    </hp>',
    '    <BARE/>',
    '    <dup><Type>NOSUCH</Type></dup>',
    '    <dup><Type>NOSUCH</Type></dup>',
    '    <lvA><Type>UINT8</Type><DetailLevel>NEAR</DetailLevel></lvA>',
    '    <lvB><Type>UINT8</Type><DetailLevel>BLAH</DetailLevel></lvB>',
    '    <lvC><Type>UINT8</Type><DetailLevel></DetailLevel></lvC>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onKill>',
    '      <Arg>ENTITY_ID</Arg>',
    '      <Exposed>true</Exposed>',
    '    </onKill>',
    '    <noargs/>',
    '    <onSee>',
    '      <Arg>NOSUCHENTITY</Arg>',
    '    </onSee>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/Child.def', [
    '<root>',
    '  <Parent Ghost/>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/components/Comp.def', [
    '<root>',
    '  <Parent Unknown/>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/components/Known.def', '<root>\n</root>');
  write(root, 'scripts/entity_defs/interfaces/Iface1.def', '<root>\n</root>');
  // 自定义类型 UINT32 与内建同名、Hero 与注册实体同名,服务去重臂
  write(root, 'scripts/entity_defs/types.xml', [
    '<root>',
    '  <UINT32><Type>UINT8</Type></UINT32>',
    '  <Hero><Type>UINT8</Type></Hero>',
    '</root>'
  ].join('\n'));

  // 文档根即 <implementedBy> 的畸形 types.xml:祖查找拿到无父节点
  write(weird, 'scripts/entity_defs/types.xml', '<implementedBy>item.doll</implementedBy>');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(weird, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  configurationOverrides.delete('kbengine');
});

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

const docAt = (
  base: string,
  template: string,
  fileName: string,
  languageId?: string
): { document: MinimalTextDocument; position: Position } => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, {
      fileName: p(base, ...fileName.split('/')),
      languageId
    }),
    position
  };
};

const defAt = (template: string, name = 'Sample.def') =>
  docAt(root, template, `scripts/entity_defs/${name}`, 'kbengine-def');

const defDoc = (lines: string[], name: string): MinimalTextDocument =>
  makeTextDocument(lines.join('\n'), {
    fileName: p(root, 'scripts/entity_defs', name),
    languageId: 'kbengine-def'
  });

const hoverText = (hover: unknown): string => {
  const contents = (hover as { contents: unknown }).contents;
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number; character: number } };
}

const collectDiagnostics = (document: MinimalTextDocument): Diagnostic[] => {
  const store = new Map<string, Diagnostic[]>();
  const collection = {
    set(uri: Uri, diagnostics: Diagnostic[]) {
      store.set(uri.toString(), diagnostics);
    },
    delete(uri: Uri) {
      store.delete(uri.toString());
    }
  } as unknown as DiagnosticCollection;
  validateDocument(document, collection);
  return store.get(document.uri.toString()) || [];
};

const useConfig = (overrides: Record<string, unknown>): (() => void) => {
  configurationOverrides.set('kbengine', overrides);
  return () => configurationOverrides.delete('kbengine');
};

describe('def tag completion fallbacks', () => {
  const provider = new KBEngineCompletionProvider();
  const complete = (template: string, name = 'Sample.def'): string[] => {
    const { document, position } = defAt(template, name);
    return (provider.provideCompletionItems(document, position) as Array<{ label: string }>)
      .map(item => item.label);
  };

  it('keeps the stack intact when a close tag matches nothing', () => {
    // </zzz> 不在栈中:自顶向下逐项失配后不弹栈,后续闭标照常收缩
    const labels = complete([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '    </zzz>',
      '  </hp>',
      '</Properties>',
      '<|'
    ].join('\n'));

    expect(labels).toEqual([
      'Parent', 'Interfaces', 'Components', 'Properties',
      'BaseMethods', 'CellMethods', 'ClientMethods', 'DetailLevels', 'Volatile'
    ]);
  });

  it("offers nothing for 'KBEngine.'/'importlib.' outside .py/.def documents", () => {
    const kbengine = docAt(root, 'KBEngine.|', 'notes.txt');
    expect(provider.provideCompletionItems(kbengine.document, kbengine.position)).toEqual([]);

    const importlib = docAt(root, 'importlib.|', 'notes.txt');
    expect(provider.provideCompletionItems(importlib.document, importlib.position)).toEqual([]);
  });

  it('keeps builtin detail over same-named custom types and custom detail over entities', () => {
    const labels = complete([
      '<root>',
      '  <Properties>',
      '    <x>',
      '      <Type>U|</Type>',
      '    </x>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Sample.def');
    const detailOf = (name: string): string | undefined => {
      const { document, position } = defAt([
        '<root>',
        '  <Properties>',
        '    <x>',
        '      <Type>U|</Type>',
        '    </x>',
        '  </Properties>',
        '</root>'
      ].join('\n'));
      const items = provider.provideCompletionItems(document, position) as Array<{
        label: string; detail?: string;
      }>;
      return items.find(item => item.label === name)?.detail;
    };

    expect(labels).toContain('UINT32');
    expect(labels).toContain('Hero');
    expect(labels).toContain('NoDef');
    // UINT32:内建先行,自定义同名被跳过 ⇒ 保留内建 detail
    expect(detailOf('UINT32')).not.toBe('Custom type');
    // Hero:自定义先行,实体同名被跳过 ⇒ 保留自定义 detail
    expect(detailOf('Hero')).toBe('Custom type');
    // 对照:仅注册实体的 NoDef 走实体 detail
    expect(detailOf('NoDef')).toBe('Entity type');
  });
});

describe('hover feature-flag gates', () => {
  const provider = new KBEngineHoverProvider();

  it('suppresses symbol hover when hover.showSymbolDocs is off', () => {
    // 正对照:默认开启时属性名有符号悬停
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <h|p>',
      '      <Type>UINT32</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Flags.def');
    expect(hoverText(provider.provideHover(document, position))).toContain('**hp**');

    const restore = useConfig({ 'hover.showSymbolDocs': false });
    try {
      expect(provider.provideHover(document, position)).toBeNull();
    } finally {
      restore();
    }
  });

  it('suppresses tag docs when hover.showTagDocs is off', () => {
    const { document, position } = defAt('<r|oot>\n</root>', 'Root.def');
    // 正对照:默认开启时 root 标签有文档悬停
    expect(hoverText(provider.provideHover(document, position))).toContain('**root**');

    const restore = useConfig({ 'hover.showTagDocs': false });
    try {
      expect(provider.provideHover(document, position)).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('symbol hover optional lines', () => {
  const provider = new KBEngineHoverProvider();

  it('omits the Type line for a property without a Type child', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <BA|RE/>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Bare.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('**BARE**');
    expect(text).not.toContain('**Type**');
  });

  it('omits Args/Exposed lines for a method without Arg or Exposed children', () => {
    const bare = defAt([
      '<root>',
      '  <BaseMethods>',
      '    <noa|rgs/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'), 'Bare.def');
    const bareText = hoverText(provider.provideHover(bare.document, bare.position));
    expect(bareText).toContain('**参数个数**: 0');
    expect(bareText).not.toContain('**Args**');
    expect(bareText).not.toContain('**Exposed**');

    // 正对照:带 Arg/Exposed 的方法两行俱全
    const full = defAt([
      '<root>',
      '  <BaseMethods>',
      '    <onK|ill>',
      '      <Arg>ENTITY_ID</Arg>',
      '      <Exposed>true</Exposed>',
      '    </onKill>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'), 'Bare.def');
    const fullText = hoverText(provider.provideHover(full.document, full.position));
    expect(fullText).toContain('**Args**: `ENTITY_ID`');
    expect(fullText).toContain('**Exposed**: `true`');
  });
});

describe('entities.xml fallbacks', () => {
  const hoverProvider = new KBEngineHoverProvider();
  const definitionProvider = new KBEngineDefinitionProvider();

  it('returns null definition for an entity whose .def file is missing', () => {
    // assets 下的 entities.xml 不被布局候选选中 ⇒ 注册快照里没有 Oddball,
    // findEntityDefinitionFile 也找不到 Oddball.def ⇒ defPath 为 null
    const { document, position } = docAt(root, '<root>\n  <Od|dball/>\n</root>', 'assets/scripts/entities.xml');
    expect(definitionProvider.provideDefinition(document, position)).toBeNull();

    // 正对照:注册实体 Hero 命中 Hero.def
    const hero = docAt(root, '<root>\n  <He|ro hasBase="true"/>\n</root>', 'scripts/entities.xml');
    const location = definitionProvider.provideDefinition(hero.document, hero.position) as unknown as LocationLike;
    expect(location.uri.fsPath).toContain(path.join('entity_defs', 'Hero.def'));
  });

  it('renders the registration hover without runtime lines for an unregistered entity', () => {
    const { document, position } = docAt(root, '<root>\n  <Od|dball/>\n</root>', 'assets/scripts/entities.xml');
    const text = hoverText(hoverProvider.provideHover(document, position));
    expect(text).toContain('**Oddball**');
    expect(text).toContain('Entity registration from `entities.xml`');
    expect(text).not.toContain('**Base**');

    // 正对照:注册实体带运行时档案行
    const hero = docAt(root, '<root>\n  <He|ro hasBase="true"/>\n</root>', 'scripts/entities.xml');
    const heroText = hoverText(hoverProvider.provideHover(hero.document, hero.position));
    expect(heroText).toContain('**Base**');
  });
});

describe('definition reference fallbacks in .def documents', () => {
  const provider = new KBEngineDefinitionProvider();

  it('returns null for an unknown Arg entity reference', () => {
    // 光标落在 Arg 文本节点:非元素节点取父元素(自闭合判定为假),
    // findEntityDefinitionFile 未命中 ⇒ 各级守卫逐级放行后 null
    const { document, position } = defAt([
      '<root>',
      '  <BaseMethods>',
      '    <onSee>',
      '      <Arg>NOSUCHENTITY|</Arg>',
      '    </onSee>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'), 'Refs.def');

    expect(provider.provideDefinition(document, position)).toBeNull();
  });

  it('returns null for an unknown interface reference and jumps for a known one', () => {
    const miss = defAt([
      '<root>',
      '  <Interfaces>',
      '    <Iface|X/>',
      '  </Interfaces>',
      '</root>'
    ].join('\n'), 'Iface.def');
    expect(provider.provideDefinition(miss.document, miss.position)).toBeNull();

    const hit = defAt([
      '<root>',
      '  <Interfaces>',
      '    <Iface|1/>',
      '  </Interfaces>',
      '</root>'
    ].join('\n'), 'Iface.def');
    const location = provider.provideDefinition(hit.document, hit.position) as unknown as LocationLike;
    expect(location.uri.fsPath).toContain(path.join('interfaces', 'Iface1.def'));
  });

  it('returns null for an unknown Parent sibling and jumps for a registered one', () => {
    const miss = defAt([
      '<root>',
      '  <Parent Gh|ost/>',
      '</root>'
    ].join('\n'), 'Child.def');
    expect(provider.provideDefinition(miss.document, miss.position)).toBeNull();

    const hit = defAt([
      '<root>',
      '  <Parent He|ro/>',
      '</root>'
    ].join('\n'), 'Child.def');
    const location = provider.provideDefinition(hit.document, hit.position) as unknown as LocationLike;
    expect(location.uri.fsPath).toContain(path.join('entity_defs', 'Hero.def'));
  });

  it('falls through to entity lookup for an unknown component parent inside components/', () => {
    const miss = docAt(root, [
      '<root>',
      '  <Parent Un|known/>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/components/Comp.def', 'kbengine-def');
    expect(provider.provideDefinition(miss.document, miss.position)).toBeNull();

    // 正对照:组件目录下的同名定义可命中
    const hit = docAt(root, [
      '<root>',
      '  <Parent Kn|own/>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/components/Comp.def', 'kbengine-def');
    const location = provider.provideDefinition(hit.document, hit.position) as unknown as LocationLike;
    expect(location.uri.fsPath).toContain(path.join('components', 'Known.def'));
  });
});

describe('implementedBy as document root', () => {
  const hoverProvider = new KBEngineHoverProvider();
  const definitionProvider = new KBEngineDefinitionProvider();

  it('resolves to no hover and no definition when implementedBy has no parent', () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(weird), name: 'weird', index: 0 }];
    try {
      // 文档根即 <implementedBy>:祖查找命中其自身,取 parent 得 undefined ⇒ null
      const { document, position } = docAt(
        weird,
        '<implementedBy>item.do|ll</implementedBy>',
        'scripts/entity_defs/types.xml'
      );
      expect(hoverProvider.provideHover(document, position)).toBeNull();
      expect(definitionProvider.provideDefinition(document, position)).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    }
  });
});

describe('diagnostics gates', () => {
  it('keeps scalar unknown-type diagnostics when structure diagnostics are off', () => {
    const document = defDoc([
      '<root>',
      '  <Properties>',
      '    <dup><Type>NOSUCH</Type><Flags>CELL_PUBLIC</Flags></dup>',
      '    <dup><Type>NOSUCH</Type><Flags>CELL_PUBLIC</Flags></dup>',
      '  </Properties>',
      '</root>'
    ], 'Dup.def');

    const defaultMessages = collectDiagnostics(document).map(d => d.message);
    expect(defaultMessages.some(m => m.includes('属性区块中存在重复定义'))).toBe(true);
    expect(defaultMessages.some(m => m.includes('未在 types.xml 中注册'))).toBe(true);

    const restore = useConfig({ enableStructureDiagnostics: false });
    try {
      const messages = collectDiagnostics(document).map(d => d.message);
      expect(messages.some(m => m.includes('属性区块中存在重复定义'))).toBe(false);
      expect(messages.some(m => m.includes('未在 types.xml 中注册'))).toBe(true);
    } finally {
      restore();
    }
  });

  it('only reports invalid non-empty DetailLevel values when the check is on', () => {
    const document = defDoc([
      '<root>',
      '  <Properties>',
      '    <lvA><Type>UINT8</Type><DetailLevel>NEAR</DetailLevel></lvA>',
      '    <lvB><Type>UINT8</Type><DetailLevel>BLAH</DetailLevel></lvB>',
      '    <lvC><Type>UINT8</Type><DetailLevel></DetailLevel></lvC>',
      '  </Properties>',
      '</root>'
    ], 'Levels.def');

    const defaultMessages = collectDiagnostics(document).map(d => d.message);
    expect(defaultMessages.filter(m => m.includes('未知的 DetailLevel'))).toHaveLength(1);
    expect(defaultMessages.some(m => m.includes('BLAH'))).toBe(true);

    const restore = useConfig({ 'diagnostics.checkUnknownDetailLevels': false });
    try {
      const messages = collectDiagnostics(document).map(d => d.message);
      expect(messages.some(m => m.includes('未知的 DetailLevel'))).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('PythonDefinitionProvider full-miss fallback', () => {
  it('returns null when neither the property nor the method resolves', async () => {
    const manager = {
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = docAt(
      root,
      'x = self.ba|g.items\n',
      'scripts/base/Hero.py',
      'python'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });
});
