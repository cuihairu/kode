import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDefinitionStructure } from '../src/explorerProviders';
import { EntityExplorerProvider, ServerControlProvider } from '../src/explorerProviders';
import { KBEngineServerManager, ServerStatus } from '../src/serverManager';
import { workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// explorerProviders 的纯逻辑:def 结构解析(导出)、树的描述/视图模型
// 构建(私有方法经实例直调,断言真实输出),以及服务器树的状态映射。
// 真实 vscode 树控件与 QuickPick 由 mocha 层覆盖。文件驱动部分用真实
// 临时 workspace。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-explorer-'));
  (globalThis as { __explorerRoot?: string }).__explorerRoot = root;
  const write = (relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  // Phantom 注册但无 def 文件,锁定 !exists 的早期返回分支
  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasClient="false"/>',
    '  <Ghost/>',
    '  <Phantom hasClient="true"/>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <Components>',
    '    <healthPack>',
    '      <Type>HealthComp</Type>',
    '    </healthPack>',
    '  </Components>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onSave><Exposed/></onSave>',
    '    <onLoad/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <dash><Exposed/></dash>',
    '  </CellMethods>',
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
    '    </ferocity>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Ghost.def', '<root>\n</root>\n');
  write('scripts/entity_defs/Unregistered.def', '<root>\n</root>\n');
  write('scripts/entity_defs/interfaces/MoveIface.def', [
    '<root>',
    '  <Properties>',
    '    <stride>',
    '      <Type>UINT8</Type>',
    '    </stride>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/components/HealthComp.def', [
    '<root>',
    '  <Properties>',
    '    <regen>',
    '      <Type>UINT32</Type>',
    '    </regen>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  const root = (globalThis as { __explorerRoot?: string }).__explorerRoot;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
});

const explorerRoot = (): string =>
  (globalThis as { __explorerRoot?: string }).__explorerRoot as string;

// 私有方法经实例直调:类型按已定案的真实形状收窄。
interface GroupItemLike {
  label: string;
  category: string;
  description?: string;
  iconPath?: { id: string };
  contextValue?: string;
}
interface TreeItemLike {
  definition: Record<string, unknown> & { name: string };
  description: string;
  viewModel: {
    summary: Array<{ label: string; value: string }>;
    sections: Array<{ key: string; label: string; items?: Array<{ label: string; description?: string }>; groups?: Array<{ label: string; items: Array<{ label: string; description?: string }> }> }>;
  };
  label?: string;
  iconPath?: { id: string };
  command?: { command: string; arguments?: unknown[] } | undefined;
  tooltip?: string;
}

type EntityInternals = EntityExplorerProvider & {
  getRootGroups(workspaceRoot: string): GroupItemLike[];
  getDefinitionItems(workspaceRoot: string, category: string): TreeItemLike[];
  buildDefinitionDescription(workspaceRoot: string, entry: Record<string, unknown>): string;
  buildDefinitionViewModel(workspaceRoot: string, entry: Record<string, unknown>): TreeItemLike['viewModel'];
  getCategoryLabel(category: string): string;
  getCategoryIcon(category: string): string;
  resolveParentCategory(entry: { category: string }): string;
  describeRuntimeFacet(facet: { enabled: boolean; declared: boolean; scriptExists: boolean }): string;
};

const makeExplorer = (): EntityInternals =>
  new EntityExplorerProvider() as unknown as EntityInternals;

const entityItem = (name: string): TreeItemLike => {
  const provider = makeExplorer();
  const items = provider.getDefinitionItems(explorerRoot(), 'entity');
  const found = items.find(item => item.definition.name === name);
  if (!found) {
    throw new Error(`entry not found: ${name}`);
  }
  return found;
};

const summaryOf = (viewModel: TreeItemLike['viewModel']): Record<string, string> =>
  Object.fromEntries(viewModel.summary.map(item => [item.label, item.value]));

const keysOf = (viewModel: TreeItemLike['viewModel']): string[] =>
  viewModel.sections.map(section => section.key);

describe('parseDefinitionStructure', () => {
  const ANONYMOUS_DEF = [
    '<root>',
    '  <Parent>Monster</Parent>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <Components>',
    '    <healthPack>',
    '      <Type>HealthComp</Type>',
    '    </healthPack>',
    '  </Components>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '    </hp>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '    </bag>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onSave><Exposed/></onSave>',
    '    <onLoad/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <dash><Exposed/></dash>',
    '  </CellMethods>',
    '  <ClientMethods>',
    '    <say/>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');

  it('keeps array shell properties while the dedicated stats helper filters deeper paths', () => {
    // parseDefinitionStructure 只滤含 '.' 的路径;数组壳 'bag' 保留
    const stats = parseDefinitionStructure(ANONYMOUS_DEF);

    expect(stats.properties).toEqual(['hp', 'bag']);
    expect(stats.parent).toBe('Monster');
    expect(stats.interfaces).toEqual(['MoveIface']);
    expect(stats.components).toEqual([
      { propertyName: 'healthPack', typeName: 'HealthComp' }
    ]);
  });

  it('maps the three method sections with exposed flags and symbol identity', () => {
    const stats = parseDefinitionStructure(ANONYMOUS_DEF);

    expect(stats.baseMethods.map(m => [m.name, m.exposed])).toEqual([
      ['onSave', true],
      ['onLoad', false]
    ]);
    expect(stats.cellMethods.map(m => [m.name, m.exposed])).toEqual([['dash', true]]);
    expect(stats.clientMethods.map(m => [m.name, m.exposed])).toEqual([['say', false]]);

    expect(stats.baseMethods[0].identity).toMatchObject({
      ownerKind: 'entity',
      ownerName: 'Anonymous',
      sourceKind: 'local',
      section: 'BaseMethods',
      symbolName: 'onSave'
    });
  });

  it('returns the empty shape for a def without content', () => {
    const stats = parseDefinitionStructure('<root>\n</root>\n');

    expect(stats).toEqual({
      properties: [],
      baseMethods: [],
      cellMethods: [],
      clientMethods: [],
      parent: undefined,
      interfaces: [],
      components: []
    });
  });
});

describe('EntityExplorerProvider basic tree behaviour', () => {
  it('returns no children without a workspace', async () => {
    const previous = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [];
    try {
      const provider = new EntityExplorerProvider();
      await expect(provider.getChildren()).resolves.toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = previous;
    }
  });

  it('refreshes without throwing and passes tree items through', () => {
    const provider = new EntityExplorerProvider();
    const item = { label: 'x' } as unknown as vscode.TreeItem;

    expect(() => provider.refresh()).not.toThrow();
    expect(provider.getTreeItem(item)).toBe(item);
  });
});

describe('EntityExplorerProvider root groups', () => {
  it('builds the four root groups with live counts as descriptions', () => {
    const provider = makeExplorer();
    const groups = provider.getRootGroups(explorerRoot());

    expect(groups.map(g => [g.label, g.description])).toEqual([
      ['Types', '1'],
      ['Entities', '5'],
      ['Interfaces', '1'],
      ['Components', '1']
    ]);
    expect(groups.map(g => g.category)).toEqual(['type', 'entity', 'interface', 'component']);
    expect(groups.map(g => g.iconPath?.id)).toEqual([
      'symbol-type-parameter',
      'symbol-class',
      'symbol-interface',
      'extensions'
    ]);
    expect(groups.map(g => g.contextValue)).toEqual([
      'definition_group_type',
      'definition_group_entity',
      'definition_group_interface',
      'definition_group_component'
    ]);
  });
});

describe('EntityExplorerProvider descriptions', () => {
  it('describes a registered entity through its runtime profile', () => {
    const provider = makeExplorer();

    // Hero 声明 base/cell/client 且都为 true:三角色标签 + 客户端可见
    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'Hero', category: 'entity', filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'Hero.def'),
      exists: true, registered: true, hasBase: true, hasCell: true, hasClient: true
    })).toBe('BaseApp / CellApp / Client, Client Entity');

    // Ghost 无声明 flags 且无脚本:三 facet 全 disabled
    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'Ghost', category: 'entity', filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'Ghost.def'),
      exists: true, registered: true
    })).toBe('None, Server Only');

    // Monster 显式 hasClient=false:声明的 disabled 直接生效
    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'Monster', category: 'entity', filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'Monster.def'),
      exists: true, registered: true, hasClient: false
    })).toBe('None, Server Only');

    // 未注册条目拿不到 runtime profile,只剩 Unregistered 标记
    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'Unregistered', category: 'entity',
      filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'Unregistered.def'),
      exists: true, registered: false
    })).toBe('Unregistered');
  });

  it('describes types, interfaces and components', () => {
    const provider = makeExplorer();

    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'ITEM_ID', category: 'type',
      filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'types.xml'),
      exists: true, registered: true, aliasType: 'UINT16'
    })).toBe('UINT16, Python Missing');

    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'MoveIface', category: 'interface',
      filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'interfaces', 'MoveIface.def'),
      exists: true, registered: true
    })).toBe('MoveIface.def');

    expect(provider.buildDefinitionDescription(explorerRoot(), {
      name: 'HealthComp', category: 'component',
      filePath: p(explorerRoot(), 'scripts', 'entity_defs', 'components', 'HealthComp.def'),
      exists: false, registered: true
    })).toBe('Missing');
  });
});

