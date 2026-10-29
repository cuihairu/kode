/**
 * 预览列来源接线(IDE-REV-018):把 databaseColumnSource 的三态列来源接到
 * 表预览输出通道——预览表名反查工作区虚拟 schema(逐注册实体,含 ARRAY/
 * 组件子表),拿到描述符后逐列渲染 derived(声明处 filePath:line,输出
 * 面板可点击定位 def/type 行)/synthetic(引擎合成列,无声明处)/unknown
 * (如实未知);表不在推导面内时整段如实说明,不猜邻居表。反查面全注入,
 * 装配层给真实注册表与 schema 快照。
 */

import type { TableSchemaDescriptor } from './databaseSchemaCore';
import { formatColumnSourceDetail, linkResultColumnsToSources } from './databaseColumnSource';

/** 反查依赖:装配层注入真实注册表/快照面(测试注入替身) */
export interface ColumnSourceResolverDeps {
  /** 逐工作区根列出实体清单(注册序) */
  listEntityRoots(): Array<{ rootPath: string; entityName: string }>;
  getSnapshot(
    entityName: string,
    rootPath: string
  ): { tableIndex: Map<string, TableSchemaDescriptor> } | null;
}

export type ColumnSourceTableResolver = (tableName: string) => TableSchemaDescriptor | null;

/** 表名 → 虚拟 schema 描述符:按注册清单逐实体反查,首个命中即返回;miss=null */
export function createPreviewColumnSourceTableResolver(
  deps: ColumnSourceResolverDeps
): ColumnSourceTableResolver {
  return tableName => {
    for (const { rootPath, entityName } of deps.listEntityRoots()) {
      const snapshot = deps.getSnapshot(entityName, rootPath);
      const descriptor = snapshot?.tableIndex.get(tableName);
      if (descriptor) {
        return descriptor;
      }
    }
    return null;
  };
}

/** 列来源段:derived 行带 filePath:line(输出面板点击定位面),段尾空行分段 */
export function renderColumnSourceSection(
  columns: Array<{ name: string }>,
  table: string,
  descriptor: TableSchemaDescriptor | null
): string[] {
  if (!descriptor) {
    return [`列来源:表 ${table} 不在工作区虚拟 schema 推导面内——各列来源未知(如实,不猜邻居表)`, ''];
  }
  const links = linkResultColumnsToSources(columns, descriptor);
  return [
    `列来源:${descriptor.title}(derived=点击 filePath:line 定位 def/type 声明行;合成列无声明处)`,
    ...links.map(link => `  ${formatColumnSourceDetail(link)}`),
    ''
  ];
}
