/**
 * KBEngine Python API 文档 hover(C-21):三类触发点的文档段数据源与纯渲染。
 *
 * 触发点:
 *  A. `KBEngine.<api>` 成员访问(module 函数/常量);
 *  B. 实体内建属性/通道 hover 的文档追加段(通道/内建 attr 语义,由
 *     languageProviders 的内建属性面调用,本模块只出文档段文本);
 *  C. 生命周期回调 `def onX(...)` 声明行(callback 类条目)。
 *
 * 正本 = docs/knowledge/api-*.md(KB-API 批次源码 grounding)→
 * scripts/generate-api-docs.mjs → src/generated/apiDocs.ts(TS 镜像)与
 * crates/kode-server/assets/api-docs.json(kode-server 嵌入面)同源,
 * tests/apiDocsParity.test.ts 锁一致。zh 缺条目回退 en,不猜不编。
 *
 * 查询语义:按当前脚本面(base/cell/client)精确优先;面未命中或无面时,
 * 跨域唯一命中才返回;多域歧义返回候选列表(消费端如实呈现两面),绝不
 * 静默挑一个。
 */

import { API_DOC_ENTRIES, type ApiDocEntry } from '../generated/apiDocs';
import type { HoverLanguage } from '../hoverLocale';

/** 脚本面(kbengine.entityBuiltinProperties 的 face)→ 文档库域 */
const FACE_TO_DOMAIN: Record<string, string> = {
  baseapp: 'base',
  cellapp: 'cell',
  client: 'client'
};

/** 文档库域代称(bots 脚本目录按 client 面惯例,另试 bots 域) */
export function apiDocDomainsForFace(face: string | null | undefined): string[] {
  const primary = face ? FACE_TO_DOMAIN[face] : undefined;
  return primary ? [primary, ...(primary === 'client' ? ['bots'] : [])] : [];
}

export interface ApiDocHit {
  readonly entry: ApiDocEntry;
  /** 按 locale 解析后的摘要(zh 缺失回退 en) */
  readonly summary: string;
  readonly locale: HoverLanguage;
}

export type ApiDocLookup =
  | { readonly kind: 'hit'; readonly hit: ApiDocHit }
  | { readonly kind: 'ambiguous'; readonly entries: readonly ApiDocEntry[] }
  | { readonly kind: 'miss' };

function localize(entry: ApiDocEntry, locale: HoverLanguage): string {
  if (locale === 'zh-cn' && entry.summaryZh) {
    return entry.summaryZh;
  }
  return entry.summaryEn;
}

export function lookupApiDoc(
  name: string,
  domains: readonly string[] = [],
  locale: HoverLanguage = 'en'
): ApiDocLookup {
  const byName = API_DOC_ENTRIES.filter(entry => entry.member === name);
  if (byName.length === 0) {
    return { kind: 'miss' };
  }
  for (const domain of domains) {
    const inDomain = byName.filter(entry => entry.domain === domain);
    if (inDomain.length === 1) {
      return { kind: 'hit', hit: { entry: inDomain[0], summary: localize(inDomain[0], locale), locale } };
    }
    if (inDomain.length > 1) {
      // 同域同名多 owner(entity.cell 与 KBEngine.component 之类撞名):
      // 仍按唯一 owner 消歧,分不出才如实歧义
      const owners = new Set(inDomain.map(entry => entry.owner));
      if (owners.size === 1) {
        return { kind: 'hit', hit: { entry: inDomain[0], summary: localize(inDomain[0], locale), locale } };
      }
    }
  }
  const owners = new Set(byName.map(entry => entry.owner));
  if (byName.length === 1 || owners.size === 1) {
    return { kind: 'hit', hit: { entry: byName[0], summary: localize(byName[0], locale), locale } };
  }
  return { kind: 'ambiguous', entries: byName };
}

const KIND_LABEL: Record<ApiDocEntry['kind'], string> = {
  method: 'method',
  callback: 'callback',
  attr: 'attr',
  constant: 'constant'
};

const DOMAIN_LABEL: Record<string, string> = {
  base: 'baseapp',
  cell: 'cellapp',
  client: 'client',
  bots: 'bots',
  interfaces: 'interfaces',
  server: 'loginapp/dbmgr/logger',
  core: 'core'
};

/** 单条命中 → markdown 文档段(签名代码块 + 本地化摘要 + 溯源锚) */
export function formatApiDocHover(lookup: ApiDocLookup): string {
  if (lookup.kind === 'miss') {
    return '';
  }
  if (lookup.kind === 'ambiguous') {
    const faces = [...new Set(lookup.entries.map(e => DOMAIN_LABEL[e.domain] ?? e.domain))];
    return `` +
      `**KBEngine API 文档**:该名称在多个进程面都有定义(${faces.join(' / ')}),` +
      `当前文件面未判定——把文件放进 base/cell/client 目录后按面精确匹配。\n`;
  }
  const { entry, summary, locale } = lookup.hit;
  const lines: string[] = [];
  lines.push('```python');
  lines.push(entry.signature);
  lines.push('```');
  const face = DOMAIN_LABEL[entry.domain] ?? entry.domain;
  lines.push(`**${face} · ${KIND_LABEL[entry.kind]}${entry.qualifier ? ` · ${entry.qualifier}` : ''}**`);
  if (summary) {
    lines.push(locale === 'zh-cn' && !entry.summaryZh ? `${summary} _(en)_` : summary);
  }
  if (entry.sourceRefs.length > 0) {
    lines.push('');
    lines.push(`源码锚: ${entry.sourceRefs.map(ref => `\`${ref}\``).join(' · ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** B 触发点:内建属性/通道 hover 的追加文档段(命中才非空;不重复签名) */
export function formatApiDocSupplement(name: string, domains: readonly string[], locale: HoverLanguage): string {
  const lookup = lookupApiDoc(name, domains, locale);
  if (lookup.kind !== 'hit' || !lookup.hit.summary) {
    return '';
  }
  const { entry, summary } = lookup.hit;
  return `\n---\n${summary} _(API 文档 · ${entry.page})_\n`;
}

/** A 触发点判定:光标是否落在 `KBEngine.<member>` 的 member 上 */
export function getKbengineApiAccessAtPosition(
  lineText: string,
  character: number
): { member: string } | null {
  const re = /KBEngine\.([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(lineText)) !== null) {
    const start = match.index + 'KBEngine.'.length;
    const end = start + match[1].length;
    if (character >= start && character <= end) {
      return { member: match[1] };
    }
  }
  return null;
}

/** C 触发点判定:光标是否落在 `def <name>(...)` 声明行的函数名上 */
export function getPythonCallbackDefinitionAtPosition(
  lineText: string,
  character: number
): { name: string } | null {
  const match = /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/.exec(lineText);
  if (!match) {
    return null;
  }
  const start = match[1].length + 4; // 'def '
  const end = start + match[2].length;
  if (character < start || character > end) {
    return null;
  }
  // 只认文档库 callback 类条目(生命周期钩子),普通方法定义不给文档
  const hasCallbackEntry = API_DOC_ENTRIES.some(
    entry => entry.member === match[2] && entry.kind === 'callback'
  );
  return hasCallbackEntry ? { name: match[2] } : null;
}
