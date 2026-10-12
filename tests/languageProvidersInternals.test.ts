import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider, KBEngineHoverProvider, validateDocument } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { getDatabaseSchemaSnapshot, renderDatabaseSchema } from '../src/databaseSchema';
import { messages } from './fake-vscode/windowState';
import {
  Diagnostic,
  DiagnosticCollection,
  Position,
  Uri,
  makeTextDocument,
  configurationOverrides,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// languageProviders 的悬停内部工具与数据库 schema 双向跳转:symbol 悬停的
// DetailLevel/DatabaseLength/Identifier/Args 附加行、FIXED_DICT 的
// Properties 详情、Type 值的实体/组件引用悬停与 runtime 档案行、
// registered 实体在无 workspace 时的空回落、诊断重复定义的四个区块
// 标签(父类/接口/组件/易变同步)、types.xml 的 implementedBy → python
// 跳转与非值位置 null 回落、def 属性 → schema 虚拟文档的正向跳转与
// schema 表/字段 → def 的反向跳转、带 EntityMappingManager 假例的
// def 方法 → python 实现跳转三分支。诊断侧自定义类型在无 workspace
// 或空 workspace 下的 unverifiable 回落也在此覆盖。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

let root = '';
let heroDefPath = '';
let heroDefLines: string[] = [];

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>CELL_AND_CLIENTS</Flags>',
  '      <DetailLevel>NEAR</DetailLevel>',
  '      <Persistent>true</Persistent>',
  '      <DatabaseLength>128</DatabaseLength>',
  '      <Identifier>true</Identifier>',
  '    </hp>',
  '    <ref>',
  '      <Type>Hero</Type>',
  '    </ref>',
  '    <comp>',
  '      <Type>NestedComp</Type>',
  '    </comp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <onKill>',
  '      <Arg>ENTITY_ID</Arg>',
  '      <Exposed>true</Exposed>',
  '    </onKill>',
  '    <onSee>',
  '      <Arg>Hero</Arg>',
  '    </onSee>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const ENTITIES_XML = [
  '<root>',
  '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
  '  <Watcher hasBase="true" hasCell="false" hasClient="true"/>',
  '  <Ghostless/>',
  '  <Scripted/>',
  '</root>'
].join('\n');

