/**
 * C-23 交付②:首批行为知识 lint 规则(接入既有诊断体系)。三条规则全部
 * 纯函数(掩码文本 + 可选解析),消息文案与「依据」从 src/behaviorKnowledge.ts
 * 结构化条目取(单一事实源,与 hover 注记同源):
 *
 * 1. fixed-dict-nested-mutation:FIXED_DICT 属性子键赋值只改本地 pyDict_
 *    (fixeddict.cpp:272 mp_ass_subscript 无 owner 通知面),不触发属性同步;
 *    顶层赋值才走同步 → warning + 整体重赋习语 CodeAction(交付②);
 *    类型判定复用类型图(getCustomTypeInfos aliasType===FIXED_DICT_TYPE_NAME,与
 *    pythonTypeStubs 同款判定,不另写一份映射)。
 * 2. destroyed-entity-reference:实体引用(self)注册进模块级容器而无
 *    onDestroy 移除(KB 内存专题:garbages/3600s 泄漏)→ warning。
 * 3. timer-leak-on-destroy:模块级 KBEngine.addTimer(interval, repeat,
 *    callback) 自绑定回调(repeat≠0 字面量)且本类 onDestroy 无
 *    KBEngine.delTimer → warning。**实体级 self.addTimer 绝不报**——destroy()
 *    全量取消(cellapp/entity.cpp:4002),报它就是与知识基线相反的误报。
 *
 * 如实边界(不猜、不静默装全量):
 * - 规则 1 只认单行 `self.<prop>[...] = / <op>=` 直接形态;局部别名
 *   (`d = self.p` 后 `d['k'] = v`)与跨行下标不检测。
 * - 规则 2 只认同文件模块级容器名(模块级 `NAME =` 赋值);import 进来的
 *   容器/函数形参容器不检测;移除语句须文本上位于本类 onDestroy 体内。
 * - 规则 3 只认 `KBEngine.addTimer(...)` 点名形态;`from KBEngine import
 *   addTimer` 别名形态与跨行调用不检测。
 */
import {
  behaviorEntryByCode,
  FIXED_DICT_NESTED_MUTATION_CODE,
  DESTROYED_ENTITY_REFERENCE_CODE,
  TIMER_LEAK_ON_DESTROY_CODE
} from '../behaviorKnowledge';

/** 稳定诊断 code(knowledge 条目同源;消费方(extension/测试)从本模块取) */
export {
  FIXED_DICT_NESTED_MUTATION_CODE,
  DESTROYED_ENTITY_REFERENCE_CODE,
  TIMER_LEAK_ON_DESTROY_CODE
} from '../behaviorKnowledge';
import type { PropertyDefinitionInfo } from '../entityMapping';
import type { CustomTypeInfo } from '../definitionWorkspace';
import type { ParsedPythonFile } from './pythonParser';
import { maskPythonNonCode } from './pythonLexicalMask';
import { parsePythonFile } from './pythonParser';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';

/** 行为 lint 诊断项(纯数据;extension 侧转 vscode.Diagnostic) */
export interface BehaviorLintFinding {
  /** 0 起行 */
  line: number;
  /** 0 起列(token 起) */
  character: number;
  /** token 长度(诊断 range 宽) */
  length: number;
  /** 稳定 code(knowledge 条目 detection.code 同源) */
  code: string;
  message: string;
}

/** 条目驱动的消息(现象 + 正确姿势 + 依据;与 hover 注记同源) */
function findingMessage(code: string, subject: string): string {
  const entry = behaviorEntryByCode(code);
  if (!entry) {
    return subject;
  }
  return `${subject}:${entry.symptomZh}。正确姿势:${entry.fixZh}。(依据:${entry.sources.join('; ')})`;
}

