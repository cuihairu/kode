import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineCompletionProvider, KBEngineHoverProvider } from '../src/languageProviders';
import {
  ENTITY_BUILTIN_COMMON_PROPERTIES,
  formatEntityBuiltinPropertyDetail,
  getEntityBuiltinPropertiesForFace,
  resolveEntityBuiltinPropertyHit,
  resolveEntityComponentFaceFromPath
} from '../src/entityBuiltinProperties';
import { CompletionItemKind, Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// Entity 内建属性提示(用户令 2026-10-21,报告 §4):三面分册属性表 +
// 目录域/def 归属双判面 + Hover/补全接线。数据面零自创:类型对齐
// docs/reference/kbengine-typings-2026-10-21 pyi,读写性对齐报告 §2 的
// file:line。正反覆盖:cell 面命中 position 不命中 databaseID、只读标注、
// 非实体脚本不接管、面歧义只给宏公共 3。

const pyDoc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const hoverText = (hover: unknown): string => {
  const { contents } = (hover ?? { contents: [] }) as { contents: unknown };
  const raw = Array.isArray(contents) ? contents : [contents];
  return raw.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

// manager 生命周期:统一登记,afterEach 全量 dispose
const managers: EntityMappingManager[] = [];
const makeManager = (): EntityMappingManager => {
  const manager = new EntityMappingManager({ subscriptions: [] });
  managers.push(manager);
  return manager;
};

afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose());
});

