// GEN-DEF-1e ④: direction-violation diagnostics (property face) — accesses
// to def properties in Python scripts are flagged Warning when the access
// position (process scope / receiver segment) falls outside the three
// domains derived from the property Flags; the process scope is inferred
// from what the py file's own section is known to be, and when that is not
// enough it degrades to Information (never Error, user order "when unsure,
// flag info, not error").
//
// cellData channel (absorbed from a 2026-11-10 user bug report): baseapp
// automatically fills in a self.cellData dict for entities carrying a cell
// part (kbe/src/server/baseapp/entity.cpp:238; createCellData:250-308 loads
// the defaults of every cell-bucket property plus position/direction; at
// cell creation the whole dict streams to cellapp as the initial values,
// baseapp.cpp:2561) — on the base side the legitimate channel for a cell
// property is self.cellData["x"], not the bare property. Analysis emits two
// streams:
//   diagnostic stream (underline): true direction violations (Warning) and
//     insufficient scope (Information);
//   hint stream (pale inline text, user order 2026-11-10 "no underlines, it
//     reads too easily as an error" and "just hint the copied property's
//     beginning, changing the color is enough"):
//     1) copied property: when __init__ reads self.y = self.cellData["x"],
//        y is the base-side copy of the cell-side def field x — the
//        assignment line and the bare access render
//        "copied property x: <type> · <domains>";
//     2) the key of cellData["key"] is resolved against the def: a def key
//        renders the key's def face "key: <type> · <domains>", and when the
//        domains lack cell, "not in cellData" is appended; non-def keys
//        (position/direction/script-added keys) are always skipped, never
//        invented.
//     Assignments in __init__ whose right side is not cellData: not shown
//     and not reported for now (user order "just copied properties for
//     now"), handled purely as false-positive suppression (no longer
//     flagged Warning).
//
// Method-face direction violations are already covered by
// receiverNoneDiagnostics' sectionMismatch (kbengine.sectionMismatch); this
// module only adds the property face (property Flags domains).
//
// Pure logic layer, does not import vscode: scans self.<property path> /
// self.<role>.<property path> accesses; property domains arrive via an
// external resolver's reply (same index and same contract as the property
// CodeLens — the provider layer assembles the
// EntityMappingManager.resolvePropertyDefinitionInfo replies into
// PropertyDirectionHit); this layer never reads def files itself.

import { findPythonSelfPropertyAccesses } from './propertyCodeLens';
import { l10nText } from '../nlsRuntime';
import { inferMethodSectionFromPythonFile } from '../entityMapping';
import { pythonStatements } from './pythonParser';
import type { PropertyFlagDomain } from './defAnalyzer';

export const PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionViolation';
export const PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionScopeUnknown';
/** __init__ shadow property (plain assignment): a same-named property maintained by the script, false-positive suppression so no Warning */
export const PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionShadowAttribute';
/** Copied-property hint: the right side reads from self.cellData; the hint marks a copy of a cell-side field's value */
export const PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionCellDataCopy';
/** The key of cellData["key"] resolved against the def (including the "not in cellData" marker) */
export const PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionCellDataKey';
export const PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** The three process-scope domains (same terms as the property domains) */
export type PropertyDirectionScope = 'base' | 'cell' | 'client';

/**
 * Process-scope inference from what the py file's section is known to be
 * (demo asset directories scripts/base|cell|client|bots).
 * Same contract as inferMethodSectionFromPythonFile (same path rules at the
 * source), only mapping the def method section back to a scope name;
 * non-role directories (scripts/common/, root level) return undefined =
 * insufficient.
 */
export function inferProcessScopeFromPythonFile(
  filePath: string
): PropertyDirectionScope | undefined {
  switch (inferMethodSectionFromPythonFile(filePath)) {
    case 'BaseMethods':
      return 'base';
    case 'CellMethods':
      return 'cell';
    case 'ClientMethods':
      return 'client';
    default:
      return undefined;
  }
}