const COMMENT_ONLY = /^\s*(#.*)?$/;

/** 顶层(括号深度 0)按逗号切分(实参切分;掩码行内字符串已空白) */
function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && char === ',') {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** ---------------------------------------------------------------------
 * FIXED_DICT 根属性名集:def 属性直文本类型名(未展开别名)经类型图
 * (getCustomTypeInfos)下钻到 aliasType===FIXED_DICT_TYPE_NAME。组件槽成员与
 * FIXED_DICT 子键条目(propertyPath 含 '.')不进集合(各自另有访问面)。
 */
/** 直文本 FIXED_DICT 或类型图(别名)下钻到 FIXED_DICT 的判定(hover/诊断共用) */
export function isFixedDictTypeName(
  typeName: string | null | undefined,
  customTypeInfos: readonly CustomTypeInfo[]
): boolean {
  const trimmed = typeName?.trim();
  if (!trimmed) { return false; }
  return trimmed === FIXED_DICT_TYPE_NAME
    || customTypeInfos.some(info => info.name === trimmed && info.aliasType === FIXED_DICT_TYPE_NAME);
}

export function fixedDictRootPropertyNames(
  properties: readonly PropertyDefinitionInfo[] | null | undefined,
  customTypeInfos: readonly CustomTypeInfo[]
): Set<string> {
  const byName = new Map(customTypeInfos.map(info => [info.name, info]));
  const names = new Set<string>();
  for (const property of properties ?? []) {
    const typeName = property.typeName?.trim();
    if (!typeName) { continue; }
    if (property.identity.componentSlotName) { continue; }
    if ((property.identity.propertyPath ?? '').includes('.')) { continue; }
    // 直文本 FIXED_DICT(未走别名)或类型图下钻到 aliasType FIXED_DICT 都命中
    if (typeName === FIXED_DICT_TYPE_NAME || byName.get(typeName)?.aliasType === FIXED_DICT_TYPE_NAME) {
      names.add(property.identity.symbolName);
    }
  }
  return names;
}

/** 规则 1:`self.<FIXED_DICT属性>[子键] = 值` / `<op>=`(掩码行,单行形态) */
const SELF_SUBSCRIPT_STORE = /\bself\.([A-Za-z_]\w*)\s*\[/g;
const AUGMENTED_ASSIGN = /^(?:\*\*|\/\/|>>|<<|[+\-*/%&|^])?=/;

/**
 * 从首个 `[` 起消费整段下标串(支持链式 `['a']['b']`,段间空白),返回最后
 * 一个 `]` 之后的位置;跨行/未闭合返回 -1(如实边界:不检测)。
 */
function consumeSubscriptChain(line: string, openIndex: number): number {
  let index = openIndex;
  let end = -1;
  while (index < line.length) {
    if (line[index] !== '[') { break; }
    let depth = 0;
    let closed = false;
    for (let j = index; j < line.length; j += 1) {
      const char = line[j];
      if (char === '[' || char === '(' || char === '{') { depth += 1; continue; }
      if (char === ']' || char === ')' || char === '}') {
        depth -= 1;
        if (depth === 0 && char === ']') { end = j + 1; closed = true; break; }
        if (depth <= 0 && char !== ']') { return -1; } // 异形配平(内部括号),放弃
      }
    }
    if (!closed) { return -1; }
    index = end;
    while (index < line.length && /\s/.test(line[index])) { index += 1; }
  }
  return end;
}

export function computeFixedDictNestedMutationFindings(
  maskedText: string,
  fixedDictPropertyNames: ReadonlySet<string>
): BehaviorLintFinding[] {
  if (fixedDictPropertyNames.size === 0) { return []; }
  const findings: BehaviorLintFinding[] = [];
  const lines = maskedText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    SELF_SUBSCRIPT_STORE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SELF_SUBSCRIPT_STORE.exec(line)) !== null) {
      const propertyName = match[1];
      if (!fixedDictPropertyNames.has(propertyName)) { continue; }
      const chainEnd = consumeSubscriptChain(line, match.index + match[0].length - 1);
      if (chainEnd === -1) { continue; }
      const after = line.slice(chainEnd);
      const assignment = /^\s*/.exec(after)![0].length;
      const rest = after.slice(assignment);
      const opMatch = AUGMENTED_ASSIGN.exec(rest);
      if (!opMatch || rest[opMatch[0].length] === '=') { continue; } // == 比较不算
      findings.push({
        line: i,
        character: match.index + 5,
        length: propertyName.length,
        code: FIXED_DICT_NESTED_MUTATION_CODE,
        message: findingMessage(
          FIXED_DICT_NESTED_MUTATION_CODE,
          `FIXED_DICT 属性 \`${propertyName}\` 的子键赋值不会触发同步`
        )
      });
    }
  }
  return findings;
}

/** 类体内方法界(0 起行,含尾):方法行升序,后继方法行-1 封顶到类体界 */
interface MethodSpan { startLine: number; endLine: number; name: string; }

