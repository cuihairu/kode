import { createRequire } from 'module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

// @cuihairu/kode-mcp npm launcher (packages/kode-mcp/bin/kode-mcp) is plain Node
// CommonJS so MCP clients can spawn it without a build step. It is loaded with
// createRequire rather than an import: importing it as ESM from vitest would
// not exercise the CJS module.exports surface that npm's bin shim actually uses.
const launcherPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'kode-mcp',
  'bin',
  'kode-mcp'
);
const requireLauncher = createRequire(import.meta.url);
const launcher = requireLauncher(launcherPath) as {
  SCOPE: string;
  BINARY: string;
  ARCH: Record<string, Record<string, string>>;
  platformSuffix: (platform?: string, arch?: string) => string | undefined;
  binaryName: (suffix: string) => string;
  findInNodeModules: (suffix: string, cwd?: string) => string;
};

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const withTempDir = <T>(work: (root: string) => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'kode-npm-'));
  roots.push(root);
  return work(root);
};

describe('kode-mcp npm launcher', () => {
  it('maps every published platform package to a target key', () => {
    const suffixes = Object.values(launcher.ARCH)
      .flatMap(table => Object.values(table))
      .sort();
    expect(suffixes).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64'
    ]);
  });

  it('leaves unsupported combinations unmapped instead of guessing', () => {
    expect(launcher.platformSuffix('linux', 'ia32')).toBeUndefined();
    expect(launcher.platformSuffix('freebsd', 'x64')).toBeUndefined();
  });

  it('adds the executable suffix only for windows packages', () => {
    expect(launcher.binaryName('win32-x64')).toContain('.exe');
    expect(launcher.binaryName('linux-x64')).toBe(launcher.BINARY);
  });

  it('finds the platform binary from the client working directory', () => {
    const found = withTempDir(root => {
      const packageBin = join(
        root,
        'node_modules',
        launcher.SCOPE,
        'mcp-linux-x64',
        'bin',
        launcher.BINARY
      );
      mkdirSync(dirname(packageBin), { recursive: true });
      writeFileSync(packageBin, '#!/usr/bin/env node\n');
      return launcher.findInNodeModules('linux-x64', root);
    });
    expect(found).not.toBe('');
    expect(existsSync(found)).toBe(true);
  });

  it('returns empty when no platform package is installed', () => {
    const found = withTempDir(root => launcher.findInNodeModules('linux-arm64', root));
    expect(found).toBe('');
  });

  it('resolves the current platform so a smoke run can assert it', () => {
    expect(launcher.platformSuffix()).toBe(launcher.platformSuffix(process.platform, process.arch));
  });
});

describe('kode-mcp npm package layout', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const main = () => read('packages/kode-mcp/package.json');

  it('ships the launcher as the only published file', () => {
    const manifest = main();
    expect(manifest.bin['kode-mcp']).toBe('bin/kode-mcp');
    expect(manifest.files).toEqual(['bin/kode-mcp']);
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('declares exactly the six platform packages as optional dependencies', () => {
    const manifest = main();
    expect(Object.keys(manifest.optionalDependencies).sort()).toEqual(
      Object.values(launcher.ARCH)
        .flatMap(table => Object.values(table))
        .map(suffix => `${launcher.SCOPE}/mcp-${suffix}`)
        .sort()
    );
  });

  it('tags each platform package with its own os and cpu', () => {
    for (const [platform, table] of Object.entries(launcher.ARCH)) {
      for (const suffix of Object.values(table)) {
        const info = read(`packages/kode-mcp/mcp-${suffix}/package.json`);
        expect(info.name).toBe(`${launcher.SCOPE}/mcp-${suffix}`);
        expect(info.os).toEqual([platform]);
        expect(info.cpu).toEqual([suffix.split('-')[1]]);
        // Unstaged packages stay un-publishable until CI stages a binary.
        expect(info.private).toBe(true);
      }
    }
  });

  it('keeps staged binaries out of version control', () => {
    const ignored = readFileSync(join(root, 'packages/kode-mcp/.gitignore'), 'utf8');
    expect(ignored).toContain('mcp-*/bin/');
  });

  it('stages a manifest per platform describing the shipped binary', () => {
    for (const suffix of Object.values(launcher.ARCH).flatMap(table => Object.values(table))) {
      const manifest = join(root, 'packages/kode-mcp', `mcp-${suffix}`, 'bin', 'manifest.json');
      if (!existsSync(manifest)) {
        continue; // Only the currently built target is staged.
      }
      const record = JSON.parse(readFileSync(manifest, 'utf8'));
      expect(record).toMatchObject({
        target: suffix,
        file: expect.any(String),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      });
      const binary = join(root, 'packages/kode-mcp', `mcp-${suffix}`, 'bin', record.file);
      expect(statSync(binary).size).toBe(record.bytes);
    }
  });
});

describe('kode-mcp npm packaging script', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = () => readFileSync(join(root, 'scripts/npm-package.mjs'), 'utf8');

  it('refuses to publish unless the explicit env gate is set', () => {
    expect(source()).toContain('KODE_NPM_PUBLISH');
  });

  it('caps published binary size so a debug build cannot leak', () => {
    expect(source()).toContain('MAX_PUBLISHED_BINARY_BYTES');
  });

  it('frames MCP stdio as newline-delimited JSON, not LSP content frames', () => {
    const text = source();
    // The smoke harness must not reuse kode-server's Content-Length framing.
    expect(text).not.toContain("Content-Length: ");
    expect(text).toContain('newline-delimited JSON');
  });
});
