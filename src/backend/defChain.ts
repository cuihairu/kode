import * as fs from 'fs';
import * as path from 'path';
import { readFileSyncUtf8Recorded } from './fileReadMetrics';
import {
  findEntityDefsRootFromFile,
  parseDefFileSemantics
} from './defRenamer';

// Merged presentation of the def chain (remaining segment of the source-analysis
// design D5): a def's inheritance closure is organized into three surfaces --
// the "Parent chain (recursive) + interfaces/ flattened + components/ attached"
// -- matching the engine's merge semantics (entitydef.cpp:890-924, 551-639,
// 642-771):
// - an entity's Parent is flattened at the definition root, while a component
//   def's Parent is resolved inside components/;
// - interfaces are always resolved into interfaces/, and an interface def does
//   not read Parent when loaded (loadInterfaces does not go through
//   loadParentClass), so the chain does not pass through interfaces;
// - every def level's <Interfaces> are flattened into the closure, with
//   same-name dedup keeping the order of first appearance;
// - a component attachment takes the <Type> value of the <Components> slot
//   (the component def name).
// No cycle protection is visible in the engine's loadParentClass, so kode must
// truncate with a visited set (D5 states this explicitly); when truncation
// happens it is reported honestly, never silently.

export interface DefChainNode {
  name: string;
  /** Absolute path of the def file; null when the file is missing (e.g. a script-only parent class) -- never fabricated */
  defPath: string | null;
}

export interface DefChainInfo {
  /** Layer-by-layer walk upward, starting at the immediate parent */
  parentChain: DefChainNode[];
  /** Interfaces of every closure level, flattened; same-name dedup keeps the order of first appearance */
  interfaces: DefChainNode[];
  /** Component slot attachments of every closure level; same-name dedup keeps the order of first appearance */
  components: DefChainNode[];
  /** True when the Parent recursion hit a cycle and was truncated by the visited set */
  cycleTruncated: boolean;
}

const readFileOrNull = (filePath: string): string | null => {
  try {
    // Shared source text cache accounting entry point (2026-11-24 cache close-out batch):
    // chain traversal shares cached source text with the definition/reference chain
    return readFileSyncUtf8Recorded(filePath);
  } catch {
    return null;
  }
};

type DefChainCategory = 'entity' | 'interface' | 'component';

const categoryOf = (defsRoot: string, filePath: string): DefChainCategory => {
  const relative = path.relative(defsRoot, filePath).split(path.sep);
  if (relative.includes('interfaces')) {
    return 'interface';
  }
  if (relative.includes('components')) {
    return 'component';
  }
  return 'entity';
};

export function buildDefChain(
  entryPath: string,
  readText: (filePath: string) => string | null = readFileOrNull
): DefChainInfo {
  const defsRoot = findEntityDefsRootFromFile(entryPath);
  if (!defsRoot) {
    return { parentChain: [], interfaces: [], components: [], cycleTruncated: false };
  }

  const parentChain: DefChainNode[] = [];
  const interfaces: DefChainNode[] = [];
  const components: DefChainNode[] = [];
  const seenInterfaceNames = new Set<string>();
  const seenComponentNames = new Set<string>();
  let cycleTruncated = false;

  const collectFlatDecls = (filePath: string, content: string): void => {
    const semantics = parseDefFileSemantics(content);
    if (!semantics) {
      return;
    }
    for (const name of semantics.interfaceNames) {
      if (seenInterfaceNames.has(name)) {
        continue;
      }
      seenInterfaceNames.add(name);
      const defPath = path.join(defsRoot, 'interfaces', `${name}.def`);
      const defExists = fs.existsSync(defPath);
      interfaces.push({ name, defPath: defExists ? defPath : null });
      // KR-AUD-76: the engine's loadInterfaces recursively loads an interface def's
      // own Interfaces (entitydef.cpp:611-638) and also runs loadComponents --
      // nested interfaces and a nested interface's component slots enter the
      // chain too; seenInterfaceNames guards against cycles (each name is
      // expanded once).
      if (defExists) {
        const defContent = readText(defPath);
        if (defContent !== null) {
          collectFlatDecls(defPath, defContent);
        }
      }
    }
    for (const name of semantics.componentTypeNames) {
      if (seenComponentNames.has(name)) {
        continue;
      }
      seenComponentNames.add(name);
      const defPath = path.join(defsRoot, 'components', `${name}.def`);
      components.push({ name, defPath: fs.existsSync(defPath) ? defPath : null });
    }
  };

  const entryResolved = path.resolve(entryPath);
  const seenFiles = new Set<string>([entryResolved]);
  const entryContent = readText(entryResolved);
  if (entryContent !== null) {
    collectFlatDecls(entryResolved, entryContent);
    let current: { path: string; content: string } | null =
      { path: entryResolved, content: entryContent };
    while (current) {
      const semantics = parseDefFileSemantics(current.content);
      const category = categoryOf(defsRoot, current.path);
      // An interface def does not follow Parent (engine loadInterfaces semantics; resolveLinkPaths carries the same note)
      const parentName = semantics?.parentName && category !== 'interface'
        ? semantics.parentName
        : null;
      if (!parentName) {
        break;
      }
      const parentDir = category === 'component'
        ? path.join(defsRoot, 'components')
        : defsRoot;
      const parentPath = path.resolve(path.join(parentDir, `${parentName}.def`));
      parentChain.push({ name: parentName, defPath: fs.existsSync(parentPath) ? parentPath : null });
      if (seenFiles.has(parentPath)) {
        cycleTruncated = true;
        break;
      }
      seenFiles.add(parentPath);
      const parentContent = readText(parentPath);
      if (parentContent === null) {
        break;
      }
      collectFlatDecls(parentPath, parentContent);
      current = { path: parentPath, content: parentContent };
    }
  }

  return { parentChain, interfaces, components, cycleTruncated };
}
