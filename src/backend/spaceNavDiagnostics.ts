/**
 * SP-4: 空间/导航语义诊断(纯文本面,引擎源码取证,低误报口径)
 *
 * 三类保守检查:
 * 1) setSpaceData/delSpaceData 使用保留键 "_mapping"
 *    —— 引擎在 set/del 两路径都拒绝:spacememory.cpp:740(set)、:862(del)
 *    "key{_mapping} is protected!";_mapping 是引擎内部几何映射存储键
 *    (setGeometryPath→setSpaceData("_mapping", path),spacememory.cpp:547)。
 * 2) 文件出现 navigate/navigatePathPoints 调用但全文无 canNavigate
 *    —— 几何/导航数据未加载时 navigate 静默失败(entity.cpp:2583-2589
 *    not found navhandle → paths 为空 → navigate 返回 0 不建控制器)。
 *    canNavigate() 是引擎暴露的就绪探针(entity.cpp:2563-2576,
 *    pNavHandle==NULL 即 False);调用 navigate 却从未核验前置 → Warning。
 *    仅当文件完全没有 canNavigate 字样时才报,避免有守卫文件的噪声。
 * 3) addSpaceGeometryMapping 的 params dict 键必须是 int 字面量
 *    —— 引擎 PyDict_Next 后 PyLong_Check(key) 失败即
 *    "args(params) error!" AssertionError(spacememory.cpp:194);
 *    字符串层键({"0": "..."} )运行时必炸。仅检字典**顶层**字面量键
 *    (嵌套 dict 的字符串键引擎不校验),不猜变量/表达式求值结果。
 *
 * 纯函数,无 vscode 依赖;extension 侧转 vscode.Diagnostic 并挂
 * DiagnosticScheduler(与 receiverNone/startupScript 同一生命周期)。
 * 开关: kbengine.spaceNavDiagnostics(默认开)。
 */

import { l10nText } from '../nlsRuntime';

export const SPACE_NAV_DIAGNOSTIC_CODE = 'kbengine.spaceNav';
export const SPACE_NAV_DIAGNOSTICS_ENABLED_DEFAULT = true;

export interface SpaceNavFinding {
  /** 0 起行 */
  line: number;
  /** 0 起列(命中 token 起点) */
  start: number;
  /** 0 起列(不含,token 终点) */
  end: number;
  message: string;
  code: string;
}

