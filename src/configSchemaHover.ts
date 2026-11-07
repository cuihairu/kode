/**
 * KODE-CFG-016 ②配置 schema hover(薄 provider 层):配置类/绑定名 hover 出
 * 直读类型文本(collectConfigSchema 字面量 schema,key→value 类型已确定,
 * 非推断)。schema 缓存由装配层在意外写扫描时同步刷新(KODE-CFG-016 ①同一
 * 扫描管线),provider 零自有 IO/watcher(ARC-005 副作用白名单第 4 项:自身
 * 无 emitter,配置变更经装配层重扫自然更新)。
 */
import * as vscode from 'vscode';
import { type ConfigSchemaEntry } from './configDataMutation';

export class ConfigSchemaHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly getSchema: () => readonly ConfigSchemaEntry[]
  ) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const entry = this.getSchema().find(e => e.name === word);
    if (!entry) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    const kindText = entry.kind === 'class' ? 'config class' : 'config binding';
    md.appendMarkdown(`**配置数据 · ${entry.name}**(${kindText}): \`${entry.typeText}\``);
    md.appendMarkdown(`\n\n${entry.file}:${entry.line + 1}`);
    return new vscode.Hover(md, wordRange);
  }

  dispose(): void {
    // 薄 provider:无自有资源,dispose 为空实现(注册面统一入 subscriptions)
  }
}
