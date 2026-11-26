/**
 * Direct-read Python parent-class chain resolution (the long-reported
 * 2026-11-24 complaint the user filed "countless times"):
 * a method defined in the def that a parent class inherited by the py entity
 * class already implements still raises def-method-missing-in-python, and F12
 * will not jump either -- the earlier decision faces (owner registration face /
 * project-wide unique name) never look at real inheritance: when the method
 * name appears in several places the project-wide unique name arm goes silent,
 * and the convention chain only reads the owner file.
 *
 * This module does a **synchronous, buffer-aware** parent-class chain walk:
 * starting from (file, class name) it follows the bases of the class --
 * a same-named class in the same file is linked directly, cross-file goes
 * through import resolution (candidate paths use the same
 * pythonImportModuleCandidates criterion as the index staging, one single
 * source of truth); a base that cannot be resolved (engine builtins such as
 * KBEngine.Entity) is skipped honestly and contributes no methods.
 *
 * Consumer faces (three places, one chain): defPythonParity collection (ancestor
 * methods are folded into the implemented set, the Rust rule's set-difference
 * semantics stay unchanged) / entityMapping gap decision (present in the
 * ancestor chain = not a gap) / the mro arm of the def -> python jump
 * (landing point = the nearest declaring ancestor, the LUT keeps the slow
 * chain's order).
 *
 * Boundary: the chain order is a declaration-order BFS (parents before
 * grandparents), not C3 linearization -- for the two uses of an existence
 * decision and a nearest-ancestor landing point it differs from C3 at most in
 * which of several implementations a diamond inheritance picks, and KBEngine
 * entity inheritance is a single chain in practice; full C3 lives in
 * pythonClassIndex (which needs the index), while this module deliberately has
 * zero index dependencies.
 */

import { parsePythonFile, type ParsedPythonFile, type PythonClassDef } from './pythonParser';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';
import { pythonImportModuleCandidates } from './pythonClassIndex';

/** One class link in the chain: file + class + the method table of that class (the parsePythonFile Map as-is) */
export interface PythonBaseChainLink {
  filePath: string;
  className: string;
  cls: PythonClassDef;
}

/** Walk guardrails: class count / files-read-from-disk caps (a real KBEngine project's chain depth is single digits; the guardrails only guard against cycles and pathological layouts) */
export const PYTHON_BASE_CHAIN_MAX_CLASSES = 64;
export const PYTHON_BASE_CHAIN_MAX_FILES = 32;

const fileKey = (filePath: string): string => filePath.replace(/\\/g, '/');

/** Find a class inside an already parsed file: the top-level name first, then falling back to qualifiedName (outer.inner for nested classes) */
function findClass(parsed: ParsedPythonFile, className: string): PythonClassDef | undefined {
  return (
    parsed.classes.find(item => item.name === className) ??
    parsed.classes.find(item => (item.qualifiedName ?? item.name) === className)
  );
}

interface ChainWalkOptions {
  /** Whether to include the starting point itself as the first link (defaults to true: the caller wants the "self ∪ ancestors" union semantics) */
  includeSelf?: boolean;
}

/**
 * Walk along the parent-class chain (declaration-order BFS, closer relatives
 * first). A link that cannot be read / parsed / does not exist has its whole
 * branch skipped (zero guessing); hitting a guardrail (class count / file
 * count) stops the expansion and the links collected so far are returned as
 * they are.
 */
