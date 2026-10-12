import { describe, expect, it } from 'vitest';
import {
  DependencyType,
  extractNamedChildBlocks,
  extractTagBodies,
  dedupeReferences,
  resolveParentReferenceName,
  stripXmlTags
} from '../src/entityDependency';

// entityDependency 底部的模块级纯函数(仅加 export,零行为变更)。
// EntityDependencyAnalyzer 类本体依赖 vscode(findFiles/fs.readFile),
// 由 mocha + @vscode/test-electron 侧覆盖。

describe('resolveParentReferenceName', () => {
  it('returns undefined when no Parent wrapper exists', () => {
    expect(resolveParentReferenceName('<root><Properties/></root>')).toBeUndefined();
  });

  it('takes the tag name from an element child', () => {
    expect(resolveParentReferenceName('<root><Parent><Hero/></Parent></root>')).toBe('Hero');
  });

  it('takes the trimmed text from a whitespace-padded text child', () => {
    expect(resolveParentReferenceName('<root>\n  <Parent>\n    Hero\n  </Parent>\n</root>'))
      .toBe('Hero');
  });

  it('skips a terminated comment before the first meaningful child', () => {
    expect(resolveParentReferenceName('<Parent><!-- 旧父类 --><Hero/></Parent>')).toBe('Hero');
  });

  it('drops an unterminated comment and finds nothing', () => {
    expect(resolveParentReferenceName('<Parent><!-- <Hero/></Parent>')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only body', () => {
    expect(resolveParentReferenceName('<Parent>   </Parent>')).toBeUndefined();
  });

  it('returns undefined when the element child has no identifier name', () => {
    expect(resolveParentReferenceName('<Parent><-bad/></Parent>')).toBeUndefined();
  });

  it('is case-sensitive on the wrapper like the engine enterNode match', () => {
    expect(resolveParentReferenceName('<parent>Hero</parent>')).toBeUndefined();
  });
});

describe('extractTagBodies', () => {
  it('extracts trimmed bodies for every occurrence, case-insensitively', () => {
    const text = '<Properties> <hp><Type>UINT32</Type></hp> </Properties>\n<properties><mp>INT8</mp></properties>';

    expect(extractTagBodies(text, 'Properties')).toEqual([
      '<hp><Type>UINT32</Type></hp>',
      '<mp>INT8</mp>'
    ]);
  });

  it('returns an empty list when the tag is absent', () => {
    expect(extractTagBodies('<root></root>', 'BaseMethods')).toEqual([]);
  });

  it('is non-greedy: the body ends at the first closing tag', () => {
    // 锁定实现语义:非贪婪匹配在首个同名闭标签截断,嵌套同名标签
    // 的内层开标签会被并入 body
    expect(extractTagBodies('<Properties><Properties>a</Properties></Properties>', 'Properties'))
      .toEqual(['<Properties>a']);
  });
});

describe('extractNamedChildBlocks', () => {
  it('collects child element names with their trimmed bodies', () => {
    // 类内真实调用形态:入参是 Properties 段的 body,不含外层包裹
    const blocks = extractNamedChildBlocks(
      '<hp><Type>UINT32</Type></hp><speed><Type>UINT8</Type></speed>'
    );

    expect(blocks).toEqual([
      { name: 'hp', body: '<Type>UINT32</Type>' },
      { name: 'speed', body: '<Type>UINT8</Type>' }
    ]);
  });

  it('skips reserved metadata tags', () => {
    const blocks = extractNamedChildBlocks(
      '<Type>UINT32</Type><Flags>BASE</Flags><Default>1</Default>'
      + '<DetailLevel>LOW</DetailLevel><Arg>INT8</Arg><Identifier/>'
      + '<implementedBy>X</implementedBy>'
    );

    // Type/Flags/Default/DetailLevel/Arg/Identifier/implementedBy 全部是保留名
    expect(blocks).toEqual([]);
  });

  it('treats a reserved wrapper as one skipped block without descending', () => {
    // 锁定实现语义:正则从顶层标签起匹配,保留名包裹块整体跳过,
    // body 内层的标签不再展开
    const blocks = extractNamedChildBlocks(
      '<BaseMethods><attack><Arg>UINT32</Arg></attack></BaseMethods><bag><Type>UINT8</Type></bag>'
    );

    expect(blocks.map(block => block.name)).toEqual(['bag']);
  });
});

describe('stripXmlTags', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripXmlTags('  <Type>\n  ARRAY\n  <of>UINT32</of>  </Type>  ')).toBe('ARRAY UINT32');
    expect(stripXmlTags('plain text')).toBe('plain text');
    expect(stripXmlTags('<a></a>')).toBe('');
  });
});

describe('dedupeReferences', () => {
  it('removes repeated entity/type/property triples, keeping order', () => {
    const references = [
      { entityName: 'Hero', type: DependencyType.Array, propertyName: 'bag' },
      { entityName: 'Monster', type: DependencyType.Inheritance, propertyName: 'target' },
      { entityName: 'Hero', type: DependencyType.Array, propertyName: 'bag' },
      { entityName: 'Hero', type: DependencyType.Inheritance, propertyName: 'bag' },
      { entityName: 'Monster', type: DependencyType.Inheritance, propertyName: 'target' }
    ];

    expect(dedupeReferences(references)).toEqual([
      { entityName: 'Hero', type: DependencyType.Array, propertyName: 'bag' },
      { entityName: 'Monster', type: DependencyType.Inheritance, propertyName: 'target' },
      { entityName: 'Hero', type: DependencyType.Inheritance, propertyName: 'bag' }
    ]);
  });

  it('returns an empty list unchanged', () => {
    expect(dedupeReferences([])).toEqual([]);
  });
});
