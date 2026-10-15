import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineDefinitionProvider,
  PythonDefinitionProvider,
  RpcCodeLensProvider
} from '../src/languageProviders';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import {
  conventionalConfigRoots,
  hasEngineConfigProbe,
  resetDiscoveryState,
  resolveDiscoveredConfigRoot,
  resolveDiscoveredEntitiesXmlPath,
  resolveDiscoveredEntityDefsRoot,
  resolveDiscoveredTypesXmlPath
} from '../src/workspaceDiscovery';
import { mergeConfigXml, parseConfigXml } from '../src/serverConfigMerge';
import { messages } from './fake-vscode/windowState';
import { Position, Uri, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';

// 批132:kbengine 官方 SDK 模板之上的完整测试验证工程(端到端走查)。
//
// 来源:用户 2026-10-15「最好创建一个相对完整的测试验证的模板项目,
// kbengine 的模板里有的」。做法:
//   ① tests/fixtures/kbengine-demo-assets = 官方模板逐字快照
//      (/home/cui/workspaces/kbengine/kbe/res/sdk_templates/server/python_assets,
//      63 文件全量入库)——真模板,不是我编的布局;
//   ② 在官方模板之上补齐引擎模板里没有的丰富实体模型:Avatar/Monster def、
//      interfaces/ROLE.def、components/Inventory.def、含 implementedBy 的
//      types.xml、各角色脚本(base/cell/client/interfaces/cell 组件)与
//      user_type 实现模块;
//   ③ 本文件拿它把发现→导航→CodeLens→数据库 schema→配置合并整链一次走穿,
//      锁住「真模板布局 + 标准扩展能力」的验收面——单测各自覆盖分支,
//      这里保证这些分支在同一个真实资产上彼此咬合、端到端可用。
//
// 工作区形态刻意选「打开资产根的上层」:tmp 根下只有一级目录
// kbengine_demo_assets(名字以 _assets 结尾,批129 约定扫描的动态段),
// 资产根不是工作区根本身——这是真实用户工程最常见形态,顺带验收
// 动态 *_assets 段与深扫描兜底。
//
// 光标约定(同 batch111 走查):`|` 即落点,且落在 `|` 之后第一个字符上;
// 标签名落点写作 `<|Name`(左尖括号必须是原文自己的,不得另插)。
const KBE_DEMO_ASSETS = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
const WS_DIR_NAME = 'kbengine_demo_assets';

let wsRoot = '';
let assetsRoot = '';
const p = (...parts: string[]) => path.join(assetsRoot, ...parts);

const cursorOf = (template: string) => {
  const idx = template.indexOf('|');
  expect(idx, '样本缺少 | 光标标记').toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return { text, position: new Position(line, character) };
};

const docAt = (template: string, fileName: string, languageId = 'kbengine-def') => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, { fileName: p(...fileName.split('/')), languageId }),
    position
  };
};

/** needle 所在行号(0 基)——期望落点行从夹具现算,夹具增删行不误伤断言 */
const lineOf = (text: string, needle: string) =>
  text.split('\n').findIndex(line => line.includes(needle));

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number } };
}

const originalFindFiles = stubWorkspace.findFiles;

beforeAll(() => {
  wsRoot = path.join(os.tmpdir(), 'kode-demo-assets-ws');
  assetsRoot = path.join(wsRoot, WS_DIR_NAME);
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.mkdirSync(assetsRoot, { recursive: true });
  fs.cpSync(KBE_DEMO_ASSETS, assetsRoot, { recursive: true });
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];

  // fake-vscode 的 findFiles 是空实现;EntityMappingManager.scanEntityMappings
  // 靠它枚举 *.def 建索引——stub 按工作区真实枚举(与 entityMappingManager
  // 测试同口径),解析/闭包/选择逻辑仍走真文件真实现。
  stubWorkspace.findFiles = async () => {
    const out: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(wsRoot);
    return out;
  };
});

