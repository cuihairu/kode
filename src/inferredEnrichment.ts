/**
 * KODE-CFG-017-R 消费面富化：读 `.kbengine/inferred/` 镜像（pyrefly 注解产物）
 * 提取推断注解，供 hover/inlay provider 富化。纯逻辑层，不 import vscode。
 *
 * 铁律（T-04 禁遮蔽）：镜像只在 provider 读取面被消费，**绝不**进入
 * extraPaths / 导入解析。本模块只做「源 .py → 镜像路径」映射与「镜像全文 →
 * 注解」提取，不含任何写路径、不含 vscode 依赖。
 *
 * 提取口径：pythonLexicalMask 掩码保长保行（列偏移不变），因此所有定位
 * （def 头、括号配对、冒号/箭头）都在掩码文本上做，注解文本一律回原文切片
 * ——字符串字面量里的 `Literal["a"]`、注释尾巴不串味。
 */

import * as path from 'path';
import { maskPythonNonCode } from './pythonLexicalMask';

/** 源 .py 在镜像里的相对路径（工作区相对路径，复用 mirrorPrefixFor 口径）。 */
export function mirrorRelPathFor(
  workspaceRoot: string,
  scriptsRoot: string,
  sourceRelPath: string
): string {
  const prefix = path.relative(workspaceRoot, scriptsRoot).replace(/\\/g, '/');
  const rel = sourceRelPath.replace(/\\/g, '/');
  return prefix === '' ? rel : `${prefix}/${rel}`;
}

/**
 * 源 .py 绝对路径 → 镜像绝对路径；不在工作区内返回 null。
 * 镜像结构 `<managedDir>/inferred/<mirrorPrefix>/<scripts 相对路径>`，而
 * mirrorPrefix + scripts 相对路径 == 工作区相对路径（源在 scripts 根内时），
 * 故直接按工作区相对路径拼装；源不在 scripts 根内时镜像本就无此文件，
 * 读取面 miss 静默回退，映射无需单独拒绝。
 */
export function mirrorPathForSource(
  workspaceRoot: string,
  managedDir: string,
  sourceFsPath: string
): string | null {
  const rel = path.relative(workspaceRoot, sourceFsPath).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return path.join(workspaceRoot, managedDir, 'inferred', rel);
}

/** 找 `def <name>(` 的正文起始（返回 ')' 的 index 与 def 行结束 index）。 */
function findDefHeader(maskedText: string, symbolName: string): { closeParen: number; lineEnd: number } | null {
  const namePattern = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRe = new RegExp(`\\bdef\\s+${namePattern}\\s*\\(`, 'g');
  const match = defRe.exec(maskedText);
  if (!match) {
    return null;
  }
  const openParen = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = openParen; i < maskedText.length; i += 1) {
    const ch = maskedText[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const lineEnd = maskedText.indexOf('\n', i);
        return { closeParen: i, lineEnd: lineEnd === -1 ? maskedText.length : lineEnd };
      }
    }
  }
  return null;
}

/** 按顶层逗号切分参数表（忽略嵌套括号内的逗号）；start 为段内偏移（供原文定位）。 */
function splitTopLevelCommas(segment: string): Array<{ text: string; start: number }> {
  const parts: Array<{ text: string; start: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push({ text: segment.slice(start, i), start });
      start = i + 1;
    }
  }
  parts.push({ text: segment.slice(start), start });
  return parts;
}

/** 掩码区间 → 原文切片再 trim（注解字面量保真）。 */
function rawSlice(rawText: string, start: number, end: number): string {
  return rawText.slice(start, end).trim();
}

/** 掩码区间 → 原文切片，并按掩码回走尾部空白（注释被掩成空白，防注释尾巴串进注解）。 */
function maskedBackTrimSlice(maskedText: string, rawText: string, start: number, end: number): string {
  let e = end;
  while (e > start && (maskedText[e - 1] === ' ' || maskedText[e - 1] === '\t')) {
    e -= 1;
  }
  return rawSlice(rawText, start, e);
}

/**
 * 掩码 `name:` 注解区间的原文类型切片：截到行内顶层 `=` 或行界，再回走
 * 掩码尾部空白（注释被掩成空白，天然排除行尾注释尾巴；raw 上的 `#` 查找
 * 不可用——掩码已抹 `#`，且 raw 字符串里可有 `#`）。lineLimit 传该行结尾
 * （全文本调用必传），防 `=` 越到后续行。返回空串视为无注解。
 */
