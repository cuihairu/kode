import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';
import { discoverNativeBinary } from '../src/backend/nativeBinary';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }); } });

it.each(['linux', 'darwin', 'win32'] as const)('discovers packaged binaries before source builds on %s', platform => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-'));
  roots.push(root);
  const name = platform === 'win32' ? 'kode-server.exe' : 'kode-server';
  expect(discoverNativeBinary(root, 'kode-server', platform)).toBe('');
  for (const dir of ['target/release', 'target/debug', 'bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, name), 'binary');
    expect(discoverNativeBinary(root, 'kode-server', platform)).toBe(path.join(root, dir, name));
  }
  fs.rmSync(path.join(root, 'bin', name));
  fs.mkdirSync(path.join(root, 'bin', name));
  expect(discoverNativeBinary(root, 'kode-server', platform)).toBe(path.join(root, 'target/debug', name));
});

// RUST-060:打包面完整性——bin/manifest.json 登记了每个二进制的 sha256;
// 发现器对 bin/ 候选做哈希对账,被替换(哈希不符)的二进制视同缺失,绝不
// spawn,落空走 ts 兜底。dev 构建(target/*)无 manifest 不校验;manifest
// 缺失/未登记=无主张可校验,放行(向后兼容)。

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

it('packaged binary with matching manifest sha256 is returned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-native-ok-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'kode-server'), 'real-binary');
  fs.writeFileSync(path.join(root, 'bin', 'manifest.json'), JSON.stringify({
    target: 'linux-x64', files: { 'kode-server': sha256('real-binary') },
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
  fs.writeFileSync(path.join(root, 'bin', 'kode-server'), 'binary');
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
