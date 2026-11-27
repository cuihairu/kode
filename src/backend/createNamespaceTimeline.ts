/**
 * createNamespace timeline hover for Python `__init__` declarations (CREATE-06).
 *
 * Engine truth (verified against the engine fork at
 * kbe/src/lib/entitydef/entity_macro.h; the same source CREATE-05 cites):
 *   1. initProperty (:1574, :1616) sets every def-declared property to its
 *      dataType default via PyObject_SetAttrString before any script hook.
 *   2. createNamespace (:391) consumes the creation API params dict:
 *      cellData dict special case (:417-431), then per-key setattr / cellData
 *      routing (:439-501). Existing attributes are overwritten, unknown keys
 *      are created dynamically via PyObject_SetAttr (:501).
 *   3. initializeScript (:288) calls the script `__init__` (:322-325), after
 *      initializeEntity (:362-365) has run steps 1 and 2.
 *
 * Pure rendering: no vscode, no RPC, no engine runtime. The caller supplies
 * the entity name and its def-declared property rows. Params keys come from
 * literal dicts in the same file (collectCreationParamsKeys); never claim a
 * runtime value was observed.
 */
import { basename } from 'path';
import type { PropertyFlagDomain } from './defAnalyzer';

/** One def-declared property row in the timeline table. */
export interface TimelineProperty {
  name: string;
  typeName?: string;
  defaultValue?: string;
  domains: PropertyFlagDomain[];
  defFile: string;
  defLine: number;
}

/** Input from the hover assembly face (all data already resolved). */
export interface CreateNamespaceTimelineInput {
  entity: string;
  /** `null` = index not ready: give the semantic timeline, never invent rows. */
  properties: TimelineProperty[] | null;
  /** Keys of params dict literals found in the same Python file, if provided. */
  paramsKeys?: readonly string[];
}

const MAX_PROPERTY_ROWS = 12;

/** Engine citations shared by the timeline head and the property table tail. */
export const ENGINE_LIFECYCLE_CITATIONS = {
  initProperty: 'entity_macro.h:1574',
  defaultAssignment: 'entity_macro.h:1616',
  initializeEntity: 'entity_macro.h:362-365',
  createNamespace: 'entity_macro.h:391',
  cellDataMerge: 'entity_macro.h:417-431',
  perKeySetAttr: 'entity_macro.h:439-501',
  dynamicSetAttr: 'entity_macro.h:501',
  initializeScript: 'entity_macro.h:288',
  initCall: 'entity_macro.h:322-325'
} as const;

function domainLabel(domains: readonly string[]): string {
  return domains.length > 0 ? domains.join('/') : '—';
}

function propertyRow(property: TimelineProperty, paramsKeys: readonly string[] | undefined): string {
  const type = property.typeName || '?';
  const fallback = property.defaultValue || '—';
  const source = `${basename(property.defFile)}:${property.defLine}`;
  const hit = paramsKeys === undefined
    ? 'params 未取'
    : paramsKeys.includes(property.name) ? 'params 命中→覆盖' : '缺键→默认值';
  return `\`${property.name}\` · ${type} · 域 ${domainLabel(property.domains)} · 默认 ${fallback} · ${hit} · 声明 \`${source}\``;
}

/**
 * Render the `__init__` timeline markdown. The three steps are ordered by the
 * engine call chain, not by source order of this file; the per-property table
 * states the two params outcomes (key present = override, absent = default).
 */
