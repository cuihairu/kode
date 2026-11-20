// SemanticTokens 决策核(RUST-144 批 3,新面):python 文件结构符号语义
// ——class/方法/模块级函数声明名、def 形参名、装饰器名,共 5 类 token
// (语法关键字/字符串面留给 TextMate grammar,不与之重叠)。纯函数
// (文本输入,零 vscode/引擎依赖),解析复用 pythonParser(parsePythonFile
// /pythonCodeLines/pythonStatements)与 defParamInlayHints(parseDefLine
// /splitParams 同一套 def 行扫描,口径一致)。诚实边界:self.X 属性访问
// 与局部变量面不做(与 Pylance 冲突大+需 self scope 分析,后续批次按
// RUST-148 冲突矩阵裁度);跨行 def 的形参不提取(与 inlay 同单行闸)。
import { parsePythonFile, pythonCodeLines, pythonStatements } from './pythonParser';
import { parseDefSignature } from '../defParamInlayHints';

/** legend 顺序即编码 typeIndex(与 Rust semantic_tokens.rs 同序,勿改序) */
export const SEMANTIC_TOKEN_TYPES = ['class', 'function', 'method', 'parameter', 'macro'] as const;

export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'async'] as const;

export type SemanticTokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];

export interface SemanticTokenSpan {
  /** 0 起行 */
  line: number;
  /** 行内 0 起 UTF-16 列 */
  startCharacter: number;
  length: number;
  type: SemanticTokenType;
  /** 'declaration' 声明位;'async' async def(声明名与形参都可带) */
  modifiers: string[];
}

/** 装饰器行:@ 名(可点分,取全表达式 span) */
const DECORATOR_RE = /^\s*@\s*([A-Za-z_][\w.]*)/;
const CLASS_NAME_RE = /^\s*class\s+([A-Za-z_]\w*)/;
const DEF_HEAD_RE = /^\s*(async\s+)?def\s+([A-Za-z_]\w*)/;

/**
 * 提取结构符号 span(按行/列升序,无去重——同一 token 只会由单一规则产
 * 出)。任何 python 文件都出(语言级结构语义,无实体段闸);空文件/无符
 * 号文件返回空数组。
 */
export function buildSemanticTokenSpans(text: string): SemanticTokenSpan[] {
  const maskedLines = pythonCodeLines(text);
  const parsed = parsePythonFile(text, 'semantic-tokens-synthetic.py');
  const spans: SemanticTokenSpan[] = [];

  // 类声明名(掩码行内 class 后名字;掩码位置不变故列对齐原文)
  for (const cls of parsed.classes) {
    const lineText = maskedLines[cls.startLine] ?? '';
    const match = CLASS_NAME_RE.exec(lineText);
    if (!match) {
      continue;
    }
    const name = match[1];
    const start = lineText.indexOf(name, match[0].length - name.length);
    spans.push({
      line: cls.startLine,
      startCharacter: start,
      length: name.length,
      type: 'class',
      modifiers: ['declaration']
    });
  }

  // 方法声明名(parsePythonFile methods 表,行/列直用;async 从掩码行判)
  const classBoundDefLines = new Set<number>();
  for (const cls of parsed.classes) {
    for (const [methodName, location] of cls.methods) {
      classBoundDefLines.add(location.line);
      const modifiers = ['declaration'];
      if (/^\s*async\s+def\s/.test(maskedLines[location.line] ?? '')) {
        modifiers.push('async');
      }
      spans.push({
        line: location.line,
        startCharacter: location.character,
        length: methodName.length,
        type: 'method',
        modifiers
      });
    }
  }

  // 语句面:模块级 def(function)/装饰器(macro)
  const statements = pythonStatements(text);
  for (const statement of statements) {
    const defMatch = DEF_HEAD_RE.exec(statement.text);
    if (defMatch && !classBoundDefLines.has(statement.line)) {
      const methodName = defMatch[2];
      const modifiers = ['declaration'];
      if (defMatch[1]) {
        modifiers.push('async');
      }
      // statement.text 是合并文本,首行列与原行一致;名列表=匹配尾前
      const start = statement.text.indexOf(methodName, defMatch[0].length - methodName.length);
      spans.push({
        line: statement.line,
        startCharacter: start,
        length: methodName.length,
        type: 'function',
        modifiers
      });
      collectParameterSpans(
        maskedLines,
        statement.line,
        methodName,
        start,
        spans,
        defMatch[1] ? ['declaration', 'async'] : ['declaration']
      );
      continue;
    }
    const decoratorMatch = DECORATOR_RE.exec(statement.text);
    if (decoratorMatch) {
      const name = decoratorMatch[1];
      const start = statement.text.indexOf(name, decoratorMatch[0].length - name.length);
      spans.push({
        line: statement.line,
        startCharacter: start,
        length: name.length,
        type: 'macro',
        modifiers: []
      });
    }
  }

  // 形参:类方法 def 行(parsePythonFile 表给的行/列)
  for (const cls of parsed.classes) {
    for (const [methodName, location] of cls.methods) {
      collectParameterSpans(
        maskedLines,
        location.line,
        methodName,
        location.character,
        spans,
        /^\s*async\s+def\s/.test(maskedLines[location.line] ?? '')
          ? ['declaration', 'async']
          : ['declaration']
      );
    }
  }

  return spans.sort((a, b) => a.line - b.line || a.startCharacter - b.startCharacter);
}

