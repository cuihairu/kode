import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findImplementedBySymbolLine,
  findPythonSymbolDefinitionLine,
  findTypesXmlImplementedByReference
} from '../src/definitionWorkspace';
import { KBEngineDefinitionProvider, KBEngineHoverProvider, PythonDefinitionProvider } from '../src/languageProviders';
import {
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批129 验收走查:types.xml implementedBy 跳转精确化 + 反向跳转。
// 用户缺陷:implementedBy 形如 SKILL_SLOT_DATA.weapon_skill_slot_list_inst
// (前段=模块名,后段=符号名,引擎 datatype.cpp loadImplModule L2331-2357
// 按 '.' 拆两段:ImportModule 前段 + GetAttrString 后段)——此前只落文件
// 首行不落符号行;且只有正向,跳过去回不来。
//
// 走查清单:
//   正向(types.xml implementedBy 值 → python 符号定义行):
//     ① class 形态符号落类行(SKILL_SLOT → weapon_skill_slot_list_inst)
//     ② 赋值形态符号落赋值行(SKILL_SLOT_ALIAS → SLOT_COUNT)
//     ③ 符号在实现文件里不存在 → 回落文件首行(不空转)
//     ④ 三段式 implementedBy(引擎不合法)→ 回落文件首行
//   反向(python 符号 → types.xml implementedBy 行):
//     ⑤ 落在类定义名上 → 回 implementedBy 行
//     ⑥ 落在普通引用处 → 回 implementedBy 行(转到引用)
//     ⑦ 未被引用的词 → null 不虚跳
//     ⑧ 文档不在工作区 → null
//     ⑨ 光标不在词上(缩进空白)→ null
//   反向悬停提示(与点击跳转同一套解析):
//     ⑩ 被引用符号悬停出引用方类型与落点行
//     ⑪ 非 .py 文档/未引用词/无工作区 → 不出提示

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

let root = '';

const TYPES_XML = [
  '<root>',
  '  <ITEM_ID>UINT16</ITEM_ID>',
  '  <SKILL_SLOT>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <slot_list><Type>ARRAY</Type></slot_list>',
  '    </Properties>',
  '    <implementedBy>SKILL_SLOT_DATA.weapon_skill_slot_list_inst</implementedBy>',
  '  </SKILL_SLOT>',
  '  <SKILL_SLOT_ALIAS>',
  '    <Type>UINT16</Type>',
  '    <implementedBy>SKILL_SLOT_DATA.SLOT_COUNT</implementedBy>',
  '  </SKILL_SLOT_ALIAS>',
  '  <DOLL>',
  '    FIXED_DICT',
  '    <implementedBy>impl.doll</implementedBy>',
  '  </DOLL>',
  '  <SYMBOL_LESS>',
  '    FIXED_DICT',
  '    <implementedBy>impl.multi.part</implementedBy>',
  '  </SYMBOL_LESS>',
  '  <GHOST>',
  '    FIXED_DICT',
  '    <implementedBy>.ghost</implementedBy>',
  '  </GHOST>',
  '  <impl>',
  '    FIXED_DICT',
  '  </impl>',
  '</root>'
].join('\n');

const SKILL_MODULE_PY = [
  'import KBEngine',
  '',
  'class weapon_skill_slot_list_inst(object):',
  '    def __init__(self):',
  '        self.slots = []',
  '',
  '    def add(self, name):',
  '        self.slots.append(name)',
  '',
  '',
  'SLOT_COUNT = 4',
  '',
  'def describe():',
  '    return SLOT_COUNT'
].join('\n');

// impl.doll 的实现文件存在但里面没有 doll 符号:正向回落首行,
// 反向按符号比对不命中
const IMPL_PY = ['# helper module', 'HELPER = 1', 'def touch():', '    return HELPER'].join('\n');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-batch129-'));
  const write = (relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write('scripts/entities.xml', '<root>\n  <Hero hasBase="true"/>\n</root>');
  write('scripts/entity_defs/types.xml', TYPES_XML);
  write('scripts/user_type/SKILL_SLOT_DATA.py', SKILL_MODULE_PY);
  write('scripts/user_type/impl.py', IMPL_PY);
  // .ghost 的 implementedBy 解析到本文件(前导点布局)
  write('scripts/user_type/ghost.py', '# ghost module\n');

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

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number } };
}

const typesXmlLine = (needle: string): number => {
  const line = TYPES_XML.split('\n').findIndex(entry => entry.includes(needle));
  expect(line).toBeGreaterThanOrEqual(0);
  return line;
};

const moduleLine = (needle: string): number => {
  const line = SKILL_MODULE_PY.split('\n').findIndex(entry => entry.includes(needle));
  expect(line).toBeGreaterThanOrEqual(0);
  return line;
};