function methodSpansOf(parsed: ParsedPythonFile): Array<{ classSpan: { startLine: number; endLine: number }; methods: MethodSpan[] }> {
  return parsed.classes.map(cls => {
    const starts = [...cls.methods.entries()]
      .map(([name, loc]) => ({ name, startLine: loc.line }))
      .sort((left, right) => left.startLine - right.startLine);
    return {
      classSpan: { startLine: cls.startLine, endLine: cls.endLine },
      methods: starts.map((entry, i) => ({
        name: entry.name,
        startLine: entry.startLine,
        endLine: i + 1 < starts.length ? starts[i + 1].startLine - 1 : cls.endLine - 1
      }))
    };
  });
}

/** 模块级容器名:类体之外、0 缩进的 `NAME =` / `NAME: 标注 =` 赋值目标 */
const MODULE_LEVEL_ASSIGN = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/;

function moduleLevelContainerNames(maskedText: string, parsed: ParsedPythonFile): Set<string> {
  const names = new Set<string>();
  const lines = maskedText.split(/\r?\n/);
  const inClass = new Array<boolean>(lines.length).fill(false);
  for (const cls of parsed.classes) {
    for (let i = Math.max(0, cls.startLine); i < Math.min(lines.length, cls.endLine); i += 1) {
      inClass[i] = true;
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (inClass[i]) { continue; }
    const match = MODULE_LEVEL_ASSIGN.exec(lines[i]);
    if (match) { names.add(match[1]); }
  }
  return names;
}

/** 规则 2:`self` 注册进模块级容器(append/add/insert/setdefault/下标存) */
const REGISTER_CALL = /\b([A-Za-z_]\w*)\.(?:append|add|insert|setdefault|push)\(\s*self\b\s*[,)]/;
const REGISTER_SUBSCRIPT = /\b([A-Za-z_]\w*)\[[^\]\n]*\]\s*=(?!=)\s*self\s*$/;
/** onDestroy 内的移除形态:remove/discard/pop 调用或 del NAME[...] */
const removalPatterns = (name: string): RegExp[] => [
  new RegExp(`\\b${name}\\.(?:remove|discard|pop|removeEntity|unregister)\\s*\\(`),
  new RegExp(`^\\s*del\\s+${name}\\s*\\[`)
];

export function computeDestroyedEntityReferenceFindings(
  maskedText: string,
  parsed: ParsedPythonFile
): BehaviorLintFinding[] {
  const containerNames = moduleLevelContainerNames(maskedText, parsed);
  if (containerNames.size === 0) { return []; }
  const lines = maskedText.split(/\r?\n/);
  const findings: BehaviorLintFinding[] = [];
  for (const { methods } of methodSpansOf(parsed)) {
    // 本类注册行(按容器名记账),onDestroy 体内的移除按名抵消
    const registrations = new Map<string, Array<{ line: number; character: number }>>();
    let onDestroySpan: MethodSpan | undefined;
    for (const method of methods) {
      if (method.name === 'onDestroy') {
        onDestroySpan = method;
        continue;
      }
      for (let i = method.startLine; i <= method.endLine && i < lines.length; i += 1) {
        const text = lines[i];
        if (COMMENT_ONLY.test(text)) { continue; }
        // 非全局正则:每行首个注册形态(同行多注册是异态,单点足以提醒)
        const call = REGISTER_CALL.exec(text);
        if (call && containerNames.has(call[1])) {
          const list = registrations.get(call[1]) ?? [];
          list.push({ line: i, character: call.index });
          registrations.set(call[1], list);
        }
        const subscript = REGISTER_SUBSCRIPT.exec(text);
        if (subscript && containerNames.has(subscript[1])) {
          const list = registrations.get(subscript[1]) ?? [];
          list.push({ line: i, character: subscript.index });
          registrations.set(subscript[1], list);
        }
      }
    }
    if (registrations.size === 0) { continue; }
    const removed = new Set<string>();
    if (onDestroySpan) {
      for (let i = onDestroySpan.startLine; i <= onDestroySpan.endLine && i < lines.length; i += 1) {
        const text = lines[i];
        for (const name of registrations.keys()) {
          if (removalPatterns(name).some(pattern => pattern.test(text))) {
            removed.add(name);
          }
        }
      }
    }
    for (const [name, sites] of registrations) {
      if (removed.has(name)) { continue; }
      for (const site of sites) {
        findings.push({
          line: site.line,
          character: site.character,
          length: name.length,
          code: DESTROYED_ENTITY_REFERENCE_CODE,
          message: findingMessage(
            DESTROYED_ENTITY_REFERENCE_CODE,
            `\`self\` 注册进模块级容器 \`${name}\` 而本类 \`onDestroy\` 未移除——已销毁实体会被持续持有`
          )
        });
      }
    }
  }
  return findings;
}