describe('EntityExplorerProvider view models', () => {
  it('builds the Hero summary with counters and section keys', () => {
    const hero = entityItem('Hero');
    const summary = summaryOf(hero.viewModel);

    expect(summary['Definition']).toBe(p('scripts', 'entity_defs', 'Hero.def'));
    expect(summary['Category']).toBe('Entity');
    expect(summary['Registered']).toBe('Yes');
    expect(summary['Runtime']).toBe('BaseApp / CellApp / Client');
    expect(summary['Visibility']).toBe('Has client entity definition');
    expect(summary['Registration']).toBe('Registered on BaseApp / CellApp / Client');
    expect(summary['Interfaces']).toBe('1');
    expect(summary['Components']).toBe('1');
    // hp + 混入 MoveIface 的 stride(接口混入是独立的 inheritance group)
    expect(summary['Properties']).toBe('2');
    expect(summary['Mixed In']).toBe('1');
    expect(summary['Methods']).toBe('4');
    // exposed: onSave(Base) + dash(Cell),方法段只收非 exposed 方法
    expect(summary['Exposed']).toBe('2');
    // hp Persistent + healthPack 组件 → 主表 + 组件子表;
    // 子表按实现现状无字段(regen 未被收入),主表 6 个合成位置/朝向列
    expect(summary['DB Tables']).toBe('2');
    expect(summary['DB Fields']).toBe('6');

    expect(keysOf(hero.viewModel)).toEqual([
      'interfaces', 'components', 'runtime', 'exposed', 'database',
      'properties', 'BaseMethods', 'ClientMethods'
    ]);

    // 接口混入组出现在属性段
    const properties = hero.viewModel.sections.find(s => s.key === 'properties');
    expect(properties?.groups?.map(g => g.label)).toEqual(['Own', 'Mixin · MoveIface']);
  });

  it('exposes only unexposed methods in method sections', () => {
    const hero = entityItem('Hero');
    const baseMethods = hero.viewModel.sections.find(s => s.key === 'BaseMethods');
    const exposed = hero.viewModel.sections.find(s => s.key === 'exposed');

    expect(baseMethods?.items?.map(item => item.label)).toEqual(['onLoad']);
    expect(exposed?.groups?.[0].items.map(item => [item.label, item.description])).toEqual([
      ['onSave', 'BaseMethods'],
      ['dash', 'CellMethods']
    ]);
  });

  it('flattens inherited stats into the Monster view model', () => {
    const monster = entityItem('Monster');
    const summary = summaryOf(monster.viewModel);

    // 本地 ferocity + 继承 hp + 混入 stride;方法全部继承自 Hero
    expect(summary['Properties']).toBe('3');
    expect(summary['Methods']).toBe('4');
    // 父类链与接口混入各占一个组
    expect(summary['Mixed In']).toBe('2');
    expect(summary['Runtime']).toBe('None');
    // summary 的 Visibility 用 visibilitySummary(描述文案),非标签
    expect(summary['Visibility']).toBe('Server only (no client entity)');

    // 实现现状:无 persistent 属性也无条件建空主表(tbl_Monster,0 字段)
    expect(summary['DB Tables']).toBe('1');
    expect(summary['DB Fields']).toBe('0');

    const keys = keysOf(monster.viewModel);
    expect(keys).toEqual([
      'parent', 'runtime', 'exposed', 'database', 'properties',
      'BaseMethods', 'ClientMethods'
    ]);

    const properties = monster.viewModel.sections.find(s => s.key === 'properties');
    expect(properties?.groups?.map(g => g.label)).toEqual([
      'Own', 'Parent · Hero', 'Parent · Hero / MoveIface'
    ]);

    const parentSection = monster.viewModel.sections.find(s => s.key === 'parent');
    expect(parentSection?.items?.[0].label).toBe('Hero');
  });

  it('short-circuits missing definition files with a status line', () => {
    const phantom = entityItem('Phantom');
    const summary = summaryOf(phantom.viewModel);

    expect(summary['Status']).toBe('Definition file not found');
    expect(keysOf(phantom.viewModel)).toEqual([]);
    // !exists → warning 图标,且不挂打开命令
    expect(phantom.iconPath?.id).toBe('warning');
    expect(phantom.command).toBeUndefined();
    expect(phantom.description).toBe('Client, Client Entity');
  });

  it('builds the alias view model for types', () => {
    const provider = makeExplorer();
    const items = provider.getDefinitionItems(explorerRoot(), 'type');

    expect(items).toHaveLength(1);
    const itemId = items[0];
    const summary = summaryOf(itemId.viewModel);

    expect(summary['AliasType']).toBe('UINT16');
    expect(summary['Python']).toBe('Missing');
    expect(keysOf(itemId.viewModel)).toEqual(['alias']);
    expect(itemId.iconPath?.id).toBe('symbol-type-parameter');
  });

  it('assigns the circle-outline icon to unregistered defs', () => {
    const unregistered = entityItem('Unregistered');

    expect(unregistered.iconPath?.id).toBe('circle-outline');
    // 未注册条目仍可打开文件
    expect(unregistered.command?.command).toBe('vscode.open');
    expect((unregistered.command?.arguments?.[0] as { fsPath: string }).fsPath)
      .toBe(p(explorerRoot(), 'scripts', 'entity_defs', 'Unregistered.def'));
    expect(unregistered.tooltip).toBe(
      `Unregistered\n${p(explorerRoot(), 'scripts', 'entity_defs', 'Unregistered.def')}`
    );
  });
});