export function createNamespaceTimelineMarkdown(input: CreateNamespaceTimelineInput): string {
  const lines: string[] = [
    '**' + input.entity + ' · createNamespace 时序（`__init__` 之前）**',
    '',
    `① \`initProperty\` — def 属性逐一设为类型默认值（${ENGINE_LIFECYCLE_CITATIONS.initProperty} / ${ENGINE_LIFECYCLE_CITATIONS.defaultAssignment}）`,
    `② \`createNamespace\` — 创建 API params 逐键处理：cellData 合并（${ENGINE_LIFECYCLE_CITATIONS.cellDataMerge}），已有属性覆盖 / 未知键动态 setattr（${ENGINE_LIFECYCLE_CITATIONS.dynamicSetAttr}）`,
    `③ \`initializeScript\` 才调用 \`__init__\`（${ENGINE_LIFECYCLE_CITATIONS.initCall}；调用序 ${ENGINE_LIFECYCLE_CITATIONS.initializeEntity}）`,
    ''
  ];
  if (input.properties === null) {
    lines.push('属性目录不可用（索引未就绪）：不列属性行，不推断参数命中。');
    return lines.join('\n');
  }
  if (input.properties.length === 0) {
    lines.push('实体 def 未声明属性：①无默认装载行，params 键全部走动态 setattr 臂。');
    return lines.join('\n');
  }
  lines.push('逐属性（键在 params 中 = 覆盖默认值；缺键 = 保留①的默认值）：');
  for (const property of input.properties.slice(0, MAX_PROPERTY_ROWS)) {
    lines.push(`- ${propertyRow(property, input.paramsKeys)}`);
  }
  if (input.properties.length > MAX_PROPERTY_ROWS) {
    lines.push(`- … 其余 ${input.properties.length - MAX_PROPERTY_ROWS} 项省略`);
  }
  lines.push('');
  lines.push('params 键取 creation-API 调用点的字面量；未提供时如实写「params 未取」，不冒充运行时观测值。');
  return lines.join('\n');
}

/**
 * Extract string-literal keys from creation-API params dicts in one Python
 * source file. Deliberately narrow: only `KBEngine.<api>(...)` calls with a
 * dict literal at the known params slot (CREATE-05 contract table), first
 * positional entity type must match the entity name. No key is claimed for
 * dynamic (`**spread`) dicts or unresolvable shapes.
 */
export function collectCreationParamsKeys(source: string, entityName: string): string[] {
  const keys = new Set<string>();
  const callPattern = /\bKBEngine\.(createEntity|createEntityAnywhere|createEntityRemotely)\s*\(/g;
  for (let match = callPattern.exec(source); match !== null; match = callPattern.exec(source)) {
    const api = match[1];
    const argsStart = callPattern.lastIndex;
    let depth = 1;
    let end = argsStart;
    while (end < source.length && depth > 0) {
      const ch = source[end];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      end++;
    }
    if (depth !== 0) continue;
    const argText = source.slice(argsStart, end - 1);
    const parts = splitTopLevel(argText);
    // keyword params wins over positional (CREATE-05 rule); otherwise the
    // arity-based slot per API.
    let paramsExpr = '';
    const keywordParam = parts.find(part => /^\s*params\s*=/.test(part));
    if (keywordParam !== undefined) {
      paramsExpr = keywordParam.slice(keywordParam.indexOf('=') + 1);
    } else {
      const paramsSlot = api === 'createEntityRemotely' ? 2
        : api === 'createEntityAnywhere' ? 1
          : parts.length === 2 ? 1 : parts.length >= 5 ? 4 : -1;
      if (paramsSlot < 0 || !parts[paramsSlot]) continue;
      paramsExpr = parts[paramsSlot];
    }
    const first = parts[0]?.trim();
    if (!first || !/^(['"])(.*)\1$/.test(first) || first.slice(1, -1) !== entityName) continue;
    const dictText = paramsExpr.trim();
    if (!dictText.startsWith('{') || !dictText.endsWith('}')) continue;
    // spread/dynamic dict (`{**other, ...}`): no string-literal key is
    // claimed, keys of the merged dict are unresolvable statically.
    if (/\*\*/.test(dictText.slice(1, -1))) continue;
    for (const entry of splitTopLevel(dictText.slice(1, -1))) {
      const keyMatch = /^\s*(['"])([^'"]*)\1\s*:/.exec(entry);
      if (keyMatch) keys.add(keyMatch[2]);
    }
  }
  return [...keys].sort();
}

/** Split a comma-separated argument list on top-level commas only. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
