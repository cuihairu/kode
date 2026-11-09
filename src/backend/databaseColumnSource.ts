/**
 * 将结果列关联回 def/type 声明(IDE-DB-004):查询结果列 → 虚拟 schema
 * 字段描述符 → 来源链接。已推导列给 def 声明处(filePath+line,点击
 * 定位面)与声明类型;描述符带 synthetic 标记的引擎结构列(id/
 * sm_autoLoad/parentID/位置朝向列)说明为合成列,无 def 声明处;schema
 * 里找不到的列如实 unknown——不猜合成、不猜邻居表。表名匹配由调用
 * 方从 snapshot.tableIndex 取对表,本模块拿到什么表就只认该表字段。
 */

import type { TableFieldDescriptor, TableSchemaDescriptor } from './databaseSchemaCore';

export type ColumnSourceLink =
  | {
      column: string;
      kind: 'derived';
      /** 声明处文件(点击定位面) */
      filePath: string;
      line: number;
      /** def 内路径(如 root>Properties>hp) */
      defPath: string;
      /** 声明类型原文 */
      declaredType?: string;
    }
  | { column: string; kind: 'synthetic' }
  | { column: string; kind: 'unknown' };

/** 逐列链接:列序保持查询结果序 */
export function linkResultColumnsToSources(
  columns: Array<{ name: string }>,
  table: TableSchemaDescriptor
): ColumnSourceLink[] {
  return columns.map(column => {
    const descriptor: TableFieldDescriptor | undefined = table.fields.find(
      candidate => candidate.name === column.name
    );
    if (!descriptor) {
      return { column: column.name, kind: 'unknown' };
    }
    if (descriptor.synthetic) {
      return { column: column.name, kind: 'synthetic' };
    }
    return {
      column: column.name,
      kind: 'derived',
      filePath: descriptor.source.filePath,
      line: descriptor.source.line,
      defPath: descriptor.source.path,
      ...(descriptor.declaredType !== undefined ? { declaredType: descriptor.declaredType } : {})
    };
  });
}

/** 说明文案:derived=声明处;synthetic=合成列;unknown=如实未知 */
export function formatColumnSourceDetail(link: ColumnSourceLink): string {
  if (link.kind === 'derived') {
    const declared = link.declaredType !== undefined ? `,Type${link.declaredType.trim()}` : '';
    return `${link.column}:源自 def 声明 ${link.filePath}:${link.line}(${link.defPath}${declared})`;
  }
  if (link.kind === 'synthetic') {
    return `${link.column}:引擎合成列(结构列,无 def 声明处)`;
  }
  return `${link.column}:未知列——不在虚拟 schema 推导面内(如实未知,不猜来源)`;
}