describe('EntityExplorerProvider category helpers', () => {
  it('maps categories to labels and icons', () => {
    const provider = makeExplorer();

    expect(provider.getCategoryLabel('type')).toBe('Type');
    expect(provider.getCategoryLabel('entity')).toBe('Entity');
    expect(provider.getCategoryLabel('interface')).toBe('Interface');
    expect(provider.getCategoryLabel('component')).toBe('Component');
    expect(provider.getCategoryIcon('type')).toBe('symbol-type-parameter');
    expect(provider.getCategoryIcon('entity')).toBe('symbol-class');
    expect(provider.getCategoryIcon('interface')).toBe('symbol-interface');
    expect(provider.getCategoryIcon('component')).toBe('extensions');
  });

  it('keeps components as their own parent category', () => {
    const provider = makeExplorer();

    expect(provider.resolveParentCategory({ category: 'component' })).toBe('component');
    expect(provider.resolveParentCategory({ category: 'entity' })).toBe('entity');
    expect(provider.resolveParentCategory({ category: 'interface' })).toBe('entity');
  });

  it('describes all reachable runtime facets', () => {
    const provider = makeExplorer();

    expect(provider.describeRuntimeFacet({ enabled: true, declared: true, scriptExists: false }))
      .toBe('Declared On');
    expect(provider.describeRuntimeFacet({ enabled: false, declared: true, scriptExists: false }))
      .toBe('Declared Off');
    expect(provider.describeRuntimeFacet({ enabled: true, declared: false, scriptExists: true }))
      .toBe('Inferred From Script');
    // 声明存在且脚本存在但显式关闭:scriptExists 分支的 disabled 文案
    expect(provider.describeRuntimeFacet({ enabled: false, declared: false, scriptExists: true }))
      .toBe('Script Present');
    expect(provider.describeRuntimeFacet({ enabled: false, declared: false, scriptExists: false }))
      .toBe('Not Declared');
  });
});

