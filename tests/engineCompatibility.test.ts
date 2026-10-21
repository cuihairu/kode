import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkExtensionCompatibility,
  findEngineRoot,
  formatEngineCompatibilityReport
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
});
