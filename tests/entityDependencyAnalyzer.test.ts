import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DependencyType,
  EntityDependencyAnalyzer
} from '../src/entityDependency';
import { Uri, memoryFileSystem, workspace as stubWorkspace } from './helpers/vscodeStub';

// EntityDependencyAnalyzer 类本体:analyze 走两遍扫描(建节点 → 解引用)
// 再算统计。def 内容双写——真实磁盘(definitionWorkspace 的注册解析走
// node fs)+ memoryFileSystem(stub 的 workspace.fs.readFile 走内存)。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const originalFindFiles = stubWorkspace.findFiles;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dep-'));
  (globalThis as { __depRoot?: string }).__depRoot = root;
  memoryFileSystem.reset();

  const put = (relative: string, content: string) => {
    const abs = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    memoryFileSystem.set(abs, content);
  };

  put('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasBase="true"/>',
    '  <Guild hasBase="true"/>',
    '  <Item hasBase="true"/>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <pet>',
    '      <Type>ARRAY<Monster></Type>',
    '      <Flags>BASE</Flags>',
    '    </pet>',
    '    <bag>',
    '      <Type>ARRAY<Guild></Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </bag>',
    '    <trophy>',
    '      <Type>FIXED_DICT</Type>',
    '      <implementedBy>',
    '        <Type>Item</Type>',
    '      </implementedBy>',
    '    </trophy>',
    '    <dupe>',
    '      <Type>ARRAY<Monster></Type>',
    '      <Type>ARRAY<Monster></Type>',
    '    </dupe>',
    '    <plain>',
    '      <Type>UINT32</Type>',
    '    </plain>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onSave/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <move/>',
    '  </CellMethods>',
    '  <ClientMethods>',
    '    <show/>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Parent><Hero/></Parent>',
    '  <Properties>',
    '    <loot>',
    '      <Type>ARRAY<Item></Type>',
    '      <Flags>BASE</Flags>',
    '    </loot>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <roar/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  // Guild 只被引用,且含引擎内联 ARRAY<of> 写法(实现现状:不产生引用)
  put('scripts/entity_defs/Guild.def', [
    '<root>',
    '  <Properties>',
    '    <level>',
    '      <Type>UINT32</Type>',
    '    </level>',
    '    <engineStyle>',
    '      <Type>ARRAY<of>Item</of></Type>',
    '    </engineStyle>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <invite/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Item.def', [
    '<root>',
    '  <Properties>',
    '    <stack>',
    '      <Type>ARRAY<Hero></Type>',
    '      <Flags>BASE</Flags>',
    '    </stack>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <use/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  // 未注册的 def 也入图,类型只从方法区块推断
  put('scripts/entity_defs/Rogue.def', [
    '<root>',
    '  <BaseMethods>',
    '    <sneak/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => {
    const results: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return results;
  };

  (globalThis as { __depAnalyzer?: EntityDependencyAnalyzer }).__depAnalyzer =
    new EntityDependencyAnalyzer({ subscriptions: [] });
});

afterAll(() => {
  memoryFileSystem.reset();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];

  const root = (globalThis as { __depRoot?: string }).__depRoot;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const analyzerRef = (): EntityDependencyAnalyzer =>
  (globalThis as { __depAnalyzer?: EntityDependencyAnalyzer }).__depAnalyzer as EntityDependencyAnalyzer;

const depRoot = (): string =>
  (globalThis as { __depRoot?: string }).__depRoot as string;

const analyzeOnce = async (): Promise<ReturnType<EntityDependencyAnalyzer['analyze']>> =>
  analyzerRef().analyze();

describe('EntityDependencyAnalyzer graph construction', () => {
  it('returns an empty graph without a workspace folder', async () => {
    stubWorkspace.workspaceFolders = [];
    try {
      const graph = await new EntityDependencyAnalyzer({ subscriptions: [] }).analyze();
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
      expect(graph.stats).toEqual({
        totalEntities: 0,
        baseEntities: 0,
        cellEntities: 0,
        clientEntities: 0,
        maxDepth: 0,
        mostReferenced: ''
      });
    } finally {
      stubWorkspace.workspaceFolders = [
        { uri: Uri.file(depRoot()), name: 'ws', index: 0 }
      ];
    }
  });

  it('collects registered and unregistered entities', async () => {
    const graph = await analyzeOnce();
    expect(graph.nodes.map(node => node.name).sort())
      .toEqual(['Guild', 'Hero', 'Item', 'Monster', 'Rogue']);
  });

  it('derives types from registration order and method sections', async () => {
    const graph = await analyzeOnce();
    const hero = graph.nodes.find(node => node.name === 'Hero');
    // entities.xml 的 has* 按 Cell → Base → Client 顺序入列
    expect(hero?.types).toEqual(['Cell', 'Base', 'Client']);
    // Monster 有注册,无 Cell/Client 方法区,类型保持注册口径
    const monster = graph.nodes.find(node => node.name === 'Monster');
    expect(monster?.types).toEqual(['Base']);
    // Rogue 未注册,类型只从方法区块推断
    const rogue = graph.nodes.find(node => node.name === 'Rogue');
    expect(rogue?.types).toEqual(['Base']);
  });

  it('builds array and fixed-dict reference edges', async () => {
    const graph = await analyzeOnce();
    const edgeKey = (from: string, to: string): string => `${from}->${to}`;

    const byKey = new Map(graph.edges.map(edge => [edgeKey(edge.from, edge.to), edge]));
    // Hero→Monster 有 pet 与 dupe 两条 Array 引用
    const heroToMonster = graph.edges.filter(edge => edgeKey(edge.from, edge.to) === edgeKey('Hero', 'Monster'));
    expect(heroToMonster.map(edge => edge.label).sort()).toEqual(['dupe', 'pet']);
    expect(heroToMonster.every(edge => edge.type === DependencyType.Array)).toBe(true);
    expect(byKey.get(edgeKey('Hero', 'Guild'))).toMatchObject({
      type: DependencyType.Array,
      label: 'bag'
    });
    expect(byKey.get(edgeKey('Hero', 'Item'))).toMatchObject({
      type: DependencyType.FixedDict,
      label: 'trophy'
    });
    expect(byKey.get(edgeKey('Monster', 'Item'))).toMatchObject({
      type: DependencyType.Array,
      label: 'loot'
    });
    expect(byKey.get(edgeKey('Item', 'Hero'))).toMatchObject({
      type: DependencyType.Array,
      label: 'stack'
    });
    expect(graph.edges.filter(edge => edge.type === DependencyType.Inheritance)).toHaveLength(1);
  });

  it('adds an inheritance edge with the parent label', async () => {
    const graph = await analyzeOnce();
    const inheritance = graph.edges.find(edge => edge.type === DependencyType.Inheritance);
    expect(inheritance).toMatchObject({
      from: 'Monster',
      to: 'Hero',
      label: '继承'
    });
    const monster = graph.nodes.find(node => node.name === 'Monster');
    expect(monster?.parent).toBe('Hero');
  });

  it('tracks referencedBy counts across edge kinds', async () => {
    const graph = await analyzeOnce();
    const refOf = (name: string): number =>
      graph.nodes.find(node => node.name === name)?.referencedBy ?? -1;
    // Hero:Monster 继承 + Item.stack;Monster:pet + dupe;Item:trophy + loot
    expect(refOf('Hero')).toBe(2);
    expect(refOf('Item')).toBe(2);
    expect(refOf('Monster')).toBe(2);
    expect(refOf('Guild')).toBe(1);
    expect(refOf('Rogue')).toBe(0);
  });

  it('computes stats with registration-driven counts', async () => {
    const graph = await analyzeOnce();
    expect(graph.stats.totalEntities).toBe(5);
    expect(graph.stats.baseEntities).toBe(5);
    expect(graph.stats.cellEntities).toBe(1);
    expect(graph.stats.clientEntities).toBe(1);
    // 实现现状:深度只从无 parent 的根节点起算,父链方向不展开,恒为 1
    expect(graph.stats.maxDepth).toBe(1);
    // Hero 与 Item 并列被引 2 次,先入序者胜
    expect(graph.stats.mostReferenced).toBe('Hero');
  });

  it('creates no edges for unregistered or engine-inline references', async () => {
    const graph = await analyzeOnce();
    const guild = graph.nodes.find(node => node.name === 'Guild');
    // Guild 只被引用,自身无出边:engineStyle 的 ARRAY<of> 内联语法不被解析
    expect(guild?.references).toEqual([]);
    expect(graph.edges.filter(edge => edge.from === 'Guild')).toEqual([]);
  });

  it('dedupes identical references within one property', async () => {
    const graph = await analyzeOnce();
    const hero = graph.nodes.find(node => node.name === 'Hero');
    const dupe = hero?.references.filter(reference => reference.propertyName === 'dupe') ?? [];
    expect(dupe).toHaveLength(1);
    expect(dupe[0]).toMatchObject({
      entityName: 'Monster',
      type: DependencyType.Array
    });
  });

  it('survives a def that cannot be read', async () => {
    const ghost = new EntityDependencyAnalyzer({ subscriptions: [] });
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = async () =>
      [Uri.file(p(depRoot(), 'scripts', 'entity_defs', 'Missing.def'))];
    try {
      const graph = await ghost.analyze();
      // 注册实体仍经 entities.xml 入图,读不到的 def 不产生节点;节点
      // 未经 parseEntityFile,无 parent —— 继承边缺席,引用边照常解析
      expect(graph.nodes.map(node => node.name).sort())
        .toEqual(['Guild', 'Hero', 'Item', 'Monster']);
      expect(graph.edges.filter(edge => edge.from === 'Missing')).toEqual([]);
      expect(graph.edges.filter(edge => edge.type === DependencyType.Inheritance)).toEqual([]);
      expect(graph.edges.filter(edge => edge.type === DependencyType.Array)).toHaveLength(5);
    } finally {
      stubWorkspace.findFiles = original;
    }
  });
});

describe('EntityDependencyAnalyzer queries', () => {
  it('exposes node lookups by name', async () => {
    await analyzeOnce();
    const hero = analyzerRef().getEntityNode('Hero');
    expect(hero?.defFile).toBe(p(depRoot(), 'scripts', 'entity_defs', 'Hero.def'));
    expect(analyzerRef().getEntityNode('Nope')).toBeUndefined();
  });

  it('lists direct children by parent name', async () => {
    await analyzeOnce();
    expect(analyzerRef().getChildren('Hero').map(node => node.name)).toEqual(['Monster']);
    expect(analyzerRef().getChildren('Monster')).toEqual([]);
  });

  it('walks the ancestor chain until the root', async () => {
    await analyzeOnce();
    expect(analyzerRef().getAncestors('Monster').map(node => node.name)).toEqual(['Hero']);
    expect(analyzerRef().getAncestors('Hero')).toEqual([]);
    expect(analyzerRef().getAncestors('Nope')).toEqual([]);
  });

  it('keeps loadFromEntitiesXml idempotent', async () => {
    await analyzeOnce();
    await analyzerRef().loadFromEntitiesXml();
    const hero = analyzerRef().getEntityNode('Hero');
    expect(hero?.types).toEqual(['Cell', 'Base', 'Client']);
  });
});
