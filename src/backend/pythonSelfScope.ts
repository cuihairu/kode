// AUD-028 (R2-F05) + AUD-029 (R2-F06): the "definite attribution" of property references and
// receiver RPC calls was incomplete -- getIncomingPythonPropertyAccesses /
// getIncomingPythonReceiverCalls regex-scanned the owner file's raw text, so the results mixed
// in strings, comments, another plain class in the same file, and self.hp / self.cell.X(
// with a nested rebound self. This module does lexical/scope filtering: masking via
// pythonCodeLines rules out strings/comments (positions do not shift), an indentation stack
// tracks class/function scopes and whether a function's first parameter is self, keeping only
// the true read/write points / true call sites where "self is the owner instance" inside
// direct methods of the owner class.
//
// Rules (per candidate match, based on masked text and the scope stack):
//   ① after masking the position was replaced by whitespace -> string/comment, excluded;
//   ② the owning class (the top-level class containing the masked line) must be exactly the
//      owner class; other classes in the same file are excluded;
//   ③ self attribution: the nearest function scope "with self as first parameter" must satisfy
//      -- its containing class is exactly the owner class (nested/other classes excluded), and
//      it is not a rebind nested inside another function (a nested def helper(self) -> that self
//      is not the owner instance, excluded); closures (no self first parameter) do not rebind,
//      they inherit the outer method's self and are kept;
//   ④ property face: self.<prop>( with call parens -> method call (NAV-003 face), excluded;
//      RPC face: self.<receiver>.<method>( must carry call parens (non-call shapes are not collected).

import { pythonCodeLines } from './pythonParser';

/** One self access inside the owner class (0-based line/character; the character points at the start of the property or method name) */
export interface OwnerSelfPropertyAccess {
  line: number;
  character: number;
}

interface FunctionScope {
  /** 0-based def line */
  startLine: number;
  /** 0-based end line (exclusive; closed at class/file boundaries) */
  endLine: number;
  /** Whether the first parameter name is self (the rebind decision) */
  selfBound: boolean;
  /** Name of the innermost class containing the def line (no class = module-level function) */
  className: string | null;
}

interface ClassScope {
  name: string;
  /** 0-based class line */
  startLine: number;
  /** 0-based end line (exclusive) */
  endLine: number;
}

interface OwnerScopeWalk {
  classes: ClassScope[];
  functions: FunctionScope[];
  ownerClass: ClassScope | null;
}

/** Extract the first parameter name from a function header (parenthesized continuation lines supported); read from masked text, strings already blanked */
function firstParamName(maskedLines: string[], defLine: number): string | null {
  let header = maskedLines[defLine] ?? '';
  let depth = 0;
  let started = false;
  let line = defLine;
  for (; line < maskedLines.length; line += 1) {
    const text = line === defLine ? header : maskedLines[line];
    for (const ch of text) {
      if (ch === '(') { depth += 1; started = true; }
      if (ch === ')') { depth -= 1; }
    }
    if (line > defLine) { header = `${header} ${text}`; }
    if (started && depth <= 0) { break; }
  }
  const open = header.indexOf('(');
  const close = header.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return null;
  }
  const params = header.slice(open + 1, close).split(',');
  const first = params[0]?.trim();
  return /^self\b/.test(first ?? '') ? 'self' : first ?? null;
}

const computeIndent = (line: string): number =>
  (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;

/** Build class/function scopes via an indentation stack and resolve the owner class (shared by the property and RPC faces) */
function buildOwnerScopeWalk(masked: string[], ownerClassName: string): OwnerScopeWalk {
  const lineCount = masked.length;
  const classes: ClassScope[] = [];
  const functions: FunctionScope[] = [];
  const classStack: ClassScope[] = [];
  const functionStack: FunctionScope[] = [];

  for (let line = 0; line < lineCount; line += 1) {
    const raw = masked[line];
    if (!raw || !raw.trim()) { continue; }
    const indent = computeIndent(raw);
    while (classStack.length && computeIndent(masked[classStack[classStack.length - 1].startLine]) >= indent) {
      classStack.pop()!.endLine = line;
    }
    while (functionStack.length && computeIndent(masked[functionStack[functionStack.length - 1].startLine]) >= indent) {
      functionStack.pop()!.endLine = line;
    }
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(.*\))?\s*:/.exec(raw);
    if (classMatch) {
      const cls: ClassScope = { name: classMatch[1], startLine: line, endLine: lineCount };
      classes.push(cls);
      classStack.push(cls);
      continue;
    }
    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(raw);
    if (defMatch) {
      const first = firstParamName(masked, line);
      functions.push({
        startLine: line,
        endLine: lineCount,
        selfBound: first === 'self',
        className: classStack.length > 0 ? classStack[classStack.length - 1].name : null
      });
      functionStack.push(functions[functions.length - 1]);
    }
  }
  for (const cls of classStack) { cls.endLine = lineCount; }
  for (const fn of functionStack) { fn.endLine = lineCount; }

  const ownerClass = classes.find(cls => cls.name === ownerClassName)
    ?? (classes.length === 1 ? classes[0] : null);
  return { classes, functions, ownerClass };
}

