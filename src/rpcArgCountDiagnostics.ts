import type { EntityMapping } from './entityMapping';
import {
  PYTHON_RECEIVER_SECTIONS,
  findPythonReceiverCalls,
  type PythonReceiverCall
} from './pythonLanguageUtils';
import { maskPythonNonCode } from './pythonLexicalMask';

/**
 * RPC 参数数量 lint(IDE-LINT-008,用户令 2026-11-06;KBE-PY-009 诊断面):
 * self.base/cell/client.<method>(...) 调用按调用点顶层实参数与 .def 方法
 * 声明的 <Arg> 数对账,明确数量不符才报 Warning。
 *
 * 关键口径(与验收「星号参数/动态接收者及声明未就绪保留未知」一致):
 * - 声明未就绪:该实体/根映射里查不到该方法声明、或该方法声明的 Arg 数
 *   各来源不一致(同名跨实体/组件多来源)→ 未知,不报。
 * - 段错配:方法在别的 section 声明(经当前接收者侧调用不会路由到)→ 由
 *   sectionMismatch 单独报,此处不重复;同一 section 才按 Arg 数对账。
 * - 星号参数:调用点顶层任一实参段首以 `*` 开头(解包/收集)或声明 Arg
 *   直文本以 `*` 开头 → 数量不可判定,未知,不报。(顶层 `a * b` 的二元
 *   乘法星号不触发——只认实参段首星号;嵌套括号内的星号不影响外层计数。)
 * - 跨行调用可计数(括号深度跨行扫到配对 `)`);括号不闭合到文件尾 →
 *   未知,不报。动态接收者(非 self.<role>.<name> 形态)本就不在发现面,
 *   天然未知。inlay 提示不替代诊断:此处独立产出诊断,与 inlay 同数据源
 *   但不同面。
 */

/** 诊断稳定 code(B-7 纪律:快速修复/测试按 code 对账) */
export const RPC_ARG_COUNT_DIAGNOSTIC_CODE = 'kbengine.rpcArgCount';

/** 开关默认值(用户令:默认开启,与同族诊断一致) */
export const RPC_ARG_COUNT_DIAGNOSTICS_ENABLED_DEFAULT = true;

export interface RpcArgCountFinding {
  /** 0 起行(方法名 token 所在行) */
  line: number;
  /** 0 起列(方法名 token 起) */
  character: number;
  methodName: string;
  receiver: PythonReceiverCall['receiver'];
  /** .def 声明的 Arg 数(与调用点实参数的对账基准) */
  declaredCount: number;
  /** 调用点顶层实参数 */
  actualCount: number;
  message: string;
}

