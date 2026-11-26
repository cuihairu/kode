/**
 * KODE-CFG-017-R consumption-face enrichment: reads the `.kbengine/inferred/`
 * mirror (pyrefly annotation artifacts) to extract inferred annotations for
 * hover/inlay provider enrichment. Pure logic layer, does not import vscode.
 *
 * Iron rule (T-04 no shadowing): the mirror is consumed only on the provider
 * read face and **never** enters extraPaths / import resolution. This module
 * only does the "source .py -> mirror path" mapping and the "mirror full text
 * -> annotations" extraction; it contains no write path and no vscode
 * dependency.
 *
 * Extraction convention: the pythonLexicalMask mask preserves length and line
 * count (column offsets unchanged), so all positioning (def headers, bracket
 * pairing, colon/arrow) happens on the masked text while annotation text is
 * always sliced back from the raw source -- a `Literal["a"]` inside a string
 * literal or a comment tail never leaks into an annotation.
 */

import * as path from 'path';
import { maskPythonNonCode } from './pythonLexicalMask';
import { pythonStatements } from './pythonParser';

export function generatedStubPath(root: string, managedDir: string, source: string): string | null {
  const relative = path.relative(root, source);
  if (!relative.endsWith('.py') || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return path.join(root, managedDir, 'stubs', 'generated', `${relative}i`);
}

/** The source .py's relative path inside the mirror (workspace-relative path, reusing the mirrorPrefixFor convention). */
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
 * Source .py absolute path -> mirror absolute path; returns null when outside
 * the workspace. The mirror layout is
 * `<managedDir>/inferred/<mirrorPrefix>/<scripts-relative path>`, and
 * mirrorPrefix + scripts-relative path == workspace-relative path (when the
 * source is inside the scripts root), so we assemble directly from the
 * workspace-relative path; when the source is outside the scripts root the
 * mirror simply has no such file, the read face misses and silently falls
 * back, so the mapping needs no separate rejection.
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

/** Finds the body start of `def <name>(` (returns the ')' index and the def line end index). */
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

/** Splits the parameter list on top-level commas (ignoring commas inside nested brackets); start is the in-segment offset (for raw-source positioning). */
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

/** Masked range -> raw-source slice, then trim (keeps annotation literals faithful). */
function rawSlice(rawText: string, start: number, end: number): string {
  return rawText.slice(start, end).trim();
}

/** Masked range -> raw-source slice, walking trailing whitespace back over the mask (comments are masked into whitespace, keeping comment tails out of the annotation). */
function maskedBackTrimSlice(maskedText: string, rawText: string, start: number, end: number): string {
  let e = end;
  while (e > start && (maskedText[e - 1] === ' ' || maskedText[e - 1] === '\t')) {
    e -= 1;
  }
  return rawSlice(rawText, start, e);
}

/**
 * Raw-source type slice of a masked `name:` annotation range: cut at the
 * line's top-level `=` or the line boundary, then walk trailing whitespace
 * back over the mask (comments are masked into whitespace, which naturally
 * excludes end-of-line comment tails; searching for `#` on the raw text is
 * unusable -- the mask has already erased `#`, and raw strings may contain
 * `#`). Pass this line's end as lineLimit (required for whole-text calls) to
 * keep `=` from reaching into later lines. An empty-string return means no
 * annotation.
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
 * Extracts a function/method return annotation; returns null when absent
 * (`def f() -> str` -> 'str'). Positioning happens on the mask; the
 * annotation is sliced back from the raw source.
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

/** Parameter name/annotation parse result (nameEnd is a mask column == raw column, used as the inlay insertion point). */
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

/** Single-line def header parse (mask positioning, raw slicing); returns null when brackets do not close within the line (multi-line signature). */
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
    // Map the part start back to the raw source: in-segment offset + partRaw leading whitespace + part leading `*`
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
 * Extracts the parameter annotation table; returns [] when unannotated
 * (`def f(x: int, y)` -> [{name:'x',type:'int'}]). Positioning happens on the
 * mask; the annotations are sliced back from the raw source.
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
  // openParen is the `(` matched by findDefHeader (lastIndexOf locates it before closeParen).
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
      continue; // skip unannotated parameters (y has no type)
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
 * Extracts a variable/attribute annotation (`x: int = ...` / `self.x: str`);
 * returns null when unannotated.
 * Anchored at line start (including the self. prefix); positioning happens on
 * the mask, the annotation is sliced back from the raw source.
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

/** Line-level inference hint (inlay): renders label after column `character` of the source line. */
export interface InferredAnnotationHint {
  line: number;
  character: number;
  label: string;
}

interface StubDeclaration {
  name: string;
  key: string;
  line: number;
  text: string;
  signature?: ParsedDefHeader;
  assignment?: { column: number };
  type?: string;
}

function declarations(content: string): StubDeclaration[] {
  const lines = content.split('\n');
  const scopes: Array<{ name: string; indent: number; isFunction: boolean }> = [];
  const result: StubDeclaration[] = [];
  for (const statement of pythonStatements(content)) {
    while (scopes.length && scopes.at(-1)!.indent >= statement.indent) { scopes.pop(); }
    const { line, endLine, indent, text } = statement;
    const definition = /^\s*(?:(async)\s+)?(class|def)\s+([A-Za-z_]\w*)/.exec(text);
    const owner = scopes.map(scope => scope.name).join('.');
    if (definition) {
      const [, , kind, name] = definition;
      const raw = lines.slice(line, endLine + 1).join('\n');
      if (kind === 'def') {
        const signature = parseDefHeaderInLine(raw);
        if (signature) { result.push({ key: `def:${owner}.${name}`, name, line, text: raw, signature }); }
      }
      scopes.push({ name, indent, isFunction: kind === 'def' });
      continue;
    }
    if (scopes.some(scope => scope.isFunction)) { continue; }
    const variable = /^(\s*)([A-Za-z_]\w*)\s*(:|=(?!=))/.exec(text);
    if (!variable) { continue; }
    const [, space, name, operator] = variable;
    const raw = lines.slice(line, endLine + 1).join('\n');
    const item: StubDeclaration = { key: `var:${owner}.${name}`, name, line, text: raw };
    if (operator === '=') {
      item.assignment = { column: space.length + name.length };
    } else {
      const mask = maskPythonNonCode(raw);
      item.type = knownType(annotatedTypeAfterColon(mask, raw, variable[0].length, mask.length));
    }
    result.push(item);
  }
  return result;
}

function knownType(type: string | null | undefined): string | undefined {
  return type && !/\b(?:Incomplete|Unknown|Any)\b/.test(type) ? type : undefined;
}

function addOffsetHint(hints: InferredAnnotationHint[], declaration: StubDeclaration, offset: number, label: string): void {
  const prefix = declaration.text.slice(0, offset).split('\n');
  hints.push({ line: declaration.line + prefix.length - 1, character: prefix.at(-1)!.length, label });
}

/** Bind generated declarations to source declarations by scope and name. */
export function diffGeneratedStubAnnotations(source: string, stub: string): InferredAnnotationHint[] {
  const hints: InferredAnnotationHint[] = [];
  const byKey = new Map<string, StubDeclaration | null>();
  for (const candidate of declarations(stub)) {
    byKey.set(candidate.key, byKey.has(candidate.key) ? null : candidate);
  }
  for (const declaration of declarations(source)) {
    const candidate = byKey.get(declaration.key);
    if (!candidate) { continue; }
    if (declaration.assignment && candidate.type) {
      addOffsetHint(hints, declaration, declaration.assignment.column, `: ${candidate.type}`);
    }
    const signature = declaration.signature;
    if (!signature || !candidate.signature) { continue; }
    const returnType = knownType(candidate.signature.returnType);
    if (!signature.hasReturnArrow && returnType) {
      addOffsetHint(hints, declaration, signature.closeParen + 1, `-> ${returnType}`);
    }
    const parameterTypes = new Map(candidate.signature.params.map(param => [param.name, param.type]));
    for (const param of signature.params) {
      const type = knownType(parameterTypes.get(param.name));
      if (!param.type && type) { addOffsetHint(hints, declaration, param.nameEnd, `: ${type}`); }
    }
  }
  return hints;
}

export function generatedStubSymbol(source: string, stub: string, name: string, line?: number): {
  returnType?: string;
  variableType?: string;
  params: Array<{ name: string; type: string }>;
} | null {
  const sourceMatches = line === undefined ? [] : declarations(source).filter(item => item.name === name && item.line === line);
  const matches = declarations(stub).filter(item => sourceMatches.length === 1
    ? item.key === sourceMatches[0].key
    : item.name === name);
  if (matches.length !== 1) { return null; }
  const [item] = matches;
  const returnType = knownType(item.signature?.returnType);
  const params = (item.signature?.params ?? []).flatMap(param => {
    const type = knownType(param.type);
    return type ? [{ name: param.name, type }] : [];
  });
  return returnType || item.type || params.length ? { returnType, variableType: item.type, params } : null;
}

/**
 * Line-by-line diff of source vs mirror: type annotations present in the
 * mirror but missing in the source -> in-line hint positions.
 * pyrefly writes annotations in place without changing the line count, so a
 * line-count mismatch means structural drift and the whole batch is dropped
 * (prefer missing over wrong); a single-line def header that does not close
 * (multi-line signature) skips that line, degrading gracefully.
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
      // def header diff: return annotation (source lacks the arrow) + same-named parameter annotations (source lacks the colon);
      // when only one side is a def line (same position, different shape) do not force-pair, skip.
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
    // Assignment diff: mirror line `name: Type = ...`, source line a same-named bare assignment `name = ...`.
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
      continue; // the source line is not a bare assignment of that name (already annotated / comparison / other statement)
    }
    hints.push({
      line: i,
      character: srcAssign[1].length + srcAssign[2].length + name.length,
      label: `: ${type}`
    });
  }
  return hints;
}
