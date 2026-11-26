/**
 * KSEM-SER-04: createObjFromDict input dict binding to the FIXED_DICT schema.
 *
 * Engine ground truth (entitydef/datatype.cpp:2673
 * FixedDictType::createFromStreamEx, verified on tree 3082ab5): when
 * hasImpl() holds, the engine first builds the wire FixedDict from the
 * stream in keyTypes_ declaration order (nested FD fields built
 * recursively the same way), then hands **that transport dict** to the
 * user implementation via `impl_createObjFromDict(pydict)` -- so inside
 * the createObjFromDict method body, the parameter name receives exactly
 * the wire-form FD carrying the key slots declared in types.xml. This
 * surface complements the STRUCT-07 contract "memory-form key slots are
 * not taken over": there it is the property read point (memory form =
 * implementation class structure); here it is the transport form itself
 * at the conversion boundary.
 *
 * Three surfaces (acceptance wording: "internal key completion/jump/read
 * type work; diagnostics for wrong keys with reliable context"):
 * - Completion/jump/hover: receiver = the parameter name and not rebound
 *   → key slots = declared fields
 *   (resolveWireDictSubscriptKeyFromContainer, the completion surface
 *   offers all fields);
 * - Diagnostics: string-key reads on the parameter name (`d["k"]` /
 *   `d.get("k")`, including nested chains) are checked against the
 *   declared set; undeclared keys get a Warning -- on the engine side a
 *   FixedDict subscript raises KeyError and .get silently returns the
 *   default, so the static surface is the only place visible in advance;
 *   the first undeclared segment is reported and the chain is stopped
 *   (later keys are based on a wrong prefix -- unreliable, not guessed);
 * - Reliable-context gates: unique binding (same-name multi-class
 *   ambiguity is not guessed), missing method yields zero output, reads
 *   after the parameter is rebound (=/for/with-as) are not judged,
 *   nested def scopes are skipped, comment/string positions are not
 *   judged (mask verification), assignment-target keys are not judged
 *   (reads only).
 *
 * Reused by SER-05 (convertedObjMembers.ts, getDictFromObj obj parameter
 * surface): resolveImplMethodInputs (method name parameterized) and
 * isParamReboundAt / keyAccessAt / KeyAccessMatch / wireFdOfAnnotation /
 * splitTopLevelParams are consumed under the same contract.
 *
 * Pure logic layer; does not import vscode.
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { containerSource, type FixedDictConstructDiagnosticItem } from './fixedDictConstructCheck';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import { resolveWireDictSubscriptKeyFromContainer } from './fixedDictSubscript';
import { type FixedDictImplBinding } from './getDictFromObjReturnCheck';
import { parsePythonFile, pythonCodeLines } from './pythonParser';

export const FIXED_DICT_INPUT_KEY_SCHEMA_DIAGNOSTIC_CODE = 'kbengine.fixedDictInputKeySchema';

/** The input parameter binding surface of one contract method (SER-03
 * binding surface + parameter name and method body scope; SER-04
 * createObjFromDict and SER-05 getDictFromObj surfaces share one shape). */
export interface ImplMethodInputBinding {
  container: CustomTypeInfo;
  symbol: string;
  /** The method's parameter name (first formal parameter besides self/cls). */
  paramName: string;
  /** The def line (0-based; anchors for the signature/arity surface). */
  defLine: number;
  /** The method body scope (0-based lines, endpoints included; from the
   * signature's closing-parenthesis line + 1 to the last non-empty body line). */
  bodyStartLine: number;
  bodyEndLine: number;
}

/** One input-key read mismatch (undeclared key). */
export interface CreateObjFromDictInputKeyFinding {
  line: number;
  /** 0-based character column. */
  character: number;
  length: number;
  /** The FD container type name (the container where key resolution landed). */
  container: string;
  /** The key in question. */
  key: string;
  /** The types.xml declaration location (file:line). */
  source: string;
  message: string;
}

/** Single source of the message template (undeclared-key surface). */
export function renderFixedDictInputKeyMessage(
  container: string,
  key: string,
  source: string
): string {
  return l10nText(
    '"{key}" is not a field of {container} (declared in {source}); the createObjFromDict input dict only carries declared keys, so this subscript raises KeyError at runtime (.get silently returns the default)',
    { container, key, source }
  );
}

