import * as fs from 'fs';
import * as path from 'path';

/** Packaged binaries run on the extension host (including SSH/WSL), not the UI host. */
export function discoverNativeBinary(
  extensionRoot: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  const executable = platform === 'win32' ? `${name}.exe` : name;
  for (const directory of ['bin', path.join('target', 'debug'), path.join('target', 'release')]) {
    const candidate = path.join(extensionRoot, directory, executable);
    try {
      if (fs.statSync(candidate).isFile()) { return candidate; }
    } catch {
      // Missing packaged binary: allow a source checkout's development build.
    }
  }
  return '';
}
