import { describe, expect, it } from 'vitest';
import { previewEntitySchemaImpact } from '../src/databaseSchemaImpact';
import type { TableFieldDescriptor, TableSchemaDescriptor } from '../src/databaseSchema';

// IDE-DB-005 提供单实体结构变更影响预览:before/after 两代虚拟 schema
// 对比出新增/移除/类型变化清单——纯计算模块,零注入面零 IO,不存在
// 执行 DDL 或写库的通路;类型判定以推导后的 mysql 型(typeLabel)为
// 准,声明原文等价变化(别名)不产条目;引擎合成列(synthetic)不进影
// 响面(def 变更不影响引擎结构列)。

const field = (name: string, typeLabel: string, overrides: Partial<TableFieldDescriptor> = {}): TableFieldDescriptor => ({
  declaredType: ` ${typeLabel} `,
  sourcePath: '/ws/assets/scripts/entity_defs/Avatar.def',
  source: { filePath: '/ws/assets/scripts/entity_defs/Avatar.def', line: 12, path: `root>Properties>${name}`, category: 'property' as never },
  identifier: false,
  ...overrides,
  name,
  typeLabel
});

const table = (fields: TableFieldDescriptor[]): TableSchemaDescriptor => ({
  name: 'tbl_Account',
  kind: 'entity',
  title: 'Account',
  source: { filePath: '/ws/assets/scripts/entities.xml', line: 3, path: 'root>Avatar', category: 'entity' as never },
  fields
});

describe('previewEntitySchemaImpact(结构变更影响预览)', () => {
  it('新增属性 → added 条目', () => {
    const impact = previewEntitySchemaImpact(
      table([field('sm_hp', 'int unsigned')]),
      table([field('sm_hp', 'int unsigned'), field('sm_level', 'smallint unsigned')])
    );
    expect(impact.entries).toEqual([{ field: 'sm_level', change: 'added', after: 'smallint unsigned' }]);
  });

  it('移除属性 → removed 条目(带原类型)', () => {
    const impact = previewEntitySchemaImpact(
      table([field('sm_hp', 'int unsigned'), field('sm_level', 'smallint unsigned')]),
      table([field('sm_hp', 'int unsigned')])
    );
    expect(impact.entries).toEqual([{ field: 'sm_level', change: 'removed', before: 'smallint unsigned' }]);
  });

  it('类型变化 → type-changed 带 before/after', () => {
    const impact = previewEntitySchemaImpact(
      table([field('sm_hp', 'int unsigned')]),
      table([field('sm_hp', 'bigint unsigned')])
    );
    expect(impact.entries).toEqual([
      { field: 'sm_hp', change: 'type-changed', before: 'int unsigned', after: 'bigint unsigned' }
    ]);
  });

  it('声明原文等价变化(推导型相同) → 不产条目', () => {
    const impact = previewEntitySchemaImpact(
      table([field('sm_hp', 'int unsigned', { declaredType: ' UINT32 ' })]),
      table([field('sm_hp', 'int unsigned', { declaredType: ' MY_UINT32_ALIAS ' })])
    );
    expect(impact.entries).toEqual([]);
  });

  it('无变化 → 空清单', () => {
    const before = table([field('sm_hp', 'int unsigned')]);
    expect(previewEntitySchemaImpact(before, table([...before.fields])).entries).toEqual([]);
  });

  it('引擎合成列不进影响面', () => {
    const synthetic = (name: string): TableFieldDescriptor => ({
      name, typeLabel: 'bigint unsigned', synthetic: true, sourcePath: '',
      source: { filePath: '', line: 0, path: '', category: 'property' as never }, identifier: true
    });
    const impact = previewEntitySchemaImpact(
      table([field('sm_hp', 'int unsigned'), synthetic('id')]),
      table([field('sm_hp', 'int unsigned'), synthetic('id'), synthetic('sm_extra_struct')])
    );
    expect(impact.entries).toEqual([]);
  });

  it('混合变更按字段名字典序稳定', () => {
    const impact = previewEntitySchemaImpact(
      table([field('sm_hp', 'int unsigned'), field('sm_zeta', 'int unsigned')]),
      table([field('sm_hp', 'bigint unsigned'), field('sm_alpha', 'int unsigned')])
    );
    expect(impact.entries.map(entry => [entry.field, entry.change])).toEqual([
      ['sm_alpha', 'added'],
      ['sm_hp', 'type-changed'],
      ['sm_zeta', 'removed']
    ]);
  });

  it('表名透传(定位到受影响实体表)', () => {
    const impact = previewEntitySchemaImpact(table([]), table([]));
    expect(impact.table).toBe('tbl_Account');
  });
});