/**
 * Derive this document's binding surface from the registry (implementedBy
 * pointing at this document + the final symbol segment) -- the same
 * derivation contract as diagnostics.ts and the three-surface providers.
 */
export function implBindingsForDocument(
  customTypes: readonly CustomTypeInfo[],
  pythonFilePath: string
): FixedDictImplBinding[] {
  return customTypes
    .filter(info => info.implementedBy && info.pythonFilePath === pythonFilePath)
    .map(info => ({ container: info, symbol: info.implementedBy!.split('.').pop() ?? '' }));
}

/** def signature parse result: top-level parameters inside the parentheses
 * plus the line holding the closing parenthesis (0-based; the method body
 * start is derived from it). */
export interface DefSignature {
  params: string[];
  closeLine: number;
}

/** The content inside the def signature parentheses (balanced across lines
 * starting at the def line, using raw lines; unclosed closing parenthesis
 * → null, not guessed). */
export function defSignatureParams(realLines: readonly string[], defLine: number): DefSignature | null {
  let text = '';
  let line = defLine;
  let found = false;
  while (line < realLines.length) {
    const raw = realLines[line] ?? '';
    if (!found) {
      const open = raw.indexOf('(');
      if (open < 0) {
        return null;
      }
      text = raw.slice(open + 1);
      found = true;
    } else {
      text += raw;
    }
    let depth = 1;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote !== null) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          text = text.slice(0, i);
          return { params: splitTopLevelParams(text), closeLine: line };
        }
      }
    }
    line += 1;
  }
  return null;
}

/** Split on top-level commas (parenthesis/quote aware; also used for the
 * SER-05 dict literal key-entry split). */
export function splitTopLevelParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

/** Parameter name: strip the default value (top-level `=`) and annotation
 * (top-level `:`); *args/**kwargs/non-identifier → empty. */
export function paramNameOf(rawParam: string): string {
  let depth = 0;
  let quote: string | null = null;
  let cut = rawParam.length;
  for (let i = 0; i < rawParam.length; i += 1) {
    const ch = rawParam[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (depth === 0 && (ch === '=' || ch === ':')) {
      cut = i;
      break;
    }
  }
  const name = rawParam.slice(0, cut).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return '';
  }
  return name;
}

/**
 * Derive the input-parameter binding surface of every specified contract
 * method in this document (shared derivation contract of SER-04
 * createObjFromDict and SER-05 getDictFromObj): exactly one bound class
 * → method present → signature parseable → parameter name (first formal
 * parameter besides self/cls; none → zero output, a static-method-style
 * single parameter is also accepted).
 * Same-name multi-class ambiguity is not guessed (same contract as
 * SER-03).
 */
export function resolveImplMethodInputs(
  text: string,
  bindings: readonly FixedDictImplBinding[],
  methodName: string,
  allowMissingObj = false
): ImplMethodInputBinding[] {
  const inputs: ImplMethodInputBinding[] = [];
  if (bindings.length === 0) {
    return inputs;
  }
  const parsed = parsePythonFile(text, 'createObjFromDictInput');
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);

  for (const binding of bindings) {
    if (!binding.symbol) {
      continue;
    }
    const classes = parsed.classes.filter(cls => cls.name === binding.symbol);
    if (classes.length !== 1) {
      continue; // same-name multi-class: ambiguity not guessed
    }
    const cls = classes[0];
    const def = cls.methods.get(methodName);
    if (!def) {
      continue; // missing method belongs to the userTypeContract lane; zero output here
    }
    const signature = defSignatureParams(realLines, def.line);
    if (!signature) {
      continue;
    }
    const names = signature.params.map(paramNameOf).filter(name => name !== '' && name !== 'self' && name !== 'cls');
    // SER-07 arity-surface exception (allowMissingObj): no obj besides
    // self/star parameters is exactly the ruling surface itself, so keep
    // the binding (paramName set to empty; the isSameType consumer only
    // uses defLine/body scope, not paramName)
    if (names.length === 0 && !allowMissingObj) {
      continue; // self only: the conversion function receives no dict; zero output, not guessed
    }
    // Method body scope: bounded by the signature's closing-parenthesis
    // line, ending at the first non-empty line with indent <= the def
    // indent (with a multi-line signature the body starts after the
    // continuation lines, so a long signature will not mistake a
    // column-0 continuation line for the first body line)
    const defLine = realLines[def.line] ?? '';
    const defIndent = defLine.length - defLine.trimStart().length;
    let line = signature.closeLine + 1;
    let bodyEnd = signature.closeLine;
    while (line < masked.length) {
      const m = masked[line] ?? '';
      if (m.trim().length > 0 && (m.length - m.trimStart().length) <= defIndent) {
        break;
      }
      if (m.trim().length > 0) {
        bodyEnd = line; // trailing blank lines do not extend the scope (body end anchors the last non-empty line)
      }
      line += 1;
    }
    inputs.push({
      container: binding.container,
      symbol: binding.symbol,
      paramName: names.length > 0 ? names[0] : '',
      defLine: def.line,
      bodyStartLine: signature.closeLine + 1,
      bodyEndLine: bodyEnd
    });
  }
  return inputs;
}