describe('分册属性表(纯逻辑)', () => {
  it('baseapp 面 = 宏公共 3 + 6 项;databaseID 只读 int,shouldAutoBackup 可写', () => {
    const props = getEntityBuiltinPropertiesForFace('baseapp');
    expect(props.map(item => item.name)).toEqual([
      'id', 'isDestroyed', 'className',
      'cell', 'client', 'databaseID', 'databaseInterfaceName', 'shouldAutoBackup', 'shouldAutoArchive'
    ]);
    const dbid = props.find(item => item.name === 'databaseID');
    expect(dbid).toMatchObject({ readonly: true, type: 'int', source: 'server/baseapp/entity.cpp:38' });
    expect(props.find(item => item.name === 'shouldAutoBackup')).toMatchObject({
      readonly: false,
      type: 'Union[bool, int]'
    });
  });

  it('cellapp 面 18 项;position 可写 Vector3Like;databaseID 不在 cellapp 面', () => {
    const props = getEntityBuiltinPropertiesForFace('cellapp');
    expect(props).toHaveLength(18);
    expect(props.find(item => item.name === 'position')).toMatchObject({
      readonly: false,
      type: 'Vector3Like',
      source: 'server/cellapp/entity.cpp:83'
    });
    expect(props.some(item => item.name === 'databaseID')).toBe(false);
    expect(props.find(item => item.name === 'topSpeed')).toMatchObject({
      readonly: false,
      type: 'float'
    });
  });

  it('client 面 = 客户端宏 4 + 6 项;velocity 可写 float;clientapp 只读', () => {
    const props = getEntityBuiltinPropertiesForFace('client');
    expect(props.map(item => item.name)).toEqual([
      'id', 'spaceID', 'isDestroyed', 'className',
      'base', 'cell', 'clientapp', 'position', 'direction', 'velocity'
    ]);
    expect(props.find(item => item.name === 'velocity')).toMatchObject({
      readonly: false,
      type: 'float'
    });
    expect(props.find(item => item.name === 'clientapp')).toMatchObject({ readonly: true, type: 'Any' });
  });

  it('face=null → 宏公共 3(兜底集)', () => {
    expect(getEntityBuiltinPropertiesForFace(null)).toBe(ENTITY_BUILTIN_COMMON_PROPERTIES);
    expect(ENTITY_BUILTIN_COMMON_PROPERTIES.map(item => item.name)).toEqual([
      'id', 'isDestroyed', 'className'
    ]);
  });

  it('目录域判面:base/cell/client 段各归其面;平铺与 bots 段判不出', () => {
    expect(resolveEntityComponentFaceFromPath('/proj/scripts/base/Avatar.py')).toBe('baseapp');
    expect(resolveEntityComponentFaceFromPath('/proj/scripts/cell/Avatar.py')).toBe('cellapp');
    expect(resolveEntityComponentFaceFromPath('/proj/scripts/client/Avatar.py')).toBe('client');
    expect(resolveEntityComponentFaceFromPath('/proj/scripts/Avatar.py')).toBeNull();
    expect(resolveEntityComponentFaceFromPath('/proj/scripts/bots/Bot.py')).toBeNull();
  });

  it('命中解析:cell 面命中 position 不命中 databaseID;非实体不接管', () => {
    // cellapp 目录面:position 命中(可写),databaseID 是 baseapp 面属性 → null
    const cellHit = resolveEntityBuiltinPropertyHit('position', 'cellapp', null);
    expect(cellHit).toMatchObject({
      face: 'cellapp',
      property: { name: 'position', readonly: false, type: 'Vector3Like' }
    });
    expect(resolveEntityBuiltinPropertyHit('databaseID', 'cellapp', null)).toBeNull();

    // baseapp 目录面:databaseID 命中且只读
    expect(resolveEntityBuiltinPropertyHit('databaseID', 'baseapp', null)).toMatchObject({
      face: 'baseapp',
      property: { readonly: true }
    });

    // 目录与 def 归属都判不出 → 非实体脚本,不接管
    expect(resolveEntityBuiltinPropertyHit('position', null, null)).toBeNull();
    expect(resolveEntityBuiltinPropertyHit('id', null, null)).toBeNull();

    // 无目录域但 def 归属唯一面 → 全量面属性生效
    expect(resolveEntityBuiltinPropertyHit('velocity', null, ['client'])).toMatchObject({
      face: 'client',
      property: { name: 'velocity' }
    });

    // 判为实体但 def 面歧义 → 只查宏公共 3:id 命中,position 不命中
    const ambiguous = resolveEntityBuiltinPropertyHit('id', null, ['baseapp', 'cellapp']);
    expect(ambiguous).toMatchObject({ face: null, property: { name: 'id', readonly: true } });
    expect(resolveEntityBuiltinPropertyHit('position', null, ['baseapp', 'cellapp'])).toBeNull();
  });

  it('标注格式:「KBEngine 内建属性（<组件>面）·只读/可写 · 类型」;判不出面标公共面', () => {
    expect(
      formatEntityBuiltinPropertyDetail('cellapp', {
        name: 'position', readonly: false, type: 'Vector3Like', source: 'x'
      })
    ).toBe('KBEngine 内建属性（cellapp面）·可写 · Vector3Like');
    expect(
      formatEntityBuiltinPropertyDetail('baseapp', {
        name: 'databaseID', readonly: true, type: 'int', source: 'x'
      })
    ).toBe('KBEngine 内建属性（baseapp面）·只读 · int');
    expect(
      formatEntityBuiltinPropertyDetail(null, {
        name: 'id', readonly: true, type: 'int', source: 'x'
      })
    ).toBe('KBEngine 内建属性（公共面）·只读 · int');
  });
});

describe('def 归属面解析(EntityMappingManager)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const roots: string[] = [];

  const setupWorkspace = (): { root: string; basePy: string; flatPy: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-builtin-'));
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
      '    <reborn/>',
      '  </CellMethods>',
      '  <BaseMethods>',
      '    <heal/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    const basePy = put('scripts/base/Avatar.py', 'class Avatar:\n    pass\n');
    put('scripts/cell/Avatar.py', 'class Avatar:\n    pass\n');
    const flatPy = put('scripts/Avatar.py', 'class Avatar:\n    pass\n');
    put('scripts/helper.py', 'import os\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'builtin', index: 0 }];
    workspace.findFiles = async (glob?: string) => (glob === '**/*.def' ? [Uri.file(defFile)] : []);
    return { root, basePy, flatPy };
  };

  afterEach(() => {
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
  });

  it('base/ 目录脚本 → baseapp;非实体脚本 → null', async () => {
    const { basePy, root } = setupWorkspace();
    const manager = makeManager();
    expect(await manager.getEntityComponentFacesForPythonFile(basePy)).toEqual(['baseapp']);
    expect(
      await manager.getEntityComponentFacesForPythonFile(path.join(root, 'scripts/helper.py'))
    ).toBeNull();
  });

  it('平铺 owner 文件被 base/cell/client 三段共有 → 面歧义(三项)', async () => {
    const { flatPy } = setupWorkspace();
    const manager = makeManager();
    const faces = await manager.getEntityComponentFacesForPythonFile(flatPy);
    expect([...(faces ?? [])].sort()).toEqual(['baseapp', 'cellapp', 'client']);
  });
});

