import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityExplorerProvider } from '../src/explorerProviders';
import { workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// explorerProviders 的统计与层级回落缺口:readDefinitionStats 把入参整体
// 当工作区根,本地名取 basename——用目录名与 <目录名>.def 同名命中真实
// 解析路径(顶层 ARRAY 属性保留名字,数组元素展开的 "名[]" 被
// toStatsFromProperties 过滤)。buildDefinitionDescription 的未注册实体
// 徽章回落。readDefinitionHierarchyStats 对 def 文件缺失的条目回落
// local-only。另有视图模型组装的组合分支:无继承组+有属性的 properties
// section 直出、有继承组+自身非 exposed 方法的 BaseMethods Own 组、
// def 是目录时数据库快照回落(无 database section)。三条死分支如实
// 记录:createMethodSectionDescriptor 的 groups 空守卫(L741,进入前置
// 是 inheritedGroups 非空,groups 恒非空)、readDefinitionStats 与
// readDefinitionHierarchyStats 的 loader 空守卫(入参路径恒非空)。

type ExplorerInternals = EntityExplorerProvider & {
  readDefinitionStats(defPath: string): Record<string, unknown>;
  buildDefinitionDescription(root: string, entry: Record<string, unknown>): string;
  readDefinitionHierarchyStats(
    root: string,
    entry: Record<string, unknown>
  ): { local: Record<string, unknown>; inherited: unknown[] };
  getChildren(element?: unknown): Promise<unknown[]> | unknown[];
};

interface SectionLike {
  definition?: { name: string };
  section: {
    key: string;
    label: string;
    items?: Array<{ label: string; description?: string }>;
    groups?: Array<{ label: string; items: Array<{ label: string; description?: string }> }>;
  };
}

const makeExplorer = (): ExplorerInternals =>
  new EntityExplorerProvider() as unknown as ExplorerInternals;

let root = '';

const write = (relative: string, content: string): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-explorer-gap-'));

  write('scripts/entities.xml', [
    '<root>',
    '  <Archer hasBase="true" hasCell="true" hasClient="true"/>',
    '  <BadXml hasBase="true"/>',
    '  <P1 hasBase="true"/>',
    '  <PBase hasBase="true"/>',
    '  <P2 hasBase="true"/>',
    '  <GhostDir hasBase="true"/>',
    '</root>'
  ].join('\n'));

  // 目录名与 <目录名>.def 同名:readDefinitionStats(root) 的 basename
  // 恰好命中注册文件。ARRAY-of 属性让扁平化访问 arrayElement 分支;
  // Interfaces/Components 段让成功 return 的映射回调真实执行
  write(`scripts/entity_defs/${path.basename(root)}.def`, [
    '<root>',
    '  <Properties>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '    </bag>',
    '    <focus>',
    '      <Type>UINT8</Type>',
    '    </focus>',
    '  </Properties>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <Components>',
    '    <pack>',
    '      <Type>NestedComp</Type>',
    '    </pack>',
    '  </Components>',
    '</root>'
  ].join('\n'));

  // 无 root 的坏 def:loadResolved 走成功路径(空 local),不入本批断言
  write('scripts/entity_defs/BadXml.def', 'not xml at all');

  // 无父类 + 有属性:properties section 走"无继承组直出"分支
  write('scripts/entity_defs/P1.def', [
    '<root>',
    '  <Properties>',
    '    <focus>',
    '      <Type>UINT8</Type>',
    '    </focus>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  // 父类与子类都带非 exposed Base 方法:子类的 BaseMethods section 走
  // "Own 组 + 继承组" 合并分支(父组零方法会被 items 空过滤掉)
  write('scripts/entity_defs/PBase.def', [
    '<root>',
    '  <BaseMethods>',
    '    <onSpawn/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write('scripts/entity_defs/P2.def', [
    '<root>',
    '  <Parent><PBase/></Parent>',
    '  <BaseMethods>',
    '    <onKill/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  // def 是目录:数据库快照读取 EISDIR 被 catch,回落空模型(无 database 段)
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'GhostDir.def'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

const drillEntities = async (): Promise<Map<string, SectionLike[]>> => {
  const provider = makeExplorer();
  const groups = (await provider.getChildren()) as Array<{ label: string }>;
  const entitiesGroup = groups.find(group => group.label === 'Entities');
  const definitions = (await provider.getChildren(entitiesGroup)) as Array<{ definition: { name: string } }>;
  const byName = new Map<string, SectionLike[]>();
  for (const item of definitions) {
    byName.set(item.definition.name, (await provider.getChildren(item)) as SectionLike[]);
  }
  return byName;
};

describe('explorer provider stats gaps', () => {
  it('flattens array element properties while mapping interfaces and components', () => {
    const stats = makeExplorer().readDefinitionStats(root);

    // 顶层属性入名单(bag 的名字不含 []);数组元素(bag[])被过滤
    expect(stats.properties).toEqual(['bag', 'focus']);
    expect(stats.baseMethods).toEqual([]);
    // Interfaces/Components 段映射进 stats
    expect(stats.parent).toBeUndefined();
    expect(stats.interfaces).toEqual(['MoveIface']);
    expect(stats.components).toEqual([
      { propertyName: 'pack', typeName: 'NestedComp' }
    ]);
  });

  it('marks client participation in the entity description', () => {
    // 未注册实体无 runtime profile,徽章回落 hasBase/hasCell/hasClient
    const description = makeExplorer().buildDefinitionDescription(root, {
      category: 'entity',
      name: 'ClientOnly',
      filePath: path.join(root, 'scripts/entity_defs/ClientOnly.def'),
      exists: true,
      registered: false,
      hasBase: true,
      hasCell: true,
      hasClient: true
    });

    expect(description).toBe('Base, Cell, Client, Unregistered');
  });

  it('falls back to local-only hierarchy when the def file is missing', () => {
    // Ghost 无 def 文件:loadResolved 返 null,回落 local-only(空 shape)
    const hierarchy = makeExplorer().readDefinitionHierarchyStats(root, {
      category: 'entity',
      name: 'Ghost',
      filePath: path.join(root, 'scripts/entity_defs/Ghost.def'),
      exists: false,
      registered: true,
      hasBase: true,
      hasCell: false,
      hasClient: false
    });

    expect(hierarchy.inherited).toEqual([]);
    expect(hierarchy.local.properties).toEqual([]);
    expect(hierarchy.local.parent).toBeUndefined();
  });

  it('emits a direct properties section for entities without inheritance', async () => {
    const byName = await drillEntities();
    const sections = byName.get('P1');
    expect(sections, 'P1 sections exist').toBeTruthy();

    const properties = sections!.find(section => section.section.key === 'properties');
    expect(properties).toBeTruthy();
    // 无继承组:属性直出 items,不经过 groups 包装
    expect(properties!.section.groups).toBeUndefined();
    expect(properties!.section.items?.map(item => item.label)).toEqual(['focus']);
  });

  it('merges own methods with inherited groups in the method section', async () => {
    const byName = await drillEntities();
    const sections = byName.get('P2');
    expect(sections, 'P2 sections exist').toBeTruthy();

    const baseMethods = sections!.find(section => section.section.key === 'BaseMethods');
    expect(baseMethods).toBeTruthy();
    // Own 组 + 父类继承组并存
    const groupLabels = baseMethods!.section.groups?.map(group => group.label) || [];
    expect(groupLabels.some(label => label.startsWith('Own'))).toBe(true);
    expect(groupLabels.some(label => label.includes('PBase'))).toBe(true);
    const ownGroup = baseMethods!.section.groups!.find(group => group.label.startsWith('Own'));
    expect(ownGroup?.items.map(item => item.label)).toEqual(['onKill']);
  });

  it('omits the database section when the def snapshot cannot be read', async () => {
    const byName = await drillEntities();
    const sections = byName.get('GhostDir');
    expect(sections, 'GhostDir sections exist').toBeTruthy();

    // def 是目录:快照 null 回落空模型,database section 整段缺席
    expect(sections!.some(section => section.section.key === 'database')).toBe(false);
  });
});