/** SER-04 surface: createObjFromDict input dict binding (specialization of resolveImplMethodInputs). */
export function resolveCreateObjFromDictInputBindings(
  text: string,
  bindings: readonly FixedDictImplBinding[]
): ImplMethodInputBinding[] {
  return resolveImplMethodInputs(text, bindings, 'createObjFromDict');
}

/**
 * Line-level rebinding detection (masked line): the parameter name is
 * reassigned / a for iteration target / a with-as binding → later reads
 * are no longer the original dict/object, so they are unreliable and not
 * judged (shared by the SER-04 input surface and the SER-05 obj surface).
 */
export function isParamReboundAt(maskedLine: string, paramName: string): boolean {
  if (new RegExp(`^\\s*${paramName}\\s*=(?![=])`).test(maskedLine)) {
    return true;
  }
  if (new RegExp(`^\\s*for\\s+${paramName}\\s+in\\b`).test(maskedLine)) {
    return true;
  }
  if (new RegExp(`^\\s*with\\b.*\\bas\\s+${paramName}\\s*:`).test(maskedLine)) {
    return true;
  }
  return false;
}

/**
 * Three-surface receiver resolution: the cursor line is inside the bound
 * method's body, the receiver is exactly the parameter name, and there is
 * no rebinding before the line → the wire container (key slots = the
 * fields declared in types.xml); otherwise null (handed back to the
 * existing chain).
 * Nested def scope: the line falls inside an inner def → what the inner
 * def receives is not this method's parameter; void the result, no
 * guessing.
 */
export function resolveCreateObjFromDictInputReceiver(
  text: string,
  inputs: readonly ImplMethodInputBinding[],
  line: number,
  receiver: string
): CustomTypeInfo | null {
  if (inputs.length === 0) {
    return null;
  }
  const masked = pythonCodeLines(text);
  for (const input of inputs) {
    if (receiver !== input.paramName || line < input.bodyStartLine || line > input.bodyEndLine) {
      continue;
    }
    let cursor = input.bodyStartLine;
    let alive = true;
    while (cursor <= Math.min(line, masked.length - 1)) {
      const m = masked[cursor] ?? '';
      if (m.trim().length > 0) {
        const indent = m.length - m.trimStart().length;
        // Nested def block: the line falls inside the inner scope → the receiver belongs to the inner scope, not taken over
        if (/^\s*def\s/.test(m)) {
          const nestedIndent = indent;
          cursor += 1;
          let nestedEnd = cursor - 1;
          while (cursor < masked.length) {
            const inner = masked[cursor] ?? '';
            if (inner.trim().length > 0 && (inner.length - inner.trimStart().length) <= nestedIndent) {
              break;
            }
            nestedEnd = cursor;
            cursor += 1;
          }
          if (line <= nestedEnd) {
            return null;
          }
          continue;
        }
        if (alive && cursor < line && isParamReboundAt(m, input.paramName)) {
          alive = false;
        }
      }
      cursor += 1;
    }
    if (!alive) {
      return null;
    }
    return input.container;
  }
  return null;
}

/** Scan cursor for key access forms (`["k"]` subscript / `.get("k")`
 * method) on the raw line (shared by the SER-04 input surface and the
 * SER-05 obj surface). */
