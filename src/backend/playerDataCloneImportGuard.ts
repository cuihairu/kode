/** Durable, machine-local reservation for clone imports. A reservation is written
 * before the write connection opens, so a crash or ambiguous COMMIT fails closed. */
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, open, readFile } from 'fs/promises';
import * as path from 'path';

export interface CloneImportTarget {
  host: string;
  port: number;
  database: string;
}

export async function fingerprintCloneArchive(archivePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export async function reserveCloneImport(
  keyRoot: string,
  fingerprint: string,
  target: CloneImportTarget
): Promise<{ duplicate: boolean; reservation: string; prior?: string }> {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('invalid clone archive fingerprint');
  }
  const identity = JSON.stringify([target.host.toLowerCase(), target.port, target.database, fingerprint]);
  const id = createHash('sha256').update(identity).digest('hex');
  const directory = path.join(keyRoot, 'import-reservations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const reservation = path.join(directory, `${id}.json`);
  try {
    const file = await open(reservation, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ fingerprint, target, reservedAt: new Date().toISOString() }));
      await file.sync();
    } finally {
      await file.close();
    }
    return { duplicate: false, reservation };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    // A partially written record still blocks automatically; never infer success.
    const prior = await readFile(reservation, 'utf8').catch(() => 'unreadable reservation');
    return { duplicate: true, reservation, prior };
  }
}
