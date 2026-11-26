// IDE-MET-002/REL-004: build commit identity for the extension artifact. The
// build script scripts/write-build-commit.mjs writes git rev-parse HEAD into
// out/buildCommit.json before compile; the VSIX packaging surface keeps that
// file (.vscodeignore !out/buildCommit.json), so after installation it lives at
// <ext>/out/buildCommit.json and is read from extensionPath/out at runtime —
// the commit reported by an installed artifact matches its build inputs. Any
// missing/corrupt case falls back to 'unknown' without guessing, and never
// falls back to the git state of the source tree (the source tree's version
// must not masquerade as the installed version) — readers of the report can
// reconcile package version and source SHA separately.
import * as fs from 'fs';
import { join } from 'path';

interface BuildCommitFile {
  commit?: unknown;
}

/** Reads the build commit from extensionPath/out/buildCommit.json; unreadable/corrupt/odd field = unknown */
export function readBuildCommit(extensionPath: string): string {
  try {
    const raw = fs.readFileSync(join(extensionPath, 'out', 'buildCommit.json'), 'utf8');
    const parsed = JSON.parse(raw) as BuildCommitFile;
    return typeof parsed.commit === 'string' && parsed.commit ? parsed.commit : 'unknown';
  } catch {
    return 'unknown';
  }
}
