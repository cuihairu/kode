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
