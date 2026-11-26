/**
 * Message-table JSON export command body (IDE-SDK-002): pick an entity -> the
 * already-computed JSON result (renderMessageTableJson, keeping the method section,
 * utype, alias config and the problem list) -> save dialog -> write the file; cancelling
 * creates no file (writeFile is never called); missing declaration/empty list is reported
 * honestly; a write failure is presented honestly. Every VSCode face is injected; wiring
 * lives in extension.ts.
 */

export interface MessageTableExportDeps {
  /** Entity name list (from the shared index/mapping) */
  listEntityNames(): string[];
  /** Build the JSON text for one entity; null = missing declaration */
  buildTableJson(entityName: string): Promise<string | null>;
  pick(items: string[]): Promise<string | undefined>;
  /** Save-path selection (showSaveDialog injected); undefined = cancelled */
  chooseSavePath(defaultFileName: string): Promise<string | undefined>;
  writeFile(path: string, content: string): Promise<void>;
  notifyWarning(message: string): unknown;
  notifyInformation(message: string): unknown;
}

export async function exportEntityMessageTable(deps: MessageTableExportDeps): Promise<void> {
  const entityNames = [...new Set(deps.listEntityNames())].sort((a, b) => a.localeCompare(b));
  if (entityNames.length === 0) {
    deps.notifyWarning('未发现实体:没有可导出的实体(检查 assets 根与 entities.xml 是否被索引)');
    return;
  }
  const entityName = await deps.pick(entityNames);
  if (entityName === undefined) {
    return;
  }
  const json = await deps.buildTableJson(entityName);
  if (json === null) {
    deps.notifyWarning(`缺声明:${entityName} 的 entity def 未找到(entities.xml 未登记或 entity_defs 缺该 .def 文件),无法导出消息表`);
    return;
  }
  const savePath = await deps.chooseSavePath(`${entityName}.messagetable.json`);
  if (savePath === undefined) {
    return;
  }
  try {
    await deps.writeFile(savePath, json);
  } catch (error) {
    deps.notifyWarning(`导出失败:${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  deps.notifyInformation(`消息表 JSON 已导出:${savePath}`);
}