function annotatedTypeAfterColon(maskedText: string, rawText: string, typeStart: number, lineLimit: number): string {
  let typeEnd = maskedText.indexOf('=', typeStart);
  if (typeEnd === -1 || typeEnd >= lineLimit) {
    typeEnd = lineLimit;
  }
  while (typeEnd > typeStart && (maskedText[typeEnd - 1] === ' ' || maskedText[typeEnd - 1] === '\t')) {
    typeEnd -= 1;
  }
  return rawSlice(rawText, typeStart, typeEnd);
}

/**
 * 提取函数/方法返回注解；无注解返回 null（`def f() -> str` → 'str'）。
 * 定位在掩码上做，注解回原文切片。
 */
export function extractReturnAnnotation(mirrorText: string, symbolName: string): string | null {
  const masked = maskPythonNonCode(mirrorText);
  const header = findDefHeader(masked, symbolName);
  if (!header) {
    return null;
  }
  const after = masked.slice(header.closeParen + 1, header.lineEnd);
  const arrow = after.indexOf('->');
  if (arrow === -1) {
    return null;
  }
  const annotationStart = arrow + 2;
  const colon = after.indexOf(':', annotationStart);
  const end = colon === -1 ? after.length : colon;
  const annotation = rawSlice(mirrorText, header.closeParen + 1 + annotationStart, header.closeParen + 1 + end);
  return annotation === '' ? null : annotation;
}

/** 参数名/注解解析结果（nameEnd 为掩码列 == 原文列，供 inlay 插入点使用）。 */
export interface ParsedParamSpan {
  name: string;
  type: string | null;
  nameEnd: number;
}

interface ParsedDefHeader {
  params: ParsedParamSpan[];
  closeParen: number;
  hasReturnArrow: boolean;
  returnType: string | null;
}

/** 单行 def 头解析（掩码定位、原文切片）；行内括号不闭合（多行签名）返回 null。 */
function parseDefHeaderInLine(lineText: string): ParsedDefHeader | null {
  const masked = maskPythonNonCode(lineText);
  const defMatch = /\bdef\s+\w+\s*\(/.exec(masked);
  if (!defMatch) {
    return null;
  }
  const openParen = defMatch.index + defMatch[0].length - 1;
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen === -1) {
    return null;
  }
  const after = masked.slice(closeParen + 1);
  const arrowOffset = after.indexOf('->');
  let returnType: string | null = null;
  if (arrowOffset !== -1) {
    const restStart = arrowOffset + 2;
    const colon = after.indexOf(':', restStart);
    const restEnd = colon === -1 ? after.length : colon;
    returnType = rawSlice(lineText, closeParen + 1 + restStart, closeParen + 1 + restEnd);
  }
  const params: ParsedParamSpan[] = [];
  const segmentStart = openParen + 1;
  for (const partRaw of splitTopLevelCommas(masked.slice(segmentStart, closeParen))) {
    const part = partRaw.text.trim();
    if (part === '' || part === '*' || part === '**' || part === '/') {
      continue;
    }
    // part 起点回原文：段内偏移 + partRaw 前导空白 + part 前导 `*`
    const lead = /^[\s*]*/.exec(part)?.[0].length ?? 0;
    const partStartInRaw = segmentStart + partRaw.start + (partRaw.text.length - partRaw.text.trimStart().length) + lead;
    const body = part.slice(lead);
    const colon = body.indexOf(':');
    const name = (colon === -1 ? body : body.slice(0, colon)).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      continue;
    }
    let type: string | null = null;
    if (colon !== -1) {
      const eq = body.indexOf('=', colon);
      type = maskedBackTrimSlice(masked, lineText, partStartInRaw + colon + 1, partStartInRaw + (eq === -1 ? body.length : eq));
    }
    params.push({ name, type: type === '' ? null : type, nameEnd: partStartInRaw + name.length });
  }
  return { params, closeParen, hasReturnArrow: arrowOffset !== -1, returnType };
}

/**
 * 提取参数注解表；无注解返回 []（`def f(x: int, y)` → [{name:'x',type:'int'}]）。
 * 定位在掩码上做，注解回原文切片。
 */