export function walkPythonBaseChain(
  pythonFile: string,
  className: string,
  options: ChainWalkOptions = {}
): PythonBaseChainLink[] {
  const includeSelf = options.includeSelf ?? true;
  const seen = new Set<string>();
  const parseCache = new Map<string, ParsedPythonFile | null>();
  let filesRead = 0;

  const parseAt = (file: string): ParsedPythonFile | null => {
    const key = fileKey(file);
    if (parseCache.has(key)) {
      return parseCache.get(key) ?? null;
    }
    let parsed: ParsedPythonFile | null = null;
    if (filesRead < PYTHON_BASE_CHAIN_MAX_FILES) {
      const snapshot = readSharedFileSnapshot(file);
      if (snapshot) {
        parsed = parsePythonFile(snapshot.content, file);
        filesRead += 1;
      }
    }
    parseCache.set(key, parsed);
    return parsed;
  };

  const links: PythonBaseChainLink[] = [];
  let processed = false;
  const queue: Array<{ file: string; className: string }> = [{ file: pythonFile, className }];
  while (queue.length > 0 && links.length < PYTHON_BASE_CHAIN_MAX_CLASSES) {
    const node = queue.shift()!;
    const nodeKey = `${fileKey(node.file)}::${node.className}`;
    if (seen.has(nodeKey)) {
      continue;
    }
    seen.add(nodeKey);
    const parsed = parseAt(node.file);
    const cls = parsed ? findClass(parsed, node.className) : undefined;
    if (!cls) {
      continue;
    }
    // includeSelf only controls "whether self enters the chain", not the
    // traversal start point: an independent processed flag is used, otherwise
    // with includeSelf:false the first node (links still empty) also tests
    // isFirst -> the first ancestor is skipped along with it and the whole chain
    // comes back empty (caught by the 2026-11-24 unit test:
    // hasMethod…InBaseChain was always false)
    const isFirst = !processed;
    processed = true;
    if (!isFirst || includeSelf) {
      links.push({ filePath: node.file, className: node.className, cls });
    }
    if (links.length >= PYTHON_BASE_CHAIN_MAX_CLASSES) {
      break;
    }
    for (const base of cls.bases) {
      if (!base || base === node.className) {
        continue;
      }
      // A same-named class in the same file is linked directly (a common shape for nested/aliased parents)
      if (parsed!.classes.some(item => item.name === base && item !== cls)) {
        queue.push({ file: node.file, className: base });
        continue;
      }
      // Cross-file: import binding resolution (from X import Y [as Z] -> binding key Z, original symbol Y)
      const binding = parsed!.imports?.get(base);
      if (!binding) {
        continue; // engine builtin / third party: unresolvable, so it honestly contributes no methods
      }
      const targetClassName = binding.symbol ?? base;
      for (const candidate of pythonImportModuleCandidates(node.file, binding.module)) {
        const candidateParsed = parseAt(candidate);
        if (candidateParsed && findClass(candidateParsed, targetClassName)) {
          queue.push({ file: candidate, className: targetClassName });
          break; // a Python import takes the first matching module; do not walk further directories
        }
      }
    }
  }
  return links;
}

/** Whether the method is already implemented somewhere on the ancestor chain (excluding self) -- for the gap decision (the caller has already checked the self face) */
export function hasMethodImplementationInBaseChain(
  pythonFile: string,
  className: string,
  methodName: string
): boolean {
  return walkPythonBaseChain(pythonFile, className, { includeSelf: false }).some(link =>
    link.cls.methods.has(methodName)
  );
}

/** Honest three-state result of the gap decision (C-19-MRO):
 * resolved=false = the chain could not be resolved (the consumer reports the
 * status quo, annotating nothing and inventing nothing);
 * resolved=true and implemented=true = the chain has an implementation
 * (closes the gap);
 * resolved=true and implemented=false = the whole chain was searched with no
 * implementation (classNames back the "chain checked" annotation). */
export interface PythonBaseChainMethodOutcome {
  readonly resolved: boolean;
  /** Chain class names (nearest first, including the owner itself; given when resolved=true) */
  readonly classNames: string[];
  readonly implemented: boolean;
}

/** One walk over the full chain (including self) yields both the existence
 * decision and the class names -- used by the gap-decision arm (absorbing the
 * lane C-19-MRO annotation residual; the mechanism shares the same source as
 * parity/jump/hover). An empty chain (the owner script does not parse) =
 * resolved=false. */
export function resolvePythonBaseChainMethodOutcome(
  pythonFile: string,
  className: string,
  methodName: string
): PythonBaseChainMethodOutcome {
  const links = walkPythonBaseChain(pythonFile, className);
  if (links.length === 0) {
    return { resolved: false, classNames: [], implemented: false };
  }
  return {
    resolved: true,
    classNames: links.map(link => link.className),
    implemented: links.some(link => link.cls.methods.has(methodName))
  };
}

/** The links on the chain that declare the method (self first, then nearer grandparents): for the jump landing point, the nearest declaration wins */
export function findMethodLocationsInPythonBaseChain(
  pythonFile: string,
  className: string,
  methodName: string
): Array<{ filePath: string; line: number; character: number; className: string }> {
  const out: Array<{ filePath: string; line: number; character: number; className: string }> = [];
  for (const link of walkPythonBaseChain(pythonFile, className)) {
    const loc = link.cls.methods.get(methodName);
    if (loc) {
      out.push({ filePath: link.filePath, line: loc.line, character: loc.character, className: link.className });
    }
  }
  return out;
}

/** The union of method names on the chain (including self): for the parity collection's implemented set */
export function collectPythonBaseChainMethodNames(pythonFile: string, className: string): Set<string> {
  const names = new Set<string>();
  for (const link of walkPythonBaseChain(pythonFile, className)) {
    for (const name of link.cls.methods.keys()) {
      names.add(name);
    }
  }
  return names;
}

/** Test-facing criterion: normalized path (the same form as the internal fileKey) */
export const normalizeChainFilePath = fileKey;
