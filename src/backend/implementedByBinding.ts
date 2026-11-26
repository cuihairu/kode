/**
 * KSEM-STRUCT-06: implementedBy binding resolution (the engine's real
 * loadImplModule shape).
 *
 * Engine reality (datatype.cpp loadImplModule L2331-2357): the value split on
 * '.' must be exactly two segments moduleName.symbolName -- ImportModule
 * (front segment) + GetAttrString (back segment), fetched by attribute name;
 * a class is not required (class/def/assignment, all three forms work). The
 * three contract methods (setImplModule L2383-2397) reuse GEN-DEF-1e's same
 * source of truth (userTypeContract.implFileHasContractMethod), zero new
 * tables.
 *
 * Real import face: under Python's import machinery, when `module.py` and
 * `module/__init__.py` coexist under the same name the **package directory
 * wins** (CPython FileFinder prefers packages, verified locally with
 * python3); the collection side emits candidates in that order. A binding
 * holds only when the module is truly resolvable (exists) and the symbol
 * truly has a definition.
 *
 * Acceptance boundaries (keep unknown, never guess):
 * - Duplicate names: the same symbol defined multiple times in one file
 *   (ambiguous-symbol) / same-named modules coexisting across user_type
 *   roots (ambiguous-module, the sys.path order is not decidable within the
 *   workspace);
 * - Dynamic values: the assignment RHS is a dynamic expression (call /
 *   attribute chain / literal), or the alias target (the Y of `X = Y`) is not
 *   statically decidable in this file -> dynamic-value;
 * - Missing implementation: module not resolved / symbol undefined ->
 *   module-not-found/symbol-not-found;
 * - Malformed: a value that is not two segments errors at engine load time ->
 *   malformed (presented honestly, no binding faked).
 *
 * Pure logic layer, does not import vscode.
 */

import { implFileHasContractMethod, USER_TYPE_CONTRACT_METHODS, type UserTypeContractMethod } from './userTypeContract';

/** Symbol forms for which a binding holds (the engine's three legal GetAttrString forms). */
export type ImplementedByForm = 'class' | 'function' | 'object';

/** Collection-side module candidates (real import order: at the same root, a package directory beats a same-named file). */
export interface ImplementedByCandidate {
  filePath: string;
  source: string;
  /** package = `__init__.py` (package module); module = a same-named .py file module. */
  kind: 'module' | 'package';
}

export type ImplementedByContractMethods = Record<UserTypeContractMethod, boolean>;

/** Binding ruling: bound = the binding holds (form/location/contract); unbound = unknown kept (with a reason). */
export interface ImplementedByBinding {
  status: 'bound' | 'unbound';
  /** Bound symbol form (class/function/object). */
  form?: ImplementedByForm;
  /** File path of the winning module candidate. */
  modulePath?: string;
  /** Module form (package/file). */
  moduleKind?: 'module' | 'package';
  /** Symbol definition line (1-based human-readable line number). */
  symbolLine?: number;
  /** object face: alias source name (the Y of `X = Y`, defined exactly once in this file as class/def). */
  aliasedFrom?: string;
  /** Presence of the three contract methods (file-level scan, GEN-DEF-1e same convention). */
  contract: ImplementedByContractMethods;
  /** unbound reason. */
  reason?: ImplementedByUnboundReason;
  /** unbound evidence fragment (duplicate definition lines / candidate root count etc., for presentation). */
  reasonDetail?: string;
}

export type ImplementedByUnboundReason =
  | 'malformed'
  | 'module-not-found'
  | 'ambiguous-module'
  | 'symbol-not-found'
  | 'ambiguous-symbol'
  | 'dynamic-value';

/** unbound reason -> hover text (engine evidence follows in the sentence). */
const UNBOUND_REASON_TEXT: Record<ImplementedByUnboundReason, string> = {
  malformed: '引擎只认两段值 `module.symbol`(loadImplModule 按 \'.\' 拆段),该值装载即报错',
  'module-not-found': '实现模块未在 user_type 根下解析到(`.py` 或包 `__init__.py`)',
  'ambiguous-module': '实现模块在多个 user_type 根下同名并存,工程内 sys.path 序不可判,不猜',
  'symbol-not-found': '模块内未找到该符号的定义(`class`/`def`/赋值三形态)',
  'ambiguous-symbol': '符号在模块内多处定义,重名不猜',
  'dynamic-value': '符号绑定到动态表达式(或别名目标不在本文件静态可判),保留未知'
};

/** Engine two-segment split (exactly two segments, both non-empty; anything else = null, the engine errors at load). */
export function parseImplementedBy(raw: string): { module: string; symbol: string } | null {
  const parts = raw.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { module: parts[0], symbol: parts[1] };
}

/** Symbol definition site (1-based line; class/def/assignment, three forms). */
interface SymbolSite {
  kind: 'class' | 'def' | 'assign';
  line: number;
  /** RHS raw text of the assign form (line tail stripped). */
  rhs: string;
}

