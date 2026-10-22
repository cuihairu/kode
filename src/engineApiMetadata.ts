import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { KBE_SYMBOLS, type KbeSymbolEntry } from './kbeModuleIndex';

const execFileAsync = promisify(execFile);

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
  const marker = pathModule.join('kbe', 'src', 'lib', 'common', 'version.h');
  const candidates = [
    explicitRoot,
    process.env.KBENGINE_ROOT === 'off' ? undefined : process.env.KBENGINE_ROOT,
    pathModule.resolve(workspaceRoot, '..', 'kbengine')
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(pathModule.join(candidate, marker))) {
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
  try {
    const source = readFileSync(
      path.join(engineRoot, 'kbe', 'src', 'lib', 'common', 'version.h'),
      'utf8'
    );
    return source.match(/^#define\s+KBE_VERSION\s+"([^"]+)"/m)?.[1] ?? null;
  } catch {
    return null;
  }
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
