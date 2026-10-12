import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DependencyType,
  EntityDependencyAnalyzer
} from '../src/entityDependency';
import { Uri, memoryFileSystem, workspace as stubWorkspace } from './helpers/vscodeStub';

// 块8 偏差收口(2026-10-12):继承边此前只认 <Parent><X/></Parent> 元素
// 形态;引擎 loadParentClass(entitydef.cpp:890)经 enterNode 按 'Parent'
// 精确匹配取首个子节点、getKey(xml.cpp:113)取文本或标签名——文本形态
// <Parent>X</Parent> 同样装载。本组锁文本形态两种排版、包装大小写敏感、
// 空文件(null 语义)不产生继承边。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const originalFindFiles = stubWorkspace.findFiles;

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dep-ptext-'));
  memoryFileSystem.reset();

  const put = (relative: string, content: string) => {
    const abs = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    memoryFileSystem.set(abs, content);
  };

  put('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true"/>',
    '  <Whelp hasBase="true"/>',
    '  <Pad hasBase="true"/>',
    '  <Lowcase hasBase="true"/>',
    '  <Blank hasBase="true"/>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <level>',
    '      <Type>UINT32</Type>',
    '    </level>',
    '  </Properties>',
    '  <BaseMethods><roar/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // 文本形态 Parent:引擎 getKey 取文本节点值
  put('scripts/entity_defs/Whelp.def', [
    '<root>',
    '  <Parent>Hero</Parent>',
    '  <BaseMethods><yip/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // 换行缩进排版的文本形态:引擎 kbe_trim 后同名
  put('scripts/entity_defs/Pad.def', [
    '<root>',
    '  <Parent>',
    '    Whelp',
    '  </Parent>',
    '  <BaseMethods><growl/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // 包装小写 <parent>:引擎 enterNode 按 'Parent' 精确比较,不装载
  put('scripts/entity_defs/Lowcase.def', [
    '<root>',
    '  <parent>Hero</parent>',
    '  <BaseMethods><hiss/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // 空 def:解析无根,null 语义,不产生继承边也不崩
  put('scripts/entity_defs/Blank.def', '');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => [
    Uri.file(p(root, 'scripts', 'entity_defs', 'Hero.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Whelp.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Pad.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Lowcase.def')),
    Uri.file(p(root, 'scripts', 'entity_defs', 'Blank.def'))
  ];
});

afterAll(() => {
  memoryFileSystem.reset();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

const makeAnalyzer = (): EntityDependencyAnalyzer =>
  new EntityDependencyAnalyzer({ subscriptions: [] });

describe('inheritance edges from text-form Parent (块8)', () => {
  it('builds an inheritance edge from the text form <Parent>Hero</Parent>', async () => {
    const graph = await makeAnalyzer().analyze();

    const whelp = graph.nodes.find(node => node.name === 'Whelp');
    expect(whelp?.parent).toBe('Hero');

    const edge = graph.edges.find(
      candidate => candidate.type === DependencyType.Inheritance &&
        candidate.from === 'Whelp'
    );
    expect(edge).toMatchObject({ from: 'Whelp', to: 'Hero', label: '继承' });

    const hero = graph.nodes.find(node => node.name === 'Hero');
    expect(hero?.referencedBy).toBe(1);
  });

  it('trims whitespace-padded text-form parents like the engine getKey', async () => {
    const analyzer = makeAnalyzer();
    await analyzer.analyze();

    const pad = analyzer.getEntityNode('Pad');
    expect(pad?.parent).toBe('Whelp');
    // 祖先链沿文本形态 Parent 连走两跳:Pad → Whelp → Hero
    expect(analyzer.getAncestors('Pad').map(node => node.name))
      .toEqual(['Whelp', 'Hero']);
  });

  it('ignores the lowercase <parent> wrapper (engine matches Parent exactly)', async () => {
    const graph = await makeAnalyzer().analyze();

    const lowcase = graph.nodes.find(node => node.name === 'Lowcase');
    expect(lowcase?.parent).toBeUndefined();
    expect(graph.edges.filter(edge => edge.from === 'Lowcase')).toEqual([]);
  });

  it('keeps an empty def node parentless instead of crashing', async () => {
    const graph = await makeAnalyzer().analyze();

    const blank = graph.nodes.find(node => node.name === 'Blank');
    expect(blank?.parent).toBeUndefined();
    expect(graph.edges.filter(edge => edge.from === 'Blank')).toEqual([]);
  });
});