export interface KeyAccessMatch {
  /** 0-based column (the quote position, or the `get` name position). */
  character: number;
  /** The key string content (inside the quotes, quotes excluded). */
  key: string;
  /** Column of the key string's first character (the diagnostic anchor). */
  keyCharacter: number;
  /** The column right after the access segment. */
  end: number;
  form: 'subscript' | 'get';
}

/** Parse one key access segment starting at column pos; returns null when
 * it is not a key access (numbers/variables/slices break the chain). */
export function keyAccessAt(lineText: string, pos: number): KeyAccessMatch | null {
  if (lineText[pos] === '[') {
    let i = pos + 1;
    while (i < lineText.length && /\s/.test(lineText[i])) {
      i += 1;
    }
    const quote = lineText[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < lineText.length && lineText[j] !== quote && lineText[j] !== '\\') {
        j += 1;
      }
      if (j < lineText.length && lineText[j] === quote) {
        let k = j + 1;
        while (k < lineText.length && /\s/.test(lineText[k])) {
          k += 1;
        }
        if (k >= lineText.length || lineText[k] === ']' || /\s/.test(lineText[k])) {
          return {
            character: pos,
            key: lineText.slice(i + 1, j),
            keyCharacter: i + 1,
            end: k < lineText.length && lineText[k] === ']' ? k + 1 : lineText.length,
            form: 'subscript'
          };
        }
      }
      return null;
    }
    return null; // expression/number/slice subscript: the key is not statically knowable, break the chain
  }
  const getForm = /^\.get\s*\(/.exec(lineText.slice(pos));
  if (!getForm) {
    return null;
  }
  let i = pos + getForm[0].length;
  while (i < lineText.length && /\s/.test(lineText[i])) {
    i += 1;
  }
  const quote = lineText[i];
  if (quote === '"' || quote === "'") {
    let j = i + 1;
    while (j < lineText.length && lineText[j] !== quote && lineText[j] !== '\\') {
      j += 1;
    }
    if (j < lineText.length && lineText[j] === quote) {
      let k = j + 1;
      while (k < lineText.length && /\s/.test(lineText[k])) {
        k += 1;
      }
      if (k >= lineText.length || lineText[k] === ')' || /\s/.test(lineText[k])) {
        return {
          character: pos,
          key: lineText.slice(i + 1, j),
          keyCharacter: i + 1,
          end: k < lineText.length && lineText[k] === ')' ? k + 1 : lineText.length,
          form: 'get'
        };
      }
    }
  }
  return null; // .get(variable): the key is not statically knowable, break the chain
}

/**
 * Input key read validation: string-key reads on the parameter name
 * inside a bound method body (subscript/.get, including nested chains) are
 * checked against the declared set; undeclared keys get a Warning; the
 * first undeclared segment is reported and the chain is stopped.
 * Honest boundaries: assignment-target keys (`d["k"] = v`) are not judged,
 * reads after rebinding are not judged, nested def scopes are skipped,
 * comment/string positions (mask verification) are not judged, and broken
 * key resolution (array/expression subscripts) is not judged.
 */
export function computeCreateObjFromDictInputKeyFindings(
  text: string,
  inputs: readonly ImplMethodInputBinding[],
  customTypes: readonly CustomTypeInfo[]
): CreateObjFromDictInputKeyFinding[] {
  const findings: CreateObjFromDictInputKeyFinding[] = [];
  if (inputs.length === 0) {
    return findings;
  }
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);

  for (const input of inputs) {
    let alive = true;
    let line = input.bodyStartLine;
    while (line <= input.bodyEndLine && line < masked.length) {
      const m = masked[line] ?? '';
      const raw = realLines[line] ?? '';
      if (m.trim().length > 0) {
        const indent = m.length - m.trimStart().length;
        if (/^\s*def\s/.test(m)) {
          // Nested def block: inner code is not judged (scope honesty); skip the whole block
          const nestedIndent = indent;
          line += 1;
          while (line <= input.bodyEndLine && line < masked.length) {
            const inner = masked[line] ?? '';
            if (inner.trim().length > 0 && (inner.length - inner.trimStart().length) <= nestedIndent) {
              break;
            }
            line += 1;
          }
          continue;
        }
        if (alive && isParamReboundAt(m, input.paramName)) {
          alive = false;
          line += 1;
          continue;
        }
      }
      if (alive) {
        findings.push(...inputKeyReadsOnLine(raw, m, line, input, customTypes));
      }
      line += 1;
    }
  }
  return findings;
}

