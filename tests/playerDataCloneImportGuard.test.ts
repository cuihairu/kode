import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { fingerprintCloneArchive, reserveCloneImport } from '../src/playerDataCloneImportGuard';

describe('clone import reservations', () => {
  it('persists and atomically rejects concurrent or later attempts for the same target', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kode-clone-guard-'));
    try {
      const archive = path.join(dir, 'data.kdpclone');
      await writeFile(archive, 'first');
      const fingerprint = await fingerprintCloneArchive(archive);
      const target = { host: 'LOCALHOST', port: 3306, database: 'test' };
      const [one, two] = await Promise.all([
        reserveCloneImport(dir, fingerprint, target),
        reserveCloneImport(dir, fingerprint, target)
      ]);
      expect([one.duplicate, two.duplicate].sort()).toEqual([false, true]);
      expect(JSON.parse(await readFile(one.reservation, 'utf8')).fingerprint).toBe(fingerprint);
      expect((await reserveCloneImport(dir, fingerprint, { ...target, host: 'localhost' })).duplicate).toBe(true);
      expect((await reserveCloneImport(dir, fingerprint, { ...target, database: 'other' })).duplicate).toBe(false);
      await writeFile(archive, 'changed');
      expect(await fingerprintCloneArchive(archive)).not.toBe(fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
