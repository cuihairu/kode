/**
 * 引擎目标 Python 版本来源与 debugpy 版本策略(DBG-COMPAT-01/02,2026-11-12
 * 用户账本):引擎目标版本从「真实引擎」或「显式项目目标」来,保留来源与
 * 未知状态——绝不拿开发机解释器或全局常量(旧 EMBEDDED_PYTHON_VERSION
 * '3.12.13')代替引擎版本,多工程不同版本互不串用(解析按活动 profile 的
 * engineRoot 逐工作区走)。
 *
 * 版本来源优先级(resolvePythonTarget):
 * 1. 显式设置 kbengine.debug.pythonTarget(如 "3.7.3";空 = 未显式);
 * 2. 引擎二进制横幅扫描:活动 profile 的 engineRoot 下 kbe/bin/server 的
 *    服务二进制(前 32MB,至多 3 个)扫 CPython 版本串投票——≥2 个二进制
 *    同现一个候选才认;单二进制单候选降级认( weaker,来源如实记);
 *    多候选/零候选 = 未知,不猜;
 * 3. 都无 = none(未知)。未知不是错误状态,是诚实状态:下游策略返回
 *    无 pin,自动安装/同步拒绝盲动,预检只查装没装。
 *
 * debugpy 版本策略(debugpyPolicyFor,口径=docs/guide/
 * python-debugger-compatibility.md 官方兼容表,2026-11-11 核查):
 * - 3.7.x → 严格锁 1.7.0(1.8.0 起 debugpy 官方要求 ≥3.8,过高直接拒);
 * - 3.8.x → 1.8.1(官方 2024.2.x 支持线),下限闸;
 * - 3.9.x → 1.8.13(官方 2025.5.x 支持线),下限闸;
 * - 3.10+(现代已知版本)→ 下限 1.8.0(该线官方纳入 3.10-3.12 的最低版);
 * - 未知 → 无策略:不盲装最新版,不自动同步。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveActiveProfile } from '../activeProfile';

/** 显式项目目标设置键(空/未设 = 不显式,走引擎二进制探测) */
export const PYTHON_TARGET_SETTING = 'kbengine.debug.pythonTarget';

/** 二进制扫描扇出上限:至多前 N 个服务二进制(投票跨二进制) */
export const ENGINE_BIN_SCAN_LIMIT = 3;
/** 单二进制扫描头部字节数(CPython 版本串在 .rodata,头部窗口足够) */
export const ENGINE_BIN_SCAN_BYTES = 32 * 1024 * 1024;

export type PythonTargetSource = 'project-setting' | 'engine-binary' | 'none';

export interface PythonTarget {
  /** 三段版本("3.7.3");null = 未知(来源字段保留,绝不回落常量) */
  version: string | null;
  /** 版本从哪来(project-setting/engine-binary;none = 无来源) */
  source: PythonTargetSource;
  /** 一行人类可读来源描述(哪条设置/哪些二进制/缺什么) */
  detail: string;
}

