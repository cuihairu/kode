/**
 * IDE-GEN-005: atomic replacement for generator writes to disk. Writes a
 * temporary file in the same directory first, then renames it into place
 * (same directory guarantees the same filesystem, and rename is atomic). If
 * the write or the rename is interrupted the old file's bytes stay intact —
 * either the full new content or the full old content, never half-written
 * text; for the new-file case, it either appears completely or not at all.
 * Failure paths clean up the temporary file, and a cleanup failure does not
 * mask the original error.
 *
 * AUD-032 (R2-F08): noClobber uses fs.link (hard link) rather than rename —
 * when the target already exists, link atomically reports EEXIST and never
 * overwrites a concurrently appeared file (rename would silently replace it).
 * After a successful link the target and the temp file share the same inode;
 * unlinking the temp file leaves a complete target, still an atomic landing.
 */

import * as fs from 'fs';

let tempCounter = 0;

/** Atomic-write options: noClobber=true refuses to overwrite an existing target (EEXIST-safe creation) */
export interface WriteFileAtomicOptions {
  noClobber?: boolean;
}

/** Atomic replacement write: temp file + rename (link + unlink when noClobber); any failure guarantees the target path is not partially written */
export function writeFileAtomic(filePath: string, content: string, options: WriteFileAtomicOptions = {}): void {
  tempCounter += 1;
  const tempPath = `${filePath}.kode-tmp-${process.pid}-${tempCounter}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    if (options.noClobber) {
      fs.linkSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, filePath);
    }
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // A cleanup failure does not mask the original error
    }
    throw error;
  }
}
