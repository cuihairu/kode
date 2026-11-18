/**
 * INDEX-DISCIPLINE-001 ③:python 索引输入语法门——TS 侧(Rust 主路径 +
 * TS 回退,模式照 ruffLint 先例)。
 *
 * Rust 侧 `$/kode/syntax/gate`(kode-server syntax_gate.rs)是预检主路径:
 * 括号/引号配平 + 缩进一致性粗检(单遍扫描器,微秒级,零子进程)。
 * 本文件:
 * - `syntaxGateCheck`:TS 镜像核(Rust 不可用时的回退,语义与 Rust 同构;
 *   vitest 契约用例两面同跑);
 * - `checkSyntaxGate`:主入口——Rust 门在则走 Rust,无门/失败走 TS 回退
 *   (行为不变降级:门永远有答案,消费面不分支)。
 *
 * 消费纪律(用户令 2026-11-18):不过关 → 跳过符号入索引和绑定,索引保留
 * 上一次健康版本符号;诊断面照旧由既有诊断链报语法错,本门不产诊断只做闸。
 * 零 vscode import(纯核;配置读取由调用方注入)。
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** 预检结果:`ok=false` 时 reasons 带行号定位(日志/观测面用,不进诊断)。 */
export interface SyntaxGateResult {
  ok: boolean;
  reasons: string[];
}

/** 段扫描:括号配平 + 未闭合字符串定位(缩进判定不在此面)。 */
function scanSegment(
  segment: string,
  lineNo: number,
  brackets: Array<{ open: string; line: number }>,
  reasons: string[]
): boolean {
  let i = 0;
  while (i < segment.length) {
    const b = segment[i];
    if (b === '#') { return false; }
    if (b === '\\') { i += 2; continue; }
    if (b === "'" || b === '"') {
      const triple = segment[i + 1] === b && segment[i + 2] === b;
      if (triple) { return true; }
      let probe = i + 1;
      let closed = false;
      while (probe < segment.length) {
        if (segment[probe] === '\\') { probe += 2; continue; }
        if (segment[probe] === b) { closed = true; break; }
        probe += 1;
      }
      if (!closed) {
        reasons.push(`unterminated-string at line ${lineNo}`);
        return false;
      }
      i = probe + 1;
      continue;
    }
    if (b === '(' || b === '[' || b === '{') {
      brackets.push({ open: b, line: lineNo });
      i += 1;
      continue;
    }
    if (b === ')' || b === ']' || b === '}') {
      const expect = b === ')' ? '(' : b === ']' ? '[' : '{';
      const top = brackets[brackets.length - 1];
      if (top && top.open === expect) {
        brackets.pop();
      } else if (top) {
        const want = top.open === '(' ? ')' : top.open === '[' ? ']' : '}';
        reasons.push(`unbalanced-bracket at line ${lineNo} (expected '${want}' for line ${top.line})`);
        brackets.pop();
      } else {
        reasons.push(`unbalanced-bracket at line ${lineNo}`);
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/** 行内找三引号收尾(尊重转义);返回起始下标,null=本行无收尾。 */
function findCloseTriple(line: string): number | null {
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue; }
    if (line[i] === "'" && line[i + 1] === "'" && line[i + 2] === "'") { return i; }
    if (line[i] === '"' && line[i + 1] === '"' && line[i + 2] === '"') { return i; }
    i += 1;
  }
  return null;
}

/**
 * TS 镜像核:与 Rust `syntax_gate` 同构的单遍扫描预检。
 * 宁漏勿冤:只拦「确定烂」(编辑中途显式断裂);假 OK 可接受(真诊断链
 * 照常报错),假 NO 不可接受(索引会饿死)。续行(行尾反斜杠)/括号内
 * 换行/三引号串体内的缩进一律不判。
 */
export function syntaxGateCheck(text: string): SyntaxGateResult {
  const reasons: string[] = [];
  const brackets: Array<{ open: string; line: number }> = [];
  const levels: string[] = [];
  let indentChar: string | null = null;
  let inTripleString = false;
  let physicalLine = 0;
  let pending: string | null = null;

  for (const raw of text.split('\n')) {
    physicalLine += 1;
    const line: string = (pending ?? '') + (raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    pending = null;
    const lineNo = physicalLine;

    // 三引号串体内:只找收尾引号(缩进/括号一律不判)
    if (inTripleString) {
      const closeCol = findCloseTriple(line);
      if (closeCol !== null) {
        inTripleString = false;
        if (scanSegment(line.slice(closeCol + 3), lineNo, brackets, reasons)) {
          inTripleString = true;
        }
      }
      continue;
    }

    // 续行(行尾反斜杠):先并再扫——否则 `'abc \` 这类续字符串会被误判。
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1);
      continue;
    }

    const trimmedStart = line.length - (line.replace(/^[ \t]+/, '').length);
    const indent = line.slice(0, trimmedStart);
    const rest = line.slice(trimmedStart);
    const isBlank = rest.length === 0;
    const isComment = rest.startsWith('#');
    const inBrackets = brackets.length > 0;
    if (!isBlank && !isComment && !inBrackets && indent.length > 0) {
      const hasSpace = indent.includes(' ');
      const hasTab = indent.includes('\t');
      if (hasSpace && hasTab) {
        reasons.push(`mixed-indent at line ${lineNo}`);
      } else {
        const thisChar = hasTab ? '\t' : ' ';
        if (indentChar === null) {
          indentChar = thisChar;
        } else if (indentChar !== thisChar) {
          reasons.push(`mixed-indent at line ${lineNo}`);
        }
      }
      if (!levels.some(lvl => lvl === indent)) {
        const deepest = levels.length > 0 ? levels[levels.length - 1].length : 0;
        if (indent.length < deepest) {
          reasons.push(`inconsistent-dedent at line ${lineNo}`);
        } else {
          levels.push(indent);
        }
      } else {
        while (levels.length > 0 && levels[levels.length - 1] !== indent) {
          levels.pop();
        }
      }
    } else if (!isBlank && !isComment && !inBrackets && indent.length === 0 && levels.length > 0) {
      levels.length = 0;
    }
    if (!isBlank && !isComment) {
      if (scanSegment(rest, lineNo, brackets, reasons)) {
        inTripleString = true;
      }
    }
  }

  if (inTripleString) {
    reasons.push('unterminated-string at EOF');
  }
  for (const bracket of brackets) {
    reasons.push(`unclosed-bracket '${bracket.open}' from line ${bracket.line}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 主入口:Rust 门(`$/kode/syntax/gate`)主路径;无门/请求失败/应答畸形
 * → TS 镜像回退(ruffLint 先例的「行为不变降级」口径:门永远有答案)。
 */
export async function checkSyntaxGate(text: string): Promise<SyntaxGateResult> {
  const gate = getKodeCoreShadowGate();
  if (gate) {
    try {
      const response = await gate.runInRust('$/kode/syntax/gate', { text });
      if (response.ok) {
        const record = response.result as { ok?: unknown; reasons?: unknown } | null;
        if (record && typeof record === 'object' && typeof record.ok === 'boolean' &&
            Array.isArray(record.reasons)) {
          return { ok: record.ok, reasons: record.reasons as string[] };
        }
      }
    } catch {
      // 门抛错 → 回退 TS 镜像(不装死也不吞成 ok)
    }
  }
  return syntaxGateCheck(text);
}