describe('findPythonSymbolDefinitionLine(纯函数)', () => {
  it('covers class/def/assignment forms at any indent, word-bounded', () => {
    const source = [
      'import KBEngine',
      'class weapon_skill_slot_list_inst(object):',
      '    def add(self):',
      '        self.slots.append(1)',
      'SLOT_COUNT = 4',
      'def describe():',
      '    return SLOT_COUNT',
      'def slot_padded():',
      '    pass'
    ].join('\n');

    // class / 赋值 / def 三种形态分别落在各自定义行(1-based)
    expect(findPythonSymbolDefinitionLine(source, 'weapon_skill_slot_list_inst')).toBe(2);
    expect(findPythonSymbolDefinitionLine(source, 'SLOT_COUNT')).toBe(5);
    expect(findPythonSymbolDefinitionLine(source, 'describe')).toBe(6);

    // 缩进的 def 也算(模块属性可以由嵌套处绑定吗——这里锁定宽松形态)
    expect(findPythonSymbolDefinitionLine(source, 'slot_padded')).toBe(8);

    // 词边界:slot 不是 slots,也不是 slot_padded
    expect(findPythonSymbolDefinitionLine(source, 'slot')).toBeNull();

    // 不存在与空符号
    expect(findPythonSymbolDefinitionLine(source, 'missing')).toBeNull();
    expect(findPythonSymbolDefinitionLine(source, '')).toBeNull();
  });

  it('findImplementedBySymbolLine keeps engine two-part semantics', () => {
    const modulePath = p(root, 'scripts', 'user_type', 'SKILL_SLOT_DATA.py');

    // MODULE.symbol 恰两段:落符号行
    expect(findImplementedBySymbolLine(modulePath, 'SKILL_SLOT_DATA.weapon_skill_slot_list_inst'))
      .toBe(moduleLine('class weapon_skill_slot_list_inst') + 1);

    // 非两段(引擎 loadImplModule 报错形态)如实回 null
    expect(findImplementedBySymbolLine(modulePath, 'SOLO_MODULE')).toBeNull();
    expect(findImplementedBySymbolLine(modulePath, 'impl.multi.part')).toBeNull();
    // 两段但符号段为空(impl.)同样如实回 null
    expect(findImplementedBySymbolLine(modulePath, 'impl.')).toBeNull();
    // implementedBy 缺省:拆分无对象,如实回 null
    expect(findImplementedBySymbolLine(modulePath)).toBeNull();

    // 文件读不到
    expect(findImplementedBySymbolLine(p(root, 'no', 'such.py'), 'a.b')).toBeNull();
  });

  it('findTypesXmlImplementedByReference matches by file path and symbol', () => {
    const modulePath = p(root, 'scripts', 'user_type', 'SKILL_SLOT_DATA.py');
    const implPath = p(root, 'scripts', 'user_type', 'impl.py');

    expect(findTypesXmlImplementedByReference(root, modulePath, 'weapon_skill_slot_list_inst')).toEqual({
      filePath: p(root, 'scripts', 'entity_defs', 'types.xml'),
      line: typesXmlLine('SKILL_SLOT_DATA.weapon_skill_slot_list_inst') + 1,
      typeName: 'SKILL_SLOT'
    });

    expect(findTypesXmlImplementedByReference(root, modulePath, 'SLOT_COUNT')).toEqual({
      filePath: p(root, 'scripts', 'entity_defs', 'types.xml'),
      line: typesXmlLine('SKILL_SLOT_DATA.SLOT_COUNT') + 1,
      typeName: 'SKILL_SLOT_ALIAS'
    });

    // 同文件但符号未被任何 implementedBy 引用(含无 implementedBy 的类型)
    expect(findTypesXmlImplementedByReference(root, implPath, 'HELPER')).toBeNull();

    // 前导点 implementedBy(.ghost):模块段为空,引擎不装载,不命中
    expect(findTypesXmlImplementedByReference(
      root,
      p(root, 'scripts', 'user_type', 'ghost.py'),
      'ghost'
    )).toBeNull();

    // 无 types.xml 的空工作区
    expect(findTypesXmlImplementedByReference('/nonexistent-root', modulePath, 'x')).toBeNull();
  });
});

