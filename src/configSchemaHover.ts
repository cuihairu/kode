/**
 * KODE-CFG-016 ②配置 schema hover(薄 provider 层):配置类/绑定名 hover 出
 * 直读类型文本(collectConfigSchema 字面量 schema,key→value 类型已确定,
 * 非推断)。schema 缓存由装配层在意外写扫描时同步刷新(KODE-CFG-016 ①同一
 * 扫描管线),provider 零自有 IO/watcher(ARC-005 副作用白名单第 4 项:自身
 * 无 emitter,配置变更经装配层重扫自然更新)。
 *
 * CFG-HOVER-FIX-002 ①命中面放宽:全等词匹配之外补成员链直读——
 * `Config.MOBILES[0].hp` 悬停 hp、`TABLE['k'].hp` 悬停键名,顺
 * configSchemaChain 走链解析成员类型;模块级别名(`TBL = MOBILES`)一跳
 * 归一。②空 schema 引导:开关开但 schema 为空、悬停词形似配置类时出一
 * 次 notice(当前 dirGlobs/classPatterns 可见,引导配置),其余词零噪声。
 */
import * as vscode from 'vscode';
import { type ConfigSchemaEntry, type ConfigDataSettings, CONFIG_DATA_SETTINGS_DEFAULT, nameMatchesPattern } from './configDataMutation';
import { extractMemberChainQuery, resolveConfigMemberChain } from './configSchemaChain';

export class ConfigSchemaHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly getSchema: () => readonly ConfigSchemaEntry[],
    private readonly getSettings: () => ConfigDataSettings = () => CONFIG_DATA_SETTINGS_DEFAULT
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
    const schema = this.getSchema();
    const entry = schema.find(e => e.name === word);
    if (entry) {
      const md = new vscode.MarkdownString();
      const kindText = entry.kind === 'class' ? 'config class' : 'config binding';
      md.appendMarkdown(`**配置数据 · ${entry.name}**(${kindText}): \`${entry.typeText}\``);
      md.appendMarkdown(`\n\n${entry.file}:${entry.line + 1}`);
      return new vscode.Hover(md, wordRange);
    }
    // 成员链直读:悬停词处于 `root.steps.` / `root.steps['` 前缀之后
    const line = document.lineAt(position.line).text;
    const query = extractMemberChainQuery(line, wordRange.start.character, word);
    if (query) {
      const root = this.resolveAlias(document.getText(), query.root) ?? query.root;
      const hit = resolveConfigMemberChain({ ...query, root }, schema);
      if (hit) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**配置数据 · ${query.root}**链成员 \`${word}\`: \`${hit.typeText}\``);
        md.appendMarkdown(`\n\n源 ${hit.rootFile}:${hit.rootLine + 1}(${hit.rootName})`);
        return new vscode.Hover(md, wordRange);
      }
    }
    return this.emptySchemaNotice(word, schema);
  }

  /** 模块级别名一跳(`TBL = MOBILES`);无别名/别名指向自身返回 null */
  private resolveAlias(text: string, name: string): string | null {
    const m = new RegExp(`^${name}\\s*=\\s*([A-Za-z_]\\w*)\\s*$`, 'm').exec(text);
    if (!m || m[1] === name) {
      return null;
    }
    return m[1];
  }

  /** 空 schema 引导:开关开+零条目+词形似配置类才出(其余词零噪声) */
  private emptySchemaNotice(word: string, schema: readonly ConfigSchemaEntry[]): vscode.Hover | undefined {
    const settings = this.getSettings();
    if (!settings.enabled || schema.length > 0) {
      return undefined;
    }
    if (!nameMatchesPattern(word, settings.configClassPatterns)) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**配置数据 · ${word}**:配置 schema 为空——未在配置目录扫到任何配置类/绑定。`);
    md.appendMarkdown(`\n\n检查 \`kbengine.configData.dirGlobs\`(当前 \`${settings.configDirGlobs.join('`, `')}\`)`
      + ` 与 \`kbengine.configData.classPatterns\`(当前 \`${settings.configClassPatterns.join('`, `')}\`)。`);
    return new vscode.Hover(md);
  }

  dispose(): void {
    // 薄 provider:无自有资源,dispose 为空实现(注册面统一入 subscriptions)
  }
}