afterAll(() => {
  stubWorkspace.findFiles = originalFindFiles;
  fs.rmSync(wsRoot, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  resetDiscoveryState();
});

describe('资产根发现:官方模板 *_assets 布局(批129 链路)', () => {
  it('探针命中:res/server/kbengine.xml 在盘上', () => {
    expect(fs.existsSync(p('res/server/kbengine.xml'))).toBe(true);
    expect(hasEngineConfigProbe(assetsRoot)).toBe(true);
  });

  it('一级 *_assets 目录进约定链(动态段)', () => {
    expect(conventionalConfigRoots(wsRoot)).toContain(assetsRoot);
  });

  it('深扫描兜底定位:asset 根/entities.xml/types.xml/def 根唯一命中', () => {
    expect(resolveDiscoveredConfigRoot(wsRoot)).toBe(assetsRoot);
    expect(resolveDiscoveredEntitiesXmlPath(wsRoot)).toBe(p('scripts/entities.xml'));
    expect(resolveDiscoveredTypesXmlPath(wsRoot)).toBe(p('scripts/entity_defs/types.xml'));
    expect(resolveDiscoveredEntityDefsRoot(wsRoot)).toBe(p('scripts/entity_defs'));
  });
});

describe('定义导航:实体/类型/接口/DetailLevel/方法/属性', () => {
  const provider = new KBEngineDefinitionProvider();

  it('entities.xml 注册项 → 对应 def', async () => {
    const entities = fs.readFileSync(p('scripts/entities.xml'), 'utf8');
    const { document, position } = docAt(
      entities.replace('<Avatar hasBase', '<|Avatar hasBase'),
      'scripts/entities.xml',
      'xml'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/Avatar.def'));
  });

  it('Parent 值 → 父类 def(Monster → Avatar)', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Monster.def'), 'utf8');
    const { document, position } = docAt(
      def.replace('<Parent> Avatar </Parent>', '<Parent> A|vatar </Parent>'),
      'scripts/entity_defs/Monster.def'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/Avatar.def'));
  });

  it('<Components> 内 Type 值 → 组件 def(bag → components/Inventory.def)', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    const { document, position } = docAt(
      def.replace('<Type> Inventory </Type>', '<Type> In|ventory </Type>'),
      'scripts/entity_defs/Avatar.def'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/components/Inventory.def'));
  });

  it('Properties 内 Type 值 → types.xml 自定义类型节点行', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    // 数组元素类型写在 <Type> 内的 <of> 文本里(引擎 FixedArrayType::initialize
    // 从 Type 节点找 <of>),光标落在元素别名上同样应导航回 types.xml 声明行
    const { document, position } = docAt(
      def.replace('<of> SKILL_SLOT </of>', '<of> SK|ILL_SLOT </of>'),
      'scripts/entity_defs/Avatar.def'
    );
    const typesXml = fs.readFileSync(p('scripts/entity_defs/types.xml'), 'utf8');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/types.xml'));
    expect(loc!.range.start.line).toBe(lineOf(typesXml, '<SKILL_SLOT>'));
  });

  it('<Interfaces> 内接口名 → interfaces/ROLE.def', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Monster.def'), 'utf8');
    const { document, position } = docAt(
      def.replace('<interface> ROLE </interface>', '<interface> R|OLE </interface>'),
      'scripts/entity_defs/Monster.def'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/interfaces/ROLE.def'));
  });

  it('DetailLevel 值 → 同文件 DetailLevels 档位行', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    const { document, position } = docAt(
      def.replace('<DetailLevel> MEDIUM </DetailLevel>', '<DetailLevel> MED|IUM </DetailLevel>'),
      'scripts/entity_defs/Avatar.def'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/Avatar.def'));
    expect(loc!.range.start.line).toBe(lineOf(def, '<MEDIUM>'));
  });

  it('BaseMethods 方法 → base 脚本 def 行', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    const { document, position } = docAt(def.replace('<reqCastSkill>', '<reqCast|Skill>'), 'scripts/entity_defs/Avatar.def');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/base/Avatar.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(fs.readFileSync(p('scripts/base/Avatar.py'), 'utf8'), 'def reqCastSkill')
    );
  });

  it('CellMethods 方法 → cell 脚本 def 行', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    const { document, position } = docAt(def.replace('<respawn>', '<resp|awn>'), 'scripts/entity_defs/Avatar.def');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/cell/Avatar.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(fs.readFileSync(p('scripts/cell/Avatar.py'), 'utf8'), 'def respawn')
    );
  });

  it('ClientMethods 方法 → client 脚本 def 行', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    const { document, position } = docAt(def.replace('<onHPChanged>', '<onHP|Changed>'), 'scripts/entity_defs/Avatar.def');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/client/Avatar.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(fs.readFileSync(p('scripts/client/Avatar.py'), 'utf8'), 'def onHPChanged')
    );
  });

  it('接口 def 的方法 → 接口实现脚本 interfaces/ROLE.py', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/interfaces/ROLE.def'), 'utf8');
    const { document, position } = docAt(def.replace('<onMove>', '<on|Move>'), 'scripts/entity_defs/interfaces/ROLE.def');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/interfaces/ROLE.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(fs.readFileSync(p('scripts/interfaces/ROLE.py'), 'utf8'), 'def onMove')
    );
  });

  it('组件 def 的方法 → 组件角色脚本 cell/Inventory.py', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/components/Inventory.def'), 'utf8');
    const { document, position } = docAt(def.replace('<onItemGained>', '<onItem|Gained>'), 'scripts/entity_defs/components/Inventory.def');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/cell/Inventory.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(fs.readFileSync(p('scripts/cell/Inventory.py'), 'utf8'), 'def onItemGained')
    );
  });

  it('属性名 → base 脚本类定义行(引擎 __init__ 前装载属性的落点)', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Avatar.def'), 'utf8');
    const { document, position } = docAt(def.replace('<name>', '<na|me>'), 'scripts/entity_defs/Avatar.def');
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/base/Avatar.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(fs.readFileSync(p('scripts/base/Avatar.py'), 'utf8'), 'class Avatar')
    );
  });

  it('Account 走查:ClientMethods → client/Account.py,BaseMethods → base/Account.py', async () => {
    const def = fs.readFileSync(p('scripts/entity_defs/Account.def'), 'utf8');
    const client = docAt(def.replace('<onLoginOK>', '<onLog|inOK>'), 'scripts/entity_defs/Account.def');
    const locClient = (await provider.provideDefinition(
      client.document,
      client.position
    )) as unknown as LocationLike | null;
    expect(locClient?.uri.fsPath).toBe(p('scripts/client/Account.py'));

    const base = docAt(def.replace('<reqCreateAvatar>', '<reqCreate|Avatar>'), 'scripts/entity_defs/Account.def');
    const locBase = (await provider.provideDefinition(
      base.document,
      base.position
    )) as unknown as LocationLike | null;
    expect(locBase?.uri.fsPath).toBe(p('scripts/base/Account.py'));
  });
});

