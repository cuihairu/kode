/**
 * Property access lenses (batch 135 user order: "you can jump from
 * types.xml to the concrete code, but the code has no similar type marker
 * for the reverse jump"). Python scripts carry no type name to attach to,
 * so the workable equivalent is one CodeLens line at each self.<property>
 * access, titled with the type and visibility domains declared by the def,
 * clicking back to the def declaration line.
 *
 * Pure logic layer, does not import vscode: scans self.<property path>
 * accesses + builds line titles from an external resolver's reply; the
 * provider layer (languageProviders) assembles the resolver replies into
 * vscode.CodeLens. Resolver replies go through
 * EntityMappingManager.resolvePropertyDefinitionInfo — the same index and
 * the same contract as property F12 reverse jump; this layer never reads
 * def files itself.
 *
 * Known boundary: only the self.<property path> shape is recognized (same
 * contract as property F12's getPythonSelfAccessAtPosition); the engine's
 * self.get('property')/self.set('property', value) API shape is out of
 * scope.
 */

import type { PropertyFlagDomain } from './defAnalyzer';

/** One self.<property> access in a Python script (position contract same source as the declaration-line resolver) */
export interface PythonSelfPropertyAccess {
  /** Document line (0-based) */
  line: number;
  /** Start column of the root segment (property name) within the access line (0-based) */
  character: number;
  /** Root segment of self.<x.y> */
  rootSymbol: string;
  /** Full path of self.<x.y>, same contract as resolvePropertyDefinition's fullPath */
  fullPath: string;
}

/** The def declaration face of one property access (the minimal face a CodeLens title and jump need) */
export interface PropertyCodeLensHit {
  /** Property name declared by the def (a FIXED_DICT sub-key uses the key name) */
  propertyName: string;
  /** Slot name for component-slot property hits (e.g. Inventory.items); omitted when there is no slot */
  componentSlotName?: string;
  /** <Type> verbatim text (alias not expanded); null when undeclared */
  typeName: string | null;
  /** Visibility domains derived from the Flags bit set, ordered base → cell → client */
  domains: PropertyFlagDomain[];
  persistent: boolean;
  defFile: string;
  /** def declaration line (1-based) */
  defLine: number;
}

export interface PropertyCodeLensSpec {
  access: PythonSelfPropertyAccess;
  hit: PropertyCodeLensHit;
  title: string;
}

/** Same regex as pythonLanguageUtils.getPythonSelfAccessAtPosition; no separate contract is written */
const PYTHON_SELF_ACCESS_PATTERN = /\bself\.(\w+(?:\.\w+)*)/g;

/** Resolve/dedup key: both the root segment and the full path take part (FIXED_DICT nesting falls back to the parent path) */
export const propertyAccessKey = (access: PythonSelfPropertyAccess): string =>
  `${access.rootSymbol}\u0000${access.fullPath}`;

export function findPythonSelfPropertyAccesses(text: string): PythonSelfPropertyAccess[] {
  const accesses: PythonSelfPropertyAccess[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    PYTHON_SELF_ACCESS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PYTHON_SELF_ACCESS_PATTERN.exec(lines[index])) !== null) {
      const fullPath = match[1];
      // fullMatch always equals 'self.' + fullPath (batch 86 same contract:
      // indexOf would match look-alike substrings inside 'self'; the root
      // segment start comes from suffix arithmetic)
      const start = match.index + match[0].length - fullPath.length;
      accesses.push({
        line: index,
        character: start,
        rootSymbol: fullPath.split('.')[0],
        fullPath
      });
    }
  }

  return accesses;
}

/** Line title: `property · <[slot.]property> · <type> · <visibility domains> · Persistent?` */
export function describePropertyCodeLensTitle(hit: PropertyCodeLensHit): string {
  const display = hit.componentSlotName
    ? `${hit.componentSlotName}.${hit.propertyName}`
    : hit.propertyName;
  const type = hit.typeName ?? 'Type 未声明';
  const domains = hit.domains.length > 0 ? hit.domains.join('|') : 'Flags 未配置';
  const parts = ['属性', display, type, domains];

  if (hit.persistent) {
    parts.push('Persistent');
  }

  return parts.join(' · ');
}

export function buildPropertyCodeLenses(
  accesses: PythonSelfPropertyAccess[],
  resolve: (access: PythonSelfPropertyAccess) => PropertyCodeLensHit | null | undefined
): PropertyCodeLensSpec[] {
  // No dedup by property: a reader parked on any line must still see the
  // marker, so every access gets its own lens; the waste of repeatedly
  // resolving the same property is absorbed by the provider-side resolve
  // cache
  return accesses.flatMap(access => {
    const hit = resolve(access);
    if (!hit) {
      return [];
    }

    return [{ access, hit, title: describePropertyCodeLensTitle(hit) }];
  });
}
