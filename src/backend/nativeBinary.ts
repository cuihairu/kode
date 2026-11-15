import { createHash } from 'crypto';
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
    return candidate;
  }
  return '';
}

/** 打包面完整性:bin/<executable> 的 sha256 必须与 bin/manifest.json 记录一致。
 * manifest 缺失/不可读/未登记该文件=无主张可校验,放行(向后兼容);记录不匹配
 * =二进制在安装后被替换,不放行。只约束打包面 bin/,dev 构建(target/*)无
 * manifest 不校验。 */
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
