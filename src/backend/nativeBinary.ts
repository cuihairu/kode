import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 打包二进制发现结果:路径为空 = 该面无可运行产物;rejectedReason 非空 =
 * bin/ 面上找到了同名文件但魔数与当前平台不符(错平台包落盘),按缺失处理,
 * 原因交由调用方直显(不再以「未安装」假象呈现哑挂形状)。
 */
export interface NativeBinaryReport {
  readonly path: string;
  readonly rejectedReason: string | null;
}

/** 平台期望的镜像魔数(win32=PE 的 MZ;linux=ELF;darwin=Mach-O/fat) */
function expectedMagics(platform: NodeJS.Platform): readonly string[] {
  switch (platform) {
    case 'win32': return ['4d5a'];
    case 'darwin': return ['feedfacf', 'feedface', 'cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'];
    default: return ['7f454c46'];
  }
}

/** 读文件头 4 字节的十六进制;不可读返回 null。 */
function readHeaderHex(file: string): string | null {
  // openSync 返回文件描述符(number),非 promises 面的 FileHandle
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

/** 镜像格式与平台相符?只用于 bin/ 打包面(dev 构建是本机产物,不属本门)。 */
function matchesPlatformFormat(file: string, platform: NodeJS.Platform): boolean {
  const header = readHeaderHex(file);
  if (header === null) { return false; }
  return expectedMagics(platform).includes(header);
}

/** 错平台包的用户可读原因(直显面;platform 形态与 VSIX 平台名同口径) */
function platformPackageMismatchReason(platform: NodeJS.Platform): string {
  return `安装的平台包与当前系统不匹配（当前 ${platform}），请安装 ${platform} 平台包`;
}

/**
 * 打包二进制发现(带诊断原因)。Packaged binaries run on the extension host
 * (including SSH/WSL), not the UI host.
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
      // 错平台包落盘(如 linux-x64 的 ELF 落在 win32 扩展目录):spawn 只会
      // 得到 exec format error / ENOENT 同形哑挂,先按缺失处理让回落路径接手,
      // 原因记进 report 由调用方直显,不再呈现「未安装」假象。
      rejectedReason = platformPackageMismatchReason(platform);
      continue;
    }
    return { path: candidate, rejectedReason: null };
  }
  return { path: '', rejectedReason };
}

/** 签名保持向后兼容:六个生产调用点只取路径。 */
export function discoverNativeBinary(
  extensionRoot: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  return discoverNativeBinaryReport(extensionRoot, name, platform).path;
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
