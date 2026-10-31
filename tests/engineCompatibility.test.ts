import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkExtensionCompatibility,
  findEngineRoot,
  formatEngineCompatibilityReport,
  runCompatibilityCheck
} from '../src/engineCompatibility';

let root = '';
let engineRoot = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-compat-'));
  engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-engine-'));
  fs.mkdirSync(path.join(engineRoot, 'kbe/src/lib/common'), { recursive: true });
  fs.writeFileSync(path.join(engineRoot, 'kbe/src/lib/common/version.h'), '#define KBE_VERSION "2.5.10"\n');
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out/extension.js'), '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    version: '0.1.2',
    engines: { vscode: '^1.84.0' }
  }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(engineRoot, { recursive: true, force: true });
});

describe('engine compatibility check', () => {
  it('finds local engine source and validates the package contract', () => {
    const found = findEngineRoot(root, engineRoot);
    expect(found).toBe(engineRoot);
    const report = checkExtensionCompatibility(path.join(root, 'package.json'), found, {
      displayName: 'Kode KBEngine',
      engines: '^1.84.0',
      vscodeEngine: '^1.84.0',
      files: [{ relativePath: 'out/extension.js', exported: true }]
    });
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'engine-version', status: 'ok' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'bundle', status: 'ok' }));
    expect(formatEngineCompatibilityReport(report)).toContain('OK engine-version');
  });

  it('accepts a 2.5.10+ tree with only kbeversion.h and reads the synthesized version (C-14)', () => {
    const kbeversionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-engine-kbeversion-'));
    try {
      fs.mkdirSync(path.join(kbeversionRoot, 'kbe/src/lib/common'), { recursive: true });
      fs.writeFileSync(
        path.join(kbeversionRoot, 'kbe/src/lib/common/kbeversion.h'),
        '#define KBE_VERSION_MAJOR 2\n#define KBE_VERSION_MINOR 5\n#define KBE_VERSION_PATCH 10\n'
      );
      expect(findEngineRoot(root, kbeversionRoot)).toBe(kbeversionRoot);
      const report = checkExtensionCompatibility(path.join(root, 'package.json'), kbeversionRoot, {
        displayName: 'Kode KBEngine',
        engines: '^1.84.0',
        vscodeEngine: '^1.84.0',
        files: [{ relativePath: 'out/extension.js', exported: true }]
      });
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'engine-version',
        status: 'ok',
        detail: expect.stringContaining('Engine 2.5.10')
      }));
    } finally {
      fs.rmSync(kbeversionRoot, { recursive: true, force: true });
    }
  });

  it('does not invent an engine root when source is absent', () => {
    expect(findEngineRoot(root)).toBeNull();
    const report = checkExtensionCompatibility(path.join(root, 'package.json'), null, {
      displayName: 'Kode KBEngine',
      engines: '^1.84.0',
      vscodeEngine: '^1.84.0',
      files: []
    });
    expect(report.engineRoot).toBeNull();
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'engine-version', status: 'warning' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'bundle', status: 'error' }));
  });

  it('engine 版本与要求完全相等时仍判 ok(满足比较的全等末臂)', () => {
    // satisfies 逐位比较,仅当前缀全等且无更大/更小时落到末臂 return true;
    // 旧码该末臂未覆盖。用版本完全相等的树(2.5.10 == ^2.5.10)触发。
    const equalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-engine-equal-'));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-compat-equal-'));
    try {
      fs.mkdirSync(path.join(equalRoot, 'kbe/src/lib/common'), { recursive: true });
      fs.writeFileSync(
        path.join(equalRoot, 'kbe/src/lib/common/version.h'),
        '#define KBE_VERSION "2.5.10"\n'
      );
      fs.writeFileSync(path.join(manifestDir, 'package.json'), JSON.stringify({
        version: '0.1.2',
        engines: { vscode: '^2.5.10' }
      }));
      const report = checkExtensionCompatibility(
        path.join(manifestDir, 'package.json'),
        equalRoot,
        {
          displayName: 'Kode KBEngine',
          engines: '^2.5.10',
          vscodeEngine: '^2.5.10',
          files: []
        }
      );
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'engine-version',
        status: 'ok',
        detail: expect.stringContaining('Engine 2.5.10; extension host requirement ^2.5.10.')
      }));
    } finally {
      fs.rmSync(equalRoot, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });
});

describe('compatibility command manifest path (R2-F21 / IDE-AUD-046)', () => {
  const target = {
    displayName: 'Kode KBEngine',
    engines: '^1.84.0',
    vscodeEngine: '^1.84.0',
    files: [{ relativePath: 'out/extension.js', exported: true }]
  };

  it('documented bug: passing the extension directory (old wiring) breaks manifest and bundle checks', () => {
    // 现网接线曾传 extension 目录:fs.readFileSync(目录) 抛 EISDIR → manifest
    // error,且 bundle 探测落在 dirname(目录) 的上层 → bundle error。
    // 即使 package.json 与 out/extension.js 都在,也报错(R2-F21 失败形态)。
    const broken = checkExtensionCompatibility(root, engineRoot, target);
    expect(broken.checks).toContainEqual(expect.objectContaining({ name: 'manifest', status: 'error' }));
    expect(broken.checks).toContainEqual(expect.objectContaining({ name: 'bundle', status: 'error' }));
  });

  it('runCompatibilityCheck passes the manifest file path and yields a clean report', () => {
    const report = runCompatibilityCheck(root, engineRoot, target);
    // manifest 检查只在读取失败时出现;成功路径下不应有任何 error 级检查。
    expect(report.checks.some(check => check.status === 'error')).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'bundle', status: 'ok' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'package-version', status: 'ok' }));
  });
});
