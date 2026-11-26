// Decision core for python method call hierarchy resolution (RUST-145 batch 1).
// The index query algorithms for CallHierarchy incoming/outgoing (target locating ->
// self. call-site enumeration -> binding resolution (exact file+name, fallback by same
// name) -> dedup / process-scope filtering) share with the index first scan / unsaved
// document override both the method-block parsing (parsePythonMethodBlocks, migrated
// from entityMappingHelpers) and the section inference (inferMethodSectionFromPythonFile,
// migrated; semantics unchanged -- normalizeLookupPath is a pass-through alias of
// normalizeFileIdentity, used directly here).
// Pure library, zero vscode/fs; the manager face (entityMapping getIncoming/OutgoingPython
// MethodCalls) only does index fetching + cancellation checks + open-document inventory
// collection. Golden-parity with Rust python_method_calls.rs from the same source
// (tests/kodePythonMethodCallsParity.test.ts).
import { normalizeFileIdentity } from './pathIdentity';
import type { DefMethodSection } from './defParser';

export interface PythonMethodLocationCore {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface PythonSelfCallCore {
  methodName: string;
  line: number;
  character: number;
  filePath: string;
}

export interface IndexedPythonMethodLocationCore extends PythonMethodLocationCore {
  endLine: number;
  calls: PythonSelfCallCore[];
}

export interface PythonMethodCallReferenceCore {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface IncomingPythonMethodCallCore {
  caller: PythonMethodLocationCore;
  callLine: number;
  callCharacter: number;
}

export interface OpenDocumentTextCore {
  fsPath: string;
  content: string;
}

export function inferMethodSectionFromPythonFile(pythonFile: string): DefMethodSection | undefined {
  const normalizedPath = normalizeFileIdentity(pythonFile).toLowerCase();

  // demo asset directory names (scripts/base|cell|client|bots, official asset
  // template shape; the engine loads baseapp->scripts/base, cellapp->scripts/cell,
  // bots->scripts/bots, bots.cpp:211-228). Previously only base/cell/client were
  // recognised, so the demo's scripts/bots files all fell to undefined -- section
  // filtering/scope inference/call-graph segmentation went blind together (the
  // 2026-11-11 user bug report folded in). bots' script face is the client face
  // (KB-API-007: ClientObjectBase assembly). Engine process names (baseapp/cellapp)
  // are not directory names -- directories are recognised by the asset layer only.
  if (normalizedPath.includes('/scripts/bots/') || normalizedPath.includes('/assets/scripts/bots/')
    || normalizedPath.startsWith('bots/') || normalizedPath.includes('/bots/')) {
    return 'ClientMethods';
  }

  if (normalizedPath.includes('/scripts/base/') || normalizedPath.includes('/assets/scripts/base/')
    || normalizedPath.startsWith('base/') || normalizedPath.includes('/base/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cell/') || normalizedPath.includes('/assets/scripts/cell/')
    || normalizedPath.startsWith('cell/') || normalizedPath.includes('/cell/')) {
    return 'CellMethods';
  }

  if (normalizedPath.includes('/scripts/client/') || normalizedPath.includes('/assets/scripts/client/')
    || normalizedPath.startsWith('client/') || normalizedPath.includes('/client/')) {
    return 'ClientMethods';
  }

  return undefined;
}

export function parsePythonMethodBlocks(
  content: string,
  pythonFile: string
): IndexedPythonMethodLocationCore[] {
  const lines = content.split('\n');
  const methods: IndexedPythonMethodLocationCore[] = [];
  const definitionRegex = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const match = definitionRegex.exec(lineText);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const methodName = match[2];
    const character = lineText.indexOf(methodName);
    let endLine = lines.length;

    for (let nextLine = index + 1; nextLine < lines.length; nextLine += 1) {
      const nextText = lines[nextLine];
      if (!nextText.trim()) {
        continue;
      }

      const nextIndent = nextText.match(/^\s*/)?.[0].length || 0;
      if (nextIndent <= indent) {
        endLine = nextLine;
        break;
      }
    }

    const bodyLines = lines.slice(index + 1, endLine);
    methods.push({
      filePath: pythonFile,
      methodName,
      line: index + 1,
      character,
      endLine,
      calls: parsePythonSelfCalls(bodyLines, index + 2, pythonFile)
    });
  }

  return methods;
}

function parsePythonSelfCalls(
  bodyLines: string[],
  startLine: number,
  pythonFile: string
): PythonSelfCallCore[] {
  const calls: PythonSelfCallCore[] = [];
  const callRegex = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const lineText = bodyLines[index];
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(lineText)) !== null) {
      calls.push({
        methodName: match[1],
        line: startLine + index,
        // match[0] always starts with 'self.' and the name follows the prefix directly
        // (batch 86 M7 family: indexOf(name) hits inside the prefix when name is a 'self'
        // substring, misplacing the column for self.e/self.self)
        character: match.index + 'self.'.length,
        filePath: pythonFile
      });
    }
  }

  return calls;
}

