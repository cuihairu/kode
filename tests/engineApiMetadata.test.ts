import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UNKNOWN_ENGINE_VALUE,
  buildEngineApiCatalog,
  readEngineApiMetadata
} from '../src/engineApiMetadata';

const originalEngineRoot = process.env.KBENGINE_ROOT;

function makeEngineTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-api-metadata-'));
  mkdirSync(join(root, 'kbe/src/lib/common'), { recursive: true });
  writeFileSync(join(root, 'kbe/src/lib/common/version.h'), '#define KBE_VERSION "9.9.9"\n');
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
