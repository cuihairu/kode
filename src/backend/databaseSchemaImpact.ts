/**
 * 单实体结构变更影响预览(IDE-DB-005):before/after 两代虚拟 schema
 * 对比出新增/移除/类型变化清单。纯计算模块——零注入面零 IO,不存在
 * 执行 DDL 或写库的通路(预览只是清单,落地动作不在本模块);类型判
 * 定以推导后的 mysql 型(typeLabel)为准,声明原文等价变化(别名)不
 * 产条目;引擎合成列(synthetic)不进影响面(def 变更不影响引擎结构
 * 列)。
 */

import type { TableFieldDescriptor, TableSchemaDescriptor } from './databaseSchemaCore';

export type SchemaImpactChange = 'added' | 'removed' | 'type-changed';

export interface SchemaImpactEntry {
  field: string;
  change: SchemaImpactChange;
  before?: string;
  after?: string;
}

export interface EntitySchemaImpact {
  table: string;
  /** 按字段名字典序稳定 */
  entries: SchemaImpactEntry[];
}

/** before/after 同表对比:synthetic 列剔除,余列按名 diff */
export function previewEntitySchemaImpact(
  before: TableSchemaDescriptor,
  after: TableSchemaDescriptor
): EntitySchemaImpact {
  const derive = (table: TableSchemaDescriptor): Map<string, TableFieldDescriptor> => {
    const byName = new Map<string, TableFieldDescriptor>();
    for (const descriptor of table.fields) {
      if (!descriptor.synthetic) {
        byName.set(descriptor.name, descriptor);
      }
    }
    return byName;
  };
  const beforeFields = derive(before);
  const afterFields = derive(after);
  const entries: SchemaImpactEntry[] = [];
  const names = [...new Set([...beforeFields.keys(), ...afterFields.keys()])].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const beforeField = beforeFields.get(name);
    const afterField = afterFields.get(name);
    if (!beforeField && afterField) {
      entries.push({ field: name, change: 'added', after: afterField.typeLabel });
    } else if (beforeField && !afterField) {
      entries.push({ field: name, change: 'removed', before: beforeField.typeLabel });
    } else if (beforeField && afterField && beforeField.typeLabel !== afterField.typeLabel) {
      entries.push({
        field: name,
        change: 'type-changed',
        before: beforeField.typeLabel,
        after: afterField.typeLabel
      });
    }
  }
  return { table: before.name, entries };
}