const MAPPING_KEY_RE =
  /\b(?:setSpaceData|delSpaceData)\s*\(\s*[^,)]+,\s*("|')_mapping\1/g;
// 只认 self.navigate / self.navigatePathPoints(引擎实体方法调用约定);
// 任意对象(avatar.navigate 等)不当作引擎方法,避免无关告警。
const NAV_CALL_RE = /\bself\s*\.\s*(navigate|navigatePathPoints)\s*\(/g;
const CAN_NAVIGATE_RE = /\bcanNavigate\b/g;

/**
 * dict 体内的**顶层**引号键(嵌套 dict/list 里的不收):返回 [体偏移, 原文
 * token]。引擎 PyDict_Next 只见顶层键(spacememory.cpp:194 只查顶层),
 * 嵌套 {"a": 1} 的字符串键不是 params 键。逐字符扫描:字符串整体跳过
 * (含转义),闭引号后跳空白紧跟 `:` 且深度为 0 才算键位。
 */
function topLevelQuotedKeys(body: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let depth = 0;
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === ch) {
          break;
        }
        j += 1;
      }
      if (j >= n) {
        return out; // 未闭合:保守收手
      }
      const token = body.slice(i, j + 1);
      let k = j + 1;
      while (k < n && /\s/.test(body[k])) {
        k += 1;
      }
      if (depth === 0 && k < n && body[k] === ':') {
        out.push([i, token]);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
    i += 1;
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** 全文偏移 → 行内列(0 基):减该行起始偏移。 */
function offsetToCol(starts: readonly number[], offset: number): number {
  return offset - starts[offsetToLine(starts, offset)];
}

/**
 * 纯文本词法掩码:true=该位置在代码区(非注释/字符串)。
 * 供空间导航匹配过滤——注释/字符串里的 navigate/canNavigate 字样不参与
 * 语义判定,避免无关告警。逐字符状态机:行注释 #、单/双引号字符串(含三引号)。
 */
function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true);
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '#') {
      // 行注释:到行尾(不含换行)
      while (i < n && text[i] !== '\n') {
        mask[i] = false;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      const triple = text[i + 1] === q && text[i + 2] === q;
      mask[i] = false;
      i += 1;
      if (triple) {
        mask[i] = false;
        i += 1;
        mask[i] = false;
        i += 1;
      }
      while (i < n) {
        mask[i] = false;
        if (text[i] === '\\') {
          i += 1;
          if (i < n) {
            mask[i] = false;
            i += 1;
          }
          continue;
        }
        if (triple) {
          if (text[i] === q && text[i + 1] === q && text[i + 2] === q) {
            mask[i] = false;
            mask[i + 1] = false;
            mask[i + 2] = false;
            i += 3;
            break;
          }
        } else if (text[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return mask;
}

/**
 * 找到 addSpaceGeometryMapping 调用里 params 位置的 dict 字面量区间。
 * 策略:从调用开括号起做括号深度扫描,跳过字符串;遇到 depth==1 的
 * `{` 即 params dict(引擎签名第 5 参;无 dict 则返回 null)。
 * 返回 [dictOpen, dictClose] 字符下标(含括号)。
 */
function findParamsDictSpan(text: string, callOpen: number): [number, number] | null {
  let depth = 0;
  let inString: string | null = null;
  let dictOpen = -1;
  for (let i = callOpen; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      if (ch === '{' && depth === 1 && dictOpen < 0) {
        dictOpen = i;
      }
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // 调用闭合;若 dict 未闭合则无效
        if (dictOpen >= 0) {
          return null;
        }
        return null;
      }
      if (ch === '}' && dictOpen >= 0 && depth === 1) {
        return [dictOpen, i];
      }
    }
  }
  return null;
}

export function computeSpaceNavFindings(text: string): SpaceNavFinding[] {
  if (!text) {
    return [];
  }
  const findings: SpaceNavFinding[] = [];
  const starts = lineStarts(text);
  const mask = codeMask(text);
  const inCode = (offset: number): boolean => offset >= 0 && offset < mask.length && mask[offset];

  // ── 1) _mapping 保留键 ──
  MAPPING_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAPPING_KEY_RE.exec(text)) !== null) {
    if (!inCode(match.index)) continue; // 调用在注释/字符串里 → 不报
    const keyToken = match[0];
    // 命中位置落在 "_mapping" 上
    const keyOffset = match.index + keyToken.lastIndexOf(match[1] + '_mapping' + match[1]);
    const keyLen = '_mapping'.length + 2;
    findings.push({
      line: offsetToLine(starts, keyOffset),
      start: offsetToCol(starts, keyOffset),
      end: offsetToCol(starts, keyOffset) + keyLen,
      message: l10nText(
        'The key "_mapping" is an engine reserved key (rejected by both set and del, runtime AssertionError "key{_mapping} is protected!"). Space geometry is managed by addSpaceGeometryMapping; use another key. (spacememory.cpp:740/862)'
      ),
      code: SPACE_NAV_DIAGNOSTIC_CODE
    });
  }

  // ── 2) self.navigate / self.navigatePathPoints 无 canNavigate 前置 ──
  let hasCanNavigate = false;
  CAN_NAVIGATE_RE.lastIndex = 0;
  let guardMatch: RegExpExecArray | null;
  while ((guardMatch = CAN_NAVIGATE_RE.exec(text)) !== null) {
    if (inCode(guardMatch.index)) {
      hasCanNavigate = true;
      break;
    }
  }
  if (!hasCanNavigate) {
    NAV_CALL_RE.lastIndex = 0;
    while ((match = NAV_CALL_RE.exec(text)) !== null) {
      const offset = match.index;
      if (!inCode(offset)) continue; // 注释/字符串里的调用不报
      // 方法名起点(self. 之后),用于定位列。
      const methodOffset = offset + match[0].indexOf(match[1]);
      // 审核发现:`\s*` 可跨行(self\n.navigate)——行号必须取方法名所在行,
      // 与列同源;取 self 行会把范围放到错行且列越出行尾。
      const line = offsetToLine(starts, methodOffset);
      findings.push({
        line,
        start: offsetToCol(starts, methodOffset),
        end: offsetToCol(starts, methodOffset) + match[1].length,
        message: l10nText(
          'navigate/navigatePathPoints called but canNavigate never appears: pathfinding fails silently when nav data is not loaded (paths empty, no move controller). Guard with if self.canNavigate() first. (entity.cpp:2583 not found navhandle; canNavigate entity.cpp:2563)'
        ),
        code: SPACE_NAV_DIAGNOSTIC_CODE
      });
    }
  }

  // ── 3) params dict 引号键(非 int 字面量) ──
  const mappingCallRe = /\baddSpaceGeometryMapping\s*\(/g;
  while ((match = mappingCallRe.exec(text)) !== null) {
    if (!inCode(match.index)) continue; // 调用在注释/字符串里 → 不报
    const callOpen = match.index + match[0].length - 1;
    const span = findParamsDictSpan(text, callOpen);
    if (!span) {
      continue;
    }
    const [dictOpen, dictClose] = span;
    const dictBody = text.slice(dictOpen + 1, dictClose);
    // 审核发现:引擎只校验 params **顶层**键(PyDict_Next 收到的就是顶层键,
    // spacememory.cpp:194),嵌套 dict 的字符串键不校验——旧实现对整个 dict 体
    // 正则扫描,`{0: {"a": 1}}` 里嵌套键 "a" 被误报。深度感知只收顶层键位。
    for (const [bodyOffset, token] of topLevelQuotedKeys(dictBody)) {
      const keyOffset = dictOpen + 1 + bodyOffset;
      const keyLen = token.length;
      const line = offsetToLine(starts, keyOffset);
      findings.push({
        line,
        start: offsetToCol(starts, keyOffset),
        end: offsetToCol(starts, keyOffset) + keyLen,
        message: l10nText(
          'params-level key {key} is a string literal; the engine requires int keys (PyLong_Check failure raises AssertionError "args(params) error!"). Write {0: "xx.navmesh"}. (spacememory.cpp:194)',
          { key: token }
        ),
        code: SPACE_NAV_DIAGNOSTIC_CODE
      });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.start - b.start);
  return findings;
}
