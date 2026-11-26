/**
 * Engine target Python version provenance and the debugpy version policy (DBG-COMPAT-01/02,
 * 2026-11-12 user ledger): the engine target version comes from "the real engine" or an
 * "explicit project target", and provenance plus the unknown state are preserved -- never
 * substitute the dev machine's interpreter or a global constant (the old EMBEDDED_PYTHON_VERSION
 * '3.12.13') for the engine version; projects with different versions never borrow from each
 * other (resolution walks the active profile's engineRoot per workspace).
 *
 * Version source priority (resolvePythonTarget):
 * 1. Explicit kbengine.debug.pythonTarget setting (e.g. "3.7.3"; empty = not explicit);
 * 2. Engine binary banner scan: scan the server binaries under kbe/bin/server of the active
 *    profile's engineRoot (first 32MB, at most 3 binaries) for CPython version strings and vote
 *    -- a candidate is trusted only when >=2 binaries show it; a single binary with a single
 *    candidate is accepted at reduced confidence (weaker, provenance recorded honestly);
 *    multiple candidates / zero candidates = unknown, no guessing;
 * 3. Neither = none (unknown). Unknown is not an error state, it is the honest state: downstream
 *    policy returns no pin, auto-install/sync refuses to act blindly, and the precheck only
 *    checks whether it is installed.
 *
 * debugpy version policy (debugpyPolicyFor; authoritative source = the official compatibility
 * table in docs/guide/python-debugger-compatibility.md, verified 2026-11-11):
 * - 3.7.x -> strict lock on 1.7.0 (from 1.8.0 on, debugpy officially requires >=3.8; anything
 *   newer is rejected outright);
 * - 3.8.x -> 1.8.1 (official 2024.2.x support line), as a floor gate;
 * - 3.9.x -> 1.8.13 (official 2025.5.x support line), as a floor gate;
 * - 3.10+ (modern known versions) -> floor 1.8.0 (the lowest version of that line whose official
 *   CI covers 3.10-3.12);
 * - unknown -> no policy: never blindly install the latest, never auto-sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveActiveProfile } from '../activeProfile';

/** Explicit project target setting key (empty/unset = not explicit, go through engine binary probing) */
export const PYTHON_TARGET_SETTING = 'kbengine.debug.pythonTarget';

/** Binary scan fan-out cap: at most the first N server binaries (voting across binaries) */
export const ENGINE_BIN_SCAN_LIMIT = 3;
/** Head bytes scanned per binary (the CPython version string lives in .rodata; a head window is enough) */
export const ENGINE_BIN_SCAN_BYTES = 32 * 1024 * 1024;

export type PythonTargetSource = 'project-setting' | 'engine-binary' | 'none';

export interface PythonTarget {
  /** Three-segment version ("3.7.3"); null = unknown (the source field is preserved; never falls back to a constant) */
  version: string | null;
  /** Where the version came from (project-setting/engine-binary; none = no source) */
  source: PythonTargetSource;
  /** One-line human-readable provenance description (which setting / which binaries / what is missing) */
  detail: string;
}