describe('批129 正向:implementedBy 值跳符号定义行', () => {
  const provider = new KBEngineDefinitionProvider();

  it('① class 形态符号落在类定义行', () => {
    const { document, position } = docAt([
      '<root>',
      '  <SKILL_SLOT>',
      '    <implementedBy>SKILL_SLOT_DATA.weapon_skill_slot_l|ist_inst</implementedBy>',
      '  </SKILL_SLOT>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('SKILL_SLOT_DATA.py')).toBe(true);
    expect(location.range.start.line).toBe(moduleLine('class weapon_skill_slot_list_inst'));
  });

  it('② 赋值形态符号落在赋值行', () => {
    const { document, position } = docAt([
      '<root>',
      '  <SKILL_SLOT_ALIAS>',
      '    <implementedBy>SKILL_SLOT_DATA.SLOT_CO|UNT</implementedBy>',
      '  </SKILL_SLOT_ALIAS>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('SKILL_SLOT_DATA.py')).toBe(true);
    expect(location.range.start.line).toBe(moduleLine('SLOT_COUNT = 4'));
  });

  it('③ 符号不在实现文件里:回落文件首行不空转', () => {
    const { document, position } = docAt([
      '<root>',
      '  <DOLL>',
      '    <implementedBy>impl.do|ll</implementedBy>',
      '  </DOLL>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('impl.py')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });

  it('④ 三段式 implementedBy(引擎不合法):回落文件首行', () => {
    const { document, position } = docAt([
      '<root>',
      '  <SYMBOL_LESS>',
      '    <implementedBy>impl.multi.pa|rt</implementedBy>',
      '  </SYMBOL_LESS>',
      '</root>'
    ].join('\n'), 'scripts/entity_defs/types.xml');

    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('impl.py')).toBe(true);
    expect(location.range.start.line).toBe(0);
  });
});

describe('批129 反向:python 符号跳回 implementedBy 行', () => {
  const provider = new PythonDefinitionProvider();

  it('⑤ 类定义名上跳回 implementedBy 行', async () => {
    const { document, position } = docAt(SKILL_MODULE_PY.replace(
      'class weapon_skill_slot_list_inst(object):',
      'class weapon_skill_slot_l|ist_inst(object):'
    ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('types.xml')).toBe(true);
    expect(location.range.start.line).toBe(typesXmlLine('SKILL_SLOT_DATA.weapon_skill_slot_list_inst'));
  });

  it('⑥ 普通引用处跳回 implementedBy 行(转到引用)', async () => {
    const { document, position } = docAt(SKILL_MODULE_PY.replace(
      '    return SLOT_COUNT',
      '    return SLOT_CO|UNT'
    ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath.endsWith('types.xml')).toBe(true);
    expect(location.range.start.line).toBe(typesXmlLine('SKILL_SLOT_DATA.SLOT_COUNT'));
  });

  it('⑦ 未被引用的词不虚跳', async () => {
    const { document, position } = docAt(SKILL_MODULE_PY.replace(
      'class weapon_skill_slot_list_inst(object):',
      'class weapon_skill_slot_list_inst(ob|ject):'
    ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('⑧ 文档不在工作区:反向链让路,不炸', async () => {
    stubWorkspace.workspaceFolders = [];
    try {
      const { document, position } = docAt(SKILL_MODULE_PY.replace(
        'class weapon_skill_slot_list_inst(object):',
        'class weapon_skill_slot_l|ist_inst(object):'
      ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');

      expect(await provider.provideDefinition(document, position)).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = [
        { uri: Uri.file(root), name: 'ws', index: 0 }
      ];
    }
  });

  it('⑨ 光标不在词上(缩进空白):不反向跳转', async () => {
    const { document, position } = docAt(SKILL_MODULE_PY.replace(
      '    def add(self, name):',
      '|    def add(self, name):'
    ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });
});

describe('批129 反向悬停提示', () => {
  const hoverProvider = new KBEngineHoverProvider();

  const hoverText = (hover: unknown): string => {
    const contents = (hover as { contents: { value: string } | Array<{ value: string }> }).contents;
    return Array.isArray(contents) ? contents.map(item => item.value).join('') : contents.value;
  };

  it('⑩ 被引用符号悬停出引用方类型与落点行', () => {
    const { document, position } = docAt(SKILL_MODULE_PY.replace(
      'class weapon_skill_slot_list_inst(object):',
      'class weapon_skill_slot_l|ist_inst(object):'
    ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');

    const hover = hoverProvider.provideHover(document, position);
    const text = hoverText(hover);
    expect(text).toContain('weapon_skill_slot_list_inst');
    expect(text).toContain('SKILL_SLOT');
    expect(text).toContain('implementedBy');
    expect(text).toContain(`第 ${typesXmlLine('SKILL_SLOT_DATA.weapon_skill_slot_list_inst') + 1} 行`);
  });

  it('⑪ 非 .py 文档、未引用词、无工作区均不出提示', () => {
    // 非 .py(链路里在 types.xml 专属悬停之后,普通 .def 词不会命中)
    const defDoc = docAt('<root>\n  <hp>\n    <Type>NOTHING_SP|ECIAL</Type>\n  </hp>\n</root>',
      'scripts/entity_defs/Hero.def');
    expect(hoverProvider.provideHover(defDoc.document, defDoc.position)).toBeNull();

    // .py 但词未被 implementedBy 引用
    const pyDoc = docAt(SKILL_MODULE_PY.replace(
      'class weapon_skill_slot_list_inst(object):',
      'class weapon_skill_slot_list_inst(ob|ject):'
    ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');
    expect(hoverProvider.provideHover(pyDoc.document, pyDoc.position)).toBeNull();

    // 无工作区
    stubWorkspace.workspaceFolders = [];
    try {
      const orphan = docAt(SKILL_MODULE_PY.replace(
        'class weapon_skill_slot_list_inst(object):',
        'class weapon_skill_slot_l|ist_inst(object):'
      ), 'scripts/user_type/SKILL_SLOT_DATA.py', 'python');
      expect(hoverProvider.provideHover(orphan.document, orphan.position)).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = [
        { uri: Uri.file(root), name: 'ws', index: 0 }
      ];
    }
  });
});
