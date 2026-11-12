/**
 * cellData 错键提示(KSEM-CELL-10):把 KSEM-CELL-09 的键跟踪事实转成提示面。
 * 只在「能证明键不存在」或「键名明显是某个声明键的笔误」时报,否则沉默——
 * 本面的错误预算全押在误报上(漏报只是没帮忙,误报会打断合法代码)。
 *
 * 两条验收各自的判据:
 * - **缺失/拼写候选** = 有确定性证据才给确定性提示;候选只跟已声明键比对。
 * - **get 不按必然 KeyError 报错** = `.get(k)` 是合法取值形态(引擎与 Python
 *   语义都不抛 KeyError),get 读点**永不给确定性提示**;但 `.get("hpe")` 这种
 *   笔误会静默取到 None/默认值,是真实缺陷,故只给**低置信建议**。
 *
 * 世界开放度决定置信度(CELL-09 事实面提供 worldOpen):
 * - 封闭(文档内无追踪不到的增键面)→ 裸下标读已证 absent 报**确定性缺失**;
 * - 开放(动态键下标写 / update( / setdefault() 存在)→ 只给**低置信建议**,
 *   绝不报确定性缺失:增键面不可证穷举,报缺失会打断合法代码。
 *
 * 诚实边界(不硬造):
 * - presence=unknown(scriptAdded 跨作用域调用序不可证 / 别名逃逸后不可证 /
 *   开放世界的 unknown 键)→ 不给确定性提示;
 * - 声明键与内建键初始即有,绝不报缺失——即便中途被 del,那也是「删了再读」
 *   的生命周期事实面(KSEM-CELL-12),不在本面猜成因;
 * - 候选只在键宇宙内取(声明 ∪ 内建);距离超上限或平局 → 不给建议。
 *
 * 纯逻辑无 vscode / 无引擎依赖:entries 为键宇宙(Rust cellDataKeys RPC 同形),
 * text 经 trackCellDataKeys 转事实后进入本面,直接可测。
 */
import type { CellDataKeyFact } from './cellDataKeyTracking';
import type { CellDataKeyEntry, CellDataRelatedLocation } from './cellDataCompletion';
import type { CellDataKeyOperation } from './cellDataReadType';

/** 本面产出的提示码(与 lintRuleRegistry 锁步)。 */
export const CELL_DATA_WRONG_KEY_CODE = 'kbengine.cellDataWrongKey';

/** 编辑距离上限:超过此阈值的候选一律不收(键名相差太远不是笔误)。 */
const CANDIDATE_DISTANCE_MAX = 3;

/** 提示形态:confirmed=能证明缺失(裸下标读已证 absent,封闭世界);
 * hint=低置信建议(世界开放 / get 形态 / 仅拼写疑似)。 */
export type CellDataKeySuggestionKind = 'confirmed' | 'hint';

/** 一条错键提示(纯数据;extension 侧转 vscode.Diagnostic)。 */
export interface CellDataWrongKeyFinding {
  /** 读点行(0 基)。 */
  line: number;
  /** 键内容起点(0 基行内字符列,不含引号)。 */
  character: number;
  /** 键内容长度(提示区间 = 键字面量本体)。 */
  length: number;
  key: string;
  kind: CellDataKeySuggestionKind;
  /** 候选键(无可靠候选 → 空串)。 */
  candidate: string;
  /** 候选声明来源(有候选时给出,便于「跳去声明处」)。 */
  candidateSource: string;
  /** 候选声明文件名(`{from}.def`;无 → null;KSEM-CELL-14 关联跳转解析用)。 */
  candidateFile: string | null;
  /** 候选声明行(Rust sourceLine,1 基人读行号;无 → null)。 */
  candidateLine: number | null;
  /** 是否带默认值的 get(消息里区分「不会因缺失抛错」)。 */
  hasDefault: boolean;
  message: string;
}

/**
 * Levenshtein 编辑距离(带公共前后缀修剪)。键名都短,二次方足够;修剪把
 * 「只差尾部一个字符」这类笔误压到常数级,也避免长公共前缀的候选白算。
 */
function editDistance(a: string, b: string): number {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  const aTail = a.slice(start);
  const bTail = b.slice(start);
  let end = 0;
  while (
    end < aTail.length &&
    end < bTail.length &&
    aTail[aTail.length - 1 - end] === bTail[bTail.length - 1 - end]
  ) {
    end += 1;
  }
  const left = aTail.slice(0, aTail.length - end);
  const right = bTail.slice(0, bTail.length - end);
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }
  let previous: number[] = new Array(right.length + 1);
  let current: number[] = new Array(right.length + 1);
  for (let column = 0; column <= right.length; column += 1) {
    previous[column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let col = 1; col <= right.length; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      current[col] = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length];
}

/**
 * 取最近的候选键:编辑距离最小且 ≤ 上限;平局或超上限 → null(不硬造唯一性)。
 * 候选只在传入的键宇宙内取(声明 ∪ 内建;scriptAdded/未知键不进候选)。
 */