describe('types.xml implementedBy:双向跳转', () => {
  const provider = new KBEngineDefinitionProvider();

  it('正向:implementedBy 值 → user_type 实现模块符号定义行', async () => {
    const typesXml = fs.readFileSync(p('scripts/entity_defs/types.xml'), 'utf8');
    const { document, position } = docAt(
      typesXml.replace(
        '<implementedBy> SKILL_SLOT_DATA.weapon_skill_slot_list_inst </implementedBy>',
        '<implementedBy> SKILL_SLOT_DATA.weapon_skill_slot_list|_inst </implementedBy>'
      ),
      'scripts/entity_defs/types.xml',
      'xml'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/user_type/SKILL_SLOT_DATA.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(
        fs.readFileSync(p('scripts/user_type/SKILL_SLOT_DATA.py'), 'utf8'),
        'weapon_skill_slot_list_inst = weapon_skill_slot_list()'
      )
    );
  });

  it('正向:第二个实现类型 POSITION_DATA.position_inst → 对应模块', async () => {
    const typesXml = fs.readFileSync(p('scripts/entity_defs/types.xml'), 'utf8');
    const { document, position } = docAt(
      typesXml.replace(
        '<implementedBy> POSITION_DATA.position_inst </implementedBy>',
        '<implementedBy> POSITION_DATA.position|_inst </implementedBy>'
      ),
      'scripts/entity_defs/types.xml',
      'xml'
    );
    const loc = (await provider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/user_type/POSITION_DATA.py'));
    expect(loc!.range.start.line).toBe(
      lineOf(
        fs.readFileSync(p('scripts/user_type/POSITION_DATA.py'), 'utf8'),
        'position_inst = position()'
      )
    );
  });

  it('反向:user_type 符号 → types.xml implementedBy 行', async () => {
    const py = fs.readFileSync(p('scripts/user_type/SKILL_SLOT_DATA.py'), 'utf8');
    const { document, position } = docAt(
      py.replace(
        'weapon_skill_slot_list_inst = weapon_skill_slot_list()',
        'weapon_skill_slot_lis|t_inst = weapon_skill_slot_list()'
      ),
      'scripts/user_type/SKILL_SLOT_DATA.py',
      'python'
    );
    const typesXml = fs.readFileSync(p('scripts/entity_defs/types.xml'), 'utf8');
    // Python 文档的注册 provider 是 PythonDefinitionProvider(extension.ts:186),
    // 反向 implementedBy 跳转走它——不是 .def 侧的 KBEngineDefinitionProvider
    const pyProvider = new PythonDefinitionProvider(new EntityMappingManager({ subscriptions: [] }));
    const loc = (await pyProvider.provideDefinition(document, position)) as unknown as LocationLike | null;
    expect(loc?.uri.fsPath).toBe(p('scripts/entity_defs/types.xml'));
    expect(loc!.range.start.line).toBe(
      lineOf(typesXml, '<implementedBy> SKILL_SLOT_DATA.weapon_skill_slot_list_inst </implementedBy>')
    );
  });
});

describe('RPC CodeLens:Python 方法声明行上方标记(接口闭包)', () => {
  it('cell/Monster.py:onAggro → Monster.def,onMove → ROLE.def(接口混入)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] });
    const provider = new RpcCodeLensProvider(manager);
    const cellPy = fs.readFileSync(p('scripts/cell/Monster.py'), 'utf8');
    const doc = makeTextDocument(cellPy, { fileName: p('scripts/cell/Monster.py'), languageId: 'python' });
    const lenses = (await provider.provideCodeLenses(doc)) as unknown as Array<{
      range: { start: { line: number } };
      command: { title: string; arguments: Array<{ fsPath: string } | unknown> };
    }>;
    expect(lenses.length).toBeGreaterThan(0);

    const lensOf = (needle: string) =>
      lenses.find(l => l.range.start.line === lineOf(cellPy, needle));
    const aggro = lensOf('def onAggro');
    expect(aggro, 'onAggro 应有 lens').toBeDefined();
    expect(aggro!.command.title).toContain('CellMethods');
    expect(aggro!.command.title).toContain('Monster.def');
    expect((aggro!.command.arguments[0] as { fsPath: string }).fsPath)
      .toBe(p('scripts/entity_defs/Monster.def'));

    // onMove 声明在 interfaces/ROLE.def,实现写在 Monster.py ——
    // 引用闭包解析应把 lens 指向接口 def 行
    const move = lensOf('def onMove');
    expect(move, '接口混入 onMove 应有 lens').toBeDefined();
    expect(move!.command.title).toContain('ROLE.def');
    expect((move!.command.arguments[0] as { fsPath: string }).fsPath)
      .toBe(p('scripts/entity_defs/interfaces/ROLE.def'));
  });
});