export function extractParamAnnotations(
  mirrorText: string,
  symbolName: string
): Array<{ name: string; type: string }> {
  const masked = maskPythonNonCode(mirrorText);
  const header = findDefHeader(masked, symbolName);
  if (!header) {
    return [];
  }
  // openParen 是 findDefHeader 匹配到的 `(`（lastIndexOf 在 closeParen 前定位）。
  const openParen = masked.lastIndexOf('(', header.closeParen);
  const segmentStart = openParen + 1;
  const result: Array<{ name: string; type: string }> = [];
  for (const partRaw of splitTopLevelCommas(masked.slice(segmentStart, header.closeParen))) {
    const part = partRaw.text.trim();
    if (part === '' || part === '*' || part === '**' || part === '/') {
      continue;
    }
    const lead = /^[\s*]*/.exec(part)?.[0].length ?? 0;
    const partStartInRaw = segmentStart + partRaw.start + (partRaw.text.length - partRaw.text.trimStart().length) + lead;
    const body = part.slice(lead);
    const colon = body.indexOf(':');
    if (colon === -1) {
      continue; // 无注解参数跳过（y 无类型）
    }
    const name = body.slice(0, colon).trim();
    if (name === '') {
      continue;
    }
    const eq = body.indexOf('=', colon);
    const type = maskedBackTrimSlice(masked, mirrorText, partStartInRaw + colon + 1, partStartInRaw + (eq === -1 ? body.length : eq));
    result.push({ name, type: type === '' ? 'Unknown' : type });
  }
  return result;
}

/**
 * 提取变量/属性注解（`x: int = ...` / `self.x: str`）；无注解返回 null。
 * 行首锚定（含 self. 前缀），定位在掩码上做，注解回原文切片。
 */
export function extractVariableAnnotation(mirrorText: string, symbolName: string): string | null {
  const masked = maskPythonNonCode(mirrorText);
  const namePattern = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*(?:self\\.)?${namePattern}\\s*:`);
  const match = re.exec(masked);
  if (!match) {
    return null;
  }
  const typeStart = match.index + match[0].length;
  const lineEnd = masked.indexOf('\n', typeStart);
  const type = annotatedTypeAfterColon(masked, mirrorText, typeStart, lineEnd === -1 ? masked.length : lineEnd);
  return type === '' ? null : type;
}

/** 行级推断提示（inlay）：源行第 character 列后渲染 label。 */
export interface InferredAnnotationHint {
  line: number;
  character: number;
  label: string;
}

/**
 * 源文与镜像逐行差分：镜像有而源缺的类型注解 → 行内提示位。
 * pyrefly 就地写注解不改行数，两文行数不一致即结构漂移，整批不出
 * （宁缺毋错）；单行 def 头不闭合（多行签名）该行跳过，优雅降级。
 */
export function diffInferredAnnotations(sourceText: string, mirrorText: string): InferredAnnotationHint[] {
  const sourceLines = sourceText.split('\n');
  const mirrorLines = mirrorText.split('\n');
  if (sourceLines.length !== mirrorLines.length) {
    return [];
  }
  const hints: InferredAnnotationHint[] = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    const srcLine = sourceLines[i];
    const mirLine = mirrorLines[i];
    if (srcLine === mirLine) {
      continue;
    }
    const srcDef = parseDefHeaderInLine(srcLine);
    const mirDef = parseDefHeaderInLine(mirLine);
    if (srcDef || mirDef) {
      // def 头差分：返回注解（源缺箭头）+ 同名形参注解（源缺冒号）；
      // 单侧是 def 行（同位异构）不硬配,跳过。
      if (srcDef && mirDef) {
        if (!srcDef.hasReturnArrow && mirDef.hasReturnArrow && mirDef.returnType) {
          hints.push({ line: i, character: srcDef.closeParen + 1, label: `-> ${mirDef.returnType}` });
        }
        const srcByName = new Map(srcDef.params.map(p => [p.name, p]));
        for (const mirParam of mirDef.params) {
          if (!mirParam.type) {
            continue;
          }
          const srcParam = srcByName.get(mirParam.name);
          if (srcParam && !srcParam.type) {
            hints.push({ line: i, character: srcParam.nameEnd, label: `: ${mirParam.type}` });
          }
        }
      }
      continue;
    }
    // 赋值差分：镜像行 `name: Type = ...`、源行同名裸赋值 `name = ...`。
    const mirMasked = maskPythonNonCode(mirLine);
    const nameMatch = /^(\s*)((?:self\.)?)([A-Za-z_]\w*)\s*:/.exec(mirMasked);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[3];
    const type = annotatedTypeAfterColon(mirMasked, mirLine, nameMatch.index + nameMatch[0].length, mirMasked.length);
    if (type === '') {
      continue;
    }
    const namePattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const srcAssign = new RegExp(`^(\\s*)((?:self\\.)?)(${namePattern})(?![\\w])([^\\n]*)$`).exec(maskPythonNonCode(srcLine));
    if (!srcAssign || !/^\s*=(?!=)/.test(srcAssign[4])) {
      continue; // 源行不是该名字的裸赋值（已带注解 / 比较运算 / 其他语句）
    }
    hints.push({
      line: i,
      character: srcAssign[1].length + srcAssign[2].length + name.length,
      label: `: ${type}`
    });
  }
  return hints;
}