/** Wire-form field annotation → nested FD container (implementedBy
 * containers accepted as-is; non-FD → null and the chain is stopped;
 * shared by the SER-04 input surface and the SER-05 obj surface). */
export function wireFdOfAnnotation(
  annotation: string | null,
  customTypes: readonly CustomTypeInfo[]
): CustomTypeInfo | null {
  if (!annotation) {
    return null;
  }
  return customTypes.find(
    info => info.name === annotation && info.aliasType === FIXED_DICT_TYPE_NAME
  ) ?? null;
}

/** Single-line parameter-name key read scan (keys taken from the raw
 * line, code positions verified against the masked line). */
function inputKeyReadsOnLine(
  rawLine: string,
  maskedLine: string,
  line: number,
  input: ImplMethodInputBinding,
  customTypes: readonly CustomTypeInfo[]
): CreateObjFromDictInputKeyFinding[] {
  const findings: CreateObjFromDictInputKeyFinding[] = [];
  const param = input.paramName;
  const receiverPattern = new RegExp(`(^|[^\\w.])${param}(?![\\w])`, 'g');
  let match: RegExpExecArray | null;
  while ((match = receiverPattern.exec(rawLine)) !== null) {
    const receiverStart = match.index + match[1].length;
    receiverPattern.lastIndex = receiverStart + param.length;
    // Mask verification: the receiver must sit at a code position (same-named forms inside comments/strings are not judged)
    if (maskedLine.slice(receiverStart, receiverStart + param.length) !== param) {
      continue;
    }
    // The receiver must be immediately followed by a key access segment
    // (`[`/`.get(` after whitespace); any other attribute access breaks the chain
    let pos = receiverStart + param.length;
    while (pos < rawLine.length && /\s/.test(rawLine[pos])) {
      pos += 1;
    }
    const accesses: KeyAccessMatch[] = [];
    while (pos < rawLine.length) {
      const access = keyAccessAt(rawLine, pos);
      if (!access) {
        break;
      }
      accesses.push(access);
      // After a segment the chain may continue (`["k2"]`/`.get("k2")`);
      // anything else (method calls/attributes) stops the chain
      let next = access.end;
      while (next < rawLine.length && /\s/.test(rawLine[next])) {
        next += 1;
      }
      if (next < rawLine.length && (rawLine[next] === '[' || /^\.get\s*\(/.test(rawLine.slice(next)))) {
        pos = next;
        continue;
      }
      pos = next;
      break;
    }
    if (accesses.length === 0) {
      continue;
    }
    // Assignment-target key (a `=` that is not ==/>= after the last
    // segment): the write surface is not judged (reads only);
    // `+=`/`==`/`!=` and other comparison/augmented forms are judged as
    // usual -- the runtime reads that key first as well
    if (/^\s*=(?![=>])/.test(rawLine.slice(pos))) {
      continue;
    }
    // Walk the chain segment by segment: look up the key on the current
    // container; undeclared → report and stop the chain (later segments are
    // based on a wrong prefix, so unreliable)
    let container: CustomTypeInfo | null = input.container;
    for (const access of accesses) {
      if (!container) {
        break; // an earlier field is not an FD (scalar/array/unparseable): the nested key's container is not guessed
      }
      const resolution = resolveWireDictSubscriptKeyFromContainer(container, [], access.key, customTypes);
      if (!resolution?.field) {
        const source = containerSource(container);
        findings.push({
          line,
          character: access.keyCharacter,
          length: Math.max(1, access.key.length),
          container: container.name,
          key: access.key,
          source,
          message: renderFixedDictInputKeyMessage(container.name, access.key, source)
        });
        break;
      }
      // Declared: the next segment's container = the wire FD resolved from
      // the field annotation (nested implementedBy containers accepted as-is)
      container = wireFdOfAnnotation(resolution.annotation, customTypes);
    }
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic,与构造点同形状)。 */
export function createObjFromDictInputFindingToItem(
  finding: CreateObjFromDictInputKeyFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: FIXED_DICT_INPUT_KEY_SCHEMA_DIAGNOSTIC_CODE
  };
}