function candidateOf(key: string, universe: Map<string, CellDataKeyEntry>): CellDataKeyEntry | null {
  let best: CellDataKeyEntry | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const [candidateKey, entry] of universe) {
    if (candidateKey === key) {
      continue;
    }
    const distance = editDistance(key, candidateKey);
    if (distance > CANDIDATE_DISTANCE_MAX) {
      continue;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  if (tie || best === null || bestDistance > CANDIDATE_DISTANCE_MAX) {
    return null;
  }
  return best;
}

/** 拼接消息里的「声明来源」段(缺 → 空串,不硬造位置)。 */
function sourceSegment(entry: CellDataKeyEntry): string {
  const file = entry.sourceFile ?? '';
  if (!file) {
    return '';
  }
  // sourceLine 已是 1 基人读行号(kode-parser LineMap::line_of `lo+1`;
  // CELL-05 跳转/补全 detail 同口径),原样展示。旧码 `+1` 是错位显示,
  // KSEM-CELL-14 顺修(消息与关联跳转必须一致)。
  return entry.sourceLine !== null && entry.sourceLine !== undefined
    ? `${file}:${entry.sourceLine}`
    : file;
}

/**
 * 从 CELL-09 键事实里选出要提示的读点。
 *
 * @param worldOpen 文档内是否存在追踪不到的增键面(动态键写 / update /
 *   setdefault)——true 时只出低置信建议,绝不报确定性缺失。
 */
export function cellDataWrongKeyFindings(
  facts: readonly CellDataKeyFact[],
  entries: readonly CellDataKeyEntry[],
  worldOpen: boolean
): CellDataWrongKeyFinding[] {
  const universe = new Map<string, CellDataKeyEntry>();
  for (const entry of entries) {
    if (!universe.has(entry.key)) {
      universe.set(entry.key, entry);
    }
  }
  if (facts.length === 0 || universe.size === 0) {
    return [];
  }
  const findings: CellDataWrongKeyFinding[] = [];
  for (const fact of facts) {
    const op: CellDataKeyOperation = fact.op;
    // 只有「读」才有缺失问题:写即引入键(scriptAdded 是合法新增),
    // del 是写点面不读键。
    if (op.kind !== 'read') {
      continue;
    }
    // 声明键/内建键初始即有:出现 absent 只能是中途被删(生命周期事实面),
    // 不在本面猜成因,不报。
    if (fact.keyClass === 'declared' || fact.keyClass === 'builtin') {
      continue;
    }
    const candidate = candidateOf(op.key, universe);
    if (op.accessKind === 'get') {
      // get 永不给确定性提示(不按必然 KeyError 报错);笔误值得低置信建议,
      // 无候选则沉默(不给「未知键」噪声)。
      if (candidate) {
        findings.push(makeFinding(op, op.key, candidate, 'hint'));
      }
      continue;
    }
    // 裸下标读:只有「已证 absent」且世界封闭才给确定性提示。
    if (fact.presence === 'absent' && !worldOpen) {
      findings.push(makeFinding(op, op.key, candidate, 'confirmed'));
      continue;
    }
    // 开放世界 / 不可证(absent 但世界开放、presence=unknown):只给建议。
    if (candidate && fact.presence !== 'present') {
      findings.push(makeFinding(op, op.key, candidate, 'hint'));
    }
  }
  return findings;
}

function makeFinding(
  op: CellDataKeyOperation,
  key: string,
  candidate: CellDataKeyEntry | null,
  kind: CellDataKeySuggestionKind
): CellDataWrongKeyFinding {
  const hasDefault = op.defaultExpr !== null;
  const source = candidate ? sourceSegment(candidate) : '';
  // 分级文案:确定性提示说「不存在」,低置信只说「未在已声明字段中出现」,
  // 措辞本身即置信度——不把不可证的推论写成结论。
  const head =
    kind === 'confirmed'
      ? `cellData 键「${key}」不存在于该实体已声明的字段`
      : `cellData 键「${key}」未在已声明字段中出现`;
  const candidatePart =
    kind === 'confirmed' && candidate
      ? `;最接近的声明键是「${candidate.key}」`
      : candidate
        ? `;最接近的声明键疑似「${candidate.key}」`
        : '';
  const sourcePart = source ? `(声明来源 ${source})` : '';
  const defaultPart = hasDefault ? '(get 带默认值,不会因缺失抛错)' : '';
  return {
    line: op.line,
    character: op.keyStart,
    length: Math.max(0, op.keyEnd - op.keyStart),
    key,
    kind,
    candidate: candidate?.key ?? '',
    candidateSource: source,
    candidateFile: candidate?.sourceFile ?? null,
    candidateLine: candidate?.sourceLine ?? null,
    hasDefault,
    message: `${head}${candidatePart}${sourcePart}${defaultPart}`
  };
}
/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖)。
 * 与 CELL-08 的 item 形状同形,便于共用装配面。related=声明锚点(KSEM-CELL-14
 * 关联跳转;装配面经 resolveCellDataDeclAnchor 解析后传入)。 */
export interface CellDataWrongKeyDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
  related?: CellDataRelatedLocation;
}

/** 错键提示 → 诊断项(区间 = 键字面量本体,不含引号)。 */
export function cellDataWrongKeyFindingToItem(
  finding: CellDataWrongKeyFinding,
  related?: CellDataRelatedLocation
): CellDataWrongKeyDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: CELL_DATA_WRONG_KEY_CODE,
    ...(related ? { related } : {})
  };
}

/** 开关默认值(与 CELL-08 同口径:默认开)。 */
export const CELL_DATA_WRONG_KEY_DIAGNOSTICS_ENABLED_DEFAULT = true;