const CALL_OPENER_CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * 调用点顶层实参数计数;数量不可判定(星号实参/括号不闭合/方法名与 '('
 * 间有其他 token)返回 null。输入是**原始 Python 文本**(非掩码)——本扫描
 * 自带字符串/注释词法状态:字符串里的逗号/括号/星号不计,注释(# 到行尾)
 * 不计,顶层逗号即实参分隔;空括号计 0;尾随逗号不多计;跨行从 '(' 所在
 * 行扫到配对 ')' 或文件尾(未闭合 → null)。与调用点发现面(findPythonReceiver
 * Calls 走掩码)分工:发现面掩码去伪调用,计数面原文去伪分隔。
 */
export function countCallArguments(
  lines: readonly string[],
  call: PythonReceiverCall
): number | null {
  const nameEnd = call.character + call.methodName.length;
  const firstLine = lines[call.line] ?? '';

  // 方法名后同行找 '(';先出现其他非空白 token → 形态不明,未知
  let openParen = -1;
  for (let i = nameEnd; i < firstLine.length; i += 1) {
    const ch = firstLine[i];
    if (ch === '(') { openParen = i; break; }
    if (!/\s/.test(ch)) { return null; }
  }
  if (openParen === -1) { return null; }

  let count = 0;
  // 括号闭符号栈:调用自身 '(' 是根(不入栈),其内嵌套 ( [ { 才入栈;
  // 栈空时看到的 ')' 即调用闭合,栈空时看到的逗号即顶层实参分隔。
  const closerStack: string[] = [];
  let atSegmentStart = true; // 段首(括号后/逗号后)
  let segmentHasStar = false; // 段首出现 '*' → 解包/收集,数量不可判定
  let segmentHasCode = false; // 段内出现实参内容(逗号前)
  let inString: string | null = null; // 字符串定界引号;null=不在字符串
  let tripleString = false;

  for (let line = call.line; line < lines.length; line += 1) {
    const text = lines[line];
    const startCol = line === call.line ? openParen + 1 : 0;
    for (let col = startCol; col < text.length; col += 1) {
      const ch = text[col];
      // 字符串态:引号内一切字符不计(含逗号/括号/星号/注释符)
      if (inString) {
        if (ch === '\\') { col += 1; continue; }
        if (tripleString) {
          if (text.startsWith(inString.repeat(3), col)) {
            inString = null;
            tripleString = false;
            col += 2;
          }
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      // 引号进入字符串态(整个字符串是一个实参内容,不展开内部逗号)
      if (ch === '"' || ch === '\'') {
        inString = ch;
        tripleString = text.startsWith(ch.repeat(3), col);
        if (closerStack.length === 0) {
          segmentHasCode = true;
          atSegmentStart = false;
        }
        if (tripleString) { col += 2; }
        continue;
      }
      // 注释:到行尾(跳出内层循环,行首续扫)
      if (ch === '#') { break; }
      if (closerStack.length === 0) {
        if (ch === ')') {
          if (segmentHasStar) { return null; }
          if (segmentHasCode) { count += 1; }
          return count;
        }
        if (ch === ',') {
          if (segmentHasStar) { return null; }
          if (segmentHasCode) { count += 1; }
          atSegmentStart = true;
          segmentHasStar = false;
          segmentHasCode = false;
          continue;
        }
        if (ch in CALL_OPENER_CLOSER) {
          closerStack.push(CALL_OPENER_CLOSER[ch]);
          // 嵌套结构整段算一个实参内容;段内星号不影响外层计数
          segmentHasCode = true;
          atSegmentStart = false;
          continue;
        }
        if (ch === '*' && atSegmentStart) {
          segmentHasStar = true;
          continue;
        }
        if (!/\s/.test(ch)) {
          segmentHasCode = true;
          atSegmentStart = false;
        }
        continue;
      }
      // 嵌套深度 >0:只记括号配对,不参与顶层实参统计
      const top = closerStack[closerStack.length - 1];
      if (ch === top) {
        closerStack.pop();
      } else if (ch in CALL_OPENER_CLOSER) {
        closerStack.push(CALL_OPENER_CLOSER[ch]);
      }
    }
  }
  return null; // '(' 到文件尾未闭合:形态不明,未知
}

/** 声明侧:该方法在调用所属 section 的声明里,Arg 数是否可唯一确定 */
function resolveDeclaredArgCount(
  declarations: readonly { section: string; declaredArgs?: string[] }[],
  expectedSection: string
): { declaredCount: number; hasStarArg: boolean } | null {
  const matching = declarations.filter(d => d.section === expectedSection);
  if (matching.length === 0) {
    return null; // 本 section 无声明:段错配面负责,此处未知
  }
  let declaredCount: number | null = null;
  let hasStarArg = false;
  for (const declaration of matching) {
    if (declaration.declaredArgs === undefined) {
      return null; // 声明未就绪(无 Arg 信息):未知
    }
    const argCount = declaration.declaredArgs.length;
    if (declaration.declaredArgs.some(arg => arg.trim().startsWith('*'))) {
      hasStarArg = true; // 声明带星号形参:数量可变,未知
    }
    if (declaredCount === null) {
      declaredCount = argCount;
    } else if (declaredCount !== argCount) {
      return null; // 同 section 多来源 Arg 数不一致:歧义,未知
    }
  }
  if (declaredCount === null) {
    return null;
  }
  return { declaredCount, hasStarArg };
}

/**
 * 全量计算:RPC 调用点实参数与 .def <Arg> 数明确不符的 Warning。
 * 纯函数(文本 + 内存映射快照),供诊断调度器同步 compute 面调用;
 * 无映射/无调用点即空集,零额外解析。
 */
export function computeRpcArgCountFindings(
  text: string,
  mapping?: EntityMapping
): RpcArgCountFinding[] {
  if (!mapping?.methods) { return []; }
  // IDE-LINT-005 同款词法掩码:字符串/注释先行空白,列偏移不变。调用点发现
  // 面走掩码(去字符串/注释里的伪调用);实参计数面走原文(计数自带词法态,
  // 字符串里的逗号不当分隔——见 countCallArguments)。
  const masked = maskPythonNonCode(text);
  const calls = findPythonReceiverCalls(masked);
  if (calls.length === 0) { return []; }
  const lines = text.split(/\r?\n/);
  const findings: RpcArgCountFinding[] = [];
  for (const call of calls) {
    const declarations = mapping.methods[call.methodName];
    if (!declarations || declarations.length === 0) {
      continue; // 声明未就绪:未知,不报
    }
    const expectedSection = PYTHON_RECEIVER_SECTIONS[call.receiver];
    const declared = resolveDeclaredArgCount(declarations, expectedSection);
    if (!declared || declared.hasStarArg) {
      continue; // 段外声明/星号形参/歧义:未知,不报
    }
    const actualCount = countCallArguments(lines, call);
    if (actualCount === null || actualCount === declared.declaredCount) {
      continue; // 未知或数量一致:不报
    }
    const first = declarations.find(d => d.section === expectedSection);
    const where = first ? `(${first.defFile}:${first.line + 1})` : '';
    findings.push({
      line: call.line,
      character: call.character,
      methodName: call.methodName,
      receiver: call.receiver,
      declaredCount: declared.declaredCount,
      actualCount,
      message: `self.${call.receiver}.${call.methodName} 实参数量不符:.def ${expectedSection}`
        + ` 声明 ${declared.declaredCount} 个 Arg,调用给出 ${actualCount} 个${where}`
    });
  }
  return findings;
}