/** Whether the self access at a masked line lands inside a direct method of the owner class (rules ② and ③) */
function isOwnerMethodSelfAccess(walk: OwnerScopeWalk, line: number): boolean {
  const { functions, ownerClass } = walk;
  // ② owning class: the top-level class containing the masked line must be the owner class (other classes in the same file excluded)
  if (ownerClass && (line < ownerClass.startLine || line >= ownerClass.endLine)) { return false; }
  // ③ self attribution: the nearest self-first-parameter function scope must be a direct method of the owner class
  const containing = functions.filter(fn => line >= fn.startLine && line < fn.endLine);
  const selfBinder = [...containing].reverse().find(fn => fn.selfBound);
  if (!selfBinder) { return false; } // no self binding (class body / module level) -> not an instance access
  if (ownerClass && selfBinder.className !== ownerClass.name) { return false; } // other/nested class
  // Nested rebind (def helper(self) inside a method) -> that self is not the owner instance, excluded;
  // closures (no self first parameter) do not form a selfBinder and inherit the outer method's self on their own
  const nestedInFunction = functions.some(fn =>
    fn !== selfBinder && fn.startLine < selfBinder.startLine && selfBinder.startLine < fn.endLine);
  if (nestedInFunction) { return false; }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the true read/write points of self.<prop> within the owner class scope.
 * @param ownerClassName the owner class name (entity name / file base name fallback)
 * @returns a list of 0-based line/character pairs; the character points at the start of the property name (same convention as existing code)
 */
export function findOwnerSelfPropertyAccesses(
  content: string,
  ownerClassName: string,
  propertyName: string
): OwnerSelfPropertyAccess[] {
  const masked = pythonCodeLines(content);
  const walk = buildOwnerScopeWalk(masked, ownerClassName);

  const results: OwnerSelfPropertyAccess[] = [];
  const regex = new RegExp(`\\bself\\.${escapeRegExp(propertyName)}\\b(?!\\s*\\()`, 'g');

  for (let line = 0; line < masked.length; line += 1) {
    const raw = masked[line];
    if (!raw) { continue; }
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      if (!isOwnerMethodSelfAccess(walk, line)) { continue; }
      results.push({ line, character: match.index + 'self.'.length });
    }
  }
  return results;
}

/**
 * Find the true call sites of self.<receiver>.<method>( within the owner class scope.
 * @param receiver the call section (cell/base/client), same mapping as the declaration section
 * @returns a list of 0-based line/character pairs; the character points at the start of the method name (same convention as existing code)
 */
export function findOwnerSelfReceiverCalls(
  content: string,
  ownerClassName: string,
  receiver: 'cell' | 'base' | 'client',
  methodName: string
): OwnerSelfPropertyAccess[] {
  const masked = pythonCodeLines(content);
  const walk = buildOwnerScopeWalk(masked, ownerClassName);

  const results: OwnerSelfPropertyAccess[] = [];
  const regex = new RegExp(`\\bself\\.${receiver}\\.${escapeRegExp(methodName)}\\b(?=\\s*\\()`, 'g');

  for (let line = 0; line < masked.length; line += 1) {
    const raw = masked[line];
    if (!raw) { continue; }
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      if (!isOwnerMethodSelfAccess(walk, line)) { continue; }
      results.push({ line, character: match.index + `self.${receiver}.`.length });
    }
  }
  return results;
}
