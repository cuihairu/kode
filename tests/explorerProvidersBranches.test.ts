import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityExplorerProvider } from '../src/explorerProviders';
import { workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// 批60 分支覆盖专项(explorerProviders.ts):
// - 存在的接口/组件定义条目进入视图模型后,非实体侧的分支才可达:数据库模型
//   的零值回落、无运行时档案段、属性描述用类别标签前缀、组件方法条目的命令
//   走"打开定义"而非方法打开命令、层级统计按 component/interface 归类;
// - 只有继承属性没有自身属性的实体:properties 段跳过 Own 组;
// - 悬空 Parent 引用:实体类别下不再回退查其他类别,描述退化为引用名;
// - readDefinitionStats 的 interfaces/components 路径判定;
// - 类型条目的兜底与组合:aliasType 缺失、rawValue 缺失、深结构为空时的
//   alias 回落条目、属性 typeName 缺失、叶子结构 rawValue 与名不等;
// - 视图模型的工作区根自身路径(relative 为空时回落 filePath);
// - 方法条目 exposed 侧与身份缺失时的兜底身份(类型上 identity 可选)。

type DefinitionEntryLike = {
  name: string;
  filePath: string;
  category: string;
  exists: boolean;
  registered: boolean;
  line?: number;
  aliasType?: string;
  rawValue?: string;
  typeStructure?: unknown;
  implementedBy?: string;
  pythonFilePath?: string;
};

interface LeafLike {
  label: string;
  description?: string;
  icon: string;
  command?: { command: string; arguments?: unknown[] };
}

interface SectionDescriptorLike {
  key: string;
  label: string;
  items?: LeafLike[];
  groups?: Array<{ label: string; items: LeafLike[] }>;
}

// getChildren 返回的是 DefinitionSectionItem 包装,描述符挂在 .section 上
interface SectionItemLike {
  section: SectionDescriptorLike;
}

interface ViewModelLike {
  summary: Array<{ label: string; value: string; icon: string }>;
  sections: SectionDescriptorLike[];
}

interface ExplorerInternals {
  getChildren(element?: unknown): Promise<unknown[]> | unknown[];
  buildDefinitionDescription(workspaceRoot: string, entry: unknown): string;
  buildDefinitionViewModel(workspaceRoot: string, entry: unknown): ViewModelLike;
  readDefinitionStats(defPath: string): Record<string, unknown>;
  createTypePropertyItem(workspaceRoot: string, property: unknown): LeafLike;
  createTypeStructureItems(workspaceRoot: string, structure?: unknown): LeafLike[];
  createMethodItem(entry: unknown, method: unknown, section: string): LeafLike;
  createMethodCommand(entry: unknown, method: unknown, section: string): { command: string; arguments: unknown[] } | undefined;
}

const makeExplorer = (): ExplorerInternals & EntityExplorerProvider =>
  new EntityExplorerProvider() as unknown as ExplorerInternals & EntityExplorerProvider;

let root = '';

const write = (relative: string, content: string): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const p = (...segments: string[]) => path.join(root, ...segments);

const groupByLabel = async (label: string): Promise<Array<{ definition: { name: string } }>> => {
  const provider = makeExplorer();
  const groups = (await provider.getChildren()) as Array<{ label: string }>;
  const group = groups.find(item => item.label === label);
  expect(group, `group ${label} exists`).toBeTruthy();
  return (await provider.getChildren(group)) as Array<{ definition: { name: string } }>;
};

const sectionsOf = async (element: unknown): Promise<SectionItemLike[]> => {
  const provider = makeExplorer();
  return (await provider.getChildren(element)) as SectionItemLike[];
};

const sectionOf = (
  sections: SectionItemLike[] | SectionDescriptorLike[],
  key: string
): SectionDescriptorLike | undefined =>
  sections
    .map(item => (item as SectionItemLike).section ?? (item as SectionDescriptorLike))
    .find(section => section.key === key);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-explorer-branch-'));

  write('scripts/entities.xml', [
    '<root>',
    '  <Kid hasBase="true"/>',
    '  <Guardian hasBase="true"/>',
    '  <OrphanKid hasBase="true"/>',
    '</root>'
  ].join('\n'));

  // 只继承属性、自身无属性的实体:properties 段只有继承组,不建 Own 组
  write('scripts/entity_defs/Guardian.def', [
    '<root>',
    '  <Properties>',
    '    <armor>',
    '      <Type>UINT16</Type>',
    '      <Flags>BASE</Flags>',
    '    </armor>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  write('scripts/entity_defs/Kid.def', [
    '<root>',
    '  <Parent><Guardian/></Parent>',
    '</root>'
  ].join('\n'));

  // 悬空父引用:实体类别下找不到定义,回退查询对其他类别才生效
  write('scripts/entity_defs/OrphanKid.def', [
    '<root>',
    '  <Parent><NoSuchAnc/></Parent>',
    '</root>'
  ].join('\n'));

  // 存在的接口定义:自身属性 + 非 exposed 方法
  write('scripts/entity_defs/interfaces/IfaceX.def', [
    '<root>',
    '  <Properties>',
    '    <gauge>',
    '      <Type>UINT8</Type>',
    '    </gauge>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <ping/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  // 存在的组件定义:自身属性 + CellMethods(方法命令走"打开定义"分支)
  write('scripts/entity_defs/components/CompX.def', [
    '<root>',
    '  <Properties>',
    '    <charge>',
    '      <Type>UINT32</Type>',
    '    </charge>',
    '  </Properties>',
    '  <CellMethods>',
    '    <apply/>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

describe('explorer 非实体条目的视图模型分支', () => {
  it('展开接口组:类别标签前缀、零数据库模型、方法条目的方法打开命令', async () => {
    const entries = await groupByLabel('Interfaces');
    const iface = entries.find(item => item.definition.name === 'IfaceX');
    expect(iface, 'IfaceX entry listed').toBeTruthy();

    const sections = await sectionsOf(iface);
    const properties = sectionOf(sections, 'properties');
    expect(properties, 'properties section present').toBeTruthy();
    // 非实体条目:属性描述带类别标签前缀
    expect(properties!.items?.map(item => item.label)).toEqual(['gauge']);
    expect(properties!.items?.[0].description).toBe('Interface Property');

    const methods = sectionOf(sections, 'BaseMethods');
    expect(methods?.items?.[0].description).toBe('BaseMethods');
    // 接口条目的方法命令仍是方法打开命令,身份由解析层给出
    expect(methods?.items?.[0].command?.command).toBe('kbengine.entity.method.open');
  });

  it('展开组件组:数据库模型零值、方法条目回落到打开定义命令', async () => {
    const entries = await groupByLabel('Components');
    const component = entries.find(item => item.definition.name === 'CompX');
    expect(component, 'CompX entry listed').toBeTruthy();

    const sections = await sectionsOf(component);
    // 非实体:无 database 段、无 runtime 段
    expect(sectionOf(sections, 'database')).toBeUndefined();
    expect(sectionOf(sections, 'runtime')).toBeUndefined();

    const properties = sectionOf(sections, 'properties');
    expect(properties!.items?.[0].description).toBe('Component Property');

    const methods = sectionOf(sections, 'CellMethods');
    expect(methods?.items?.map(item => item.label)).toEqual(['apply']);
    expect(methods?.items?.[0].command?.command).toBe('vscode.open');
  });

  it('只有继承属性的实体不建 Own 属性组', async () => {
    const entries = await groupByLabel('Entities');
    const kid = entries.find(item => item.definition.name === 'Kid');
    expect(kid, 'Kid entry listed').toBeTruthy();

    const sections = await sectionsOf(kid);
    const properties = sectionOf(sections, 'properties');
    expect(properties?.groups, 'groups wrapper used').toBeTruthy();
    expect(properties!.groups!.map(group => group.label)).toEqual(['Parent · Guardian']);
    expect(properties!.groups![0].items.map(item => item.label)).toEqual(['armor']);
  });

  it('悬空 Parent 引用退化为引用名且不带打开命令', async () => {
    const entries = await groupByLabel('Entities');
    const orphan = entries.find(item => item.definition.name === 'OrphanKid');
    expect(orphan, 'OrphanKid entry listed').toBeTruthy();

    const sections = await sectionsOf(orphan);
    const parent = sectionOf(sections, 'parent');
    expect(parent?.items?.[0].label).toBe('NoSuchAnc');
    // 实体类别不回退查其他类别:无路径时描述就是引用名,命令缺席
    expect(parent?.items?.[0].description).toBe('NoSuchAnc');
    expect(parent?.items?.[0].command).toBeUndefined();
  });
});

describe('explorer readDefinitionStats 的类别路径判定', () => {
  // readDefinitionStats 把入参整体当工作区根、本地名取 basename——以目录名
  // 与 <目录名>.def 同名命中真实解析路径;这里再让根的父链带上
  // interfaces/ 与 components/ 段,驱动其类别判定两分支
  it('interfaces 与 components 路径特征各自成类别', () => {
    const provider = makeExplorer();

    const ifaceRoot = p('probe', 'interfaces', 'IfaceX');
    write('probe/interfaces/IfaceX/scripts/entity_defs/interfaces/IfaceX.def', [
      '<root>',
      '  <Properties>',
      '    <gauge>',
      '      <Type>UINT8</Type>',
      '    </gauge>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <ping/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    const ifaceStats = provider.readDefinitionStats(ifaceRoot);
    expect(ifaceStats.properties).toEqual(['gauge']);
    expect((ifaceStats.baseMethods as Array<{ name: string }>).map(item => item.name)).toEqual(['ping']);

    const compRoot = p('probe', 'components', 'CompX');
    write('probe/components/CompX/scripts/entity_defs/components/CompX.def', [
      '<root>',
      '  <Properties>',
      '    <charge>',
      '      <Type>UINT32</Type>',
      '    </charge>',
      '  </Properties>',
      '  <CellMethods>',
      '    <apply/>',
      '  </CellMethods>',
      '</root>'
    ].join('\n'));

    const compStats = provider.readDefinitionStats(compRoot);
    expect(compStats.properties).toEqual(['charge']);
    expect((compStats.cellMethods as Array<{ name: string }>).map(item => item.name)).toEqual(['apply']);
  });
});

describe('explorer 类型条目的兜底与组合分支', () => {
  it('aliasType 缺失时描述与汇总都回落 ALIAS', () => {
    const provider = makeExplorer();
    const bareType: DefinitionEntryLike = {
      name: 'BARE',
      filePath: p('scripts', 'entity_defs', 'types.xml'),
      category: 'type',
      exists: true,
      registered: true
    };

    expect(provider.buildDefinitionDescription(root, bareType)).toBe('ALIAS, Python Missing');

    const model = provider.buildDefinitionViewModel(root, bareType);
    const aliasType = model.summary.find(item => item.label === 'AliasType');
    expect(aliasType?.value).toBe('ALIAS');
    // 无 rawValue:alias 段整段不建
    expect(sectionOf(model.sections, 'alias')).toBeUndefined();
  });

  it('深结构为空时 alias 段回落单条目,别名缺失时标签用 ALIAS', () => {
    const provider = makeExplorer();
    const base: DefinitionEntryLike = {
      name: 'EMPTY',
      filePath: p('scripts', 'entity_defs', 'types.xml'),
      category: 'type',
      exists: true,
      registered: true,
      rawValue: 'UINT16'
    };

    // aliasType 缺失:回落条目标签走 || 右侧,描述就是 rawValue
    const withoutAlias = provider.buildDefinitionViewModel(root, base);
    const aliasSection = sectionOf(withoutAlias.sections, 'alias');
    expect(aliasSection?.items?.map(item => item.label)).toEqual(['ALIAS']);
    expect(aliasSection?.items?.[0].description).toBe('UINT16');

    // aliasType 存在:回落条目标签用别名(|| 左侧)
    const withAlias = provider.buildDefinitionViewModel(root, { ...base, aliasType: 'UINT8' });
    expect(sectionOf(withAlias.sections, 'alias')?.items?.[0].label).toBe('UINT8');
  });

  it('工作区根自身的相对路径为空时回落到绝对路径', () => {
    const model = makeExplorer().buildDefinitionViewModel(root, {
      name: 'RootLike',
      filePath: root,
      category: 'entity',
      exists: false,
      registered: false
    } satisfies DefinitionEntryLike);

    expect(model.summary[0].value).toBe(root);
    expect(model.sections).toEqual([]);
  });

  it('属性类型名缺失与叶子结构值不等同名各有表现', () => {
    const provider = makeExplorer();

    // typeName 缺失(类型上可选):UNKNOWN 前缀
    expect(provider.createTypePropertyItem(root, { name: 'x' }).description)
      .toBe('UNKNOWN · Unresolved');

    // 叶子结构 rawValue 与名不等:描述带值前缀(引用按名解析,coins 无定义)
    const leaf = provider.createTypeStructureItems(root, {
      name: 'coins',
      rawValue: 'UINT32',
      children: []
    });
    expect(leaf[0].description).toBe('UINT32 · Unresolved');

    // 对照:rawValue 与名相等时只留解析标签
    const same = provider.createTypeStructureItems(root, {
      name: 'UINT32',
      rawValue: 'UINT32',
      children: []
    });
    expect(same[0].description).toBe('Built-in');
  });
});

describe('explorer 方法条目与命令的兜底形态', () => {
  const entityEntry = {
    name: 'Hero',
    filePath: p('scripts', 'entity_defs', 'Hero.def'),
    category: 'entity',
    exists: true,
    registered: true,
    line: 1
  };
  const interfaceEntry = { ...entityEntry, name: 'IfaceY', category: 'interface' };
  const componentEntry = { ...entityEntry, name: 'CompY', category: 'component' };

  it('exposed 方法条目走 Exposed 描述与信号塔图标', () => {
    const item = makeExplorer().createMethodItem(entityEntry, { name: 'cast', exposed: true }, 'BaseMethods');
    expect(item.description).toBe('BaseMethods · Exposed');
    expect(item.icon).toBe('radio-tower');

    const plain = makeExplorer().createMethodItem(entityEntry, { name: 'walk', exposed: false }, 'BaseMethods');
    expect(plain.description).toBe('BaseMethods');
    expect(plain.icon).toBe('symbol-method');
  });

  it('身份缺失时命令参数回落为按条目类别组装的身份', () => {
    const provider = makeExplorer();

    const entityCommand = provider.createMethodCommand(entityEntry, { name: 'cast' }, 'BaseMethods');
    expect(entityCommand?.arguments?.[0]).toEqual({
      ownerKind: 'entity',
      ownerName: 'Hero',
      sourceKind: 'local',
      sourceChain: [],
      section: 'BaseMethods',
      symbolName: 'cast'
    });

    const interfaceCommand = provider.createMethodCommand(interfaceEntry, { name: 'cast' }, 'CellMethods');
    expect((interfaceCommand?.arguments?.[0] as { ownerKind: string }).ownerKind).toBe('interface');
    expect(interfaceCommand?.command).toBe('kbengine.entity.method.open');
  });

  it('组件条目的方法命令回落到打开定义', () => {
    const command = makeExplorer().createMethodCommand(componentEntry, { name: 'apply' }, 'CellMethods');
    expect(command?.command).toBe('vscode.open');
  });

  it('带身份的方法条目直接透传身份', () => {
    const identity = {
      ownerKind: 'entity',
      ownerName: 'Hero',
      sourceKind: 'local',
      sourceChain: [],
      section: 'BaseMethods',
      symbolName: 'cast'
    };
    const command = makeExplorer().createMethodCommand(entityEntry, { name: 'cast', identity }, 'BaseMethods');
    expect(command?.arguments?.[0]).toBe(identity);
  });
});
