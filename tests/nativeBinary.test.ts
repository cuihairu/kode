import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';
import { discoverNativeBinary, discoverNativeBinaryReport } from '../src/backend/nativeBinary';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }); } });

// :2999 魔数守门——bin/ 打包面候选必须是当前平台的镜像格式;dev 构建(target/*)
// 是本机产物不校验。fixture 用真魔数(bin 面),target 面内容随意。win32 fixture
// 用真实 PE 头形状(MZ\x90\x00,4 字节):2 字节 MZ 文件历史上恰好骗过读取面,
// 真 PE(首 4 字节 4d5a9000)曾被精确比对整类拒收(KODE-WINPKG-001 根因)。
const platformMagic = (platform: 'linux' | 'darwin' | 'win32'): Buffer =>
  platform === 'win32' ? Buffer.from('4d5a9000', 'hex')
  : platform === 'darwin' ? Buffer.from('cffaedfe', 'hex')
  : Buffer.from('7f454c46', 'hex');

it.each(['linux', 'darwin', 'win32'] as const)('discovers packaged binaries before source builds on %s', platform => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-'));
  roots.push(root);
  const name = platform === 'win32' ? 'kode-server.exe' : 'kode-server';
  expect(discoverNativeBinary(root, 'kode-server', platform)).toBe('');
  for (const dir of ['target/release', 'target/debug', 'bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, name), dir === 'bin' ? platformMagic(platform) : 'binary');
    expect(discoverNativeBinary(root, 'kode-server', platform)).toBe(path.join(root, dir, name));
  }
  fs.rmSync(path.join(root, 'bin', name));
  fs.mkdirSync(path.join(root, 'bin', name));
  expect(discoverNativeBinary(root, 'kode-server', platform)).toBe(path.join(root, 'target/debug', name));
});

it('wrong-platform packaged binary is treated as missing with a visible reason', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-wrongplat-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  // linux 平台下 bin/ 落了一个 PE(MZ)包 = 错平台包哑挂形状的 fixture
  fs.writeFileSync(path.join(root, 'bin', 'kode-server'), Buffer.from('4d5a', 'hex'));
  const report = discoverNativeBinaryReport(root, 'kode-server', 'linux');
  expect(report.path).toBe('');
  expect(report.rejectedReason).toContain('linux');
  expect(discoverNativeBinary(root, 'kode-server', 'linux')).toBe('');
  // 有 dev 构建时回落到 dev 构建,且不再报错因(产物可用)
  fs.mkdirSync(path.join(root, 'target', 'release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'target', 'release', 'kode-server'), 'binary');
  expect(discoverNativeBinaryReport(root, 'kode-server', 'linux'))
    .toEqual({ path: path.join(root, 'target', 'release', 'kode-server'), rejectedReason: null });
});

it('darwin accepts fat and both endianness Mach-O magics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-macho-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const magic of ['feedfacf', 'cefaedfe', 'cafebabe']) {
    fs.writeFileSync(path.join(root, 'bin', 'kode-server'), Buffer.from(magic, 'hex'));
    expect(discoverNativeBinary(root, 'kode-server', 'darwin'))
      .toBe(path.join(root, 'bin', 'kode-server'));
  }
});

it('win32 discovers a real 4-byte PE header with no rejection (KODE-WINPKG-001)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-pe-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  // 真 PE:首 4 字节 4d5a9000(MZ\x90\x00,mingw/msvc DOS 头常见形状)。
  // 精确比对时代这里整类拒收,rejectedReason 谎报「平台不匹配」。
  fs.writeFileSync(path.join(root, 'bin', 'kode-server.exe'), Buffer.from('4d5a9000', 'hex'));
  expect(discoverNativeBinaryReport(root, 'kode-server', 'win32'))
    .toEqual({ path: path.join(root, 'bin', 'kode-server.exe'), rejectedReason: null });
  // 截断到只剩 2 字节 MZ 也仍是 PE 形状(前缀语义),可发现
  fs.writeFileSync(path.join(root, 'bin', 'kode-server.exe'), Buffer.from('4d5a', 'hex'));
  expect(discoverNativeBinary(root, 'kode-server', 'win32'))
    .toBe(path.join(root, 'bin', 'kode-server.exe'));
  // 真 ELF 头落在 win32 = 错平台包,仍拒收并给原因
  fs.writeFileSync(path.join(root, 'bin', 'kode-server.exe'), Buffer.from('7f454c46', 'hex'));
  const report = discoverNativeBinaryReport(root, 'kode-server', 'win32');
  expect(report.path).toBe('');
  expect(report.rejectedReason).toContain('win32');
});

// RUST-060:打包面完整性——bin/manifest.json 登记了每个二进制的 sha256;
// 发现器对 bin/ 候选做哈希对账,被替换(哈希不符)的二进制视同缺失,绝不
// spawn,落空走 ts 兜底。dev 构建(target/*)无 manifest 不校验;manifest
// 缺失/未登记=无主张可校验,放行(向后兼容)。

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

it('packaged binary with matching manifest sha256 is returned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-ok-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const elf = platformMagic('linux');
  fs.writeFileSync(path.join(root, 'bin', 'kode-server'), elf);
  fs.writeFileSync(path.join(root, 'bin', 'manifest.json'), JSON.stringify({
    target: 'linux-x64', files: { 'kode-server': sha256(elf) },
  }));
  expect(discoverNativeBinary(root, 'kode-server', 'linux'))
    .toBe(path.join(root, 'bin', 'kode-server'));
});

it('packaged binary whose sha256 no longer matches the manifest is skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-tamper-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'kode-server'), 'replaced-by-attacker');
  fs.writeFileSync(path.join(root, 'bin', 'manifest.json'), JSON.stringify({
    target: 'linux-x64', files: { 'kode-server': sha256('real-binary') },
  }));
  // bin/ 候选被跳过:无 dev 构建时落空(''),有 dev 构建时回落到它
  expect(discoverNativeBinary(root, 'kode-server', 'linux')).toBe('');
  fs.mkdirSync(path.join(root, 'target', 'release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'target', 'release', 'kode-server'), 'dev-build');
  expect(discoverNativeBinary(root, 'kode-server', 'linux'))
    .toBe(path.join(root, 'target', 'release', 'kode-server'));
});

it('manifest without a record for the binary, or unreadable, imposes no claim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-noclaim-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'kode-server'), platformMagic('linux'));
  // 未登记该文件(如未来清单收窄)=无主张,放行
  fs.writeFileSync(path.join(root, 'bin', 'manifest.json'),
    JSON.stringify({ target: 'linux-x64', files: {} }));
  expect(discoverNativeBinary(root, 'kode-server', 'linux'))
    .toBe(path.join(root, 'bin', 'kode-server'));
  // manifest 损坏不可读=无主张,放行(向后兼容)
  fs.writeFileSync(path.join(root, 'bin', 'manifest.json'), 'not-json{');
  expect(discoverNativeBinary(root, 'kode-server', 'linux'))
    .toBe(path.join(root, 'bin', 'kode-server'));
});