/** 规则 3:模块级 KBEngine.addTimer 自绑定回调泄漏(实体级 self.addTimer 永不报) */
const KBENGINE_ADD_TIMER = /\bKBEngine\.addTimer\s*\(/g;
const SINGLE_SHOT_REPEAT = /^0(?:\.0+)?$/;

export function computeTimerLeakOnDestroyFindings(
  maskedText: string,
  parsed: ParsedPythonFile
): BehaviorLintFinding[] {
  const lines = maskedText.split(/\r?\n/);
  const findings: BehaviorLintFinding[] = [];
  const allSpans = methodSpansOf(parsed);
  KBENGINE_ADD_TIMER.lastIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    KBENGINE_ADD_TIMER.lastIndex = 0;
    while ((match = KBENGINE_ADD_TIMER.exec(line)) !== null) {
      // 实参括号配平(仅本行;跨行调用不检测,如实边界)
      const argsOpen = match.index + match[0].length - 1;
      let depth = 0;
      let closeIndex = -1;
      for (let j = argsOpen; j < line.length; j += 1) {
        const char = line[j];
        if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
        if (char === ')' || char === ']' || char === '}') {
          depth -= 1;
          if (depth === 0) { closeIndex = j; break; }
        }
      }
      if (closeIndex === -1) { continue; }
      const args = splitTopLevelArgs(line.slice(argsOpen + 1, closeIndex));
      if (args.length < 2) { continue; }
      const repeatArg = args[1].trim();
      if (SINGLE_SHOT_REPEAT.test(repeatArg)) { continue; } // 单发自释放
      const selfBound = args.some(arg => /\bself\.\w/.test(arg));
      if (!selfBound) { continue; }
      // 类外调用点 self 绑定不成立(staticmethod/模块层),保守不报
      const enclosingIndex = parsed.classes.findIndex(
        cls => i >= cls.startLine && i < cls.endLine
      );
      if (enclosingIndex === -1) { continue; }
      // 本类 onDestroy 有 KBEngine.delTimer 即视为已管理
      const onDestroy = allSpans[enclosingIndex].methods.find(method => method.name === 'onDestroy');
      if (onDestroy) {
        let managed = false;
        for (let j = onDestroy.startLine; j <= onDestroy.endLine && j < lines.length; j += 1) {
          if (/\bKBEngine\.delTimer\s*\(/.test(lines[j])) { managed = true; break; }
        }
        if (managed) { continue; }
      }
      findings.push({
        line: i,
        character: match.index,
        length: 'KBEngine.addTimer'.length,
        code: TIMER_LEAK_ON_DESTROY_CODE,
        message: findingMessage(
          TIMER_LEAK_ON_DESTROY_CODE,
          '模块级 `KBEngine.addTimer` 自绑定回调(repeat≠0)且本类 `onDestroy` 未 `KBEngine.delTimer`'
        )
      });
    }
  }
  return findings;
}

/** 规则 2/3 的廉价预检(无命中不解析;有命中才需要 ParsedPythonFile) */
const DESTROYED_ENTITY_REFERENCE_HINT =
  /\.\s*(?:append|add|insert|setdefault|push)\s*\(\s*self\b|\[[^\]\n]*\]\s*=(?!=)\s*self\s*$/m;
const TIMER_LEAK_HINT = /\bKBEngine\.addTimer\s*\(/;

/** 惰性解析提供器(诊断入口把共享解析传进来;null=本轮不可用) */
export type BehaviorParsedProvider =
  | ParsedPythonFile
  | null
  | (() => ParsedPythonFile | null | Promise<ParsedPythonFile | null>);

/** 三规则配置开关默认值(package.json 同步;规则粒度各自可关) */
export const BEHAVIOR_LINT_DIAGNOSTICS_ENABLED_DEFAULT = true;

export interface BehaviorLintOptions {
  /** 三规则各自开关(默认全开;配置面逐规则可关,验收口径) */
  fixedDictNestedMutationEnabled?: boolean;
  destroyedEntityReferenceEnabled?: boolean;
  timerLeakOnDestroyEnabled?: boolean;
  /** FIXED_DICT 根属性名集(规则 1;空集=无该类型属性,零产出) */
  fixedDictPropertyNames?: ReadonlySet<string>;
  /** 解析(规则 2/3 类界/方法界);缺省自行 parsePythonFile */
  parsed?: BehaviorParsedProvider;
}

/** 规则 2/3 需要(预检命中时)解析;统一走这里(惰性 + 可 null) */
async function resolveParsed(
  text: string,
  filePath: string,
  provider: BehaviorParsedProvider | undefined
): Promise<ParsedPythonFile | null> {
  if (typeof provider === 'function') { return provider(); }
  if (provider !== undefined) { return provider; }
  return parsePythonFile(text, filePath);
}

/**
 * 行为 lint 全量计算(三规则一次,掩码/解析共享)。返回 null=本轮解析
 * 不可用且规则 2/3 有预检命中(中止本轮,不把部分结果当全量——与
 * receiverNone 中止语义同款);规则 2/3 预检全空时无解析需求,规则 1
 * 独立于解析照常产出。
 */
export async function computeBehaviorLintFindingsAsync(
  text: string,
  filePath: string,
  options: BehaviorLintOptions = {}
): Promise<BehaviorLintFinding[] | null> {
  const {
    fixedDictNestedMutationEnabled = true,
    destroyedEntityReferenceEnabled = true,
    timerLeakOnDestroyEnabled = true,
    fixedDictPropertyNames = new Set<string>(),
    parsed
  } = options;
  const masked = maskPythonNonCode(text);
  const findings: BehaviorLintFinding[] = [];
  if (fixedDictNestedMutationEnabled) {
    findings.push(...computeFixedDictNestedMutationFindings(masked, fixedDictPropertyNames));
  }
  const destroyedHint = destroyedEntityReferenceEnabled
    && DESTROYED_ENTITY_REFERENCE_HINT.test(masked);
  const timerHint = timerLeakOnDestroyEnabled && TIMER_LEAK_HINT.test(masked);
  if (!destroyedHint && !timerHint) {
    return findings;
  }
  const resolved = await resolveParsed(text, filePath, parsed);
  if (!resolved) {
    // 解析不可用但确有候选形态:整轮中止(不把部分结果当全量发布)
    return null;
  }
  if (destroyedHint) {
    findings.push(...computeDestroyedEntityReferenceFindings(masked, resolved));
  }
  if (timerHint) {
    findings.push(...computeTimerLeakOnDestroyFindings(masked, resolved));
  }
  return findings;
}

/** ---------------------------------------------------------------------
 * 整体重赋习语编辑(交付② CodeAction 纯函数):
 * `self.p['k'] = v` → `_fd = self.p` / `_fd['k'] = v` / `self.p = _fd`
 * (顶层赋值才走同步的引擎语义;临时名 `_fd` 与行缩进原文保持)。
 */
export interface FixedDictWholeReassignEdit {
  /** 替换起点行(0 起,含) */
  startLine: number;
  /** 替换终点行(0 起,不含) */
  endLine: number;
  /** 替换文本(三行,无尾换行) */
  text: string;
}

const SUBSCRIPT_STORE_LINE = /^([ \t]*)(self\.[A-Za-z_]\w*)((?:\s*\[[^\]\n]*\]\s*)+)(?:(\*\*|\/\/|>>|<<|[+\-*/%&|^]))?=(?!=)(.*)$/;

export function buildFixedDictWholeReassignEdit(
  text: string,
  line: number
): FixedDictWholeReassignEdit | null {
  if (!text || line < 0) { return null; }
  const lines = text.split(/\r?\n/);
  const source = lines[line];
  if (source === undefined || !source.trim()) { return null; }
  const match = SUBSCRIPT_STORE_LINE.exec(source);
  if (!match) { return null; }
  const [, indent, base, subscripts, operator, rhs] = match;
  const suffix = subscripts.replace(/\s+$/, '');
  const tail = rhs.trim();
  return {
    startLine: line,
    endLine: line + 1,
    text: [
      `${indent}_fd = ${base}`,
      `${indent}_fd${suffix} ${operator ?? ''}= ${tail}`,
      `${indent}${base} = _fd`
    ].join('\n')
  };
}
