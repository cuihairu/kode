import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DependencyType,
  EntityDependencyAnalyzer
} from '../src/entityDependency';
import { Uri, memoryFileSystem, workspace as stubWorkspace } from './helpers/vscodeStub';

// EntityDependencyAnalyzer 的剩余分支:注册口径之外从 Cell/Client 方法
// 区块补充类型、注册实体缺 def 文件时跳过、悬空 parent 的祖先遍历、
// 嵌套 <Properties> 的顶层截断现状、FIXED_DICT<X> 容器形态、未知容器
// 的 null 回落、无工作区直接调 loadFromEntitiesXml、解析阶段 readFile
// 抛错 catch。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const originalFindFiles = stubWorkspace.findFiles;
const originalReadFile = stubWorkspace.fs.readFile;

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dep-gap-'));
  memoryFileSystem.reset();

  const put = (relative: string, content: string) => {
    const abs = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    memoryFileSystem.set(abs, content);
  };

  // Warden 注册时只有 hasBase,def 里带 Cell/Client 方法区块
  put('scripts/entities.xml', [
    '<root>',
    '  <Warden hasBase="true"/>',
    '  <Phantom hasBase="true"/>',
    '  <Anchor hasBase="true"/>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Warden.def', [
    '<root>',
    '  <BaseMethods><guard/></BaseMethods>',
    '  <CellMethods><patrol/></CellMethods>',
    '  <ClientMethods><emote/></ClientMethods>',
    '</root>'
  ].join('\n'));

  // Phantom 只在 entities.xml 注册,def 文件不存在 → 跳过
  // Anchor:悬空 parent + 两种容器形态(无嵌套 Properties,保证顶层提取完整)
  put('scripts/entity_defs/Anchor.def', [
    '<root>',
    '  <Parent><Missing/></Parent>',
    '  <Properties>',
    '    <fd>',
    '      <Type>FIXED_DICT<Anchor></Type>',
    '    </fd>',
    '    <tup>',
    '      <Type>TUPLE<Anchor></Type>',
    '    </tup>',
    '  </Properties>',
    '  <BaseMethods><hold/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // Shatter:属性内嵌 <Properties> — 顶层提取在首个同名闭标截断,
  // nest 整块丢失,内层 x 反被当成顶层属性提取(实现现状)
  put('scripts/entity_defs/Shatter.def', [
    '<root>',
    '  <Properties>',
    '    <nest>',
    '      <Type>UINT8</Type>',
    '      <Properties>',
    '        <x>',
    '          <Type>ARRAY<Anchor></Type>',
    '        </x>',
    '      </Properties>',
    '    </nest>',
    '  </Properties>',
    '  <BaseMethods><crack/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // Boom:第一遍读取成功,第二遍解析时 readFile 抛错
  put('scripts/entity_defs/Boom.def', '<root>\n</root>');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => [
    Uri.file(p(root, 'scripts', 'entity_defs', 'Warden.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Anchor.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Shatter.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Boom.def'))
  ];
});

afterAll(() => {
  memoryFileSystem.reset();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.fs.readFile = originalReadFile;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

const makeAnalyzer = (): EntityDependencyAnalyzer =>
  new EntityDependencyAnalyzer({ subscriptions: [] });

const internals = (analyzer: EntityDependencyAnalyzer): {
  entities: Map<string, unknown>;
} => analyzer as unknown as never;

describe('type derivation and registration gaps', () => {
  it('adds Cell and Client types from method sections beyond registration', async () => {
    // Warden 注册口径只有 Base;def 带 CellMethods/ClientMethods → 补齐
    const graph = await makeAnalyzer().analyze();
    const warden = graph.nodes.find(node => node.name === 'Warden');
    expect(warden?.types).toEqual(['Base', 'Cell', 'Client']);
  }, 8000);

  it('skips registered entities whose def file is missing', async () => {
    const graph = await makeAnalyzer().analyze();
    expect(graph.nodes.map(node => node.name).sort())
      .toEqual(['Anchor', 'Boom', 'Shatter', 'Warden']);
  }, 8000);
});

describe('reference extraction gaps', () => {
  it('loses the nested property but hoists the inner block after truncation', async () => {
    // 实现现状:嵌套 <Properties> 使顶层 section 在首个同名闭标截断,
    // nest 属性整块丢失;内层 x(闭合完整)反被当成顶层属性提取
    const graph = await makeAnalyzer().analyze();
    const shatter = graph.nodes.find(node => node.name === 'Shatter')!;
    expect(shatter.references).toEqual([{
      entityName: 'Anchor',
      type: DependencyType.Array,
      propertyName: 'x'
    }]);
  }, 8000);

  it('treats FIXED_DICT<X> as a fixed-dict container reference', async () => {
    const graph = await makeAnalyzer().analyze();
    const anchor = graph.nodes.find(node => node.name === 'Anchor')!;
    expect(anchor.references).toContainEqual({
      entityName: 'Anchor',
      type: DependencyType.FixedDict,
      propertyName: 'fd'
    });
  }, 8000);

  it('drops references with an unknown container type', async () => {
    const graph = await makeAnalyzer().analyze();
    const anchor = graph.nodes.find(node => node.name === 'Anchor')!;
    expect(anchor.references.find(reference => reference.propertyName === 'tup'))
      .toBeUndefined();
  }, 8000);
});

describe('ancestor traversal and error paths', () => {
  it('stops ancestor lookup when the parent name has no node', async () => {
    const analyzer = makeAnalyzer();
    await analyzer.analyze();

    // Anchor 的 parent 指向 Missing(无 def、无节点)→ else break
    expect(analyzer.getAncestors('Anchor')).toEqual([]);
  }, 8000);

  it('returns early from loadFromEntitiesXml without a workspace', async () => {
    stubWorkspace.workspaceFolders = [];
    try {
      const analyzer = makeAnalyzer();
      await analyzer.loadFromEntitiesXml();
      expect(internals(analyzer).entities.size).toBe(0);
    } finally {
      stubWorkspace.workspaceFolders = [
        { uri: Uri.file(root), name: 'ws', index: 0 }
      ];
    }
  }, 8000);

  it('keeps the node and skips references when parsing throws', async () => {
    let reads = 0;
    stubWorkspace.fs.readFile = async (uri: Uri) => {
      if (uri.fsPath.endsWith('Boom.def')) {
        reads += 1;
        if (reads > 1) {
          throw new Error('解析炸点');
        }
      }
      return originalReadFile.call(stubWorkspace.fs, uri);
    };

    try {
      const graph = await makeAnalyzer().analyze();
      // 第一遍建节点成功,第二遍抛错被 catch:节点保留、无引用
      const boom = graph.nodes.find(node => node.name === 'Boom');
      expect(boom).toBeDefined();
      expect(boom?.references).toEqual([]);
      expect(reads).toBe(2);
    } finally {
      stubWorkspace.fs.readFile = originalReadFile;
    }
  }, 8000);
});