const TYPES_XML = [
  '<root>',
  '  <DOLL>',
  '    <Type>FIXED_DICT</Type>',
  '    <Properties>',
  '      <name><Type>UNICODE</Type></name>',
  '      <dbid/>',
  '    </Properties>',
  '    <implementedBy>item.doll</implementedBy>',
  '  </DOLL>',
  '  <GIFT>',
  '    <Type>DOLL</Type>',
  '  </GIFT>',
  '  <BROKEN>',
  '    <Type>UINT8</Type>',
  '    <implementedBy>nosuch.mod</implementedBy>',
  '  </BROKEN>',
  '</root>'
].join('\n');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lang-int-'));
  const write = (relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write('scripts/entities.xml', ENTITIES_XML);
  write('scripts/entity_defs/Hero.def', HERO_DEF);
  write('scripts/entity_defs/Watcher.def', [
    '<root>',
    '  <Properties>',
    '    <wv>',
    '      <Type>UINT8</Type>',
    '    </wv>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/types.xml', TYPES_XML);
  write('scripts/entity_defs/components/NestedComp.def', '<root></root>');
  write('scripts/entity_defs/BaseP.def', '<root></root>');
  write('scripts/base/Scripted.py', 'class Scripted(object):\n    pass\n');
  write('user_type/item/doll.py', 'class Doll(object):\n    pass\n');

  heroDefPath = p(root, 'scripts/entity_defs/Hero.def');
  heroDefLines = HERO_DEF.split('\n');

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

const hoverText = (hover: unknown): string => {
  const contents = (hover as { contents: unknown }).contents;
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

interface LocationLike {
  uri: { fsPath: string; scheme: string; toString(): string };
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

describe('symbol hover annotation lines', () => {
  const provider = new KBEngineHoverProvider();

  it('annotates DetailLevel, DatabaseLength and Identifier for a property', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <h|p>',
      '      <Type>UINT32</Type>',
      '      <DetailLevel>NEAR</DetailLevel>',
      '      <DatabaseLength>128</DatabaseLength>',
      '      <Identifier>true</Identifier>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Ann.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('**Type**: `UINT32`');
    expect(text).toContain('**DetailLevel**: `NEAR`');
    expect(text).toContain('**DatabaseLength**: `128`');
    expect(text).toContain('**Identifier**: `true`');
  });

  it('lists method args and the exposed marker', () => {
    const { document, position } = defAt([
      '<root>',
      '  <BaseMethods>',
      '    <onK|ill>',
      '      <Arg>ENTITY_ID</Arg>',
      '      <Exposed>true</Exposed>',
      '    </onKill>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'), 'Ann.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('**参数个数**: 1');
    expect(text).toContain('**Args**: `ENTITY_ID`');
    expect(text).toContain('**Exposed**: `true`');
  });

  it('renders a hover for reload function names', () => {
    const { document, position } = defAt([
      '<root>',
      '  <rel|oadScript/>',
      '</root>'
    ].join('\n'), 'Ann.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('reloadScript');
    expect(text).toContain('重新加载当前组件脚本');
  });

  it('suppresses hook value docs when showValueDocs is off', () => {
    // showValueDocs=false 关断值文档段(hook 尾部命中因此成为死分支)
    configurationOverrides.set('kbengine', { 'hover.showValueDocs': false });
    try {
      const { document, position } = defAt([
        '<root>',
        '  <onTi|mer/>',
        '</root>'
      ].join('\n'), 'Ann.def');

      expect(provider.provideHover(document, position)).toBeNull();
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });
});

describe('type value reference hovers', () => {
  const provider = new KBEngineHoverProvider();

  it('renders runtime profile lines for a registered entity type', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <ref>',
      '      <Type>He|ro</Type>',
      '    </ref>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Refs.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('Entity type');
    expect(text).toContain('Hero.def');
    expect(text).toContain('(declared, enabled)');
    expect(text).toContain('**Runtime**: `BaseApp / CellApp / Client`');
    expect(text).toContain('client SDK may generate');
  });

  it('references a component type from the components directory', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <comp>',
      '      <Type>NestedCo|mp</Type>',
      '    </comp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Refs.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('Component type');
    expect(text).toContain('NestedComp.def');
  });

  it('lists FIXED_DICT properties with an UNKNOWN type fallback', () => {
    const { document, position } = docAt([
      '<root>',
      '  <DOLL>',
      '    <Type>FIXED_DICT</Type>',
      '    <Properties>',
      '      <name><Type>UNICODE</Type></name>',
      '    </Properties>',
      '    <implementedBy>item.doll</implementedBy>',
      '  </DOLL>',
      '  <GIFT>',
      '    <Type>DO|LL</Type>',
      '  </GIFT>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('**Properties**:');
    expect(text).toContain('`name`: `UNICODE`');
    expect(text).toContain('`dbid`: `UNKNOWN`');
  });
});

describe('entity registration runtime hovers', () => {
  const provider = new KBEngineHoverProvider();
  const hoverEntities = (template: string): string => {
    const { document, position } = docAt(template, 'scripts/entities.xml');
    return hoverText(provider.provideHover(document, position));
  };

  it('marks undeclared facets without scripts as disabled', () => {
    const text = hoverEntities([
      '<root>',
      '  <Ghostle|ss/>',
      '</root>'
    ].join('\n'));

    expect(text).toContain('**Base**: `false` (not declared, no script)');
    expect(text).toContain('**Cell**: `false` (not declared, no script)');
    expect(text).toContain('**Client**: `false` (not declared, no script)');
    expect(text).toContain('**Runtime**: `None`');
    expect(text).toContain('client SDK will not create');
  });

  it('renders a declared-disabled cell facet for Watcher', () => {
    const text = hoverEntities([
      '<root>',
      '  <Wat|cher hasBase="true" hasCell="false" hasClient="true"/>',
      '</root>'
    ].join('\n'));

    expect(text).toContain('**Cell**: `false` (declared, disabled)');
    expect(text).toContain('**Base**: `true` (declared, enabled)');
  });

  it('falls back to registration flags without a workspace', () => {
    const saved = stubWorkspace.workspaceFolders;
    try {
      stubWorkspace.workspaceFolders = [];
      const text = hoverEntities([
        '<root>',
        '  <He|ro hasBase="true" hasCell="true" hasClient="true"/>',
        '</root>'
      ].join('\n'));

      // 无 workspace:注册表读不到,runtime 行整体缺席
      expect(text).not.toContain('**Base**');
      expect(text).toContain('Hero.def');
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });

  it('infers an enabled facet from an existing script without a declaration', () => {
    const text = hoverEntities([
      '<root>',
      '  <Scri|pted/>',
      '</root>'
    ].join('\n'));

    expect(text).toContain('**Base**: `true` (inferred from script)');
    expect(text).toContain('**Cell**: `false` (not declared, no script)');
  });

  it('returns null for a word in a malformed entities.xml document', () => {
    const { document, position } = docAt('not xm|l at all', 'scripts/entities.xml');
    expect(provider.provideHover(document, position)).toBeNull();
  });

  it('does not render a registration hover for an attribute word', () => {
    const { document, position } = docAt([
      '<root>',
      '  <Hero hasBa|se="true" hasCell="true" hasClient="true"/>',
      '</root>'
    ].join('\n'), 'scripts/entities.xml');

    const hover = provider.provideHover(document, position);
    expect(hover ? hoverText(hover) : '').not.toContain('Entity registration');
  });
});

describe('diagnostics section labels', () => {
  it('labels duplicate definitions with the owning section name', () => {
    const document = makeTextDocument([
      '<root>',
      '  <Parent>',
      '    <GhostA/>',
      '    <GhostA/>',
      '  </Parent>',
      '  <Interfaces>',
      '    <IfaceX/>',
      '    <IfaceX/>',
      '  </Interfaces>',
      '  <Components>',
      '    <CompY/>',
      '    <CompY/>',
      '  </Components>',
      '  <Volatile>',
      '    <VItem/>',
      '    <VItem/>',
      '  </Volatile>',
      '</root>'
    ].join('\n'), {
      fileName: p(root, 'scripts/entity_defs/Labels.def'),
      languageId: 'kbengine-def'
    });

    const joined = collectDiagnostics(document).map(d => d.message).join('\n');
    expect(joined).toContain('父类区块');
    expect(joined).toContain('接口区块');
    expect(joined).toContain('组件区块');
    expect(joined).toContain('易变同步区块');
  });

  it('treats custom type references as unverifiable without a workspace', () => {
    const document = makeTextDocument([
      '<root>',
      '  <Properties>',
      '    <p>',
      '      <Type>DOLL</Type>',
      '    </p>',
      '  </Properties>',
      '</root>'
    ].join('\n'), {
      fileName: p(root, 'scripts/entity_defs/Unverified.def'),
      languageId: 'kbengine-def'
    });

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lang-empty-'));
    const saved = stubWorkspace.workspaceFolders;
    try {
      stubWorkspace.workspaceFolders = [];
      // 无 workspace:无法验证注册状态,不报"未在 types.xml 注册"
      expect(collectDiagnostics(document).map(d => d.message).join('\n'))
        .not.toContain('未在 types.xml');

      // 空 workspace(无 types.xml):同样 unverifiable
      stubWorkspace.workspaceFolders = [
        { uri: Uri.file(emptyRoot), name: 'empty', index: 0 }
      ];
      expect(collectDiagnostics(document).map(d => d.message).join('\n'))
        .not.toContain('未在 types.xml');
    } finally {
      stubWorkspace.workspaceFolders = saved;
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('types.xml definition jumps', () => {
  const provider = new KBEngineDefinitionProvider();

  it('jumps from an implementedBy value to the python implementation', () => {
    const { document, position } = docAt([
      '<root>',
      '  <DOLL>',
      '    <Type>FIXED_DICT</Type>',
      '    <implementedBy>it|em.doll</implementedBy>',
      '  </DOLL>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('doll.py')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });

  it('returns null for a child element tag name inside a type node', () => {
    const { document, position } = docAt([
      '<root>',
      '  <DOLL>',
      '    <|Type>FIXED_DICT</Type>',
      '    <implementedBy>item.doll</implementedBy>',
      '  </DOLL>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    expect(provider.provideDefinition(document, position)).toBeNull();
  });

  it('returns null for a word in a malformed types.xml document', () => {
    const { document, position } = docAt('not xm|l at all', 'scripts/entity_defs/types.xml');
    expect(provider.provideDefinition(document, position)).toBeNull();
  });

  it('returns null for an implementedBy value without a python file', () => {
    const { document, position } = docAt([
      '<root>',
      '  <BROKEN>',
      '    <implementedBy>nosuch|.mod</implementedBy>',
      '  </BROKEN>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    expect(provider.provideDefinition(document, position)).toBeNull();
  });

  it('returns null for an attribute value word inside a type element', () => {
    const { document, position } = docAt([
      '<root>',
      '  <DOLL note="ab|c">',
      '    <Type>FIXED_DICT</Type>',
      '  </DOLL>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    expect(provider.provideDefinition(document, position)).toBeNull();
  });

  it('prefers the definition carried by the current document text', () => {
    const template = [
      '<root>',
      '  <LOCALX>',
      '    <Type>UINT32</Type>',
      '  </LOCALX>',
      '  <GIFT>',
      '    <Type>LO|CALX</Type>',
      '  </GIFT>',
      '</root>'
    ].join('\n');
    const { text: docText, position } = cursorOf(template);
    const defLine = docText.split('\n').findIndex(line => line.includes('<LOCALX>'));
    const document = makeTextDocument(docText, {
      fileName: p(root, 'scripts/entity_defs/types.xml'),
      languageId: 'kbengine-def'
    });

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('types.xml')).toBe(true);
    // LOCALX 只存在于当前文档文本,行号即文档内定义行 → 走的是文档自含定义路径
    expect(location.range.start.line).toBe(defLine);
  });

  it('jumps from a type value to a registered entity def', () => {
    const { document, position } = docAt([
      '<root>',
      '  <GIFT>',
      '    <Type>He|ro</Type>',
      '  </GIFT>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('Hero.def')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });

  it('returns null when a type value matches nothing', () => {
    const { document, position } = docAt([
      '<root>',
      '  <GIFT>',
      '    <Type>ZZZ|Unk</Type>',
      '  </GIFT>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    expect(provider.provideDefinition(document, position)).toBeNull();
  });
});

describe('database schema cross jumps', () => {
  const provider = new KBEngineDefinitionProvider();
  it('jumps from a def property to its database schema location', () => {
    const { document, position } = docAt(HERO_DEF.replace('    <hp>', '    <|hp>'), 'scripts/entity_defs/Hero.def', 'kbengine-def');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.scheme).toBe('kbengine-db-schema');
    expect(location.uri.fsPath).toContain('Hero.schema');
  });

  const buildSchemaDocument = (): {
    document: MinimalTextDocument;
    fieldPosition: Position;
    tablePosition: Position;
  } => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', root);
    expect(snapshot, 'schema snapshot exists').toBeTruthy();
    const text = renderDatabaseSchema(snapshot);
    const lines = text.split('\n');
    return {
      document: makeTextDocument(text, {
        fileName: heroDefPath,
        languageId: 'plaintext',
        uri: Uri.parse('kbengine-db-schema:/Hero.schema')
      }),
      fieldPosition: new Position(lines.findIndex(line => line.startsWith('sm_hp ')), 2),
      tablePosition: new Position(lines.findIndex(line => line.startsWith('TABLE ')), 2)
    };
  };

  it('jumps from a schema field row back to the def property', () => {
    const { document, fieldPosition } = buildSchemaDocument();
    const hpLine = heroDefLines.findIndex(line => line.includes('<hp>'));

    const location = provider.provideDefinition(document, fieldPosition) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath).toBe(heroDefPath);
    expect(location.range.start.line).toBe(hpLine);
  });

  it('jumps from a schema table row back to the def file head', () => {
    const { document, tablePosition } = buildSchemaDocument();

    const location = provider.provideDefinition(document, tablePosition) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath).toBe(heroDefPath);
    expect(location.range.start.line).toBe(0);
  });

  it('returns null for a schema document whose entity has no def', () => {
    const document = makeTextDocument('# KBEngine Database Schema\n\nNo schema available.\n', {
      fileName: heroDefPath,
      languageId: 'plaintext',
      uri: Uri.parse('kbengine-db-schema:/Ghost.schema')
    });

    expect(provider.provideDefinition(document, new Position(0, 2))).toBeNull();
  });

  it('returns null when the cursor is not on a field or table row', () => {
    const { document } = buildSchemaDocument();
    const lines = (document.getText() as string).split('\n');
    const kindLine = lines.findIndex(line => line.startsWith('kind:'));

    expect(provider.provideDefinition(document, new Position(kindLine, 2))).toBeNull();
  });

  it('returns null when the field under the cursor is absent from the snapshot', () => {
    const text = [
      'TABLE tbl_Hero',
      'kind: entity',
      'source: Hero.def:1 (Hero)',
      '',
      'sm_nonexistent  int',
      '  source: Hero.def:2 (nonexistent)'
    ].join('\n');
    const document = makeTextDocument(text, {
      fileName: heroDefPath,
      languageId: 'plaintext',
      uri: Uri.parse('kbengine-db-schema:/Hero.schema')
    });

    expect(provider.provideDefinition(document, new Position(4, 2))).toBeNull();
  });

  it('falls back to the def first line when the def entity has no database snapshot', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <|p>',
      '      <Type>UINT32</Type>',
      '    </p>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Ann.def');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts', 'entity_defs', 'Ann.def'));
    expect(location!.range.start.line).toBe(0);
  });

  it('lands on the entities.xml declaration when the property produces no schema targets', () => {
    const { document, position } = docAt(
      [
        '<root>',
        '  <Properties>',
        '    <|wv>',
        '      <Type>UINT8</Type>',
        '    </wv>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'scripts/entity_defs/Watcher.def',
      'kbengine-def'
    );

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts', 'entities.xml'));
    expect(location!.range.start.line).toBe(2);
  });
});

describe('def cross reference jumps', () => {
  const provider = new KBEngineDefinitionProvider();

  it('jumps from an Arg value to the referenced entity def', () => {
    const { document, position } = defAt([
      '<root>',
      '  <CellMethods>',
      '    <onScan>',
      '      <Arg>He|ro</Arg>',
      '    </onScan>',
      '  </CellMethods>',
      '</root>'
    ].join('\n'), 'Refs.def');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('Hero.def')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });

  it('jumps from a Parent child tag to the sibling def', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Parent>',
      '    <Ba|seP/>',
      '  </Parent>',
      '</root>'
    ].join('\n'), 'Refs.def');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('BaseP.def')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });

  it('jumps from a Parent child tag inside a components document', () => {
    const { document, position } = docAt([
      '<root>',
      '  <Parent>',
      '    <NestedCo|mp/>',
      '  </Parent>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/components/Refs.def', 'kbengine-def');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('NestedComp.def')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });

  it('returns null when a reference resolves to the current def document itself', () => {
    // Arg 值 Hero 解析到 Hero.def,而当前文档就是 Hero.def 且无行号 → 不产出 Location
    const { document, position } = defAt(HERO_DEF.replace('      <Arg>Hero</Arg>', '      <Arg>He|ro</Arg>'), 'Hero.def');

    expect(provider.provideDefinition(document, position)).toBeNull();
  });

  it('lands on the entities.xml declaration for a method symbol without an entity mapping manager', () => {
    const { document, position } = defAt(HERO_DEF.replace('    <onKill>', '    <|onKill>'), 'Hero.def');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts', 'entities.xml'));
    expect(location!.range.start.line).toBe(1);
  });
});

describe('diagnostics value ranges', () => {
  it('falls back to the node value range when the value text is split by a comment', () => {
    const document = makeTextDocument([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Flags>BAD_<!--split-->FLAG</Flags>',
      '      <Type>UINT32</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), {
      fileName: p(root, 'scripts/entity_defs/Split.def'),
      languageId: 'kbengine-def'
    });

    const diagnostics = collectDiagnostics(document);
    // 注释把值文本拆成两个 text 节点:join 后的值在原文中找不到连续子串,
    // 诊断区间回落到节点值区间(仍在 Flags 元素所在行)
    const flagged = diagnostics.find(d => d.message.includes('未知的 KBEngine Flags 值'));
    expect(flagged).toBeTruthy();
    expect(flagged!.message).toContain('BAD_FLAG');
    expect(flagged!.range.start.line).toBe(3);
  });
});

describe('def method implementation jumps', () => {
  const makeManager = (
    identity: unknown,
    implementation: unknown
  ): EntityMappingManager => ({
    resolveDefinitionSymbolAtPosition: () => Promise.resolve(identity),
    resolveMethodImplementationByIdentity: () => Promise.resolve(implementation)
  } as unknown as EntityMappingManager);

  const defineOnKill = async (
    manager: EntityMappingManager
  ): Promise<{ document: MinimalTextDocument; location: unknown }> => {
    const provider = new KBEngineDefinitionProvider(manager);
    const { document, position } = defAt(HERO_DEF.replace('    <onKill>', '    <|onKill>'), 'Hero.def');
    return { document, location: await provider.provideDefinition(document, position) };
  };

  it('falls back to the registry declaration with a hint when no identity resolves', async () => {
    messages.info.length = 0;
    const { location } = await defineOnKill(makeManager(null, null));
    const typed = location as unknown as LocationLike;

    // 2026-10-12 用户令:管理器路径约定链落空不再静默落 def 声明行(光标常已
    // 在该行,等同没跳)——改弹「期望位置」提示并落 entities.xml 注册声明行。
    expect(typed).toBeTruthy();
    expect(typed.uri.fsPath).toBe(p(root, 'scripts', 'entities.xml'));
    const declaredLine = fs.readFileSync(p(root, 'scripts', 'entities.xml'), 'utf8')
      .split('\n')
      .findIndex(line => line.includes('<Hero'));
    expect(typed.range.start.line).toBe(declaredLine);
    expect(messages.info.some(entry => entry.includes('onKill') && entry.includes('base/Hero.py'))).toBe(true);
  });

  it('falls back to the registry declaration with a hint when the implementation is missing', async () => {
    messages.info.length = 0;
    const { location } = await defineOnKill(
      makeManager({ ownerName: 'Hero', symbolName: 'onKill' }, null)
    );
    const typed = location as unknown as LocationLike;

    expect(typed).toBeTruthy();
    expect(typed.uri.fsPath).toBe(p(root, 'scripts', 'entities.xml'));
    const declaredLine = fs.readFileSync(p(root, 'scripts', 'entities.xml'), 'utf8')
      .split('\n')
      .findIndex(line => line.includes('<Hero'));
    expect(typed.range.start.line).toBe(declaredLine);
    expect(messages.info.some(entry => entry.includes('onKill') && entry.includes('base/Hero.py'))).toBe(true);
  });

  it('jumps to the python implementation when the identity resolves', async () => {
    const implPath = p(root, 'scripts/base/Hero.py');
    const { location } = await defineOnKill(
      makeManager({ ownerName: 'Hero', symbolName: 'onKill' }, { filePath: implPath, line: 5, character: 7 })
    );
    const typed = location as unknown as LocationLike;

    expect(typed).toBeTruthy();
    expect(typed.uri.fsPath).toBe(implPath);
    expect(typed.range.start.line).toBe(4);
    expect(typed.range.start.character).toBe(7);
  });
});

describe('persistent property database storage hover', () => {
  const provider = new KBEngineHoverProvider();

  beforeAll(() => {
    // 追加引擎可装载的文本指引型 FIXED_DICT 别名(loadTypes 取首子节点
    // getValStr:<Type>FIXED_DICT</Type> 元素形态取值空串,引擎整份报错,
    // 批98 口径不展开;文本形态才装载)。先跑完的用例不受影响,afterAll 还原。
    const typesXmlPath = p(root, 'scripts', 'entity_defs', 'types.xml');
    const original = fs.readFileSync(typesXmlPath, 'utf8');
    (globalThis as { __typesXmlOriginal?: string }).__typesXmlOriginal = original;
    fs.writeFileSync(typesXmlPath, original.replace('</root>', [
      '  <FDPAIR>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <name>',
      '        <Type>UNICODE</Type>',
      '      </name>',
      '    </Properties>',
      '  </FDPAIR>',
      '</root>'
    ].join('\n')), 'utf8');

    // 独立实体 Stor:标量/向量/types.xml FIXED_DICT 别名/数组/非持久各一,
    // 不动共享 HERO_DEF(entities.xml 也不必注册,findEntityDefinitionFile
    // 只按布局找 entity_defs/<名>.def)。
    fs.writeFileSync(p(root, 'scripts', 'entity_defs', 'Stor.def'), [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '    <pos>',
      '      <Type>VECTOR3</Type>',
      '      <Persistent>true</Persistent>',
      '    </pos>',
      '    <info>',
      '      <Type>FDPAIR</Type>',
      '      <Persistent>true</Persistent>',
      '    </info>',
      '    <bag>',
      '      <Type>',
      '        ARRAY',
      '        <of>UINT32</of>',
      '      </Type>',
      '      <Persistent>true</Persistent>',
      '    </bag>',
      '    <temp>',
      '      <Type>UINT8</Type>',
      '    </temp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  });

  afterAll(() => {
    const original = (globalThis as { __typesXmlOriginal?: string }).__typesXmlOriginal;
    if (original) {
      fs.writeFileSync(p(root, 'scripts', 'entity_defs', 'types.xml'), original, 'utf8');
    }
  });

  it('shows table and column names for a persistent scalar', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <h|p>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Stor.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('**数据库存储**');
    expect(text).toContain('`tbl_Stor`');
    expect(text).toContain('`sm_hp`');
  });

  it('lists every vector column of a persistent VECTOR3', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <po|s>',
      '      <Type>VECTOR3</Type>',
      '      <Persistent>true</Persistent>',
      '    </pos>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Stor.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('`sm_0_pos`、`sm_1_pos`、`sm_2_pos`');
  });

  it('expands a types.xml FIXED_DICT alias into its column names', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <in|fo>',
      '      <Type>FDPAIR</Type>',
      '      <Persistent>true</Persistent>',
      '    </info>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Stor.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('`sm_info_name`');
  });

  it('points an ARRAY property at its child table', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <b|ag>',
      '      <Type>',
      '        ARRAY',
      '        <of>UINT32</of>',
      '      </Type>',
      '      <Persistent>true</Persistent>',
      '    </bag>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Stor.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).toContain('子表 `tbl_Stor_bag`');
  });

  it('omits the storage line for a non-persistent property', () => {
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <te|mp>',
      '      <Type>UINT8</Type>',
      '    </temp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Stor.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).not.toContain('数据库存储');
  });

  it('omits the storage line when the entity def is not on disk', () => {
    // 悬停文档的实体名在磁盘上无 def → 快照 null,属性行照常但不给库表
    const { document, position } = defAt([
      '<root>',
      '  <Properties>',
      '    <h|p>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'Ghost.def');

    const text = hoverText(provider.provideHover(document, position));
    expect(text).not.toContain('数据库存储');
  });
});
