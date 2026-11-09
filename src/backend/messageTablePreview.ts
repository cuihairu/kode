/**
 * 单实体 messageTable 预览命令体(IDE-SDK-001):选实体(QuickPick)→
 * 现有计算结果(buildMessageTable→markdown)可查看;缺声明(构建返
 * 回 null——entities.xml 未登记或 entity_defs 缺 def)时明确提示,不
 * 展示空预览不猜;未发现任何实体如实提示;取消选择静默退出。VSCode
 * 面全部注入(pick/show/notify),装配在 extension.ts。
 */

export interface MessageTablePreviewDeps {
  /** 实体名清单(来自共享索引/映射) */
  listEntityNames(): string[];
  /** 单实体构建 markdown;null=缺声明 */
  buildTableMarkdown(entityName: string): Promise<string | null>;
  pick(items: string[]): Promise<string | undefined>;
  show(markdown: string): Promise<unknown>;
  notifyWarning(message: string): unknown;
  notifyInformation(message: string): unknown;
}

export async function showEntityMessageTablePreview(deps: MessageTablePreviewDeps): Promise<void> {
  const entityNames = [...new Set(deps.listEntityNames())].sort((a, b) => a.localeCompare(b));
  if (entityNames.length === 0) {
    deps.notifyWarning('未发现实体:没有可预览的实体(检查 assets 根与 entities.xml 是否被索引)');
    return;
  }
  const entityName = await deps.pick(entityNames);
  if (entityName === undefined) {
    return;
  }
  const markdown = await deps.buildTableMarkdown(entityName);
  if (markdown === null) {
    deps.notifyWarning(`缺声明:${entityName} 的 entity def 未找到(entities.xml 未登记或 entity_defs 缺该 .def 文件),无法生成 messageTable 预览`);
    return;
  }
  await deps.show(markdown);
}
