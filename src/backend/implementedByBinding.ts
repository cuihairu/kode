/**
 * KSEM-STRUCT-06:implementedBy 绑定解析(引擎 loadImplModule 真形)。
 *
 * 引擎真形(datatype.cpp loadImplModule L2331-2357):值按 '.' 拆必须恰好
 * 两段 moduleName.symbolName——ImportModule(前段)+ GetAttrString(后段),
 * 按属性名取,不要求 class(class/def/赋值三形态皆可)。三契约方法
 * (setImplModule L2383-2397)复用 GEN-DEF-1e 同一真源
 * (userTypeContract.implFileHasContractMethod),零新表。
 *
 * 真实导入面:Python import 机制下 `module.py` 与 `module/__init__.py`
 * 同名并存时**包目录胜出**(CPython FileFinder 包优先,本地 python3 实测),
 * 采集侧按此序出候选;绑定只在模块真可解析(存在)且符号真有定义时成立。
 *
 * 验收边界(保留未知,绝不猜):
 * - 重名:同文件同符号多处定义(ambiguous-symbol)/跨 user_type 根同名
 *   模块并存(ambiguous-module,sys.path 序工程内不可判);
 * - 动态返回:赋值 RHS 是调用/属性链/字面量等动态表达式,或别名目标
 *   (`X = Y` 的 Y)在本文件不可静态判定 → dynamic-value;
 * - 缺实现:模块未解析到/符号无定义 → module-not-found/symbol-not-found;
 * - 形态:非两段值引擎装载即报错 → malformed(如实呈现,不装绑定)。
 *
 * 纯逻辑层,不 import vscode。
 */

import { implFileHasContractMethod, USER_TYPE_CONTRACT_METHODS, type UserTypeContractMethod } from './userTypeContract';

/** 绑定成立的符号形态(引擎 GetAttrString 三合法形态)。 */
export type ImplementedByForm = 'class' | 'function' | 'object';

/** 采集侧模块候选(真实导入序:同根包目录胜过同名文件)。 */
export interface ImplementedByCandidate {
  filePath: string;
  source: string;
  /** package=`__init__.py`(包模块);module=同名 .py 文件模块。 */
  kind: 'module' | 'package';
}

export type ImplementedByContractMethods = Record<UserTypeContractMethod, boolean>;

/** 绑定裁定:bound=绑定成立(形态/落点/契约);unbound=保留未知(原因)。 */
export interface ImplementedByBinding {
  status: 'bound' | 'unbound';
  /** 绑定符号形态(class/function/object)。 */
  form?: ImplementedByForm;
  /** 胜出模块候选文件路径。 */
  modulePath?: string;
  /** 模块形态(包/文件)。 */
  moduleKind?: 'module' | 'package';
  /** 符号定义行(1 基人读行号)。 */
  symbolLine?: number;
  /** object 面:别名来源名(`X = Y` 的 Y,本文件 class/def 单处定义)。 */
  aliasedFrom?: string;
  /** 三契约方法存在性(文件级扫描,GEN-DEF-1e 同口径)。 */
  contract: ImplementedByContractMethods;
  /** unbound 原因。 */
  reason?: ImplementedByUnboundReason;
  /** unbound 证据段(重名行列/候选根数等,呈现用)。 */
  reasonDetail?: string;
}

export type ImplementedByUnboundReason =
  | 'malformed'
  | 'module-not-found'
  | 'ambiguous-module'
  | 'symbol-not-found'
  | 'ambiguous-symbol'
  | 'dynamic-value';

/** unbound 原因 → 悬停文案(引擎依据随句)。 */
const UNBOUND_REASON_TEXT: Record<ImplementedByUnboundReason, string> = {
  malformed: '引擎只认两段值 `module.symbol`(loadImplModule 按 \'.\' 拆段),该值装载即报错',
  'module-not-found': '实现模块未在 user_type 根下解析到(`.py` 或包 `__init__.py`)',
  'ambiguous-module': '实现模块在多个 user_type 根下同名并存,工程内 sys.path 序不可判,不猜',
  'symbol-not-found': '模块内未找到该符号的定义(`class`/`def`/赋值三形态)',
  'ambiguous-symbol': '符号在模块内多处定义,重名不猜',
  'dynamic-value': '符号绑定到动态表达式(或别名目标不在本文件静态可判),保留未知'
};

/** 引擎两段拆分(恰好两段且皆非空;其余 null=引擎装载即报错)。 */
export function parseImplementedBy(raw: string): { module: string; symbol: string } | null {
  const parts = raw.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { module: parts[0], symbol: parts[1] };
}

/** 符号定义点(行 1 基;class/def/赋值三形态)。 */
interface SymbolSite {
  kind: 'class' | 'def' | 'assign';
  line: number;
  /** assign 形态的 RHS 原文(剥行尾)。 */
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
 * 绑定裁定主函数。candidates 为采集侧按真实导入序(包胜文件)产出的候选:
 * 0=模块缺失;>1=跨根重名不猜;唯一候选内符号定义点 0/多/单分判,单点按
 * 形态分类(object 面别名只追同文件单点 class/def 一跳,其余动态保留未知)。
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
  // assign 形态:RHS 恰为裸名且该名在本文件 class/def 单处定义 → 别名对象;
  // 其余(调用/属性链/字面量/目标缺失或重名)一律动态保留未知。
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

/** 绑定段悬停文案(纯字符串;bound=真形落点,unbound=未知原因随引擎依据)。 */
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
