import type * as vscode from 'vscode';

/**
 * KODE-PERF-001 流敏感解析缓存键:按「文档实例身份 + 版本」成键。
 *
 * 为什么不用 uri|version:vscode 关闭后重开同名文档 version 会重置为 1
 * (内容可能已不同),uri|version 跨实例撞键会命中旧文档的解析产物 → 错解。
 * 测试替身同名文档(同 fileName)version 缺省 undefined,同样撞键。用
 * WeakMap 给每个 TextDocument 实例一个单调自增 id,跨实例永不撞;同实例
 * 编辑 version 递增 → 键随内容换 → 缓存正确失效。
 */
const documentInstanceIds = new WeakMap<object, number>();
let nextDocumentInstanceId = 1;

export function flowVersionKeyForDocument(document: vscode.TextDocument): string {
  let id = documentInstanceIds.get(document);
  if (id === undefined) {
    id = nextDocumentInstanceId;
    nextDocumentInstanceId += 1;
    documentInstanceIds.set(document, id);
  }
  return `${id}|${document.version}`;
}
