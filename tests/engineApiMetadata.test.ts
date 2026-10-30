import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UNKNOWN_ENGINE_VALUE,
  buildEngineApiCatalog,
  readEngineApiMetadata,
  readEngineVersionMarker
} from '../src/engineApiMetadata';

const originalEngineRoot = process.env.KBENGINE_ROOT;

function makeEngineTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-api-metadata-'));
  mkdirSync(join(root, 'kbe/src/lib/common'), { recursive: true });
  writeFileSync(join(root, 'kbe/src/lib/common/version.h'), '#define KBE_VERSION "9.9.9"\n');
  return root;
}

/** C-14: 2.5.10+ 真树形状——只有 kbeversion.h 三宏，无 version.h */
function makeKbeversionTree(options: { patch?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-api-metadata-kbeversion-'));
  mkdirSync(join(root, 'kbe/src/lib/common'), { recursive: true });
  const macros = [
    '#define KBE_VERSION_MAJOR 2',
    '#define KBE_VERSION_MINOR 5',
    ...(options.patch ? ['#define KBE_VERSION_PATCH 10'] : [])
  ];
  writeFileSync(join(root, 'kbe/src/lib/common/kbeversion.h'), macros.join('\n') + '\n');
  return root;
}

const gitSuccess = (value: string) => async () => value;
const gitFailure = async () => {
  throw new Error('no git');
};

beforeEach(() => {
  delete process.env.KBENGINE_ROOT;
});

afterEach(() => {
  if (originalEngineRoot === undefined) {
    delete process.env.KBENGINE_ROOT;
  } else {
    process.env.KBENGINE_ROOT = originalEngineRoot;
  }
});

describe('engine API metadata', () => {
  it('derives version and git identity from an explicit source tree', async () => {
    const root = makeEngineTree();
    try {
      const metadata = await readEngineApiMetadata('/ws', {
        engineRoot: root,
        git: gitSuccess('abc123def')
      });
      expect(metadata).toEqual({
        version: '9.9.9',
        commit: 'abc123def',
        describe: 'abc123def'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a 2.5.10+ tree with only kbeversion.h and synthesizes the version (C-14)', async () => {
    const root = makeKbeversionTree({ patch: true });
    try {
      expect(existsSync(join(root, 'kbe/src/lib/common/version.h'))).toBe(false);
      const metadata = await readEngineApiMetadata('/ws', {
        engineRoot: root,
        git: gitSuccess('abc123def')
      });
      expect(metadata.version).toBe('2.5.10');
      expect(metadata.commit).toBe('abc123def');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unknown version when kbeversion.h macros are incomplete, never fabricates (C-14)', async () => {
    const root = makeKbeversionTree({ patch: false });
    try {
      const metadata = await readEngineApiMetadata('/ws', {
        engineRoot: root,
        git: gitSuccess('abc123def')
      });
      expect(metadata.version).toBe(UNKNOWN_ENGINE_VALUE);
      expect(metadata.commit).toBe('abc123def');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shows unknown rather than inventing values when source or git is unavailable', async () => {
    expect(await readEngineApiMetadata('/ws', { engineRoot: null }))
      .toEqual({ version: UNKNOWN_ENGINE_VALUE, commit: UNKNOWN_ENGINE_VALUE, describe: UNKNOWN_ENGINE_VALUE });

    const root = makeEngineTree();
    try {
      const metadata = await readEngineApiMetadata('/ws', { engineRoot: root, git: gitFailure });
      expect(metadata.version).toBe('9.9.9');
      expect(metadata.commit).toBe(UNKNOWN_ENGINE_VALUE);
      expect(metadata.describe).toBe(UNKNOWN_ENGINE_VALUE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when neither marker file is readable (legacy absent, kbeversion read fails)', () => {
    // readFile 对两个候选路径都抛 → 先落 legacy 的 catch,再落 kbeversion 的
    // catch → null(未知上游,不编造)。旧码在 kbeversion catch 上未覆盖。
    expect(
      readEngineVersionMarker('/nonexistent-engine-root', () => {
        throw new Error('unreadable');
      })
    ).toBeNull();
  });

  it('adds original declaration locations to every API symbol', async () => {
    const root = makeEngineTree();
    try {
      const catalog = await buildEngineApiCatalog('/ws', {
        engineRoot: root,
        git: gitSuccess('abc123def')
      });
      expect(catalog.metadata.version).toBe('9.9.9');
      expect(catalog.symbols.length).toBeGreaterThan(0);
      expect(catalog.symbols[0].declaration).toBe(
        `${catalog.symbols[0].sourceFile}:${catalog.symbols[0].sourceLine}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