/** The def declaration face of one property access (minimal face the direction ruling needs; domains derived from Flags) */
export interface PropertyDirectionHit {
  propertyName: string;
  domains: PropertyFlagDomain[];
  defFile: string;
  defLine: number;
  /** def <Type> verbatim text (for copied-property/cellData key hint display; omitted when there is no type segment) */
  typeName?: string;
}

export interface PropertyDirectionFinding {
  /** Access line (0-based) */
  line: number;
  /** Start column of the property name within the access line (0-based; a receiver qualifier has already skipped self.<role>.) */
  character: number;
  /** Property name length (highlight range) */
  length: number;
  /** Property path (receiver prefix stripped, e.g. cell.hp → hp) */
  propertyPath: string;
  /** Receiver of self.<role>.<prop> (when present the access domain = the receiver) */
  receiver?: PropertyDirectionScope;
  /** File scope (without a receiver the access domain = the file scope) */
  fileScope?: PropertyDirectionScope;
  domains: PropertyFlagDomain[];
  message: string;
  severity: 'Warning' | 'Information';
  code: string;
  /** RHS key name of the copied-property/cellData key stream (for hint display) */
  cellDataKey?: string;
  /** Hint anchor column (after the self.<name> token / the cellData access expression; used by the hint stream) */
  endCharacter?: number;
  /** def <Type> verbatim text (for hint display; absent when resolution missed) */
  typeName?: string;
  /** def declaration file (hint-stream navigation target; absent when resolution missed) */
  defFile?: string;
  /** def declaration line (0-based; hint-stream navigation target) */
  defLine?: number;
}

/** Receiver segment → property domain (one-to-one with PYTHON_RECEIVER_SECTIONS segment names) */
const RECEIVER_SCOPE: Record<string, PropertyDirectionScope> = {
  cell: 'cell',
  base: 'base',
  client: 'client'
};

const domainLabel = (domains: readonly PropertyFlagDomain[]): string =>
  domains.length > 0 ? domains.join('|') : l10nText('(Flags not configured)');

/** Position face of one self.<name> = assignment inside __init__ */
export interface InitAssignmentSite {
  /** Assignment line (0-based) */
  line: number;
  /** End column of the self.<name> token (0-based; the copied-property inlay anchors after it) */
  character: number;
}

/** Scan-result face of the self.<property> = assignments inside __init__ */
export interface InitAssignedSelfProperties {
  /** Property names assigned in __init__ (the full shadow-property set, the false-positive suppression face) */
  names: Set<string>;
  /** Name → assignment position (after the self.<name> token) */
  sites: Map<string, InitAssignmentSite>;
  /** Name → the cellData key its RHS reads (the x of self.y = self.cellData["x"]) */
  cellDataCopyKeys: Map<string, string>;
}

/**
 * Scan of the self.<property> = assignments inside __init__ (pure line scan,
 * the same conservative lexical face as the module — no vscode import, no
 * AST): a script assigning a same-named property inside __init__
 * (self.spaceUType = self.cellData["spaceUType"] etc.) declares a
 * "self-maintained shadow property" — bare accesses outside the engine's
 * domain are no longer dead references (the engine's GenericGetAttr lands
 * on the shadow value in the instance __dict__), so false-positive
 * suppression stops flagging Warning (user order). Right sides reading
 * self.cellData have their key names recorded (2026-11-10 user order: the
 * hint is the copy value of the matching cell property, carrying
 * key/type/domains). Each class scans independently; the scan stops once
 * __init__ exits its block (indent falls back); `==`/`+=`/annotated
 * assignments do not count (conservative, prefer misses over wrong hits).
 */
