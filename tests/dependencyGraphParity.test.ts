/**
 * dependency/graph Rust↔TS 实体级投影对拍(AUDIT-002 结论 #4)。
 *
 * Rust `$/kode/dependency/graph` 是 def 中心图(6 类节点/7 类边),TS
 * `EntityDependencyAnalyzer` 是实体中心旧视图——直接 equality 对拍不成立,
 * 有意义的对拍 = **投影**:把 Rust def 级边升到实体级,与 TS 实体图比对。
 *
 * 用真实 kode-server 二进制跑 Rust 侧;TS 侧走真实 EntityDependencyAnalyzer
 * (vscodeStub + 双写磁盘/内存,同 entityDependencyAnalyzer.test.ts 口径)。
 *
 * 实测语义(2026-11-09 探针测量,本测试锁定):
 *
 * 1. **继承投影精确相等**(双方 Parent 双形态同口径):TS
 *    `<Parent>X</Parent>`/`<Parent><X/></Parent>` 边集 == Rust
 *    def:X --inheritance--> def:P 投影(登记实体内)。
 * 2. **Rust 属性引用 = 引擎规范形态超集**:直引类型(`<Type>Mob</Type>`)与
 *    规范 `<of>` 形态(`ARRAY <of> X </of>`,engine datatype.cpp 主形态)
 *    Rust 都成 property-type 边;TS 旧视图 containerMatch 正则贪婪吃尾 `>`,
 *    `<of>` 形态残留 `</of` 过不了标识符检查 → 丢失;直引非容器 → 不识别。
 * 3. **TS 独有边 = 两类已定性差异**(不是 Rust 丢能力):
 *    - 裸子元素形态 `ARRAY<X>`(旧 demo 风格,引擎只认 `<of>`,engine-invalid
 *      形态):TS 宽容出边,Rust 按 kode-parser collect_type_refs 规范口径
 *      不收(与其 TS 对位 collectTypeReferences 同口径,compositionRoots.ts:49);
 *    - FIXED_DICT+implementedBy→实体:TS 在实体级建模,Rust 在类型级建模
 *      (type:T --implements--> python:<py>,经 typeImpls),层级不同。
 * 4. types.xml 对象类双形态并集(2026-11-09 修):此前只认元素形态
 *    (`<X><FIXED_DICT>`),真实资产文本形态(`<X> FIXED_DICT`)全丢 →
 *    property-type/type 节点全缺(dependency_graph.rs object_class_names,
 *    Rust 侧 dependency_graph_dispatch::text_directive_types_are_object_classes_too
 *    锁定);本文件场景 B 在真实 fixture 上端到端复证。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏纯 TS 门禁。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityDependencyAnalyzer } from '../src/entityDependency';
import { KodeCoreClient } from '../src/kodeCoreClient';
import { Uri, memoryFileSystem, workspace as stubWorkspace } from './helpers/vscodeStub';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);
const suite = binaryReady ? describe : describe.skip;

const REAL_FIXTURE_ROOT = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets');
const REAL_FIXTURE_SCRIPTS = join(REAL_FIXTURE_ROOT, 'scripts');
const REAL_FIXTURE_DEFS = join(REAL_FIXTURE_SCRIPTS, 'entity_defs');

interface TsEdge {
  from: string;
  to: string;
  type: string;
  label: string;
}

interface RustEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
}

const edgeKey = (from: string, to: string, extra: string): string => `${from}->${to}|${extra}`;

suite('dependency/graph Rust↔TS 实体级投影对拍(真实 kode-server)', () => {
  let client: KodeCoreClient;
  let tmpRoots: string[] = [];
  let analyzer: EntityDependencyAnalyzer;
  const originalFindFiles = stubWorkspace.findFiles;

  const def = (...lines: string[]): string => ['<root>', ...lines, '</root>'].join('\n');
  const prop = (name: string, inner: string): string =>
    `\t<Properties>\n\t\t<${name}>\n${inner}\n\t\t</${name}>\n\t</Properties>`;

  /** 合成 fixture:登记 Avatar/Mob/Item/Guild + 未登记 Rogue,覆盖全部投影面。
   *  磁盘+内存双写(注册解析走磁盘,analyzer readFile 走内存替身)。 */
  const makeSyntheticRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'kode-dep-parity-XXXXXX'));
    tmpRoots.push(root);
    const put = (relative: string, content: string): void => {
      const abs = join(root, ...relative.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      memoryFileSystem.set(abs, content);
    };
    put('scripts/entities.xml', [
      '<root>',
      '  <Avatar hasBase="true" hasCell="true"/>',
      '  <Mob hasBase="true"/>',
      '  <Item hasBase="true"/>',
      '  <Guild hasBase="true"/>',
      '</root>'
    ].join('\n'));
    put(
      'scripts/entity_defs/Avatar.def',
      def(
        '\t<Parent><Mob/></Parent>',
        prop(
          'pets',
          '\t\t\t<Type>\n\t\t\t\tARRAY\n\t\t\t\t<of> Mob </of>\n\t\t\t</Type>\n\t\t\t<Flags>BASE</Flags>'
        ),
        prop('rival', '\t\t\t<Type>Mob</Type>'),
        prop('loot', '\t\t\t<Type>ARRAY<Rogue></Type>'),
        prop('trophy', '\t\t\t<Type>FIXED_DICT</Type>\n\t\t\t<implementedBy>\n\t\t\t\t<Type>Guild</Type>\n\t\t\t</implementedBy>'),
        '\t<BaseMethods><onSave/></BaseMethods>'
      )
    );
    put(
      'scripts/entity_defs/Mob.def',
      def(
        '\t<Parent> Item </Parent>',
        prop('hoard', '\t\t\t<Type>\n\t\t\t\tARRAY\n\t\t\t\t<of> Item </of>\n\t\t\t</Type>')
      )
    );
    put(
      'scripts/entity_defs/Item.def',
      def(prop('owner', '\t\t\t<Type>\n\t\t\t\tARRAY\n\t\t\t\t<of> Avatar </of>\n\t\t\t</Type>'))
    );
    put('scripts/entity_defs/Guild.def', def(prop('level', '\t\t\t<Type>UINT32</Type>')));
    put('scripts/entity_defs/Rogue.def', def('\t<BaseMethods><sneak/></BaseMethods>'));
    return root;
  };

  /** Rust 侧入参(合成 fixture:全实体分类,无 types.xml/python 面)。 */
  const syntheticRustParams = (root: string): Record<string, unknown> => {
    const read = (relative: string): string =>
      readFileSync(join(root, ...relative.split('/')), 'utf8');
    const defsDir = join(root, 'scripts', 'entity_defs');
    const defs: Record<string, string> = {};
    for (const f of readdirSync(defsDir)) {
      if (f.endsWith('.def')) {
        defs[f.replace(/\.def$/, '')] = readFileSync(join(defsDir, f), 'utf8');
      }
    }
    return {
      entitiesXml: read('scripts/entities.xml'),
      typesXml: '',
      defsRoot: defsDir,
      entitiesXmlPath: join(root, 'scripts', 'entities.xml'),
      typesXmlPath: '',
      defs,
      paths: {},
      categories: {},
      pythonFiles: {},
      typeImpls: {},
    };
  };

  /** 真实 fixture Rust 入参:全 .def 原文 + 按目录分类(interface/component/entity)。 */
  const realFixtureRustParams = (): Record<string, unknown> => {
    const defs: Record<string, string> = {};
    const categories: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), relPath);
        } else if (entry.name.endsWith('.def')) {
          defs[entry.name.replace(/\.def$/, '')] = readFileSync(join(dir, entry.name), 'utf8');
          categories[entry.name.replace(/\.def$/, '')] = relPath.includes('interfaces')
            ? 'interface'
            : relPath.includes('components')
              ? 'component'
              : 'entity';
        }
      }
    };
    walk(REAL_FIXTURE_DEFS, '');
    return {
      entitiesXml: readFileSync(join(REAL_FIXTURE_SCRIPTS, 'entities.xml'), 'utf8'),
      typesXml: readFileSync(join(REAL_FIXTURE_DEFS, 'types.xml'), 'utf8'),
      defsRoot: REAL_FIXTURE_DEFS,
      entitiesXmlPath: join(REAL_FIXTURE_SCRIPTS, 'entities.xml'),
      typesXmlPath: join(REAL_FIXTURE_DEFS, 'types.xml'),
      defs,
      paths: {},
      categories,
      pythonFiles: {},
      typeImpls: {},
    };
  };

  const rustGraph = async (params: Record<string, unknown>): Promise<{ edges: RustEdge[]; entityNames: string[] }> => {
    const resp = (await client.request('$/kode/rpc', {
      method: '$/kode/dependency/graph',
      params
    })) as { edges: RustEdge[]; nodes: Array<{ id: string; kind: string; name: string }> };
    return {
      edges: resp.edges ?? [],
      entityNames: (resp.nodes ?? []).filter(n => n.kind === 'entity').map(n => n.name),
    };
  };

  beforeAll(async () => {
    client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/parity', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    memoryFileSystem.reset();
  });

  afterAll(async () => {
    await client.dispose().catch(() => undefined);
    memoryFileSystem.reset();
    stubWorkspace.workspaceFolders = [];
    stubWorkspace.findFiles = originalFindFiles;
    for (const root of tmpRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tmpRoots = [];
  });

  /** TS 侧:工作区根 + 真实 analyzer(注册解析走磁盘,readFile 走内存替身——
   *  两面都喂同一份文件,替身内容从磁盘实读,保证双写一致)。 */
  const withTsWorkspace = async (root: string, run: (graph: { nodes: Array<{ name: string }>; edges: TsEdge[] }) => Promise<void>): Promise<void> => {
    memoryFileSystem.reset();
    const feed = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          feed(full);
        } else if (entry.isFile()) {
          memoryFileSystem.set(full, readFileSync(full, 'utf8'));
        }
      }
    };
    feed(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = async () => {
      const results: Uri[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
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
    analyzer = new EntityDependencyAnalyzer({ subscriptions: [] });
    try {
      await run(await analyzer.analyze());
    } finally {
      stubWorkspace.workspaceFolders = [];
      stubWorkspace.findFiles = originalFindFiles;
      memoryFileSystem.reset();
    }
  };

  it('场景A 合成:继承投影精确相等 + 登记实体集相等', async () => {
    const root = makeSyntheticRoot();
    await withTsWorkspace(root, async tsGraph => {
      const rust = await rustGraph(syntheticRustParams(root));
      const registered = ['Avatar', 'Mob', 'Item', 'Guild'];
      // 登记实体集相等(双方都以 entities.xml 为注册源)
      expect([...rust.entityNames].sort()).toEqual([...registered].sort());
      const tsRegistered = tsGraph.nodes.map(n => n.name).filter(n => registered.includes(n));
      expect([...tsRegistered].sort()).toEqual([...registered].sort());

      // 继承投影:Rust def 级 inheritance 升到实体级 == TS inheritance 边集
      const rustInheritance = new Set(
        rust.edges
          .filter(e => e.kind === 'inheritance')
          .map(e => edgeKey(e.from.replace(/^def:/, ''), e.to.replace(/^def:/, ''), ''))
      );
      const tsInheritance = new Set(
        tsGraph.edges.filter(e => e.type === 'inheritance').map(e => edgeKey(e.from, e.to, ''))
      );
      expect([...tsInheritance].sort()).toEqual([...rustInheritance].sort());
      // 两条:Avatar→Mob(元素形态 Parent)+ Mob→Item(空白文本形态 Parent)
      expect([...tsInheritance].sort()).toEqual([
        edgeKey('Avatar', 'Mob', ''),
        edgeKey('Mob', 'Item', '')
      ]);
    });
  }, 30000);

  it('场景A 合成:Rust 属性引用=引擎规范形态超集(直引+<of>),TS 独有边=裸子元素+FIXED_DICT 建模', async () => {
    const root = makeSyntheticRoot();
    await withTsWorkspace(root, async tsGraph => {
      const rust = await rustGraph(syntheticRustParams(root));
      // Rust property-type 投影(登记 from/to):直引 rival + 规范 <of> 三条,
      // TS 旧视图全部丢失(containerMatch 贪婪吃尾 '>' / 直引非容器不识别)
      const rustProp = rust.edges
        .filter(e => e.kind === 'property-type')
        .map(e => ({
          from: e.from.replace(/^def:/, ''),
          to: e.to.replace(/^def:/, ''),
          label: e.label ?? ''
        }))
        .filter(e => ['Avatar', 'Mob', 'Item', 'Guild'].includes(e.to))
        .sort((a, b) => `${a.from}${a.to}${a.label}`.localeCompare(`${b.from}${b.to}${b.label}`));
      expect(rustProp).toEqual([
        { from: 'Avatar', to: 'Mob', label: 'pets' },
        { from: 'Avatar', to: 'Mob', label: 'rival' },
        { from: 'Item', to: 'Avatar', label: 'owner' },
        { from: 'Mob', to: 'Item', label: 'hoard' }
      ]);

      // TS 独有边恰两类(差异已定性,不是 Rust 丢能力):
      // loot=ARRAY<Rogue> 裸子元素形态(engine-invalid,TS 宽容);
      // trophy=FIXED_DICT+implementedBy→实体(Rust 在类型级建模)。
      const tsOnly = tsGraph.edges
        .filter(e => e.type !== 'inheritance')
        .map(e => ({ from: e.from, to: e.to, type: e.type, label: e.label }))
        .sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
      expect(tsOnly).toEqual([
        { from: 'Avatar', to: 'Guild', type: 'fixed_dict', label: 'trophy' },
        { from: 'Avatar', to: 'Rogue', type: 'array', label: 'loot' }
      ]);
      // 裸子元素目标 Rogue:TS 图内有节点,Rust 图无 entity/def 节点(规范口径不收)
      expect(tsGraph.nodes.map(n => n.name)).toContain('Rogue');
      expect(rust.entityNames).not.toContain('Rogue');
    });
  }, 30000);

  it('场景B 真实 fixture:继承投影相等 + Rust 引擎规范形态超集(is-a/has-a/文本形态对象类)', async () => {
    await withTsWorkspace(REAL_FIXTURE_ROOT, async tsGraph => {
      const rust = await rustGraph(realFixtureRustParams());
      const registered = [
        'Account', 'Spaces', 'Space', 'Avatar',
        'Monster', 'TrainingAvatar', 'TrainingMonster', 'EliteMonster'
      ];
      expect([...rust.entityNames].sort()).toEqual(registered.sort());

      // 继承投影相等:Monster→Avatar + EliteMonster→TrainingMonster(双文本形态)
      const rustInheritance = rust.edges
        .filter(e => e.kind === 'inheritance')
        .map(e => `${e.from}->${e.to}`)
        .sort();
      expect(rustInheritance).toEqual(['def:EliteMonster->def:TrainingMonster', 'def:Monster->def:Avatar']);
      const tsInheritance = tsGraph.edges
        .filter(e => e.type === 'inheritance')
        .map(e => `${e.from}->${e.to}`)
        .sort();
      expect(tsInheritance).toEqual(['EliteMonster->TrainingMonster', 'Monster->Avatar']);

      // TS 旧视图在此 fixture 上只看到继承(规范 <of>/Interfaces/Components 全丢)
      expect(tsGraph.edges.filter(e => e.type !== 'inheritance')).toEqual([]);

      // Rust 引擎规范形态超集:is-a(Avatar→ROLE 等)+ has-a(Avatar→Inventory)
      const rustIsA = rust.edges.filter(e => e.kind === 'is-a').map(e => `${e.from}->${e.to}`).sort();
      expect(rustIsA).toEqual([
        'def:Avatar->interface:ROLE',
        'def:TrainingAvatar->interface:TRAINING_ACTOR',
        'def:TrainingMonster->interface:TRAINING_ACTOR'
      ]);
      expect(rust.edges.some(e => e.kind === 'has-a' && e.from === 'def:Avatar' && e.to === 'component:Inventory')).toBe(true);

      // 文本形态对象类端到端:skillSlots ARRAY <of> SKILL_SLOT → type:SKILL_SLOT
      // (2026-11-09 修 object_class_names 双形态并集后,真实 fixture 不再丢 type 面)
      expect(rust.edges.some(e => e.kind === 'property-type' && e.from === 'def:Avatar' && e.to === 'type:SKILL_SLOT')).toBe(true);
    });
  }, 30000);
});
