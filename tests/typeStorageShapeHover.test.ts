import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider, describeTypeStorageShape } from '../src/languageProviders';
import { Position, Uri, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批134:types.xml 类型声明行悬停的落库形态。形态文字全部经
// describeTypeStorageShape(与 schema 构建器同源语义)翻出,这里锁定:
// - 四种形态(builtin/FIXED_DICT/ARRAY/未解析)各自的措辞与缺省分支;
// - 声明行悬停带形态段,implementedBy 值上的悬停不带(只谈引用)。

let root = '';

const TYPES_XML = [
  '<root>',
  '  <ITEM_ID> UINT16 </ITEM_ID>',
  '  <SKILL_SLOT>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <slot_list>',
  '        <Type>',
  '          ARRAY',
  '          <of> UINT32 </of>',
  '        </Type>',
  '      </slot_list>',
  '      <count>',
  '        <Type> UINT32 </Type>',
  '      </count>',
  '    </Properties>',
  '  </SKILL_SLOT>',
  '  <ITEM_IDS>',
  '    ARRAY',
  '    <of> ITEM_ID </of>',
  '  </ITEM_IDS>',
  '  <BAD_ARRAY> ARRAY </BAD_ARRAY>',
  '  <BROKEN> NO_SUCH_TYPE </BROKEN>',
  '  <DOLL>',
  '    <Type> UINT32 </Type>',
  '    <implementedBy>item.doll</implementedBy>',
  '  </DOLL>',
  '</root>'
].join('\n');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-shape-hover-'));
  const target = path.join(root, 'scripts/entity_defs/types.xml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, TYPES_XML, 'utf8');

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

const provider = new KBEngineHoverProvider();

const hoverAt = (template: string): string => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  const document: MinimalTextDocument = makeTextDocument(text, {
    fileName: path.join(root, 'scripts/entity_defs/types.xml'),
    languageId: 'xml'
  });
  const hover = provider.provideHover(document, new Position(line, character));
  expect(hover).toBeTruthy();
  const contents = (hover as { contents: unknown }).contents;
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

describe('describeTypeStorageShape wordings', () => {
  it('describes builtin shapes with or without a mapped column type', () => {
    expect(describeTypeStorageShape({
      kind: 'builtin', rawType: 'ITEM_ID', typeName: 'UINT16', columnType: 'smallint unsigned'
    })).toEqual(['主表单列（`smallint unsigned`）']);
    expect(describeTypeStorageShape({
      kind: 'builtin', rawType: 'VECTOR9', typeName: 'VECTOR9', columnType: null
    })).toEqual(['主表单列']);
  });

  it('describes fixed dict shapes with or without top level keys', () => {
    expect(describeTypeStorageShape({
      kind: 'fixedDict', rawType: 'SKILL_SLOT', topLevelKeys: ['slot_list', 'count']
    })).toEqual(['平铺成列，不成表；顶层键各占一列：slot_list、count']);
    expect(describeTypeStorageShape({
      kind: 'fixedDict', rawType: 'EMPTY', topLevelKeys: []
    })).toEqual(['平铺成列，不成表']);
  });

  it('describes array shapes through every element kind', () => {
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'ITEM_IDS', element: {
        kind: 'builtin', rawType: 'ITEM_ID', typeName: 'UINT16', columnType: 'smallint unsigned'
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：`sm_value`（`smallint unsigned`）']);
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'X', element: {
        kind: 'builtin', rawType: 'Q', typeName: 'Q', columnType: null
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：`sm_value`']);
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'X', element: {
        kind: 'fixedDict', rawType: 'SKILL_SLOT', topLevelKeys: ['count']
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：键平铺：count']);
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'X', element: {
        kind: 'fixedDict', rawType: 'EMPTY', topLevelKeys: []
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：键平铺']);
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'X', element: {
        kind: 'array', rawType: 'Y', element: {
          kind: 'builtin', rawType: 'Q', typeName: 'Q', columnType: null
        }
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：`sm_value`（套更深层子表）']);
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'X', element: {
        kind: 'array', rawType: 'Y', element: null
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：`sm_value`']);
    expect(describeTypeStorageShape({
      kind: 'array', rawType: 'X', element: {
        kind: 'unresolved', rawType: 'NOPE'
      }
    })).toEqual(['成子表 `tbl_<实体>_<属性>`，元素各占一行；元素落列：未知元素类型']);
  });

  it('describes unresolved shapes as engine load failures', () => {
    expect(describeTypeStorageShape({ kind: 'unresolved', rawType: 'BROKEN' }))
      .toEqual(['未知类型，引擎装载 types.xml 会失败']);
  });
});

describe('type declaration hover carries the storage shape', () => {
  it('shows a builtin alias landing as a main table column', () => {
    const text = hoverAt(TYPES_XML.replace('<ITEM_ID>', '<ITEM_|ID>'));
    expect(text).toContain('落库形态');
    expect(text).toContain('主表单列（`smallint unsigned`）');
  });

  it('shows a fixed dict alias flattening into columns', () => {
    const text = hoverAt(TYPES_XML.replace('<SKILL_SLOT>', '<SKILL_|SLOT>'));
    expect(text).toContain('平铺成列，不成表');
    expect(text).toContain('slot_list、count');
  });

  it('shows an array alias landing as a child table', () => {
    const text = hoverAt(TYPES_XML.replace('<ITEM_IDS>', '<ITEM_I|DS>'));
    expect(text).toContain('成子表 `tbl_<实体>_<属性>`，元素各占一行');
    expect(text).toContain('元素落列：`sm_value`（`smallint unsigned`）');
  });

  it('flags an array without of and an unknown type as unresolved', () => {
    expect(hoverAt(TYPES_XML.replace('<BAD_ARRAY>', '<BAD_AR|RAY>'))).toContain('缺 <of>，元素类型未知');
    expect(hoverAt(TYPES_XML.replace('<BROKEN>', '<BR|OKEN>'))).toContain('未知类型，引擎装载 types.xml 会失败');
  });

  it('keeps implementedBy value hovers free of storage shape', () => {
    const text = hoverAt(TYPES_XML.replace('item.doll', 'item.do|ll'));
    expect(text).toContain('item.doll');
    expect(text).not.toContain('落库形态');
  });
});
