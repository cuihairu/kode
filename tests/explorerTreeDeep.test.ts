import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EntityExplorerProvider,
  ServerControlProvider,
  pickServerComponent
} from '../src/explorerProviders';
import { SERVER_COMPONENTS } from '../src/serverManager';
import type * as serverManagerModule from '../src/serverManager';
import { window as stubWindow, workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// explorerProviders 的树形下钻与缺口分支:getChildren 五层 instanceof
// 链(真实临时 workspace)、type 分支(implementedBy/python/user_type/
// typeProperties 引用解析)、readDefinitionStats 与回落、
// pickServerComponent、ServerControlProvider 状态描述。私有方法经
// 实例直调;QuickPick 由 monkey-patch 驱动。

interface LeafLike {
  label?: string;
  description?: string;
  iconPath?: { id: string };
  contextValue?: string;
  command?: { command: string; arguments?: unknown[] } | undefined;
}

interface SectionLike {
  definition: { name: string };
  section: {
    key: string;
    label: string;
    items?: Array<{ label: string; description?: string }>;
    groups?: Array<{ label: string; items: Array<{ label: string; description?: string }> }>;
  };
}

type ExplorerInternals = EntityExplorerProvider & {
  readDefinitionStats(defPath: string): Record<string, unknown>;
  createTypeStructureItems(root: string, structure?: unknown): LeafLike[];
  resolveTypeReference(root: string, typeName: string): { label: string; icon: string };
  buildDefinitionDescription(root: string, entry: Record<string, unknown>): string;
};

const makeExplorer = (): ExplorerInternals =>
  new EntityExplorerProvider() as unknown as ExplorerInternals;

let workspaceRoot = '';

const write = (relative: string, content: string): void => {
  const target = path.join(workspaceRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

beforeAll(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-explorer-deep-'));

  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true"/>',
    '</root>'
  ].join('\n'));

  write('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <Components>',
    '    <pack>',
    '      <Type>HealthComp</Type>',
    '    </pack>',
    '  </Components>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '    <meta>',
    '      <Type>FIXED_DICT</Type>',
    '      <Properties>',
    '        <weight>',
    '          <Type>UINT8</Type>',
    '        </weight>',
    '      </Properties>',
    '    </meta>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onSave><Exposed/></onSave>',
    '    <onLoad/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <dash><Exposed/></dash>',
    '    <move/>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));

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
    '  <GOLD>UINT32</GOLD>',
    '  <WIDGET>',
    '    <Type>UINT16</Type>',
    '    <implementedBy>game.widget</implementedBy>',
    '  </WIDGET>',
    '  <BAGSPEC>',
    '    <Type>FIXED_DICT</Type>',
    '    <Properties>',
    '      <gold><Type>UINT32</Type></gold>',
    '      <spec><Type>BAGSPEC</Type></spec>',
    '      <pack><Type>HealthComp</Type></pack>',
    '      <hero><Type>Hero</Type></hero>',
    '      <ghost><Type>NoSuchType123</Type></ghost>',
    '    </Properties>',
    '  </BAGSPEC>',
    '</root>'
  ].join('\n'));

  write('scripts/user_type/game/widget.py', 'class Widget:\n    pass\n');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(workspaceRoot), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

const send = (node: unknown): unknown[] => {
  const provider = makeExplorer();
  return provider.getChildren(node as never) as unknown as unknown[];
};

const findSection = (sections: unknown[], key: string): SectionLike =>
  (sections as SectionLike[]).find(section => section.section.key === key) as SectionLike;

describe('EntityExplorerProvider.getChildren drill-down', () => {
  it('expands the root into the four category groups', async () => {
    const groups = (await send(undefined)) as Array<{ label: string; description?: string }>;

    expect(groups.map(group => group.label)).toEqual(['Types', 'Entities', 'Interfaces', 'Components']);
    expect((groups[1] as { description?: string }).description).toBe('1');
  });

  it('expands the entities group into definition items', async () => {
    const groups = (await send(undefined)) as Array<{ label: string; category?: string }>;
    const entitiesGroup = groups.find(group => group.label === 'Entities');
    const definitions = (await send(entitiesGroup)) as Array<{ definition: { name: string } }>;

    expect(definitions.map(item => item.definition.name)).toEqual(['Hero']);
  });

  it('expands a definition into the summary section plus view model sections', async () => {
    const groups = (await send(undefined)) as Array<{ label: string }>;
    const definitions = (await send(groups[1])) as unknown[];
    const sections = (await send(definitions[0])) as SectionLike[];

    expect(sections[0].section.key).toBe('summary');
    expect(sections[0].contextValue).toBe('definition_section_entity_summary');
    expect(sections.slice(1).map(section => section.section.key)).toEqual([
      'interfaces', 'components', 'runtime', 'exposed', 'database', 'properties', 'BaseMethods', 'CellMethods'
    ]);
  });

  it('expands the summary section into leaves carrying summary values', async () => {
    const groups = (await send(undefined)) as Array<{ label: string }>;
    const definitions = (await send(groups[1])) as unknown[];
    const sections = (await send(definitions[0])) as SectionLike[];
    const leaves = (await send(sections[0])) as LeafLike[];

    const values = leaves.map(leaf => leaf.description);
    expect(values[0]).toContain('Hero.def');
    expect(values[1]).toBe('Entity');
    expect(leaves[0].contextValue).toBe('definition_leaf');
  });

  it('expands grouped sections via DefinitionGroupItem and ungrouped sections directly', async () => {
    const groups = (await send(undefined)) as Array<{ label: string }>;
    const definitions = (await send(groups[1])) as unknown[];
    const sections = (await send(definitions[0])) as SectionLike[];

    // exposed/database 段走 groups;方法段走 items
    const exposed = findSection(sections, 'exposed');
    const exposedGroups = (await send(exposed)) as Array<{ group?: { label: string; items: LeafLike[] } }>;
    expect(exposedGroups.map(group => group.group!.label)).toEqual(['Own']);

    const exposedLeaves = (await send(exposedGroups[0])) as LeafLike[];
    expect(exposedLeaves.map(leaf => leaf.label).sort()).toEqual(['dash', 'onSave']);

    const baseMethods = findSection(sections, 'BaseMethods');
    const methodLeaves = (await send(baseMethods)) as LeafLike[];
    expect(methodLeaves.map(leaf => leaf.label)).toEqual(['onLoad']);
    expect(methodLeaves[0].description).toBe('BaseMethods');

    const database = findSection(sections, 'database');
    const dbGroups = (await send(database)) as Array<{ group?: { label: string; items: LeafLike[] } }>;
    // 根表 + pack 组件子表
    expect(dbGroups.map(group => group.group!.label)).toEqual(['tbl_Hero', 'tbl_Hero_pack']);

    const dbLeaves = (await send(dbGroups[0])) as LeafLike[];
    // hasCell 实体:合成位置/朝向列在字段最前,真实属性 sm_hp 紧随
    expect(dbLeaves[0].label).toBe('sm_position_0');
    expect(dbLeaves.map(leaf => leaf.label)).toContain('sm_hp');
    expect(dbLeaves.find(leaf => leaf.label === 'sm_hp')!.command!.command).toBe('kbengine.database.open');
  });

  it('returns no children below a leaf and for unknown elements', async () => {
    const groups = (await send(undefined)) as Array<{ label: string }>;
    const definitions = (await send(groups[1])) as unknown[];
    const sections = (await send(definitions[0])) as SectionLike[];
    const leaves = (await send(sections[0])) as unknown[];

    expect(await send(leaves[0])).toEqual([]);
    expect(await send({} as never)).toEqual([]);
  });

  it('expands type definitions with alias, properties and python sections', async () => {
    const groups = (await send(undefined)) as Array<{ label: string }>;
    const types = (await send(groups[0])) as Array<{ definition: { name: string } }>;
    const widget = types.find(item => item.definition.name === 'WIDGET') as unknown;

    const sections = (await send(widget)) as SectionLike[];
    // WIDGET 无 Properties 子节点 → 无 properties 段
    expect(sections.slice(1).map(section => section.section.key)).toEqual(['alias', 'python']);

    const typeItems = (await send(groups[0])) as Array<{ definition: { name: string } }>;
    const bagspec = typeItems.find(item => item.definition.name === 'BAGSPEC') as unknown;
    const bagSections = (await send(bagspec)) as SectionLike[];
    expect(bagSections.slice(1).map(section => section.section.key)).toEqual(['alias', 'properties']);

    const properties = findSection(bagSections, 'properties');
    const leaves = (await send(properties)) as LeafLike[];
    // 引用解析:description = '<type> · <label>'
    const byLabel = Object.fromEntries(leaves.map(leaf => [leaf.label, leaf.description]));
    expect(byLabel.gold).toContain('UINT32 · Built-in');
    expect(byLabel.spec).toContain('BAGSPEC · Type');
    expect(byLabel.pack).toContain('HealthComp · Component');
    expect(byLabel.hero).toContain('Hero · Entity');
    expect(byLabel.ghost).toContain('NoSuchType123 · Unresolved');

    const python = findSection(sections, 'python');
    expect(python.section.items![0].label).toBe('widget.py');
    expect(python.section.items![0].description).toBe('scripts/user_type/game/widget.py');
  });
});

describe('EntityExplorerProvider internals gap branches', () => {
  it('reads definition stats when the root basename resolves to a def file', () => {
    // 实现语义:入参即 workspaceRoot,name 取 basename(workspaceRoot),
    // category 按 /interfaces//components/ 路径特征判定
    const rootBasename = path.basename(workspaceRoot);
    write(`scripts/entity_defs/${rootBasename}.def`, [
      '<root>',
      '  <Properties>',
      '    <stamina>',
      '      <Type>UINT32</Type>',
      '    </stamina>',
      '  </Properties>',
      '  <BaseMethods>',
    '    <sync/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    const provider = makeExplorer();
    const stats = provider.readDefinitionStats(workspaceRoot);

    expect(stats.properties).toEqual(['stamina']);
    expect((stats.baseMethods as Array<{ name: string }>)[0].name).toBe('sync');
  });

  it('falls back to the empty stats shape for unreadable files', () => {
    const provider = makeExplorer();
    const stats = provider.readDefinitionStats(path.join(workspaceRoot, 'scripts/entity_defs/Missing.def'));

    expect(stats).toEqual({
      properties: [],
      baseMethods: [],
      cellMethods: [],
      clientMethods: [],
      interfaces: [],
      components: []
    });
  });

  it('resolves type references across all five outcomes', () => {
    const provider = makeExplorer();

    expect(provider.resolveTypeReference(workspaceRoot, 'UINT32').label).toBe('Built-in');
    expect(provider.resolveTypeReference(workspaceRoot, 'BAGSPEC').label).toBe('Type');
    expect(provider.resolveTypeReference(workspaceRoot, 'HealthComp').label).toBe('Component');
    expect(provider.resolveTypeReference(workspaceRoot, 'Hero').label).toBe('Entity');
    expect(provider.resolveTypeReference(workspaceRoot, 'NothingAtAll').label).toBe('Unresolved');
  });

  it('returns an empty item list for an absent type structure', () => {
    const provider = makeExplorer();
    expect(provider.createTypeStructureItems(workspaceRoot, undefined)).toEqual([]);
  });

  it('describes types with implementedBy and missing python files', () => {
    const provider = makeExplorer();
    const description = provider.buildDefinitionDescription(workspaceRoot, {
      category: 'type',
      aliasType: 'UINT16',
      implementedBy: 'game.widget',
      pythonFilePath: undefined
    });

    expect(description).toBe('UINT16, implementedBy: game.widget, Python Missing');
  });

  it('describes entities via base/cell/client flags when no runtime profile resolves', () => {
    const provider = makeExplorer();
    const description = provider.buildDefinitionDescription(workspaceRoot, {
      category: 'entity',
      name: 'NotRegisteredAnywhere',
      filePath: path.join(workspaceRoot, 'scripts/entity_defs/NotRegisteredAnywhere.def'),
      exists: true,
      registered: false,
      hasBase: true,
      hasCell: true,
      hasClient: false
    });

    expect(description).toBe('Base, Cell, Unregistered');
  });
});

describe('pickServerComponent', () => {
  const windowish = stubWindow as unknown as Record<string, unknown>;

  it('offers every server component through the quick pick', async () => {
    const original = windowish.showQuickPick;
    let seenItems: Array<{ label: string; description?: string; name: string }> = [];
    let seenOptions: { placeHolder?: string } | undefined;
    windowish.showQuickPick = async (items: Array<{ label: string; description?: string; name: string }>, options?: { placeHolder?: string }) => {
      seenItems = items;
      seenOptions = options;
      return items[0];
    };

    try {
      const picked = await pickServerComponent('pick one');
      expect(picked).toBe(seenItems[0]);
      expect(seenItems.map(item => item.name)).toEqual(SERVER_COMPONENTS.map(component => component.name));
      expect(seenItems.every(item => item.label && item.description)).toBe(true);
      expect(seenOptions!.placeHolder).toBe('pick one');
    } finally {
      windowish.showQuickPick = original;
    }
  });
});

interface ServerComponentLike {
  name: string;
  displayName: string;
  description: string;
}

interface RunningServerLike {
  status: serverManagerModule.ServerStatus;
  pid?: number;
}

type ServerControlInternals = {
  new (manager: unknown): {
    getChildren(element?: unknown): Promise<LeafLike[]>;
    getTreeItem(element: unknown): unknown;
    refresh(): void;
  };
};

describe('ServerControlProvider status rendering', () => {
  const makeControl = (running: Map<string, RunningServerLike>) => {
    const manager = {
      getAllServers: (): ServerComponentLike[] => [
        { name: 'baseapp', displayName: 'BaseApp', description: 'd1' },
        { name: 'cellapp', displayName: 'CellApp', description: 'd2' },
        { name: 'logger', displayName: 'Logger', description: 'd3' },
        { name: 'dbmgr', displayName: 'DBMgr', description: 'd4' },
        { name: 'loginapp', displayName: 'LoginApp', description: 'd5' }
      ],
      getRunningServers: (): Map<string, RunningServerLike> => running
    };
    const Control = ServerControlProvider as unknown as ServerControlInternals;
    return new Control(manager);
  };

  it('renders running, starting, stopping and error descriptions', async () => {
    const { ServerStatus } = await import('../src/serverManager');
    const control = makeControl(new Map([
      ['baseapp', { status: ServerStatus.Running, pid: 4321 }],
      ['cellapp', { status: ServerStatus.Starting }],
      ['logger', { status: ServerStatus.Stopping }],
      ['dbmgr', { status: ServerStatus.Error }]
    ]));

    const items = await control.getChildren();
    const byLabel = Object.fromEntries(items.map(item => [item.label, item]));

    expect(byLabel.BaseApp.description).toBe('PID: 4321');
    expect(byLabel.BaseApp.contextValue).toBe('server_baseapp');
    expect(byLabel.BaseApp.tooltip).toContain('BaseApp');
    expect(byLabel.CellApp.description).toBe('启动中...');
    expect(byLabel.Logger.description).toBe('停止中...');
    expect(byLabel.DBMgr.description).toBe('错误');
    expect(byLabel.LoginApp.description).toBeUndefined();
  });

  it('passes elements through getTreeItem and yields no descendants', async () => {
    const control = makeControl(new Map());
    const items = await control.getChildren();

    expect(control.getTreeItem(items[0])).toBe(items[0]);
    expect(await control.getItems?.()).toBeUndefined?.();
    expect(await control.getChildren(items[0])).toEqual([]);
  });
});
