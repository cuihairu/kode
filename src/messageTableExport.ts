/**
 * 消息表 JSON 导出命令体(IDE-SDK-002):选实体 → 现有计算结果 JSON
 * (renderMessageTableJson,保留方法段/utype/alias 配置/问题清单)→ 保
 * 存对话框 → 写文件;取消不创建文件(writeFile 零调用);缺声明/空清
 * 单如实提示;写失败如实呈现。VSCode 面全部注入,装配在 extension.ts。
 */

export interface MessageTableExportDeps {
  /** 实体名清单(来自共享索引/映射) */
  listEntityNames(): string[];
  /** 单实体构建 JSON 文本;null=缺声明 */
  buildTableJson(entityName: string): Promise<string | null>;
  pick(items: string[]): Promise<string | undefined>;
  /** 保存路径选择(showSaveDialog 注入);undefined=取消 */
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