describe('Hover 接线(目录域判面)', () => {
  const provider = new KBEngineHoverProvider(makeManager());

  it('cell 脚本 self.position → cellapp 面 · 可写 · Vector3Like,带引擎取证', async () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.position = (1, 2, 3)\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, '        self.'.length)))
    );
    expect(text).toContain('self.position');
    expect(text).toContain('KBEngine 内建属性（cellapp面）·可写 · Vector3Like');
    expect(text).toContain('server/cellapp/entity.cpp:83');
  });

  it('cell 脚本 self.databaseID 面内未命中 → 不标注(落回普通链)', async () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.databaseID = 1\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, '        self.'.length)))
    );
    expect(text).not.toContain('内建属性');
  });

  it('base 脚本 self.databaseID → 只读标注', async () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        print(self.databaseID)\n',
      '/proj/scripts/base/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, '        print(self.'.length)))
    );
    expect(text).toContain('KBEngine 内建属性（baseapp面）·只读 · int');
  });

  it('多段访问 self.cell.X → 走接收者链,不落内建属性标注', async () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.cell.reborn(1)\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, '        self.cell.'.length)))
    );
    expect(text).not.toContain('内建属性');
  });

  it('非实体脚本(无 manager 判面)→ 不接管', async () => {
    const bare = new KBEngineHoverProvider();
    const doc = pyDoc(
      'class Helper:\n    def run(self):\n        self.position = None\n',
      '/proj/scripts/helper.py'
    );
    const hover = await Promise.resolve(bare.provideHover(doc, new Position(2, '        self.'.length)));
    expect(hover).toBeNull();
  });
});

describe('补全接线', () => {
  const provider = new KBEngineCompletionProvider(makeManager());

  it('cell 脚本 self. → cellapp 面属性;无 databaseID;detail 带面与读写', () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const items = provider.provideCompletionItems(doc, new Position(2, '        self.'.length));
    expect(Array.isArray(items)).toBe(true);
    const list = items as Array<{ label: string; detail?: string; kind?: number }>;
    const labels = list.map(item => item.label);
    expect(labels).toContain('position');
    expect(labels).toContain('volatileInfo');
    expect(labels).not.toContain('databaseID');
    const position = list.find(item => item.label === 'position');
    expect(position?.detail).toBe('KBEngine 内建属性（cellapp面）·可写 · Vector3Like');
    expect(position?.kind).toBe(CompletionItemKind.Property);
  });

  it('片段上下文 self.pos → 项仍在(过滤交编辑器)', () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.pos\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const items = provider.provideCompletionItems(doc, new Position(2, '        self.pos'.length));
    const labels = (items as Array<{ label: string }>).map(item => item.label);
    expect(labels).toContain('position');
  });

  it('多段上下文 self.cell. → 不接管(空表)', () => {
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.cell.\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const items = provider.provideCompletionItems(doc, new Position(2, '        self.cell.'.length));
    expect(items).toEqual([]);
  });

  it('非实体脚本 self. → 空表(不接管)', () => {
    const bare = new KBEngineCompletionProvider();
    const doc = pyDoc(
      'class Helper:\n    def run(self):\n        self.\n',
      '/proj/scripts/helper.py'
    );
    expect(
      bare.provideCompletionItems(doc, new Position(2, '        self.'.length))
    ).toEqual([]);
  });
});
