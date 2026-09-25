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
import {
  Diagnostic,
  DiagnosticCollection,
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';
import { KBENGINE_HOOKS } from '../src/hooks';

// languageProviders 的 provider 入口层缺口:标签栈的闭合/自闭合维护、
// 顶层标签与方法段的空回落、Type 值自定义类型与实体注册悬停、python
// 文档的钩子/热更函数悬停与未知词 null、types.xml 的自定义类型与类型
// 值定义跳转、结构诊断的未知顶层标签与无值 Type 早退、别名 Flags 的
// 归一。真实编辑器集成由 mocha 层覆盖;数据库 schema 虚拟文档跳转与
// python 自补全链路留给后续批次。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lang-gap-'));
  const write = (relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_AND_CLIENTS</Flags>',
    '      <DetailLevel>NEAR</DetailLevel>',
    '      <DatabaseLength>128</DatabaseLength>',
    '      <Identifier>true</Identifier>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Gap.def', [
    '<root>',
    '  <UnknownSection>',
    '    <anything/>',
    '  </UnknownSection>',
    '  <Properties>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '    </bag>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <DOLL>',
    '    <Type>UINT32</Type>',
    '    <implementedBy>item.doll</implementedBy>',
    '  </DOLL>',
    '  <GIFT>',
    '    <Type>DOLL</Type>',
    '  </GIFT>',
    '</root>'
  ].join('\n'));
  write('user_type/item/doll.py', 'class Doll(object):\n    pass\n');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
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
  template: string,
  fileName: string,
  languageId?: string
): { document: MinimalTextDocument; position: Position } => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, {
      fileName: p(root, ...fileName.split('/')),
      languageId
    }),
    position
  };
};

const defAt = (template: string, name = 'Sample.def') =>
  docAt(template, `scripts/entity_defs/${name}`, 'kbengine-def');

const fullDoc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, {
    fileName: p(root, ...fileName.split('/')),
    languageId: 'kbengine-def'
  });

const labelsOf = (items: { label: string }[]): string[] => items.map(item => item.label);

