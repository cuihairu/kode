/**
 * cellData key completion (KSEM-CELL-04): the key completion data surface for
 * `self.cellData["<fragment>"]` / `self.cellData.get("<fragment>")` string key
 * positions.
 *
 * Division of labour (same contract as analyzeDef): the key universe is computed
 * in Rust (`$/kode/semantics/cellDataKeys`: CELL-01 field set + CELL-02 builtin
 * keys + CELL-03 component slots, domain bits via flag_domains); this module
 * only does context detection, role/entity isolation, def universe closure
 * collection (BFS: Parent/Interfaces/component types, outgoing edges through
 * parseDefFileSemantics) and RPC assembly. def text streams TS -> Rust
 * per request; the engine neither scans disk nor caches.
 *
 * Honest boundary:
 * - role/entity isolation: only `scripts/cell/<Name>.py` and
 *   `scripts/base/<Name>.py` are taken over (cell/base faces can reach
 *   cellData; the base face is a copy with a same-origin key set); client/bots
 *   and other roles are not taken over (no mixing in other entities/roles);
 * - Rust unavailable (no gate / call failure / non-conforming shape) -> null,
 *   the caller does not complete, no keys invented; entity def missing ->
 *   absent contribution, no guessing;
 * - replacement range = the exact range of the key fragment inside the quotes
 *   (quotes excluded).
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { parseDefFileSemantics } from './defRenamer';

export const CELL_DATA_KEYS_METHOD = '$/kode/semantics/cellDataKeys';

/** def universe face supplied with the request (same shape as the Rust contract {name,text}). */
export interface CellDataDefSource {
  name: string;
  text: string;
}

/** One cellData key returned by Rust (kind is an internal label: defField/builtin/componentSlot). */
export interface CellDataKeyEntry {
  key: string;
  kind: 'defField' | 'builtin' | 'componentSlot';
  typeLabel?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
}

/** Diagnostic related-information link surface (KSEM-CELL-14): declaration anchor resolution output (pure data, converted to vscode.DiagnosticRelatedInformation on the publish face). file = absolute path; line = 0-based vscode line. */
export interface CellDataRelatedLocation {
  file: string;
  line: number;
  label: string;
}

/**
 * sourceFile anchor resolution (KSEM-CELL-14): `{from}.def` name -> category
 * inside the universe -> real path (same contract as the pythonDefinition
 * cellData-key go-to). The engine evidence path for builtin keys
 * (server/baseapp/entity.cpp:250) and unresolvable names -> null; no fake
 * related-information link is invented.
 */
export function resolveCellDataDeclAnchor(
  sourceFile: string | null | undefined,
  defs: readonly CellDataDefSourceWithCategory[],
  findDefFile: (name: string, category: 'entity' | 'interface' | 'component') => string | null
): { file: string } | null {
  if (!sourceFile || !sourceFile.endsWith('.def')) {
    return null;
  }
  const fromName = sourceFile.replace(/\.def$/, '');
  const sourceDef = defs.find(def => def.name === fromName);
  if (!sourceDef) {
    return null;
  }
  const targetPath = findDefFile(fromName, sourceDef.category);
  return targetPath ? { file: targetPath } : null;
}

/** Key completion context (replacement range surface). */
export interface CellDataKeyCompletionContext {
  /** Key fragment already typed (may be an empty string: the cursor sits right after the quote / `[`). */
  partial: string;
  /** Replacement start (0-based character column; end = cursor column). */
  replaceStart: number;
}

/**
 * Whether the cursor is at a cellData string key position. Same-line detection
 * (same contract as the propertyDirection key-access scan):
 * `self.cellData["x` / `self.cellData['x` / `self.cellData.get("x`; a position
 * after the closing quote/paren is not a key position.
 */
