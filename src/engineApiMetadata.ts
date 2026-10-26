import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { KBE_SYMBOLS, type KbeSymbolEntry } from './kbeModuleIndex';

const execFileAsync = promisify(execFile);

/**
 * C-14 (V-06·d): engine source-tree markers. KBEngine 2.5.10 trees ship the
 * version as three numeric macros in kbeversion.h and have no version.h at
 * all (cuihairu/kbengine 0bc93d5 proves it never existed in this fork), so
 * probing version.h alone reports unknown on real trees. Both markers are
 * accepted; the version is synthesized from whichever file is present.
 */
export const ENGINE_MARKER_LEGACY = ['kbe', 'src', 'lib', 'common', 'version.h'] as const;
export const ENGINE_MARKER_KBEVERSION = ['kbe', 'src', 'lib', 'common', 'kbeversion.h'] as const;

export function hasEngineTreeMarker(
  root: string,
  exists: (candidate: string) => boolean
): boolean {
  return exists(path.join(root, ...ENGINE_MARKER_LEGACY))
    || exists(path.join(root, ...ENGINE_MARKER_KBEVERSION));
}

/**
 * Legacy trees: #define KBE_VERSION "2.5.10". New trees: three numeric macros
 * (KBE_VERSION_MAJOR/MINOR/PATCH) synthesized as major.minor.patch. Any macro
 * missing or malformed → null (unknown upstream), never a fabricated value.
 */
export function readEngineVersionMarker(
  root: string,
  readFile: (candidate: string) => string
): string | null {
  try {
    const legacy = readFile(path.join(root, ...ENGINE_MARKER_LEGACY));
    const match = legacy.match(/^#define\s+KBE_VERSION\s+"([^"]+)"/m);
    if (match) {
      return match[1];
    }
    // legacy file present but macro malformed → keep probing the new marker
  } catch {
    // legacy file absent → fall through to kbeversion.h
  }
  try {
    const source = readFile(path.join(root, ...ENGINE_MARKER_KBEVERSION));
    const readMacro = (name: string): number | null => {
      const match = source.match(new RegExp(`^#define\\s+${name}\\s+(\\d+)`, 'm'));
      if (!match) {
        return null;
      }
      const value = Number.parseInt(match[1], 10);
      return Number.isFinite(value) ? value : null;
    };
    const major = readMacro('KBE_VERSION_MAJOR');
    const minor = readMacro('KBE_VERSION_MINOR');
    const patch = readMacro('KBE_VERSION_PATCH');
    return major !== null && minor !== null && patch !== null
      ? `${major}.${minor}.${patch}`
      : null;
  } catch {
    return null;
  }
}

export interface EngineApiMetadata {
  version: string;
  commit: string;
  describe: string;
}

export type EngineApiSymbol = KbeSymbolEntry & {
  declaration: string;
};

export interface EngineApiCatalog {
  metadata: EngineApiMetadata;
  symbols: EngineApiSymbol[];
}

export interface EngineApiMetadataOptions {
  engineRoot?: string | null;
  environment?: Record<string, string | undefined>;
  git?: (cwd: string, args: string[]) => Promise<string>;
  pathModule?: typeof path;
}

function findEngineRoot(
  workspaceRoot: string,
  explicitRoot: string | undefined,
  pathModule: typeof path
): string | null {
  const candidates = [
    explicitRoot,
    process.env.KBENGINE_ROOT === 'off' ? undefined : process.env.KBENGINE_ROOT,
    pathModule.resolve(workspaceRoot, '..', 'kbengine')
  ];
  for (const candidate of candidates) {
    if (candidate && hasEngineTreeMarker(candidate, probe => existsSync(probe))) {
      return candidate;
    }
  }
  return null;
}

export const UNKNOWN_ENGINE_VALUE = 'unknown';

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

export async function readEngineApiMetadata(
  workspaceRoot: string,
  options: EngineApiMetadataOptions = {}
): Promise<EngineApiMetadata> {
  const environment = options.environment ?? process.env;
  const pathModule = options.pathModule ?? path;
  if (environment.KBENGINE_ROOT === 'off' || options.engineRoot === null) {
    return unknownMetadata();
  }

  const engineRoot = findEngineRoot(workspaceRoot, options.engineRoot ?? undefined, pathModule);
  if (!engineRoot) {
    return unknownMetadata();
  }

  const git = options.git ?? defaultGit;
  const [commit, describe] = await Promise.all([
    runGit(git, engineRoot, ['rev-parse', 'HEAD']),
    runGit(git, engineRoot, ['describe', '--tags', '--always', '--dirty'])
  ]);

  return {
    version: readVersion(engineRoot) ?? UNKNOWN_ENGINE_VALUE,
    commit: commit ?? UNKNOWN_ENGINE_VALUE,
    describe: describe ?? UNKNOWN_ENGINE_VALUE
  };
}

export async function buildEngineApiCatalog(
  workspaceRoot: string,
  options: EngineApiMetadataOptions = {}
): Promise<EngineApiCatalog> {
  return {
    metadata: await readEngineApiMetadata(workspaceRoot, options),
    symbols: KBE_SYMBOLS.map(symbol => ({
      ...symbol,
      declaration: `${symbol.sourceFile}:${symbol.sourceLine}`
    }))
  };
}

function readVersion(engineRoot: string): string | null {
  return readEngineVersionMarker(engineRoot, probe => readFileSync(probe, 'utf8'));
}

async function runGit(
  git: (cwd: string, args: string[]) => Promise<string>,
  cwd: string,
  args: string[]
): Promise<string | null> {
  try {
    const value = await git(cwd, args);
    return value || null;
  } catch {
    return null;
  }
}

function unknownMetadata(): EngineApiMetadata {
  return {
    version: UNKNOWN_ENGINE_VALUE,
    commit: UNKNOWN_ENGINE_VALUE,
    describe: UNKNOWN_ENGINE_VALUE
  };
}