/**
 * def 形参 span(parseDefSignature,与 inlay 同一套统一事实源=掩码行域;
 * KODE-SYN-004 起签名可跨行,span 落形参名所在行)。参数自带 declaration+
 * async 修饰。
 */
function collectParameterSpans(
  maskedLines: readonly string[],
  line: number,
  methodName: string,
  nameCharacter: number,
  spans: SemanticTokenSpan[],
  modifiers: string[]
): void {
  // 形参切分与 inlay 同一套:parseDefSignature 的 site.params 已剥首参
  // self/cls(本扩展 parameter 语义=RPC 形参,接收者不是形参,与 inlay/
  // 签名 formatter 同口径),未闭合签名(编辑中)不出。
  const site = parseDefSignature(maskedLines, line, methodName, nameCharacter, 'ClientMethods');
  if (!site) {
    return;
  }
  for (const param of site.params) {
    spans.push({
      line: param.line,
      startCharacter: param.start,
      length: param.end - param.start,
      type: 'parameter',
      modifiers: [...modifiers]
    });
  }
}

/**
 * LSP 相对编码:[deltaLine, deltaStartChar, length, typeIndex,
 * modifierBitmask]。span 须已按行/列升序(本模块产出保证);legend 索引
 * 由 SEMANTIC_TOKEN_TYPES/MODIFIERS 定,未知类型抛错(装配面 bug 早爆)。
 */
export function encodeSemanticTokens(spans: SemanticTokenSpan[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevStart = 0;
  for (const span of spans) {
    const typeIndex = (SEMANTIC_TOKEN_TYPES as readonly string[]).indexOf(span.type);
    if (typeIndex < 0) {
      throw new Error(`unknown semantic token type: ${span.type}`);
    }
    let modifierMask = 0;
    for (const modifier of span.modifiers) {
      const bit = (SEMANTIC_TOKEN_MODIFIERS as readonly string[]).indexOf(modifier);
      if (bit >= 0) {
        modifierMask |= 1 << bit;
      }
    }
    const deltaLine = span.line - prevLine;
    const deltaStart = deltaLine === 0 ? span.startCharacter - prevStart : span.startCharacter;
    data.push(deltaLine, deltaStart, span.length, typeIndex, modifierMask);
    prevLine = span.line;
    prevStart = span.startCharacter;
  }
  return data;
}