export function findInitAssignedSelfProperties(text: string): InitAssignedSelfProperties {
  const names = new Set<string>();
  const sites = new Map<string, InitAssignmentSite>();
  const cellDataCopyKeys = new Map<string, string>();
  let initIndent = -1;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const defMatch = /^(\s*)def\s+__init__\s*\(/.exec(line);
    if (defMatch) {
      initIndent = defMatch[1].length;
      continue;
    }
    if (initIndent < 0) {
      continue;
    }
    if (line.trim() === '') {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= initIndent) {
      initIndent = -1; // block exited; the next def __init__ (next class) re-enters
      continue;
    }
    const assign = /^(\s*)self\.(\w+)\s*=(?!=)(.*)$/.exec(line);
    if (!assign) {
      continue;
    }
    const name = assign[2];
    names.add(name);
    sites.set(name, {
      line: index,
      character: assign[1].length + 'self.'.length + name.length
    });
    const cellKey = /self\.cellData\s*(?:\[\s*(["'])([^"'\]]+)\1|\.get\s*\(\s*(["'])([^"')]+)\3)/
      .exec(assign[3] ?? '');
    const key = cellKey?.[2] ?? cellKey?.[4];
    if (key) {
      cellDataCopyKeys.set(name, key);
    }
  }
  return { names, sites, cellDataCopyKeys };
}

/** Structure face of one self.cellData["key"] / self.cellData.get("key") access */
export interface CellDataKeyAccess {
  /** Access line (0-based) */
  line: number;
  /** Key start column (0-based, UTF-16 code units; quotes excluded) */
  character: number;
  /** Key length (highlight range) */
  length: number;
  /** End column of the whole access expression (the inlay hint anchors after it) */
  accessEnd: number;
  key: string;
}

const CELL_DATA_ACCESS_PATTERN =
  /self\.cellData\s*(?:\[\s*(["'])([^"'\]]+)\1\s*\]|\.get\s*\(\s*(["'])([^"')]+)\3)/g;

/**
 * Scans the whole text for self.cellData["key"] / self.cellData.get("key")
 * accesses (the same plain line-level regex as
 * findPythonSelfPropertyAccesses, same contract, no masking).
 * Positions point at the key itself (inside the quotes) for hint anchoring;
 * accessEnd points at the end of the expression.
 */
export function findCellDataKeyAccesses(text: string): CellDataKeyAccess[] {
  const accesses: CellDataKeyAccess[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    CELL_DATA_ACCESS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CELL_DATA_ACCESS_PATTERN.exec(lines[index])) !== null) {
      const key = match[2] ?? match[4];
      if (!key) {
        continue;
      }
      accesses.push({
        line: index,
        character: match.index + match[0].indexOf(key),
        length: key.length,
        accessEnd: match.index + match[0].length,
        key
      });
    }
  }
  return accesses;
}

/** One lexical scan bundle (three scan faces: the Rust face can supply it since AUDIT-005 B2 batch 7, shared by the ruling core) */
export interface PropertyDirectionScanBundle {
  accesses: ReturnType<typeof findPythonSelfPropertyAccesses>;
  initAssigned: InitAssignedSelfProperties;
  cellDataAccesses: CellDataKeyAccess[];
}

interface CellDataCopyScope {
  keys: Map<string, string | null>;
  assignments: Map<number, { name: string; key: string }>;
}

/** Resolve direct copy origins inside each class, independently of the scanner backend. */
function scanCellDataCopyScopes(text: string): Map<number, CellDataCopyScope> {
  const byLine = new Map<number, CellDataCopyScope>();
  if (!text.includes('self.cellData')) { return byLine; }
  const lines = text.split(/\r?\n/);
  const stack: Array<{ indent: number; scope?: CellDataCopyScope; method?: boolean }> = [];
  for (const statement of pythonStatements(text)) {
    const { line, endLine, indent } = statement;
    while (stack.length && stack[stack.length - 1].indent >= indent) { stack.pop(); }
    const parent = stack[stack.length - 1];
    if (/^\s*class\s+\w+/.test(statement.text)) {
      stack.push({ indent, scope: { keys: new Map(), assignments: new Map() } });
      continue;
    }
    if (/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(statement.text)) {
      const method = parent?.scope !== undefined && !parent.method
        && /^\s*(?:async\s+)?def\s+\w+\s*\(\s*self\s*(?=[,):])/.test(statement.text);
      stack.push({ indent, scope: method ? parent.scope : undefined, method });
      continue;
    }
    if (!parent?.method || !parent.scope) { continue; }
    const { scope } = parent;
    for (let row = line; row <= endLine; row += 1) { byLine.set(row, scope); }
    const target = /^\s*self\.([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(statement.text);
    if (!target) { continue; }
    const name = target[1];
    const rhs = statement.text.slice(target[0].length);
    const direct = /^\s*\(*\s*self\.cellData\s*(?:\[|\.get\s*\()/.test(rhs);
    const rawKey = direct
      ? /^\s*\(*\s*self\.cellData\s*(?:\[\s*(["'])([^"'\r\n]+)\1\s*\]|\.get\s*\(\s*(["'])([^"'\r\n]+)\3)/.exec(
        lines.slice(line, endLine + 1).join('\n').slice(target[0].length)
      )
      : null;
    const key = rawKey?.[2] ?? rawKey?.[4];
    if (key !== undefined) { scope.assignments.set(line, { name, key }); }
    // When a destination has multiple possible origins, keep each
    // assignment's own hint and leave other reads to normal resolution.
    const previous = scope.keys.get(name);
    scope.keys.set(name, key !== undefined && (previous === undefined || previous === key) ? key : null);
  }
  return byLine;
}

/** Local scan bundle (fallback and default path; the Rust face supplies the same shape, zero divergence in the ruling core) */
export function scanBundleOf(text: string): PropertyDirectionScanBundle {
  return {
    accesses: findPythonSelfPropertyAccesses(text),
    initAssigned: findInitAssignedSelfProperties(text),
    cellDataAccesses: findCellDataKeyAccesses(text)
  };
}

/**
 * Property direction-violation ruling (pure function): for each
 * self.<prop> / self.<role>.<prop> access where the property has a def
 * declaration (resolver hit) and the access domain falls outside the Flags
 * domains → Warning; a bare self.<prop> without receiver plus an
 * insufficient file scope → Information (downgraded, never Error).
 * Resolver misses (non-def properties / pure python properties) are always
 * skipped, never diagnosed.
 * bundle defaults to the local scan; when the Rust face
 * (buildPropertyDirectionScanBundleWithRust) supplies the same shape, the
 * ruling core is bit-for-bit the same semantics (both streams fully
 * preserved, message rendering stays in this module).
 */
export function findPropertyDirectionFindings(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  bundle: PropertyDirectionScanBundle = scanBundleOf(text),
  copyScopes = inferProcessScopeFromPythonFile(filePath) === 'base' ? scanCellDataCopyScopes(text) : undefined
): PropertyDirectionFinding[] {
  const fileScope = inferProcessScopeFromPythonFile(filePath);
  const initAssigned = bundle.initAssigned;
  const findings: PropertyDirectionFinding[] = [];
  // Bare accesses already covered by a copied-property hint (line\u0000name):
  // when the assignment-line LHS is also hit by the access scan, the
  // assignment-position hint is not emitted twice
  const emitted = new Set<string>();

  for (const access of bundle.accesses) {
    const segments = access.fullPath.split('.');
    const root = segments[0] ?? '';
    let receiver: PropertyDirectionScope | undefined;
    let propertyPath = access.fullPath;
    if (RECEIVER_SCOPE[root] && segments.length >= 2) {
      receiver = RECEIVER_SCOPE[root];
      propertyPath = segments.slice(1).join('.');
    }

    // The destination is a Base instance attribute. Its type and navigation
    // come from the Cell key, even when its own name has no def declaration.
    const copyScope = copyScopes?.get(access.line);
    const assignment = copyScope?.assignments.get(access.line);
    const copiedKey = receiver ? undefined
      : (assignment?.name === root ? assignment.key : copyScope?.keys.get(root)) ?? undefined;
    const copiedFrom = copiedKey === undefined ? undefined : resolve(copiedKey, copiedKey);
    if (copiedKey !== undefined && copiedFrom?.domains.includes('cell')) {
      emitted.add(`${access.line}\u0000${root}`);
      findings.push({
        line: access.line,
        character: access.character,
        length: root.length,
        propertyPath,
        fileScope,
        domains: copiedFrom.domains,
        severity: 'Information',
        code: PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
        cellDataKey: copiedKey,
        endCharacter: access.character + root.length,
        typeName: copiedFrom.typeName,
        defFile: copiedFrom.defFile,
        defLine: copiedFrom.defLine,
        message: l10nText(
          'Base copy of self.cellData["{key}"] (DEF domains: {domains}). The value depends on whether the assignment has run.',
          { key: copiedKey, domains: domainLabel(copiedFrom.domains) }
        )
      });
      continue;
    }

    const hit = resolve(propertyPath, propertyPath.split('.')[0]);
    if (!hit) {
      continue; // not a def property, not diagnosed
    }
    const domains = hit.domains;
    // Property-name token column: a bare self.<prop> starts at the root; a receiver qualifier skips self.<role>.
    const charStart = receiver
      ? access.character + root.length + 1
      : access.character;

    const accessedDomain = receiver ?? fileScope;
    if (!accessedDomain) {
      // No receiver and insufficient file scope (not under one of the six role directory sections): downgraded to reference info
      findings.push({
        line: access.line,
        character: charStart,
        length: propertyPath.length,
        propertyPath,
        receiver,
        fileScope,
        domains,
        severity: 'Information',
        code: PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE,
        message: l10nText(
          'Cannot determine the process scope of {path} (file not under scripts/base|cell|client|bots); direction check downgraded to reference info (not Error)',
          { path: propertyPath }
        )
      });
      continue;
    }

    if (domains.length === 0) {
      continue; // Flags not configured → no domain to judge, the direction is never invented
    }
    if (!domains.includes(accessedDomain)) {
      // False-positive suppression: a same-named property assigned in this
      // file's __init__ = a script-maintained shadow property; bare accesses
      // outside the engine's domain land on the shadow value in the instance
      // __dict__ and are no longer dead references — no Warning (user order
      // "no underlines"); right sides reading self.cellData additionally emit
      // a "copied property" hint (with key/type/domains, user order "just hint
      // the copied property's beginning"); receiver-qualified forms
      // (self.base.x etc.) do not go through entity property resolution, the
      // shadow does not apply, and the original ruling stands.
      const shadowRoot = propertyPath.split('.')[0];
      if (!receiver && initAssigned.names.has(shadowRoot)) {
        const cellKey = initAssigned.cellDataCopyKeys.get(shadowRoot);
        if (cellKey !== undefined) {
          emitted.add(`${access.line}\u0000${shadowRoot}`);
        }
        findings.push({
          line: access.line,
          character: charStart,
          length: propertyPath.length,
          propertyPath,
          receiver,
          fileScope,
          domains,
          severity: 'Information',
          code: cellKey !== undefined
            ? PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE
            : PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE,
          ...(cellKey !== undefined
            ? {
              cellDataKey: cellKey,
              endCharacter: charStart + propertyPath.length,
              typeName: hit.typeName,
              defFile: hit.defFile,
              defLine: hit.defLine,
              message: l10nText(
                'base-side copy of the cell def field {key} — assigned in __init__ from self.cellData; the engine syncs {key} only to the {domains} domain, reads here see the copy',
                { key: cellKey, domains: domainLabel(domains) }
              )
            }
            : {
              message: l10nText(
                'self.{path} is assigned in __init__ — script-maintained attribute shadowing the def field (the engine syncs {path} only to the {domains} domain)',
                { path: propertyPath, domains: domainLabel(domains) }
              )
            })
        });
        continue;
      }
      const detail = receiver
        ? l10nText('not reachable via the {receiver} side (the engine stores per domain; cross-domain references break)', { receiver: receiver as string })
        : l10nText('access in the {scope} section is outside its domain', { scope: fileScope as PropertyDirectionScope });
      findings.push({
        line: access.line,
        character: charStart,
        length: propertyPath.length,
        propertyPath,
        receiver,
        fileScope,
        domains,
        severity: 'Warning',
        code: PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
        message: l10nText(
          'self.{prefix}{path} direction violation: {path} declared in the {domains} domain; {detail}',
          {
            prefix: receiver ? `${receiver}.` : '',
            path: propertyPath,
            domains: domainLabel(domains),
            detail
          }
        )
      });
    }
  }

  // Copied-property hint (assignment position): after the self.y of
  // self.y = self.cellData["x"], render the key's def face — when the bare
  // access hint already covers the same line and name, do not emit twice
  // (user order "just hint the copied property's beginning"); assignments
  // whose right side is not cellData are not shown for now (user order
  // "copied properties only for now").
  for (const [name, site] of initAssigned.sites) {
    const key = initAssigned.cellDataCopyKeys.get(name);
    if (key === undefined || emitted.has(`${site.line}\u0000${name}`)) {
      continue;
    }
    const keyHit = resolve(key, key);
    if (!keyHit || keyHit.domains.length === 0) {
      continue; // the key is not a def property / Flags not configured → the def face is unknown, prefer missing over wrong
    }
    findings.push({
      line: site.line,
      character: site.character - name.length,
      length: name.length,
      propertyPath: name,
      domains: keyHit?.domains ?? [],
      severity: 'Information',
      code: PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
      cellDataKey: key,
      endCharacter: site.character,
      typeName: keyHit?.typeName,
      defFile: keyHit?.defFile,
      defLine: keyHit?.defLine,
      message: l10nText(
        'base-side copy of the cell def field {key} — assigned in __init__ from self.cellData; the engine syncs {key} only to the {domains} domain, reads here see the copy',
        { key, domains: domainLabel(keyHit?.domains ?? []) }
      )
    });
  }

  // cellData key hints: each key of self.cellData["key"] is resolved against
  // the def — a def key renders the key's def face (key: type · domains),
  // with "not in cellData" appended when the domains lack cell (the engine
  // never puts it into cellData); non-def keys (position/direction
  // engine-added keys, script-added keys) are always skipped, never
  // invented.
  for (const access of bundle.cellDataAccesses) {
    const hit = resolve(access.key, access.key);
    if (!hit || hit.domains.length === 0) {
      continue; // non-def key / Flags not configured → no domain to judge, never invented
    }
    const carries = hit.domains.includes('cell');
    findings.push({
      line: access.line,
      character: access.character,
      length: access.length,
      propertyPath: access.key,
      domains: hit.domains,
      severity: 'Information',
      code: PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE,
      cellDataKey: access.key,
      endCharacter: access.accessEnd,
      typeName: hit.typeName,
      defFile: hit.defFile,
      defLine: hit.defLine,
      message: carries
        ? l10nText(
          'cellData["{key}"] carries the {domains} def field — the cell side writes it, base reads the copy here',
          { key: access.key, domains: domainLabel(hit.domains) }
        )
        : l10nText(
          'cellData["{key}"] never carries this def field: the {domains} domain set has no cell part, so the engine does not put it into cellData',
          { key: access.key, domains: domainLabel(hit.domains) }
        )
    });
  }
  findings.sort((left, right) =>
    left.line - right.line || left.character - right.character
  );
  return findings;
}

/** Which codes go to the hint stream (everything besides underlines); the diagnostic stream emits only violations and insufficient scope */
const HINT_STREAM_CODES = new Set([
  PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE
]);

const DIAGNOSTIC_STREAM_CODES = new Set([
  PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE
]);

/**
 * Hint short copy (user order "just hint the copied property's beginning"):
 * copied property = "copied property key: type · cell"; cellData key =
 * "key: type · cell".
 * The label shows the cell face (user order 2026-11-11: what the base side
 * reads is exactly the copy synced from the cell side; the bare union
 * cell|client is noise); when the domains lack cell, keep the original
 * domains and append "not in cellData" (the engine never puts it into
 * cellData, so the copy can never read a value).
 * The full domain union stays in the hover text (same source as the
 * diagnostic message); no information is lost.
 */
export function shadowHintLabelOf(finding: PropertyDirectionFinding): string {
  const inCellData = finding.domains.includes('cell');
  const detail =
    (finding.typeName ? `: ${finding.typeName}` : '') +
    (finding.domains.length > 0 ? ` · ${inCellData ? 'cell' : domainLabel(finding.domains)}` : '');
  if (finding.code === PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE) {
    const label = l10nText('copied property {key}{detail}', {
      key: finding.cellDataKey ?? finding.propertyPath,
      detail
    });
    return inCellData ? label : `${label} · ${l10nText('not in cellData')}`;
  }
  const label = l10nText('{key}{detail}', {
    key: finding.cellDataKey ?? finding.propertyPath,
    detail
  });
  return inCellData ? label : `${label} · ${l10nText('not in cellData')}`;
}

/** Pure-data shape of one pale inline hint (the provider layer converts to vscode.InlayHint, tests stay vscode-free) */
export interface PropertyDirectionShadowHintItem {
  /** Anchor (after the self.<name> token / the cellData access expression) */
  position: { line: number; character: number };
  /** Short copy ("copied property …" / "key: type · cell") */
  label: string;
  /** Hover full text (same source as the diagnostic-level explanation; the full domain union lives here) */
  tooltip: string;
  code: string;
  /** def declaration landing spot (file path + 0-based line; same navigation face as non-copy hints' F12; absent when resolution missed) */
  location?: { uri: string; line: number };
}

/**
 * Hint stream entry (sync): enabled=false at the switch yields nothing;
 * emits only the two pale inline hint kinds — copied property and cellData
 * key — and never an underline (user order).
 */
export function propertyDirectionShadowHintItems(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  enabled: boolean
): PropertyDirectionShadowHintItem[] {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindings(text, filePath, resolve)
    .filter(finding => HINT_STREAM_CODES.has(finding.code))
    .map(finding => ({
      position: {
        line: finding.line,
        character: finding.endCharacter ?? finding.character + finding.length
      },
      label: shadowHintLabelOf(finding),
      tooltip: finding.message,
      code: finding.code,
      ...(finding.defFile !== undefined && finding.defLine !== undefined
        ? { location: { uri: finding.defFile, line: finding.defLine } }
        : {})
    }));
}

/**
 * Async face: first pre-resolve all deduplicated accesses by
 * (propertyPath, rootSymbol) (async resolver, e.g.
 * EntityMappingManager.resolvePropertyDefinitionInfo), then run
 * findPropertyDirectionFindings with a sync lookup-table resolver — the
 * pure ruling logic is duplicated zero times, same contract as the
 * property CodeLens's "an access to the same property in many places
 * resolves once". bundle defaults to the local scan; when the Rust face
 * supplies the same shape, pre-resolution and the ruling core share one
 * bundle (zero double scans).
 */
export async function findPropertyDirectionFindingsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>,
  bundle: PropertyDirectionScanBundle = scanBundleOf(text)
): Promise<PropertyDirectionFinding[]> {
  const cache = new Map<string, PropertyDirectionHit | null>();
  const syncResolve = (
    propertyPath: string,
    rootSymbol: string
  ): PropertyDirectionHit | null | undefined => cache.get(`${propertyPath}\u0000${rootSymbol}`);

  for (const access of bundle.accesses) {
    const segments = access.fullPath.split('.');
    const root = segments[0] ?? '';
    let propertyPath = access.fullPath;
    if (RECEIVER_SCOPE[root] && segments.length >= 2) {
      propertyPath = segments.slice(1).join('.');
    }
    const rootSymbol = propertyPath.split('.')[0];
    const key = `${propertyPath}\u0000${rootSymbol}`;
    if (!cache.has(key)) {
      cache.set(key, (await resolve(propertyPath, rootSymbol)) ?? null);
    }
  }
  // cellData keys and copied-property keys are pre-resolved too: the sync
  // core goes through resolve as well, and a missed pre-resolution would
  // let a cache miss (get returning undefined) be silently treated as a
  // "non-def property"
  const cellKeys = new Set<string>([
    ...bundle.cellDataAccesses.map(access => access.key),
    ...bundle.initAssigned.cellDataCopyKeys.values()
  ]);
  const copyScopes = inferProcessScopeFromPythonFile(filePath) === 'base' ? scanCellDataCopyScopes(text) : undefined;
  for (const scope of new Set(copyScopes?.values())) {
    for (const assignment of scope.assignments.values()) { cellKeys.add(assignment.key); }
  }
  for (const key of cellKeys) {
    const cacheKey = `${key}\u0000${key}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, (await resolve(key, key)) ?? null);
    }
  }
  return findPropertyDirectionFindings(text, filePath, syncResolve, bundle, copyScopes);
}

/**
 * Diagnostic items (pure data; the extension side converts to
 * vscode.Diagnostic, tests stay vscode-free): emits only true violations
 * (Warning) and insufficient scope (Information); shadow/copied property/
 * cellData keys travel the hint stream (see
 * propertyDirectionShadowHintItems), no underlines.
 */
export function propertyDirectionDiagnosticItems(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  enabled: boolean
): PropertyDirectionDiagnosticItem[] {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindings(text, filePath, resolve)
    .filter(finding => DIAGNOSTIC_STREAM_CODES.has(finding.code))
    .map(finding => ({
      range: {
        start: { line: finding.line, character: finding.character },
        end: { line: finding.line, character: finding.character + finding.length }
      },
      message: finding.message,
      severity: finding.severity,
      source: 'kbengine' as const,
      code: finding.code
    }));
}

/** Hint stream entry (async): sync ruling after pre-resolving dedup, one analysis core shared with the diagnostic stream; bundle defaults to the local scan (zero double scans when the Rust face supplies the same shape, batch 7) */
export async function propertyDirectionShadowHintItemsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>,
  enabled: boolean,
  bundle?: PropertyDirectionScanBundle
): Promise<PropertyDirectionShadowHintItem[]> {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindingsAsync(text, filePath, resolve, bundle)
    .then(findings => findings
      .filter(finding => HINT_STREAM_CODES.has(finding.code))
      .map(finding => ({
        position: {
          line: finding.line,
          character: finding.endCharacter ?? finding.character + finding.length
        },
        label: shadowHintLabelOf(finding),
        tooltip: finding.message,
        code: finding.code,
        ...(finding.defFile !== undefined && finding.defLine !== undefined
          ? { location: { uri: finding.defFile, line: finding.defLine } }
          : {})
      })));
}

/**
 * Entry (async): enabled=false at the switch yields nothing; the resolver
 * is async (sync ruling after pre-resolving dedup, the same emission
 * contract as the sync entry).
 */
export async function propertyDirectionDiagnosticItemsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>,
  enabled: boolean,
  bundle?: PropertyDirectionScanBundle
): Promise<PropertyDirectionDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindingsAsync(text, filePath, resolve, bundle)
    .then(findings => findings
      .filter(finding => DIAGNOSTIC_STREAM_CODES.has(finding.code))
      .map(finding => ({
        range: {
          start: { line: finding.line, character: finding.character },
          end: { line: finding.line, character: finding.character + finding.length }
        },
        message: finding.message,
        severity: finding.severity,
        source: 'kbengine' as const,
        code: finding.code
      })));
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests stay vscode-free) */
export interface PropertyDirectionDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning' | 'Information';
  source: 'kbengine';
  code: string;
}