describe('数据库 schema:实体表 + 组件表 + 数组子表', () => {
  it('Avatar:sm_name/sm_level 落列,tbl_Avatar_bag 组件表带 sm_gold,数组子表随附', () => {
    const snapshot = getDatabaseSchemaSnapshot('Avatar', wsRoot);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.entityName).toBe('Avatar');

    const entityTable = snapshot!.tableIndex.get('tbl_Avatar');
    expect(entityTable).toBeDefined();
    const fieldNames = entityTable!.fields.map(f => f.name);
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('sm_autoLoad');
    expect(fieldNames).toContain('sm_name'); // Persistent STRING
    expect(fieldNames).toContain('sm_level'); // Persistent UINT32

    const componentTable = snapshot!.tableIndex.get('tbl_Avatar_bag');
    expect(componentTable, 'Components 段组件 bag 应有组件表').toBeDefined();
    expect(componentTable!.fields.map(f => f.name)).toContain('sm_gold');

    const arrayTable = snapshot!.tableIndex.get('tbl_Avatar_bag_items');
    expect(arrayTable, '数组属性 items 应有子表').toBeDefined();
    // 元素列走引擎 getValStr 文本语义(xml.cpp getValStr 只认文本子节点):
    // <of><Type>ITEM_ID</Type></of> 的 of 首子是元素,引擎读空串装载失败,
    // 正确写法是 <of> ITEM_ID </of> 文本形态 → 元素列 sm_value 落 ITEM_ID 解析型
    expect(arrayTable!.fields.map(f => f.name)).toContain('sm_value');

    // skillSlots 的 <of> 必须挂在 <Type> 内(datatype.cpp 从 Type 节点找 of):
    // 元素是 SKILL_SLOT(FIXED_DICT)→ 键平铺成列 + 数组键再出子表
    const skillTable = snapshot!.tableIndex.get('tbl_Avatar_skillSlots');
    expect(skillTable, '数组属性 skillSlots 应有子表').toBeDefined();
    expect(skillTable!.fields.map(f => f.name)).toContain('sm_count');
    expect(snapshot!.tableIndex.get('tbl_Avatar_skillSlots_slot_list'), 'FD 内数组键应有子表').toBeDefined();
  });
});