describe('ServerControlProvider', () => {
  const makeServerProvider = (): ServerControlProvider =>
    new ServerControlProvider(
      new KBEngineServerManager({} as unknown as vscode.ExtensionContext)
    );

  it('lists every component as a stopped tree item initially', async () => {
    const provider = makeServerProvider();
    const children = await provider.getChildren();

    expect(children).toHaveLength(10);
    // 启动前全部 Stopped:默认图标、无 description、tooltip 带状态后缀
    expect(children.every(item => item.iconPath?.id === 'circle-large-outline')).toBe(true);
    expect(children.every(item => item.description === undefined)).toBe(true);
    expect(children.every(item => item.tooltip?.endsWith('状态: stopped'))).toBe(true);
    expect(children.map(item => item.label)).toEqual([
      'Machine', 'Logger', 'Interfaces', 'DBMgr', 'BaseAppMgr',
      'CellAppMgr', 'BaseApp', 'CellApp', 'LoginApp', 'Bots'
    ]);
  });

  it('passes tree items through and yields no descendants', async () => {
    const provider = makeServerProvider();
    const children = await provider.getChildren();

    expect(provider.getTreeItem(children[0])).toBe(children[0]);
    await expect(provider.getChildren(children[0])).resolves.toEqual([]);
    expect(() => provider.refresh()).not.toThrow();
  });

  it('reports the stopped baseline as the enum value', () => {
    expect(ServerStatus.Stopped).toBe('stopped');
  });
});
