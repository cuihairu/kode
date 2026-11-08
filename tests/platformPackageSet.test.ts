import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }); } });
const script = path.resolve('scripts/verify-platform-set.mjs');
const editions = ['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'pure-ts'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-package-set-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.mkdirSync(path.join(root, 'dist'));
  for (const edition of editions) {
    // Set validation follows per-platform ZIP validation; payload bytes are opaque here.
    fs.writeFileSync(path.join(root, 'dist', `kode-1.2.3-${edition}.vsix`), edition);
  }
  const run = (remote?: string) => spawnSync(process.execPath, [script, 'dist', ...(remote ? [remote] : [])], {
    cwd: root, encoding: 'utf8',
  });
  return { root, run };
}

it('blocks release when any required edition is missing or an extra VSIX is present', () => {
  const { root, run } = fixture();
  const pure = path.join(root, 'dist/kode-1.2.3-pure-ts.vsix');
  fs.rmSync(pure);
  expect(run().status).not.toBe(0);
  fs.writeFileSync(pure, 'pure-ts');
  fs.writeFileSync(path.join(root, 'dist/old.vsix'), 'old');
  expect(run().status).not.toBe(0);
});

it('generates checksums for exactly seven validated editions', () => {
  const { root, run } = fixture();
  expect(run().status).toBe(0);
  const lines = fs.readFileSync(path.join(root, 'dist/SHA256SUMS'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(7);
  const digest = createHash('sha256').update('pure-ts').digest('hex');
  expect(lines).toContain(`${digest}  kode-1.2.3-pure-ts.vsix`);
});

it('rejects a published asset with mismatched bytes', () => {
  const { root, run } = fixture();
  expect(run().status).toBe(0);
  const assets = fs.readdirSync(path.join(root, 'dist')).map(name => {
    const bytes = fs.readFileSync(path.join(root, 'dist', name));
    return { name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  });
  const remote = path.join(root, 'remote.json');
  fs.writeFileSync(remote, JSON.stringify({ assets }));
  expect(run(remote).status).toBe(0);
  assets[0].digest = `sha256:${'0'.repeat(64)}`;
  fs.writeFileSync(remote, JSON.stringify({ assets }));
  expect(run(remote).status).not.toBe(0);
});
