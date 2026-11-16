// SemanticTokens provider 装配面(RUST-144 批 4):python 文件结构符号
// (class/function/method/parameter/macro)交 VSCode 语义高亮渲染。决策核
// 在 src/backend/semanticTokens.ts(与 Rust semantic_tokens.rs golden 对拍
// 同源);本面只做配置闸+按「文档实例+版本」缓存(RUST-144 批 3 成本评测
// 结论:增量面成本大头在 span 提取不在编码,典型实体文件 1.9ms/病理
// 大文件百 ms 档,重算只该发生在版本变更)+编码装箱。token 类型/修饰
// 全部用 VSCode 标准内建名(class/function/method/parameter/macro 与
// declaration/async),主题自带配色,无 contributes.semanticTokenTypes
// 声明面。默认关:python 语义 token 常由 Pylance 提供,默认开启会与之
// 抢位,冲突矩阵裁定是 RUST-148,裁定前 opt-in。
import * as vscode from 'vscode';
import { flowVersionKeyForDocument } from './flowVersionKey';
import {
  buildSemanticTokenSpans,
  encodeSemanticTokens,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES
} from './backend/semanticTokens';

/**
 * legend:类型/修饰顺序即编码索引,与决策核常量同源,勿各自维护。注册期
 * 构造而非模块顶层——bundle 装载烟测的 vscode 替身只按需提供类,顶层
 * `new` 会在 import 时炸(nightly 2026-11-12 回归门口径)。
 */
export function buildSemanticTokensLegend(): vscode.SemanticTokensLegend {
  return new vscode.SemanticTokensLegend(
    [...SEMANTIC_TOKEN_TYPES],
    [...SEMANTIC_TOKEN_MODIFIERS]
  );
}

/** 版本缓存上限:同 KODE-PERF-001 LRU 口径(8 槽),防多文档多版本积压 */
const VERSION_CACHE_LIMIT = 8;

export class SemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly cache = new Map<string, Uint32Array>();

  provideDocumentSemanticTokens(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.SemanticTokens> {
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>('semanticTokens.enabled', false)) {
      return new vscode.SemanticTokens(new Uint32Array(0));
    }
    const key = flowVersionKeyForDocument(document);
    const cached = this.cache.get(key);
    if (cached) {
      return new vscode.SemanticTokens(cached);
    }
    const spans = buildSemanticTokenSpans(document.getText());
    const encoded = new Uint32Array(encodeSemanticTokens(spans));
    this.cache.set(key, encoded);
    if (this.cache.size > VERSION_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    return new vscode.SemanticTokens(encoded);
  }
}
