/**
 * KBEngine Python API docs hover (C-21): doc-section data source and pure
 * rendering for three kinds of trigger points.
 *
 * Trigger points:
 *  A. `KBEngine.<api>` member access (module functions/constants);
 *  B. the appended doc section of an entity builtin property/channel hover
 *     (channel/builtin attr semantics, invoked by the builtin property face of
 *     languageProviders; this module only produces the doc-section text);
 *  C. the `def onX(...)` declaration line of a lifecycle callback
 *     (callback-kind entries).
 *
 * Source of truth = docs/knowledge/api-*.md (KB-API batch source-code
 * grounding) -> scripts/generate-api-docs.mjs -> src/generated/apiDocs.ts (the
 * TS mirror) and crates/kode-server/assets/api-docs.json (the kode-server
 * embedded face) share the same origin; tests/apiDocsParity.test.ts locks
 * consistency. A missing zh entry falls back to en: never guess, never
 * invent.
 *
 * Lookup semantics: prefer an exact match on the current script face
 * (base/cell/client); when the face does not match or there is no face, return
 * only a unique cross-domain hit; a multi-domain ambiguity returns the
 * candidate list (the consumer honestly shows both faces), never silently
 * picking one.
 */

import { API_DOC_ENTRIES, type ApiDocEntry } from '../generated/apiDocs';
import type { HoverLanguage } from '../hoverLocale';

/** Script face (the face of kbengine.entityBuiltinProperties) -> doc library domain */
const FACE_TO_DOMAIN: Record<string, string> = {
  baseapp: 'base',
  cellapp: 'cell',
  client: 'client', bots: 'bots', base: 'base', cell: 'cell',
  logger: 'logger', dbmgr: 'dbmgr', interfaces: 'interfaces', loginapp: 'loginapp'
};

/** Doc library domain aliases (the bots script directory follows the client-face convention; the bots domain is tried as well) */
export function apiDocDomainsForFace(face: string | null | undefined): string[] {
  const primary = face ? FACE_TO_DOMAIN[face] : undefined;
  return primary ? [primary, ...(primary === 'client' ? ['bots'] : [])] : [];
}

export interface ApiDocHit {
  readonly entry: ApiDocEntry;
  /** Summary resolved for the locale (falls back to en when zh is missing) */
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
      // Same domain, same name, multiple owners (name collisions such as
      // entity.cell versus KBEngine.component): still disambiguate by a unique
      // owner, and report an honest ambiguity only when that is impossible
      const owners = new Set(inDomain.map(entry => entry.owner));
      if (owners.size === 1) {
        return { kind: 'hit', hit: { entry: inDomain[0], summary: localize(inDomain[0], locale), locale } };
      }
    }
  }
  if (domains.length > 0) { return { kind: 'miss' }; }
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

/** One hit -> markdown doc section (signature code block + localized summary + source anchor) */
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

/** Trigger point B: the appended doc section of a builtin property/channel hover (non-empty only on a hit; the signature is not repeated) */
export function formatApiDocSupplement(name: string, domains: readonly string[], locale: HoverLanguage): string {
  const lookup = lookupApiDoc(name, domains, locale);
  if (lookup.kind !== 'hit' || !lookup.hit.summary) {
    return '';
  }
  const { entry, summary } = lookup.hit;
  return `\n---\n${summary} _(API 文档 · ${entry.page})_\n`;
}

/** Trigger point A decision: whether the cursor lands on the member of `KBEngine.<member>` */
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

/** Trigger point C decision: whether the cursor lands on the function name of a `def <name>(...)` declaration line */
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
  // Only accept callback-kind entries in the doc library (lifecycle hooks); ordinary method definitions get no docs
  const hasCallbackEntry = API_DOC_ENTRIES.some(
    entry => entry.member === match[2] && entry.kind === 'callback'
  );
  return hasCallbackEntry ? { name: match[2] } : null;
}