/** 三段版本规范化;非 x.y.z 形如实 null(不猜不裁剪) */
export function normalizeVersionText(text: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** 版本的 minor 行("3.7.3"→"3.7");非三段 null */
export function pythonLineOf(version: string | null): string | null {
  if (version === null) {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * 从二进制字节扫 CPython 版本串候选(去重、按出现序)。latin1 解码零位移,
 * 版本串是纯 ASCII。3.x 起头过滤掉 OpenSSL/zlib 等非 Python 版本噪声;
 * 上限只留 minor<40 的合理形态,防误配任意三段数字。
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
 * 跨二进制投票:同一候选出现在 ≥2 个二进制 → 可信;恰一个这样的候选才认
 * (多个 = 互斥证据,未知);零个时降级——只扫了一个二进制且它恰有一个
 * 候选,也认(来源面如实标注 weaker)。其余一律 null(不猜)。
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
  /** kbengine.debug.pythonTarget 当前值(未设/空 = 不显式) */
  configValue(): string | undefined;
  /** 活动 profile 的引擎根(判不出/未选 profile = null) */
  engineRoot(): string | null;
  /** 引擎根下的服务二进制列表(生产 = kbe/bin/server 文件,确定序) */
  listServerBinaries(root: string): string[];
  /** 读二进制头部字节;读不了(权限/不存在)如实 null */
  readBinaryHead(candidate: string, maxBytes: number): Buffer | null;
}

/** 生产面:kbe/bin/server 目录文件按名确定序(跨平台无后缀过滤) */
export const defaultListServerBinaries = (root: string): string[] => {
  const dir = path.join(root, 'kbe', 'bin', 'server');
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

/** 生产装配:工作区设置 + 活动 profile 引擎根(逐工作区,互不串用) */
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

/** 间接一层方便测试替身换 workspace 配置源 */
let workspaceConfigSource: (() => { get<T>(section: string, fallback?: T): T }) | null = null;

/** 测试注入口:替换 kbengine 配置读取源(生产默认真 vscode.workspace) */
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
 * 目标版本解析主面:设置 > 二进制投票 > 未知。每个返回都带来源与
 * detail——「未知」保留来源信息,绝不静默回落常量或开发机解释器。
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
// debugpy 版本策略(口径 = docs/guide/python-debugger-compatibility.md)
// ---------------------------------------------------------------------------

export interface DebugpyPolicy {
  /** 目标 Python 行("3.7");null = 无策略(未知目标) */
  line: string | null;
  /** 安装/同步的精确 pin("1.7.0");null = 不自动装 */
  pin: string | null;
  /** 严格等号:过高也拒(3.7 专属——1.8.0 起官方要求 ≥3.8) */
  strict: boolean;
  /** 非严格行的版本下限(null = 无) */
  floor: string | null;
}

/** 3.7 的扩展支持线(ms-python.debugpy 2024.0.x,官方兼容表) */
export const PY37_DEBUGGER_EXTENSION_LINE = '2024.0';

/** 已核实支持线表:Python 行 → debugpy pin(来源见模块头注释) */
const DEBUGPY_PIN_BY_LINE: Readonly<Record<string, string>> = {
  '3.7': '1.7.0',
  '3.8': '1.8.1',
  '3.9': '1.8.13'
};

/** 现代行(3.10+)的兼容下限:1.8.0 起官方 CI 纳入 3.10-3.12 */
export const MODERN_DEBUGPY_FLOOR = '1.8.0';

/** 语义化三段比较(autoDebugpy.compareVersions 的本模块副本避免反向依赖) */
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
 * 目标 Python 版本 → debugpy 策略。3.7 严格等号;3.8/3.9 按已核实支持线
 * pin 且接受更高(官方后续版本仍支持该行);3.10+ 下限 1.8.0;未知无策略。
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
 * 版本是否满足策略:strict 必须 ==pin;非严格 >=floor(floor null 恒真)。
 * 供同步/预检/资产树核对三处共用同一裁决(DBG-COMPAT-04 同一闸)。
 */
export function debugpyVersionSatisfiesPolicy(version: string, policy: DebugpyPolicy): boolean {
  if (policy.strict) {
    return compare3(version, policy.pin ?? '') === 0;
  }
  return policy.floor === null || compare3(version, policy.floor) >= 0;
}

/** 策略的 pip 安装参数(精确版本,不再统一 -U;modern 行用下限形式) */
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
 * 3.7 目标的调试扩展版本线核查(DBG-COMPAT-05):ms-python.debugpy 实测
 * 版本是否落在 3.7 对应支持线(2024.0.x)。null 版本 = 未知(扩展没装/
 * 读不到)——未知不判匹配,调用方如实说明。
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

/** ms-python.debugpy 扩展 id(debugpy 调试类型提供者,attach 的依赖面) */
export const DEBUGPY_EXTENSION_ID = 'ms-python.debugpy';

/**
 * 读扩展宿主里 ms-python.debugpy 的实测版本(DBG-COMPAT-05);未安装/
 * packageJSON 异常 → null(诚实未知)。registry 注入便于测试,默认真
 * vscode.extensions。
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
  /** 非 ok 时的一行可操作文案(固定版本安装 + 禁自动更新步骤) */
  message: string | null;
}

/**
 * 3.7 目标 × 调试扩展线判定(DBG-COMPAT-05):strict 目标(3.7)要求
 * ms-python.debugpy 落在 2024.0.x——之后的扩展线已移除 Python 3.7 调试
 * 支持,attach 必败;非 3.7 目标不看扩展线(新线更好);未安装=诚实缺失。
 * 判定只产出步骤文案,绝不自动降级用户的调试扩展(其他工程不受 3.7 约束)。
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