function scanSymbolSites(source: string, symbol: string): SymbolSite[] {
  const sites: SymbolSite[] = [];
  const lines = source.split('\n');
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const classDefRe = new RegExp(`^[ \\t]*(class|def)[ \\t]+${escaped}\\b`);
  const assignRe = new RegExp(`^[ \\t]*${escaped}[ \\t]*=[^=]`);
  for (let index = 0; index < lines.length; index += 1) {
    const classDefMatch = classDefRe.exec(lines[index]);
    if (classDefMatch) {
      sites.push({ kind: classDefMatch[1] === 'class' ? 'class' : 'def', line: index + 1, rhs: '' });
      continue;
    }
    const assignMatch = assignRe.exec(lines[index]);
    if (assignMatch) {
      const rhs = lines[index].slice(assignMatch.index + assignMatch[0].length - 1).trim();
      sites.push({ kind: 'assign', line: index + 1, rhs });
    }
  }
  return sites;
}

const BARE_NAME_RE = /^[A-Za-z_]\w*$/;

/**
 * Main binding-ruling function. candidates are the collection side's
 * candidates in real import order (package beats file): 0 = module missing;
 * >1 = cross-root duplicate names, no guessing; within the single candidate,
 * zero/multiple/one symbol definition sites are judged separately, and a
 * single site is classified by form (on the object face an alias only follows
 * one hop to a single class/def site in the same file; everything else stays
 * honestly unknown as dynamic).
 */
export function resolveImplementedByBinding(
  raw: string,
  candidates: readonly ImplementedByCandidate[]
): ImplementedByBinding {
  const parsed = parseImplementedBy(raw);
  if (!parsed) {
    return { status: 'unbound', contract: emptyContract(), reason: 'malformed' };
  }
  if (candidates.length === 0) {
    return { status: 'unbound', contract: emptyContract(), reason: 'module-not-found' };
  }
  if (candidates.length > 1) {
    return {
      status: 'unbound',
      contract: emptyContract(),
      reason: 'ambiguous-module',
      reasonDetail: `${candidates.length} 个候选:${candidates.map(candidate => candidate.filePath.split(/[\\/]/).pop()).join(', ')}`
    };
  }
  const winner = candidates[0];
  const contract = emptyContract();
  for (const method of USER_TYPE_CONTRACT_METHODS) {
    contract[method] = implFileHasContractMethod(winner.source, method);
  }

  const sites = scanSymbolSites(winner.source, parsed.symbol);
  if (sites.length === 0) {
    return { status: 'unbound', contract, reason: 'symbol-not-found' };
  }
  if (sites.length > 1) {
    return {
      status: 'unbound',
      contract,
      reason: 'ambiguous-symbol',
      reasonDetail: `${sites.length} 处定义(行 ${sites.map(site => site.line).join('/')})`
    };
  }

  const site = sites[0];
  if (site.kind === 'class') {
    return { status: 'bound', form: 'class', contract, modulePath: winner.filePath, moduleKind: winner.kind, symbolLine: site.line };
  }
  if (site.kind === 'def') {
    return { status: 'bound', form: 'function', contract, modulePath: winner.filePath, moduleKind: winner.kind, symbolLine: site.line };
  }
  // assign form: RHS is exactly a bare name and that name is defined exactly once in this file as class/def -> aliased object;
  // everything else (calls/attribute chains/literals/missing or duplicate target) stays honestly unknown as dynamic.
  const rhs = site.rhs.replace(/\s+#.*$/, '').trim();
  if (BARE_NAME_RE.test(rhs)) {
    const aliasSites = scanSymbolSites(winner.source, rhs).filter(candidate => candidate.kind !== 'assign');
    if (aliasSites.length === 1) {
      return {
        status: 'bound',
        form: 'object',
        aliasedFrom: rhs,
        contract,
        modulePath: winner.filePath,
        moduleKind: winner.kind,
        symbolLine: site.line
      };
    }
  }
  return { status: 'unbound', contract, reason: 'dynamic-value', reasonDetail: rhs ? `\`${rhs}\`` : undefined };
}

function emptyContract(): ImplementedByContractMethods {
  return { createObjFromDict: false, getDictFromObj: false, isSameType: false };
}

const FORM_LABEL: Record<ImplementedByForm, string> = {
  class: '类',
  function: '函数',
  object: '对象'
};

/** Binding section hover text (pure string; bound = real form and location, unbound = unknown reason with engine evidence). */
export function renderImplementedByBindingSection(binding: ImplementedByBinding): string {
  if (binding.status === 'bound') {
    const base = path1(binding.modulePath ?? '');
    const kindNote = binding.moduleKind === 'package' ? ',包模块' : '';
    const aliasNote = binding.aliasedFrom ? `(= \`${binding.aliasedFrom}\`)` : '';
    return [
      `**implementedBy 绑定**:\`${FORM_LABEL[binding.form ?? 'class']}\`${aliasNote} 于 \`${base}:${binding.symbolLine}\`${kindNote}`,
      ''
    ].join('\n');
  }
  const detail = binding.reasonDetail ? `(${binding.reasonDetail})` : '';
  return [`**implementedBy 绑定**:未绑定 —— ${UNBOUND_REASON_TEXT[binding.reason ?? 'module-not-found']}${detail}`, ''].join('\n');
}

function path1(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}