export function cellDataKeyCompletionContext(
  lines: readonly string[],
  line: number,
  character: number
): CellDataKeyCompletionContext | null {
  const row = lines[line];
  if (row === undefined) {
    return null;
  }
  const text = row.slice(0, character);
  // Open quote + fragment (no quote and no backslash inside the fragment -- the first matching quote closes it).
  const quoted = text.match(/self\.cellData\s*(?:\[\s*|\.get\s*\(\s*)(["'])([^"'\\]*)$/);
  if (quoted) {
    return { partial: quoted[2], replaceStart: character - quoted[2].length };
  }
  // Cursor right after `[` / `.get(` (no quote typed yet): empty fragment range, the insertion lands right after the quote position.
  if (/self\.cellData\s*(?:\[\s*|\.get\s*\(\s*)$/.test(text)) {
    return { partial: '', replaceStart: character };
  }
  return null;
}

/**
 * Entity script role/entity name (KBEngine layout KR-AUD-74: scripts/<part>/<Name>.py).
 * Only the cell/base faces are taken over; on the client/bots faces cellData is
 * unreachable, so null is returned.
 */
export function cellScriptRoleAndEntity(
  fileName: string
): { role: 'cell' | 'base'; entity: string } | null {
  const norm = fileName.replace(/\\/g, '/');
  const match = norm.match(/\/scripts\/(cell|base)\/([A-Za-z_][A-Za-z0-9_]*)\.py$/);
  if (!match) {
    return null;
  }
  return { role: match[1] as 'cell' | 'base', entity: match[2] };
}

/**
 * def universe closure (BFS): the entity itself + Parent chain + Interfaces +
 * component types (a component def's Parent is also a component; interfaces do
 * not traverse Parent edges -- same outgoing-edge contract as
 * collectInheritedNames). Missing files are skipped, not invented; the visited
 * set is cycle-safe.
 */
/** def universe entry (with source category; the KSEM-CELL-05 go-to resolves `{from}.def` by category). */
export interface CellDataDefSourceWithCategory extends CellDataDefSource {
  category: 'entity' | 'interface' | 'component';
}

export function collectCellDataDefUniverseWithCategory(
  entity: string,
  findDefText: (name: string, category: 'entity' | 'interface' | 'component') => string | null
): CellDataDefSourceWithCategory[] {
  const defs: CellDataDefSourceWithCategory[] = [];
  const seen = new Set<string>();
  const queue: Array<{ name: string; category: 'entity' | 'interface' | 'component' }> = [
    { name: entity, category: 'entity' }
  ];
  while (queue.length > 0) {
    const current = queue.shift() as { name: string; category: 'entity' | 'interface' | 'component' };
    const key = `${current.category}:${current.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const text = findDefText(current.name, current.category);
    if (text === null) {
      continue; // missing file: that contribution is absent, no guessing
    }
    defs.push({ name: current.name, category: current.category, text });
    const semantics = parseDefFileSemantics(text);
    if (!semantics) {
      continue;
    }
    if (semantics.parentName && current.category !== 'interface') {
      // A component def's parent is also a component; an entity def's parent is an entity.
      queue.push({
        name: semantics.parentName,
        category: current.category === 'component' ? 'component' : 'entity'
      });
    }
    for (const name of semantics.interfaceNames) {
      queue.push({ name, category: 'interface' });
    }
    for (const name of semantics.componentTypeNames) {
      queue.push({ name, category: 'component' });
    }
  }
  return defs;
}

/** def universe closure (BFS; without category, consumed by the completion face). */
export function collectCellDataDefUniverse(
  entity: string,
  findDefText: (name: string, category: 'entity' | 'interface' | 'component') => string | null
): CellDataDefSource[] {
  return collectCellDataDefUniverseWithCategory(entity, findDefText).map(({ name, text }) => ({ name, text }));
}

const isKind = (value: unknown): value is CellDataKeyEntry['kind'] =>
  value === 'defField' || value === 'builtin' || value === 'componentSlot';

/**
 * wire kind 形状:Rust CellDataKeyKind 带 `#[serde(tag = "kind")]`,线上是
 * 内嵌标签对象 `{"kind":"defField"}`,不是平面串(2026-11-12 真机全链验收
 * 实锤:平面串形状校验恒拒 → fetchCellDataKeys 真机恒 null → 键宇宙五面
 * 全哑;unit mock 用了 TS 侧平面串形状,掩盖了这一契约漂移)。
 */
const isWireKind = (value: unknown): value is { kind: CellDataKeyEntry['kind'] } =>
  typeof value === 'object' && value !== null && isKind((value as Record<string, unknown>).kind);

/** 单条键形状校验(缺省字段宽容,核心面在才收;畸形 → false)。 */
function isWireKeyEntry(value: unknown): value is { [K in keyof CellDataKeyEntry]: K extends 'kind' ? { kind: CellDataKeyEntry['kind'] } : CellDataKeyEntry[K] } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.key !== 'string' || !isWireKind(entry.kind)) {
    return false;
  }
  return true;
}

/**
 * Rust 键宇宙查询:整面形状校验(畸形 → null 整面作废,不部分采用);
 * 无 gate / 调用失败 / 实体缺(defs 空) → null 或空集,调用方不补全。
 * wire kind 内嵌标签对象在此解包为 TS 平面串,下游(entry.kind==='builtin'
 * 等)不受 wire 形状影响。
 */
export async function fetchCellDataKeys(
  entity: string,
  defs: CellDataDefSource[]
): Promise<CellDataKeyEntry[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<{ keys?: unknown }>(CELL_DATA_KEYS_METHOD, { entity, defs });
  if (!response.ok || !Array.isArray(response.result?.keys)) {
    return null;
  }
  const keys = response.result.keys;
  if (!keys.every(isWireKeyEntry)) {
    return null;
  }
  return keys.map(entry => ({
    key: entry.key,
    kind: entry.kind.kind,
    typeLabel: entry.typeLabel,
    sourceFile: entry.sourceFile,
    sourceLine: entry.sourceLine
  }));
}
