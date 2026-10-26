import * as fs from 'fs';
import * as path from 'path';

import { hasEngineTreeMarker, readEngineVersionMarker } from './engineApiMetadata';

export interface EngineVersionCheck {
  readonly name: string;
  readonly status: 'ok' | 'warning' | 'error';
  readonly detail: string;
}

export interface EngineCompatibilityReport {
  readonly engineRoot: string | null;
  readonly checks: EngineVersionCheck[];
}

export interface ExtensionCompatibilityTarget {
  readonly displayName: string;
  readonly engines: string;
  readonly vscodeEngine: string;
  readonly files: Array<{ relativePath: string; exported: boolean }>;
}

export function findEngineRoot(startDirectory: string, explicitRoot?: string): string | null {
  // C-14: dual marker probe (version.h legacy | kbeversion.h 2.5.10+), same
  // acceptance as src/engineApiMetadata.ts findEngineRoot.
  if (explicitRoot) {
    return hasEngineTreeMarker(explicitRoot, probe => fs.existsSync(probe)) ? explicitRoot : null;
  }
  const find = (current: string): string | null => {
    if (hasEngineTreeMarker(current, probe => fs.existsSync(probe))) return current;
    const parent = path.dirname(current);
    return parent === current ? null : find(parent);
  };
  return find(path.resolve(startDirectory));
}

function readVersionMacro(engineRoot: string): string | null {
  // C-14: legacy single-macro file first, then the 2.5.10+ three-macro file
  // synthesized as major.minor.patch (unknown fallback inside).
  return readEngineVersionMarker(engineRoot, probe => fs.readFileSync(probe, 'utf8'));
}

function parseRange(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function satisfies(version: string, range: string): boolean {
  const normalized = range.trim().replace(/^\^/, '').replace(/^>=?\s*/, '');
  const [target, current] = [parseRange(normalized), parseRange(version)];
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== target[index]) return current[index] > target[index];
  }
  return true;
}

export function checkExtensionCompatibility(
  manifestPath: string,
  engineRoot: string | null,
  target: ExtensionCompatibilityTarget
): EngineCompatibilityReport {
  const checks: EngineVersionCheck[] = [];
  let manifest: { version?: string; engines?: string } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    checks.push({ name: 'manifest', status: 'error', detail: `Unreadable package manifest: ${String(error)}` });
  }

  const engineVersion = engineRoot ? readVersionMacro(engineRoot) : null;
  if (!engineRoot || !engineVersion) {
    checks.push({ name: 'engine-version', status: 'warning', detail: 'Engine source not found; compatibility cannot be proven locally.' });
  } else {
    checks.push({
      name: 'engine-version',
      status: satisfies(engineVersion, target.vscodeEngine) ? 'ok' : 'warning',
      detail: `Engine ${engineVersion}; extension host requirement ${target.vscodeEngine}.`
    });
  }

  const bundle = target.files.find(file => file.relativePath === 'out/extension.js');
  checks.push({
    name: 'bundle',
    status: bundle?.exported && fs.existsSync(path.join(path.dirname(manifestPath), 'out/extension.js')) ? 'ok' : 'error',
    detail: bundle?.exported ? 'out/extension.js is packaged.' : 'out/extension.js is missing from the package files.'
  });

  const declaredVersion = String(manifest.version ?? '');
  checks.push({
    name: 'package-version',
    status: /^\d+\.\d+\.\d+$/.test(declaredVersion) ? 'ok' : 'error',
    detail: `package.json version is ${declaredVersion || 'missing'}.`
  });

  return { engineRoot, checks };
}

export function formatEngineCompatibilityReport(report: EngineCompatibilityReport): string {
  return [
    report.engineRoot ? `Engine source: ${report.engineRoot}` : 'Engine source: not found',
    ...report.checks.map(check => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`)
  ].join('\n');
}