const hoverText = (hover: unknown): string => {
  const contents = (hover as { contents: unknown }).contents;
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

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

describe('def completion stack maintenance', () => {
  const provider = new KBEngineCompletionProvider();
  const complete = (template: string, name = 'Sample.def') => {
    const { document, position } = defAt(template, name);
    const items = provider.provideCompletionItems(document, position);
    return Array.isArray(items) ? (items as { label: string }[]) : [];
  };

  it('removes closed and self-closing tags from the open tag stack', () => {
    // 光标前有完整闭合块(入栈后出栈)与自闭合标签(直接跳过)
    const hook = KBENGINE_HOOKS[0].name;
    const items = complete([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT8</Type>',
      '      <Exposed/>',
      '    </hp>',
      '  </Properties>',
      '  <BaseMethods>',
      `    <${hook.slice(0, 5)}|`
    ].join('\n'));

    // 方法段前缀补全走钩子名,证明栈上只剩 root/BaseMethods/方法标签
    expect(labelsOf(items)).toContain(hook);
  });

  it('offers nothing for direct children of method sections', () => {
    const items = complete([
      '<root>',
      '  <BaseMethods>',
      '    <|'
    ].join('\n'));
    expect(items).toEqual([]);
  });

  it('offers nothing for deeply nested contexts', () => {
    const items = complete([
      '<root>',
      '  <Properties>',
      '    <bag>',
      '      <Type>',
      '        <of>',
      '          <DOLL>',
      '            <|'
    ].join('\n'));
    expect(items).toEqual([]);
  });

  it('offers reload member after importlib prefix', () => {
    const items = complete('importlib.|', 'scripts/base/Hero.py');
    expect(labelsOf(items)).toEqual(['reload']);
  });
});

describe('hover entry branches', () => {
  const provider = new KBEngineHoverProvider();
  const hoverAt = (
    template: string,
    fileName: string,
    languageId?: string
  ): unknown => {
    const { document, position } = docAt(template, fileName, languageId);
    return provider.provideHover(document, position);
  };

  it('hovers a custom type from types.xml inside a Type value', () => {
    const hover = hoverAt([
      '<root>',
      '  <Properties>',
      '    <doll>',
      '      <Type>DOL|L</Type>',
      '    </doll>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/Sample.def', 'kbengine-def');

    expect(hover).toBeTruthy();
    const text = hoverText(hover);
    expect(text).toContain('DOLL');
    expect(text).toContain('item.doll');
  });

  it('hovers a custom type element name inside types.xml', () => {
    const hover = hoverAt([
      '<root>',
      '  <DOLL>',
      '    <Type>UINT32</Type>',
      '    <implementedBy>item.doll</implementedBy>',
      '  </DOLL>',
      '</root>'
    ].join('\n').replace('DOLL', 'DO|LL'), 'scripts/entity_defs/types.xml');

    expect(hover).toBeTruthy();
    const text = hoverText(hover);
    expect(text).toContain('DOLL');
    expect(text).toContain('item.doll');
  });

  it('hovers an entity registration inside entities.xml', () => {
    const hover = hoverAt([
      '<root>',
      '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
      '</root>'
    ].join('\n').replace('Hero', 'He|ro'), 'scripts/entities.xml');

    expect(hover).toBeTruthy();
    const text = hoverText(hover);
    expect(text).toContain('Hero');
    expect(text).toContain('Base');
    expect(text).toContain('Cell');
    expect(text).toContain('Client');
  });

  it('hovers a hook name early in a python document', () => {
    const hook = KBENGINE_HOOKS[0].name;
    const hover = hoverAt([
      'class Hero:',
      `    def ${hook}(self):`,
      '        pass'
    ].join('\n').replace(hook, `${hook.slice(0, 2)}|${hook.slice(2)}`), 'scripts/base/Hero.py', 'python');

    expect(hover).toBeTruthy();
    expect(hoverText(hover)).toContain(hook);
  });

  it('hovers a reload function name in a python document', () => {
    const hover = hoverAt([
      'import KBEngine',
      'KBEngine.re|load("Hero")'
    ].join('\n'), 'scripts/base/Hero.py', 'python');

    expect(hover).toBeTruthy();
    expect(hoverText(hover)).toContain('reload');
  });

  it('returns null for an unknown word in a python document', () => {
    const hover = hoverAt([
      'class Hero:',
      '    zzzunknown = 1'
    ].join('\n').replace('zzzunknown', 'zzzunkno|wn'), 'scripts/base/Hero.py', 'python');

    expect(hover).toBeNull();
  });

  it('returns null when there is no word at the position', () => {
    const provider2 = new KBEngineDefinitionProvider();
    const { document, position } = defAt([
      '<root>',
      '  <|',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT8</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(provider2.provideDefinition(document, position)).toBeNull();
  });
});

describe('definition entry branches', () => {
  const provider = new KBEngineDefinitionProvider();
  const defineAt = (template: string, fileName: string): unknown => {
    const { document, position } = docAt(template, fileName, 'kbengine-def');
    return provider.provideDefinition(document, position);
  };

  it('jumps from a types.xml element name to its own definition line', () => {
    const location = defineAt([
      '<root>',
      '  <DOLL>',
      '    <Type>UINT32</Type>',
      '    <implementedBy>item.doll</implementedBy>',
      '  </DOLL>',
      '</root>'
    ].join('\n').replace('DOLL', 'DO|LL'), 'scripts/entity_defs/types.xml') as {
      uri: { fsPath: string };
      range: { start: { line: number } };
    };

    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('types.xml')).toBe(true);
    expect(location.range.start.line).toBe(1);
  });

  it('jumps from a type value reference to the types.xml element', () => {
    const location = defineAt([
      '<root>',
      '  <GIFT>',
      '    <Type>DOLL</Type>',
      '  </GIFT>',
      '</root>'
    ].join('\n').replace('DOLL', 'DO|LL'), 'scripts/entity_defs/types.xml') as {
      uri: { fsPath: string };
      range: { start: { line: number } };
    };

    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('types.xml')).toBe(true);
    expect(location.range.start.line).toBe(1);
  });
});

describe('diagnostics structure gaps', () => {
  it('skips unknown top-level sections and type nodes without values', () => {
    const document = fullDoc([
      '<root>',
      '  <UnknownSection>',
      '    <anything/>',
      '  </UnknownSection>',
      '  <Properties>',
      '    <bag>',
      '      <Type>',
      '        ARRAY',
      '        <of>UINT32</of>',
      '      </Type>',
      '    </bag>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/Gaps.def');

    const diagnostics = collectDiagnostics(document);
    // 未知顶层段被跳过不产生"未知标签"类诊断;带子元素的 Type 早退
    expect(diagnostics.every(d => !d.message.includes('UnknownSection'))).toBe(true);
    expect(diagnostics.every(d => !d.message.includes('ARRAY'))).toBe(true);
  });

  it('normalizes alias flags into canonical scopes', () => {
    const document = fullDoc([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>CELL_AND_CLIENTS</Flags>',
      '    </hp>',
      '    <mp>',
      '      <Type>UINT32</Type>',
      '      <Flags>CELL_AND_OTHER_CLIENTS</Flags>',
      '    </mp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/Alias.def');

    const diagnostics = collectDiagnostics(document);
    const joined = diagnostics.map(d => d.message).join('\n');
    // 别名归一为 CELL_PUBLIC_AND_OWN / OTHER_CLIENTS(不再报未知 Flags)
    expect(joined).not.toContain('CELL_AND_CLIENTS');
    expect(joined).not.toContain('CELL_AND_OTHER_CLIENTS');
  });

  it('reports nothing for an empty document without a root', () => {
    const document = fullDoc('', 'scripts/entity_defs/Empty.def');
    expect(collectDiagnostics(document)).toEqual([]);
  });
});
