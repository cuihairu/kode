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
  /** 声明的 KBEngine 引擎支持矩阵(如 '^2.5.0');未声明则引擎兼容性标未知。 */
  readonly engines?: string;
  /** VS Code 引擎要求(engines.vscode),用于与扩展宿主版本比对。 */
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
  target: ExtensionCompatibilityTarget,
  hostVersion?: string
): EngineCompatibilityReport {
  const checks: EngineVersionCheck[] = [];
  let manifest: { version?: string; engines?: string } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    checks.push({ name: 'manifest', status: 'error', detail: `Unreadable package manifest: ${String(error)}` });
  }

  // R2-F22:引擎版本与宿主(扩展宿主)版本是两个产品版本域,绝不混比。
  // 引擎版本对照声明的引擎支持矩阵;宿主版本对照 VS Code 引擎要求。
  const engineVersion = engineRoot ? readVersionMacro(engineRoot) : null;
  if (!engineRoot || !engineVersion) {
    checks.push({ name: 'engine-version', status: 'warning', detail: 'Engine source not found; compatibility cannot be proven locally.' });
  } else if (!target.engines) {
    checks.push({ name: 'engine-version', status: 'warning', detail: `Engine ${engineVersion}; no engine support matrix declared, compatibility unproven.` });
  } else {
    checks.push({
      name: 'engine-version',
      status: satisfies(engineVersion, target.engines) ? 'ok' : 'warning',
      detail: `Engine ${engineVersion} vs engine support range ${target.engines}.`
    });
  }

  if (hostVersion === undefined) {
    checks.push({ name: 'host-version', status: 'warning', detail: 'Extension host version not provided.' });
  } else {
    checks.push({
      name: 'host-version',
      status: satisfies(hostVersion, target.vscodeEngine) ? 'ok' : 'warning',
      detail: `Extension host ${hostVersion} vs VS Code engine requirement ${target.vscodeEngine}.`
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

/**
 * 兼容检查命令的命令体(R2-F21/IDE-AUD-046):入参是扩展根目录,内部把
 * manifest 文件路径(package.json)传给 checkExtensionCompatibility ——
 * 现网接线曾直接传目录,helper 以 fs.readFileSync(目录) 抛 EISDIR,且 bundle
 * 探测落在 dirname(目录) 的上层,导致有 package.json+out/extension.js 也报错。
 */
export function runCompatibilityCheck(
  extensionDir: string,
  engineRoot: string | null,
  target: ExtensionCompatibilityTarget,
  hostVersion?: string
): EngineCompatibilityReport {
  const manifestPath = path.join(extensionDir, 'package.json');
  return checkExtensionCompatibility(manifestPath, engineRoot, target, hostVersion);
}

export function formatEngineCompatibilityReport(report: EngineCompatibilityReport): string {
  return [
    report.engineRoot ? `Engine source: ${report.engineRoot}` : 'Engine source: not found',
    ...report.checks.map(check => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`)
  ].join('\n');
}