/** Normalize a three-segment version; non-x.y.z shapes honestly yield null (no guessing, no trimming) */
export function normalizeVersionText(text: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** The version's minor line ("3.7.3" -> "3.7"); null when not three segments */
export function pythonLineOf(version: string | null): string | null {
  if (version === null) {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Scan binary bytes for CPython version string candidates (deduplicated, in order of
 * appearance). latin1 decoding shifts nothing; version strings are pure ASCII. Version strings
 * not starting with 3.x (OpenSSL/zlib and other non-Python version noise) are filtered out;
 * the cap keeps only sane shapes with minor<40, guarding against matching arbitrary three-segment numbers.
 */
export function scanPythonVersionCandidates(bytes: Buffer): string[] {
  const found: string[] = [];
  const text = bytes.toString('latin1');
  const pattern = /3\.(\d+)\.(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const minor = Number.parseInt(match[1], 10);
    const patch = Number.parseInt(match[2], 10);
    if (minor >= 40 || patch >= 100) {
      continue;
    }
    const version = match[0];
    if (!found.includes(version)) {
      found.push(version);
    }
  }
  return found;
}

/**
 * Cross-binary voting: a candidate seen in >=2 binaries -> trusted; exactly one such candidate
 * is accepted (multiple = mutually exclusive evidence, unknown); with zero, degrade -- if only
 * one binary was scanned and it has exactly one candidate, accept that too (the provenance face
 * is honestly marked weaker). Everything else is null (no guessing).
 */
export function voteEnginePythonVersion(candidatesPerBinary: readonly string[][]): string | null {
  const binaryCount = new Map<string, number>();
  for (const candidates of candidatesPerBinary) {
    for (const version of candidates) {
      binaryCount.set(version, (binaryCount.get(version) ?? 0) + 1);
    }
  }
  const trusted = [...binaryCount.entries()].filter(([, count]) => count >= 2).map(([version]) => version);
  if (trusted.length === 1) {
    return trusted[0];
  }
  if (trusted.length === 0 && candidatesPerBinary.length === 1 && candidatesPerBinary[0].length === 1) {
    return candidatesPerBinary[0][0];
  }
  return null;
}

export interface PythonTargetDeps {
  /** Current value of kbengine.debug.pythonTarget (unset/empty = not explicit) */
  configValue(): string | undefined;
  /** The active profile's engine root (unresolvable / no profile selected = null) */
  engineRoot(): string | null;
  /** Server binaries under the engine root (production = files of <engine root>/bin/server, deterministic order) */
  listServerBinaries(root: string): string[];
  /** Read the binary's head bytes; unreadable (permissions / missing) honestly yields null */
  readBinaryHead(candidate: string, maxBytes: number): Buffer | null;
}

/** Production face: files of the bin/server directory under the engine install root in deterministic name order (cross-platform, no extension filtering) */
export const defaultListServerBinaries = (root: string): string[] => {
  const dir = path.join(root, 'bin', 'server');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort()
      .map(name => path.join(dir, name));
  } catch {
    return [];
  }
};

const defaultReadBinaryHead = (candidate: string, maxBytes: number): Buffer | null => {
  try {
    const fd = fs.openSync(candidate, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
};

/** Production wiring: workspace settings + active profile engine root (per workspace, never borrowed across) */
export function pythonTargetDeps(workspaceState?: {
  get(key: string): unknown;
}): PythonTargetDeps {
  return {
    configValue: () =>
      vscodeWorkspaceConfig().get<string>('debug.pythonTarget'),
    engineRoot: () => {
      const engineRoot = resolveActiveProfile(workspaceState as never)?.engineRoot;
      return typeof engineRoot === 'string' && engineRoot.trim().length > 0 ? engineRoot.trim() : null;
    },
    listServerBinaries: defaultListServerBinaries,
    readBinaryHead: defaultReadBinaryHead
  };
}

/** One level of indirection so test doubles can swap the workspace config source */
let workspaceConfigSource: (() => { get<T>(section: string, fallback?: T): T }) | null = null;

/** Test injection point: replace the kbengine config read source (production defaults to the real vscode.workspace) */
export function setWorkspaceConfigSourceForTests(
  source: (() => { get<T>(section: string, fallback?: T): T }) | null
): void {
  workspaceConfigSource = source;
}

const vscodeWorkspaceConfig = (): { get<T>(section: string, fallback?: T): T } => {
  if (workspaceConfigSource) {
    return workspaceConfigSource();
  }
  return vscode.workspace.getConfiguration('kbengine') as unknown as {
    get<T>(section: string, fallback?: T): T;
  };
};

/**
 * Main face of target version resolution: setting > binary voting > unknown. Every return
 * carries provenance and detail -- "unknown" keeps its source information and never silently
 * falls back to a constant or the dev machine's interpreter.
 */
export function resolvePythonTarget(deps: PythonTargetDeps): PythonTarget {
  const setting = deps.configValue()?.trim();
  if (setting !== undefined && setting.length > 0) {
    const version = normalizeVersionText(setting);
    if (version !== null) {
      return {
        version,
        source: 'project-setting',
        detail: `设置 ${PYTHON_TARGET_SETTING}=${version}`
      };
    }
    return {
      version: null,
      source: 'project-setting',
      detail: `设置 ${PYTHON_TARGET_SETTING}='${setting}' 不是 x.y.z 三段版本,按未知处理(修正设置或清空走引擎探测)`
    };
  }
  const root = deps.engineRoot();
  if (root === null) {
    return {
      version: null,
      source: 'none',
      detail: `未显式设置 ${PYTHON_TARGET_SETTING} 且活动项目无引擎根,引擎 Python 版本未知`
    };
  }
  const binaries = deps.listServerBinaries(root).slice(0, ENGINE_BIN_SCAN_LIMIT);
  if (binaries.length === 0) {
    return {
      version: null,
      source: 'none',
      detail: `引擎根 ${root} 下 kbe/bin/server 无服务二进制,引擎 Python 版本未知(可在 ${PYTHON_TARGET_SETTING} 显式指定)`
    };
  }
  const perBinary = binaries.map(binary => {
    const head = deps.readBinaryHead(binary, ENGINE_BIN_SCAN_BYTES);
    return head === null ? [] : scanPythonVersionCandidates(head);
  });
  const voted = voteEnginePythonVersion(perBinary);
  if (voted !== null) {
    const weaker = candidatesPerBinaryCount(perBinary) === 1 ? '(单二进制单候选,证据较弱)' : '';
    return {
      version: voted,
      source: 'engine-binary',
      detail: `引擎二进制扫描(${binaries.length} 个投票)判定 Python ${voted}${weaker}`
    };
  }
  return {
    version: null,
    source: 'engine-binary',
    detail: `扫描 ${binaries.length} 个引擎二进制未得单一可信候选,引擎 Python 版本未知(可在 ${PYTHON_TARGET_SETTING} 显式指定)`
  };
}

const candidatesPerBinaryCount = (perBinary: readonly string[][]): number =>
  perBinary.reduce((sum, candidates) => sum + candidates.length, 0);

// ---------------------------------------------------------------------------
// debugpy version policy (authoritative source = docs/guide/python-debugger-compatibility.md)
// ---------------------------------------------------------------------------

export interface DebugpyPolicy {
  /** The target Python line ("3.7"); null = no policy (unknown target) */
  line: string | null;
  /** The exact pin installed/synced ("1.7.0"); null = no auto-install */
  pin: string | null;
  /** Strict equality: newer is rejected too (3.7 only -- from 1.8.0 on the official requirement is >=3.8) */
  strict: boolean;
  /** Version floor for non-strict lines (null = none) */
  floor: string | null;
}

/** The extension support line for 3.7 (ms-python.debugpy 2024.0.x, official compatibility table) */
export const PY37_DEBUGGER_EXTENSION_LINE = '2024.0';

/** Verified support line table: Python line -> debugpy pin (see the module header comment for provenance) */
const DEBUGPY_PIN_BY_LINE: Readonly<Record<string, string>> = {
  '3.7': '1.7.0',
  '3.8': '1.8.1',
  '3.9': '1.8.13'
};

/** Compatibility floor for modern lines (3.10+): from 1.8.0 on, official CI covers 3.10-3.12 */
export const MODERN_DEBUGPY_FLOOR = '1.8.0';

/** Semantic three-segment comparison (a local copy of autoDebugpy.compareVersions to avoid a reverse dependency) */
const compare3 = (a: string, b: string): number => {
  const parse = (value: string): number[] =>
    value.split('.').slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) - (y[i] ?? 0);
    }
  }
  return 0;
};

/**
 * Target Python version -> debugpy policy. 3.7 strict equality; 3.8/3.9 pin to the verified
 * support line and accept newer (later official versions still support that line); 3.10+ floor
 * 1.8.0; unknown -> no policy.
 */
export function debugpyPolicyFor(pythonVersion: string | null): DebugpyPolicy | null {
  const line = pythonLineOf(pythonVersion);
  if (line === null) {
    return null;
  }
  const pinned = DEBUGPY_PIN_BY_LINE[line];
  if (pinned !== undefined) {
    return line === '3.7'
      ? { line, pin: pinned, strict: true, floor: pinned }
      : { line, pin: pinned, strict: false, floor: pinned };
  }
  const major = Number.parseInt(line.split('.')[0] ?? '', 10);
  const minor = Number.parseInt(line.split('.')[1] ?? '', 10);
  if (major === 3 && minor >= 10) {
    return { line, pin: null, strict: false, floor: MODERN_DEBUGPY_FLOOR };
  }
  return null;
}

/**
 * Whether a version satisfies the policy: strict requires ==pin; non-strict requires >=floor
 * (a null floor is always true). Shared by sync / precheck / asset-tree verification so all
 * three use one ruling (DBG-COMPAT-04, the same gate).
 */
export function debugpyVersionSatisfiesPolicy(version: string, policy: DebugpyPolicy): boolean {
  if (policy.strict) {
    return compare3(version, policy.pin ?? '') === 0;
  }
  return policy.floor === null || compare3(version, policy.floor) >= 0;
}

/** pip install args for the policy (exact version, no more blanket -U; modern lines use the floor form) */
export function debugpyInstallSpecFor(pythonVersion: string | null): string[] | null {
  const policy = debugpyPolicyFor(pythonVersion);
  if (policy === null) {
    return null;
  }
  if (policy.pin !== null) {
    return ['install', `debugpy==${policy.pin}`];
  }
  return policy.floor === null ? null : ['install', `debugpy>=${policy.floor}`];
}

/**
 * Verify the debug extension version line for a 3.7 target (DBG-COMPAT-05): whether the
 * observed ms-python.debugpy version falls on the 3.7 support line (2024.0.x). A null version =
 * unknown (extension not installed / unreadable) -- unknown never judges a match; the caller
 * explains honestly.
 */
export function debugExtensionOn37Line(version: string | null): boolean | null {
  if (version === null) {
    return null;
  }
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (match === null) {
    return null;
  }
  const [expectedMajor, expectedMinor] = PY37_DEBUGGER_EXTENSION_LINE.split('.').map(part =>
    Number.parseInt(part, 10)
  );
  return Number.parseInt(match[1], 10) === expectedMajor && Number.parseInt(match[2], 10) === expectedMinor;
}

/** The ms-python.debugpy extension id (the debugpy debug type provider; the dependency face of attach) */
export const DEBUGPY_EXTENSION_ID = 'ms-python.debugpy';

/**
 * Read the observed ms-python.debugpy version in the extension host (DBG-COMPAT-05); not
 * installed / packageJSON anomaly -> null (honest unknown). The registry is injectable for
 * tests; the default is the real vscode.extensions.
 */
export function readDebugpyExtensionVersion(
  registry: { getExtension(id: string): { packageJSON?: { version?: unknown } } | undefined } = vscode.extensions
): string | null {
  try {
    const version = registry.getExtension(DEBUGPY_EXTENSION_ID)?.packageJSON?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

export interface DebugExtensionCompat {
  kind: 'ok' | 'extension-off-line' | 'extension-missing';
  /** A one-line actionable message when not ok (fixed-version install + disable auto-update steps) */
  message: string | null;
}

/**
 * 3.7 target x debug extension line decision (DBG-COMPAT-05): a strict target (3.7) requires
 * ms-python.debugpy on 2024.0.x -- later extension lines removed Python 3.7 debug support, so
 * attach is guaranteed to fail; non-3.7 targets do not look at the extension line (newer lines
 * are better); not installed = honest absence. The decision only produces step-by-step message
 * text and never auto-downgrades the user's debug extension (other projects are not bound by 3.7).
 */
export function debugExtensionCompatFor(
  pythonTarget: PythonTarget,
  extensionVersion: string | null
): DebugExtensionCompat {
  const policy = debugpyPolicyFor(pythonTarget.version);
  if (policy === null || !policy.strict) {
    return { kind: 'ok', message: null };
  }
  if (extensionVersion === null) {
    return {
      kind: 'extension-missing',
      message: `引擎目标 Python ${pythonTarget.version} 的调试依赖 ${DEBUGPY_EXTENSION_ID} 扩展,当前扩展宿主未检测到;` +
        `Python 3.7 请安装 ${PY37_DEBUGGER_EXTENSION_LINE} 线版本(如 ${PY37_DEBUGGER_EXTENSION_LINE}.0),` +
        `更高版本线(${Number.parseInt(PY37_DEBUGGER_EXTENSION_LINE.split('.')[0], 10) + 1}.x 起)已移除 3.7 调试支持`
    };
  }
  if (debugExtensionOn37Line(extensionVersion)) {
    return { kind: 'ok', message: null };
  }
  return {
    kind: 'extension-off-line',
    message: `引擎目标 Python ${pythonTarget.version} 需要 ${DEBUGPY_EXTENSION_ID} ${PY37_DEBUGGER_EXTENSION_LINE}.x` +
      `(当前 ${extensionVersion}——其后的扩展线已移除 Python 3.7 调试支持)。请在扩展面板对该扩展` +
      `「安装特定版本...」选 ${PY37_DEBUGGER_EXTENSION_LINE}.0,并在扩展齿轮菜单选「忽略升级」防自动更新;` +
      '本扩展绝不自动降级你的调试扩展(非 3.7 工程用新版扩展不受影响)'
  };
}