describe('元件配置合并:官方 kbengine.xml 实文件走 parse/merge', () => {
  // 真模板 kbengine.xml 带 <root> 包装:parseConfigXml 的伪根下第一层
  // 就是 <root> 包装节点,组件段在其下;mergeConfigXml 按同名单容器
  // 递归下钻合并,渲染/展示层走的就是这条路径。
  it('真模板 kbengine.xml 可解析,合并覆盖生效、未触及段保留', () => {
    const xml = fs.readFileSync(p('res/server/kbengine.xml'), 'utf8');
    const base = parseConfigXml(xml)!;
    const rootNode = base.children.find(child => child.name === 'root')!;
    expect(rootNode).toBeDefined();
    const scriptVersion = rootNode.children
      .find(child => child.name === 'publish')!
      .children.find(child => child.name === 'script_version')!;
    expect(scriptVersion.text).toBe('0.1.0'); // 模板里的脚本版本号

    const override = parseConfigXml([
      '<root>',
      '  <baseapp>',
      '    <backupPeriod> 300 </backupPeriod>',
      '  </baseapp>',
      '</root>'
    ].join('\n'))!;
    const merged = mergeConfigXml(base, override);
    const mergedRoot = merged.children.find(child => child.name === 'root')!;

    const mergedBaseapp = mergedRoot.children.find(child => child.name === 'baseapp')!;
    expect(
      mergedBaseapp.children.find(child => child.name === 'backupPeriod')!.text
    ).toBe('300');
    // 未触及段保留(同键覆盖、他段不动)
    expect(
      mergedRoot.children.find(child => child.name === 'publish')!
        .children.find(child => child.name === 'script_version')!.text
    ).toBe('0.1.0');
    expect(mergedRoot.children.find(child => child.name === 'dbmgr')).toBeDefined();
  });
});

describe('静默红线:走查全程无未找到提示', () => {
  it('messages.info 无累积(导航全有落点)', () => {
    expect(messages.info).toEqual([]);
  });
});
