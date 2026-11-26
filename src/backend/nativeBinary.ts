import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Packaged binary discovery result: an empty path = that face has no runnable artifact; a
 * non-empty rejectedReason = a file with the same name was found in the bin/ face but its
 * magic number does not match the current platform (a wrong-platform package landed on disk),
 * so it is treated as missing, and the reason is shown directly by the caller (the dull
 * hang shape is no longer presented under the guise of "not installed").
 */
export interface NativeBinaryReport {
  readonly path: string;
  readonly rejectedReason: string | null;
}

/** Image magic numbers expected for a platform (win32 = PE's MZ; linux = ELF; darwin = Mach-O/fat) */
function expectedMagics(platform: NodeJS.Platform): readonly string[] {
  switch (platform) {
    case 'win32': return ['4d5a'];
    case 'darwin': return ['feedfacf', 'feedface', 'cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'];
    default: return ['7f454c46'];
  }
}

/** Hex of the first 4 bytes of a file; returns null when unreadable. */
function readHeaderHex(file: string): string | null {
  // openSync returns a file descriptor (a number), not a promises-face FileHandle
  let handle: number | null = null;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4);
    const bytes = fs.readSync(handle, buffer, 0, 4, 0);
    return bytes > 0 ? buffer.subarray(0, bytes).toString('hex') : null;
  } catch {
    return null;
  } finally {
    if (handle) { fs.closeSync(handle); }
  }
}

/** Does the image format match the platform? Used only for the bin/ packaging face (a dev build is a local artifact and is not subject to this gate). Prefix match: the header reads 4 bytes while PE's MZ magic is 2 bytes, so an exact comparison would structurally reject every real Windows image. */
function matchesPlatformFormat(file: string, platform: NodeJS.Platform): boolean {
  const header = readHeaderHex(file);
  if (header === null) { return false; }
  return expectedMagics(platform).some(magic => header.startsWith(magic));
}

/** User-readable reason for a wrong-platform package (the direct-display face; the platform form uses the same accounting as VSIX platform names) */
function platformPackageMismatchReason(platform: NodeJS.Platform): string {
  return `安装的平台包与当前系统不匹配（当前 ${platform}），请安装 ${platform} 平台包`;
}

/**
 * Packaged binary discovery (carrying a diagnostic reason). Packaged binaries run on the
 * extension host (including SSH/WSL), not the UI host.
 */
export function discoverNativeBinaryReport(
  extensionRoot: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): NativeBinaryReport {
  const executable = platform === 'win32' ? `${name}.exe` : name;
  let rejectedReason: string | null = null;
  for (const directory of ['bin', path.join('target', 'debug'), path.join('target', 'release')]) {
    const candidate = path.join(extensionRoot, directory, executable);
    try {
      if (!fs.statSync(candidate).isFile()) { continue; }
    } catch {
      // Missing packaged binary: allow a source checkout's development build.
      continue;
    }
    if (directory === 'bin' && !matchesPackagedManifest(extensionRoot, executable)) {
      // RUST-060: a packaged binary whose sha256 no longer matches bin/manifest.json
      // is treated as missing (tampered or replaced after install) — never spawned;
      // discovery falls through to source-checkout paths and the TS backend.
      continue;
    }
    if (directory === 'bin' && !matchesPlatformFormat(candidate, platform)) {
      // A wrong-platform package landed on disk (e.g. a linux-x64 ELF in a win32 extension
      // directory): spawning would only produce an exec format error / ENOENT with the same
      // dull-hang shape, so treat it as missing first and let the fallback path take over;
      // the reason is recorded in the report for the caller to display directly, and the
      // "not installed" guise is no longer presented.
      rejectedReason = platformPackageMismatchReason(platform);
      continue;
    }
    return { path: candidate, rejectedReason: null };
  }
  return { path: '', rejectedReason };
}

/** The signature stays backward compatible: the six production call sites only take the path. */
export function discoverNativeBinary(
  extensionRoot: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  return discoverNativeBinaryReport(extensionRoot, name, platform).path;
}

/** Packaged-face integrity: the sha256 of bin/<executable> must match what bin/manifest.json
 * records. A missing/unreadable manifest, or one that does not list the file, means there is
 * no claim to verify, so it passes (backward compatible); a mismatched record = the binary was
 * replaced after install, which does not pass. This only constrains the packaged bin/ face; a
 * dev build (target/*) has no manifest and is not verified. */
function matchesPackagedManifest(extensionRoot: string, executable: string): boolean {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'bin', 'manifest.json'), 'utf8')
    ) as { files?: Record<string, string> };
    const expected = manifest.files?.[executable];
    if (typeof expected !== 'string') { return true; }
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(extensionRoot, 'bin', executable)))
      .digest('hex');
    return actual === expected;
  } catch {
    return true;
  }
}
