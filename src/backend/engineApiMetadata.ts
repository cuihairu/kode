import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { KBE_SYMBOLS, type KbeSymbolEntry } from '../kbeModuleIndex';

const execFileAsync = promisify(execFile);

/**
 * 引擎根身份锚(2026-11-24 用户令):kbengine.engineRoot / profile
 * engineRoot 的语义 = 引擎安装根(kbe 目录本身,res/bin/src/tools 的直接
 * 父目录,与 kbemain.h 的 KBE_ROOT「引擎装载 res 的根」同语义)。身份判定
 * 看结构特征不看目录名——用户把 kbe 改名(如 engine-2.5.10)照样认。
 */
export const ENGINE_IDENTITY_MARKER = ['res', 'server', 'kbengine_defaults.xml'] as const;

/**
 * 版本标记面(C-14,V-06·d;相对引擎安装根):KBEngine 2.5.10 trees ship
 * the version as three numeric macros in kbeversion.h and have no version.h
 * at all (cuihairu/kbengine 0bc93d5 proves it never existed in this fork),
 * so probing version.h alone reports unknown on real trees. Both files are
 * accepted; the version is synthesized from whichever is present.
 */
export const ENGINE_VERSION_FILE_LEGACY = ['src', 'lib', 'common', 'version.h'] as const;
export const ENGINE_VERSION_FILE_KBEVERSION = ['src', 'lib', 'common', 'kbeversion.h'] as const;

/** 身份验收:引擎安装根下有 res/server/kbengine_defaults.xml(主锚)。 */
export function hasEngineTreeMarker(
  root: string,
  exists: (candidate: string) => boolean
): boolean {
  return exists(path.join(root, ...ENGINE_IDENTITY_MARKER));
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
    const legacy = readFile(path.join(root, ...ENGINE_VERSION_FILE_LEGACY));
    const match = legacy.match(/^#define\s+KBE_VERSION\s+"([^"]+)"/m);
    if (match) {
      return match[1];
    }
    // legacy file present but macro malformed → keep probing the new marker
  } catch {
    // legacy file absent → fall through to kbeversion.h
  }
  try {
    const source = readFile(path.join(root, ...ENGINE_VERSION_FILE_KBEVERSION));
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
  // 兄弟仓布局:仓库根(../kbengine)是用户 typings stub 所在层,引擎安装
  // 根是其 kbe/ 孩子(2026-11-24 语义:身份锚在安装根,不在仓库根)。
  const sibling = pathModule.resolve(workspaceRoot, '..', 'kbengine');
  const candidates = [
    explicitRoot,
    process.env.KBENGINE_ROOT === 'off' ? undefined : process.env.KBENGINE_ROOT,
    sibling,
    pathModule.join(sibling, 'kbe')
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
