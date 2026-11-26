/**
 * Single-entity messageTable preview command body (IDE-SDK-001): pick an entity
 * (QuickPick) -> the already-computed result (buildMessageTable -> markdown) can be
 * viewed; when the declaration is missing (the build returns null -- entities.xml does not
 * register it or entity_defs lacks the def), say so explicitly instead of showing an empty
 * preview or guessing; if no entities were discovered at all, say so honestly; cancelling
 * the pick exits silently. Every VSCode face is injected (pick/show/notify); wiring lives
 * in extension.ts.
 */

export interface MessageTablePreviewDeps {
  /** Entity name list (from the shared index/mapping) */
  listEntityNames(): string[];
  /** Build markdown for one entity; null = missing declaration */
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
