import { describe, expect, it } from 'vitest';
import { formatColumnSourceDetail, linkResultColumnsToSources } from '../src/databaseColumnSource';
import type { TableSchemaDescriptor, TableFieldDescriptor } from '../src/databaseSchema';

// IDE-DB-004 将结果列关联回 def/type 声明:查询结果列 → 虚拟 schema 字
// 段描述符 → 来源链接——已推导列给 def 声明处(文件:行,点击定位面);
// 描述符带 synthetic 标记的引擎结构列说明为合成列(无 def 声明处);
// schema 里找不到的列如实 unknown(不猜合成不猜邻居表)。

const field = (overrides: Partial<TableFieldDescriptor> & { name: string }): TableFieldDescriptor => ({
  typeLabel: 'int',
  sourcePath: '/ws/assets/scripts/entity_defs/Avatar.def',
  source: { filePath: '/ws/assets/scripts/entity_defs/Avatar.def', line: 12, path: 'root>Properties>hp', category: 'property' as never },
  identifier: false,
  ...overrides
});

const TABLE: TableSchemaDescriptor = {
  name: 'tbl_Account',
  kind: 'entity',
  title: 'Account',
  source: { filePath: '/ws/assets/scripts/entities.xml', line: 3, path: 'root>Avatar', category: 'entity' as never },
  fields: [
    field({ name: 'sm_hp', declaredType: ' UINT32 ' }),
    field({ name: 'sm_level', declaredType: ' UINT16 ', source: { filePath: '/ws/assets/scripts/entity_defs/Avatar.def', line: 20, path: 'root>Properties>level', category: 'property' as never } }),
    field({ name: 'id', synthetic: true, sourcePath: '' }),
    field({ name: 'sm_autoLoad', synthetic: true, sourcePath: '' })
  ]
};

describe('linkResultColumnsToSources(结果列→def/type 声明)', () => {
  it('已推导列 → derived 带声明处文件与行(点击定位面)', () => {
    const links = linkResultColumnsToSources([{ name: 'sm_hp' }, { name: 'sm_level' }], TABLE);
    expect(links[0]).toMatchObject({
      column: 'sm_hp',
      kind: 'derived',
      filePath: '/ws/assets/scripts/entity_defs/Avatar.def',
      line: 12,
      defPath: 'root>Properties>hp'
    });
    expect(links[1]).toMatchObject({ kind: 'derived', line: 20 });
  });

  it('引擎结构列 → synthetic 说明为合成列(无 def 声明处)', () => {
    const links = linkResultColumnsToSources([{ name: 'id' }, { name: 'sm_autoLoad' }], TABLE);
    expect(links[0]).toMatchObject({ column: 'id', kind: 'synthetic' });
    expect(links[0]).not.toHaveProperty('filePath');
    expect(links[1]?.kind).toBe('synthetic');
  });

  it('schema 外的列 → 如实 unknown,不猜合成', () => {
    const links = linkResultColumnsToSources([{ name: 'mystery_col' }], TABLE);
    expect(links[0]).toMatchObject({ column: 'mystery_col', kind: 'unknown' });
  });

  it('空列集/空表 → 空数组', () => {
    expect(linkResultColumnsToSources([], TABLE)).toEqual([]);
    expect(linkResultColumnsToSources([{ name: 'sm_hp' }], { ...TABLE, fields: [] })).toEqual([
      expect.objectContaining({ kind: 'unknown' })
    ]);
  });

  it('列序保持查询结果序', () => {
    const links = linkResultColumnsToSources([{ name: 'id' }, { name: 'sm_hp' }], TABLE);
    expect(links.map(link => link.column)).toEqual(['id', 'sm_hp']);
  });
});

describe('formatColumnSourceDetail(说明文案)', () => {
  it('derived 文案含文件与行号', () => {
    const link = linkResultColumnsToSources([{ name: 'sm_hp' }], TABLE)[0];
    const detail = formatColumnSourceDetail(link);
    expect(detail).toContain('Avatar.def');
    expect(detail).toContain('12');
  });

  it('synthetic 文案说明合成列;unknown 文案如实未知', () => {
    const [synthetic] = linkResultColumnsToSources([{ name: 'id' }], TABLE);
    expect(formatColumnSourceDetail(synthetic)).toContain('合成');
    const [unknown] = linkResultColumnsToSources([{ name: 'x' }], TABLE);
    expect(formatColumnSourceDetail(unknown)).toContain('未知');
  });
});