/**
 * outgoing: locate the target method (path identity normalised) -> resolve the binding
 * of each self. call site -- exact (file+name) first, and when that file has no such
 * name fall back to any file with the same name (current stance: the same name across
 * files is a weak signal); the dedup key = normalised path:name:line:column. The return
 * keeps resolved's original path (not the normalised form). Pure function; cancellation
 * checks belong to the manager wrapper face.
 */
export function resolveOutgoingPythonMethodCalls(
  methods: IndexedPythonMethodLocationCore[],
  pythonFile: string,
  methodName: string
): PythonMethodCallReferenceCore[] {
  const targetMethod = methods.find(method =>
    normalizeFileIdentity(method.filePath) === normalizeFileIdentity(pythonFile)
    && method.methodName === methodName
  );
  if (!targetMethod) {
    return [];
  }

  const references: PythonMethodCallReferenceCore[] = [];
  const seen = new Set<string>();
  for (const reference of targetMethod.calls) {
    const binding = methods.find(candidate =>
      normalizeFileIdentity(candidate.filePath) === normalizeFileIdentity(reference.filePath)
      && candidate.methodName === reference.methodName
    );

    const resolved = binding
      || methods.find(candidate => candidate.methodName === reference.methodName);
    if (!resolved) {
      continue;
    }

    const key = `${normalizeFileIdentity(resolved.filePath)}:${resolved.methodName}:${resolved.line}:${resolved.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    references.push({
      filePath: resolved.filePath,
      methodName: resolved.methodName,
      line: resolved.line,
      character: resolved.character
    });
  }

  return references;
}

/**
 * incoming: a full scan of callers. 2026-11-05 user feedback (def method Shift+F12):
 * local calls are collected by the method's own section/process scope -- a baseapp
 * self.x() does not count as a reference to the same-named cellapp method. KBEngine def
 * methods cannot cross processes: this process's self.x() is a local call, and a
 * cross-process call is self.cell/base/client.x() (an RPC, handled separately via
 * getIncomingPythonReceiverCalls). The target section is inferred from the implementing
 * file path; a caller section that is known and different -> a cross-process phantom
 * reference, skipped. An unknown caller section (shared scripts under common/ etc.,
 * which the target process may import) -> conservatively kept; an unknown target
 * section -> keep everything (current behaviour).
 * IDE-NAV-004: follow unsaved documents -- openTexts (the current in-place versions of
 * the opened document buffers) override that file's index entries before the scan (the
 * same pure function as the index first scan); only already-indexed files are overridden
 * (an opened file outside the index is not scanned wholesale, current stance). Pure
 * function; collecting the openTexts inventory and the cancellation checks belong to the
 * manager wrapper face.
 */
export function resolveIncomingPythonMethodCalls(
  methods: IndexedPythonMethodLocationCore[],
  openTexts: OpenDocumentTextCore[],
  pythonFile: string,
  methodName: string
): IncomingPythonMethodCallCore[] {
  const incoming: IncomingPythonMethodCallCore[] = [];
  const normalizedTarget = normalizeFileIdentity(pythonFile);
  const targetSection = inferMethodSectionFromPythonFile(normalizedTarget);

  const methodsByFile = new Map<string, IndexedPythonMethodLocationCore[]>();
  for (const method of methods) {
    const key = normalizeFileIdentity(method.filePath);
    const bucket = methodsByFile.get(key);
    if (bucket) {
      bucket.push(method);
    } else {
      methodsByFile.set(key, [method]);
    }
  }
  for (const openText of openTexts) {
    const key = normalizeFileIdentity(openText.fsPath);
    const bucket = methodsByFile.get(key);
    if (bucket) {
      methodsByFile.set(key, parsePythonMethodBlocks(openText.content, bucket[0].filePath));
    }
  }
  const methodsOverride = [...methodsByFile.values()].flat();

  for (const method of methodsOverride) {
    for (const call of method.calls) {
      if (call.methodName !== methodName) {
        continue;
      }

      const resolved = methodsOverride.find(candidate =>
        candidate.methodName === call.methodName
        && normalizeFileIdentity(candidate.filePath) === normalizedTarget
      );
      if (!resolved) {
        continue;
      }

      // Process-scope filtering (see the note above). When both the caller file's section
      // and the target section are known and differ -> a cross-process phantom
      // reference (such as base calling a cell method), skipped.
      const callerSection = inferMethodSectionFromPythonFile(method.filePath);
      if (targetSection && callerSection && callerSection !== targetSection) {
        continue;
      }

      incoming.push({
        caller: {
          filePath: method.filePath,
          methodName: method.methodName,
          line: method.line,
          character: method.character
        },
        callLine: call.line,
        callCharacter: call.character
      });
    }
  }

  return incoming;
}
