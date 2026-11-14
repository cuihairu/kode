/**
 * KSEM-CFG-04 配置补全 provider 壳(vscode 适配层)。
 *
 * 纯核心在 src/backend/configCompletion.ts(上下文解析+键/值建议);本壳
 * 只做:开关读取(kbengine.configCompletion,默认开)→ resolve 缓存取
 * defaults/custom 树(buildConfigTreePair;调用方语义:ensureConfigResolved
 * 已在各命令入口接线,此处只读缓存,miss 时静默无建议)→ 契约提取/字段
 * 扫描按树身份 WeakMap 缓存 → CompletionItem 映射。
 *
 * 注册面=配置 XML 文档选择器(kbengine*.xml / messages_fixed*.xml),
 * 与既有 def/python/shell 补全选择器零交集,不重复注册冲突项(验收条款)。
 */
import * as vscode from 'vscode';
import {
  provideConfigCompletions,
  type ConfigCompletionItem,
} from './backend/configCompletion';
import { extractConfigContractsFromTree } from './backend/configContract';
import { scanConfigFieldIdentities } from './backend/configFieldIdentity';
import { SERVER_CONFIG_ITEM_DOCS } from './backend/serverConfigCatalog';
import { buildConfigTreePair } from './serverConfigMerge';
import type { ConfigXmlNode } from './serverConfigMerge';

export const CONFIG_COMPLETION_ENABLED_DEFAULT = true;

/** 配置 XML 文档选择器(文件名模式限定;language xml) */
export const CONFIG_COMPLETION_SELECTORS: vscode.DocumentSelector = [
  { language: 'xml', pattern: '**/kbengine.xml' },
  { language: 'xml', pattern: '**/kbengine_defaults.xml' },
  { language: 'xml', pattern: '**/messages_fixed.xml' },
  { language: 'xml', pattern: '**/messages_fixed_defaults.xml' },
];

const catalogSources: Record<string, string> = {};
for (const [key, doc] of Object.entries(SERVER_CONFIG_ITEM_DOCS)) {
  catalogSources[key] = doc.source;
}

interface PreparedAnalysis {
  scan: ReturnType<typeof scanConfigFieldIdentities>;
  extraction: ReturnType<typeof extractConfigContractsFromTree>;
}

const analysisCache = new WeakMap<ConfigXmlNode, PreparedAnalysis>();

/** 按默认树身份缓存分析产物(树对象随 resolve 缓存换代,WeakMap 自动失效) */
function analysisFor(defaultsTree: ConfigXmlNode, customTree: ConfigXmlNode | null): PreparedAnalysis {
  const cached = analysisCache.get(defaultsTree);
  if (cached) {
    return cached;
  }
  const scan = scanConfigFieldIdentities(defaultsTree, customTree);
  const extraction = extractConfigContractsFromTree(defaultsTree, catalogSources, {
    file: 'resolved defaults snapshot (runtime tree; original text not re-read)',
    lineCount: null,
    note: '运行时仅持解析树未读原文(快照行数未知,如实标注);证据分级与夹具基线同源',
  });
  const prepared: PreparedAnalysis = { scan, extraction };
  analysisCache.set(defaultsTree, prepared);
  return prepared;
}

function toCompletionItems(items: readonly ConfigCompletionItem[]): vscode.CompletionItem[] {
  return items.map((item) => {
    const completion = new vscode.CompletionItem(item.label, item.kind === 'key'
      ? vscode.CompletionItemKind.Property
      : item.kind === 'enum-value'
        ? vscode.CompletionItemKind.EnumMember
        : vscode.CompletionItemKind.Keyword);
    completion.detail = item.detail;
    return completion;
  });
}

export class ConfigCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (
      !vscode.workspace
        .getConfiguration('kbengine')
        .get<boolean>('configCompletion.enabled', CONFIG_COMPLETION_ENABLED_DEFAULT)
    ) {
      return null;
    }
    const pair = buildConfigTreePair();
    if (pair.defaultsTree === null) {
      return null;
    }
    const { scan, extraction } = analysisFor(pair.defaultsTree, pair.customTree);
    const offset = document.offsetAt(position);
    return toCompletionItems(provideConfigCompletions(document.getText(), offset, scan, extraction));
  }
}
