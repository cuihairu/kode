/**
 * cellData 键补全(KSEM-CELL-04):`self.cellData["<片段>"]` /
 * `self.cellData.get("<片段>")` 字符串键位置的键补全数据面。
 *
 * 分工(与 analyzeDef 同口径):键宇宙计算在 Rust(`$/kode/semantics/
 * cellDataKeys`:CELL-01 字段集 + CELL-02 内建键 + CELL-03 组件槽,域位真值
 * flag_domains);本模块只做上下文探测、角色/实体隔离、def 宇宙闭包收集
 * (BFS:Parent/Interfaces/组件类型,经 parseDefFileSemantics 出边)与
 * RPC 装配。def 文本流 TS→Rust 按请求供给,引擎不扫盘不缓存。
 *
 * 诚实边界:
 * - 角色/实体隔离:仅 `scripts/cell/<Name>.py` 与 `scripts/base/<Name>.py`
 *   接管(cell/base 面可达 cellData;base 面是副本,键集同源);client/bots
 *   与其他角色不接管(不混入其他实体/角色);
 * - Rust 不可用(无 gate/调用失败/形状不合规)→ null,调用方不补全,
 *   不造键;实体 def 缺 → 缺席贡献,不猜;
 * - 替换范围 = 引号内键片段的精确区间(不含引号)。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { parseDefFileSemantics } from './defRenamer';

export const CELL_DATA_KEYS_METHOD = '$/kode/semantics/cellDataKeys';

/** 随请求供给的 def 宇宙面(与 Rust 契约 {name,text} 同形)。 */
export interface CellDataDefSource {
  name: string;
  text: string;
}

/** Rust 返回的一条 cellData 键(kind 内部标签:defField/builtin/componentSlot)。 */
export interface CellDataKeyEntry {
  key: string;
  kind: 'defField' | 'builtin' | 'componentSlot';
  typeLabel?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
}

/** 诊断关联跳转面(KSEM-CELL-14):声明锚点解析产物(纯数据,publish 面
 * 转 vscode.DiagnosticRelatedInformation)。file=绝对路径;line=0 基 vscode 行。 */
export interface CellDataRelatedLocation {
  file: string;
  line: number;
  label: string;
}

/**
 * sourceFile 锚点解析(KSEM-CELL-14):`{from}.def` 名 → 宇宙内类别 → 真实
 * 路径(pythonDefinition 的 cellData-key 跳转同口径)。内建键的引擎证据路径
 * (server/baseapp/entity.cpp:250)与解析不出的名字 → null,不造假跳转。
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

/** 键补全上下文(替换区间面)。 */
export interface CellDataKeyCompletionContext {
  /** 已键入的键片段(可为空串:光标紧跟引号/`[`)。 */
  partial: string;
  /** 替换起点(0 基字符列;终点=光标列)。 */
  replaceStart: number;
}

/**
 * 光标处是否在 cellData 字符串键位置。同行探测(与 propertyDirection
 * 键访问扫描同口径):`self.cellData["x` / `self.cellData['x` /
 * `self.cellData.get("x`;闭引号/闭括号后的位置不是键位置。
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
  // 已开引号 + 片段(片段内无引号无反斜杠——首个同引号即闭)。
  const quoted = text.match(/self\.cellData\s*(?:\[\s*|\.get\s*\(\s*)(["'])([^"'\\]*)$/);
  if (quoted) {
    return { partial: quoted[2], replaceStart: character - quoted[2].length };
  }
  // 光标紧跟 `[` / `.get(`(还没打引号):空片段区间,插入即引号后位置。
  if (/self\.cellData\s*(?:\[\s*|\.get\s*\(\s*)$/.test(text)) {
    return { partial: '', replaceStart: character };
  }
  return null;
}

/**
 * 实体脚本角色/实体名(KBEngine 布局 KR-AUD-74:scripts/<part>/<Name>.py)。
 * 仅 cell/base 两面接管;client/bots 面 cellData 不可达,返回 null。
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
 * def 宇宙闭包(BFS):实体自身 + Parent 链 + Interfaces + 组件类型(组件 def
 * 的 Parent 也是组件、接口不走 Parent 边——与 collectInheritedNames 出边
 * 同口径)。缺文件跳过不造;visited 环安全。
 */
/** def 宇宙条目(带来源类别;KSEM-CELL-05 跳转按类别解析 `{from}.def`)。 */
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
      continue; // 缺文件:该贡献缺席,不猜
    }
    defs.push({ name: current.name, category: current.category, text });
    const semantics = parseDefFileSemantics(text);
    if (!semantics) {
      continue;
    }
    if (semantics.parentName && current.category !== 'interface') {
      // 组件 def 的父也是组件;实体 def 的父是实体。
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

/** def 宇宙闭包(BFS;不带类别,补全面消费)。 */
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
