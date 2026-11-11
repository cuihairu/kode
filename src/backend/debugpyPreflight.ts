/**
 * 调试前解释器 debugpy 预检(IDE-DBG-003;DBG-COMPAT-03 重铸 2026-11-12):
 * autoDebugpy 注入消费的 debugpy 包由「所选解释器」同步而来
 * (syncDebugpyPackage)。注入联动发起前先在该解释器上探 debugpy——缺
 * 解释器/缺包各给一行可操作状态。版本判定不再拿全局常量(旧
 * EMBEDDED_PYTHON_VERSION '3.12.13' + MIN 1.8.0 对所有引擎一刀切,
 * 3.7 工程被误导装 1.8.x=引擎里直接崩),改按「引擎目标 Python 版本」
 * 的兼容策略(pythonTarget.ts,DBG-COMPAT-01/02)裁定:3.7 严格锁
 * 1.7.0,3.8/3.9 按支持线,3.10+ 下限 1.8.0,目标未知 = target-unknown
 * 诚实态(只报装没装,不判兼容,不给盲装建议)。放行判定
 * (debugpyPreflightAllowsInjection)对资产树包从「查存在」升级为
 * 「读 __init__.__version__ 核对策略」(DBG-COMPAT-04:存在 ≠ 兼容,
 * 1.8.0 的资产树包不许给 3.7 工程放行)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnProcess } from './processManager';
import { readDebugpyVersionFromSource } from '../autoDebugpy';
import {
  PYTHON_TARGET_SETTING,
  debugpyInstallSpecFor,
  debugpyPolicyFor,
  debugpyVersionSatisfiesPolicy,
  type PythonTarget
} from './pythonTarget';
import { resolveProfileInterpreter, type InterpreterResolution } from '../profileInterpreter';

export type DebugpyPreflightKind =
  | 'ok'
  | 'interpreter-missing'
  | 'debugpy-missing'
  | 'debugpy-incompatible'
  | 'target-unknown';

export interface DebugpyPreflightStatus {
  kind: DebugpyPreflightKind;
  /** 探测的解释器路径;interpreter-missing 为 null */
  interpreterPath: string | null;
  /** 探到的 debugpy 版本;缺包/缺解释器为 null */
  version: string | null;
  /** 探到的源解释器 Python 三段版本(ABI 核对面);缺包/缺解释器 null */
  python: string | null;
  /** 预检消费的引擎目标(未知态原样带,detail 说明缺什么) */
  target: PythonTarget;
  /** 目标策略的 pip 安装参数(null=目标未知/无策略,不给盲装建议) */
  installSpec: string[] | null;
  /** 一行可操作文案(注入联动直接进 LogHub) */
  message: string;
}

/** 探测代码:先打印源解释器 Python 三段版本,再打印 debugpy 版本;
 * 缺包时 import 即失败(非零退出) */
const VERSION_PROBE_CODE =
  'import sys\n' +
  'import debugpy\n' +
  'print("%d.%d.%d" % sys.version_info[:3])\n' +
  'print(debugpy.__version__)\n';

export interface DebugpyPreflightDeps {
  resolveInterpreter(): InterpreterResolution;
  /** 在解释器上跑一段代码拿 stdout(注入面);异常/失败按非零退出 */
  runInterpreterCode(
    interpreterPath: string,
    code: string
  ): Promise<{ stdout: string; exitCode: number | null }>;
}

/** 缺包文案的安装建议:有策略给精确命令;目标未知不盲装,给设置键 */
const installHint = (pythonTarget: PythonTarget): string => {
  const spec = debugpyInstallSpecFor(pythonTarget.version);
  if (spec === null) {
    return `先在设置 ${PYTHON_TARGET_SETTING} 指定引擎目标 Python 版本(目标未知不盲装版本),` +
      '再装对应兼容版 debugpy';
  }
  return `先在该解释器执行 pip ${spec.join(' ')},再运行 kbengine.python.debugpySync 同步进资产树`;
};

/**
 * 预检本体:解析链(设置→PATH,PRJ-004 同一链)拿解释器,跑版本探测
 * (源 Python 行 + debugpy 版本),按引擎目标策略(DBG-COMPAT-01/02)
 * 裁定兼容性——同一闸三处共用(同步 syncDebugpyPolicyFor / 预检本函数 /
 * 资产树核对 debugpyVersionSatisfiesPolicy),永不各说各话。
 */
export async function checkInterpreterDebugpy(
  deps: DebugpyPreflightDeps,
  pythonTarget: PythonTarget
): Promise<DebugpyPreflightStatus> {
  const resolution = deps.resolveInterpreter();
  if (!resolution.interpreterPath) {
    return {
      kind: 'interpreter-missing',
      interpreterPath: null,
      version: null,
      python: null,
      target: pythonTarget,
      installSpec: null,
      message: 'debugpy 预检:未找到所选 Python 解释器,注入前先在设置 kbengine.python.interpreterPath 指定并安装 debugpy'
    };
  }
  const probe = await deps.runInterpreterCode(resolution.interpreterPath, VERSION_PROBE_CODE);
  const lines = probe.exitCode === 0
    ? probe.stdout.trim().split(/\r?\n/).filter(line => line.length > 0)
    : [];
  const version = lines.length > 0 ? lines[lines.length - 1].trim() : '';
  const python = lines.length >= 2 ? lines[0].trim() : null;
  const base = { interpreterPath: resolution.interpreterPath, target: pythonTarget };
  if (version.length === 0 || !/^\d/.test(version)) {
    return {
      kind: 'debugpy-missing',
      ...base,
      version: null,
      python: null,
      installSpec: debugpyInstallSpecFor(pythonTarget.version),
      message: `debugpy 预检:${resolution.interpreterPath} 没有 debugpy(${installHint(pythonTarget)})`
    };
  }
  const policy = debugpyPolicyFor(pythonTarget.version);
  if (policy === null) {
    return {
      kind: pythonTarget.version === null ? 'target-unknown' : 'debugpy-incompatible',
      ...base,
      version,
      python,
      installSpec: null,
      message: pythonTarget.version === null
        ? `debugpy 预检:${resolution.interpreterPath} 的 debugpy ${version} 已装;引擎目标 Python 版本未知` +
          `(${pythonTarget.detail}),兼容性无法核对——可在设置 ${PYTHON_TARGET_SETTING} 显式指定`
        : `debugpy 预检:引擎 Python ${pythonTarget.version} 无已核实的 debugpy 支持线` +
          '(见 docs/guide/python-debugger-compatibility.md),不自动安装不同步'
    };
  }
  if (!debugpyVersionSatisfiesPolicy(version, policy)) {
    const want = policy.pin !== null ? `== ${policy.pin}` : `>= ${policy.floor}`;
    return {
      kind: 'debugpy-incompatible',
      ...base,
      version,
      python,
      installSpec: debugpyInstallSpecFor(pythonTarget.version),
      message: `debugpy 预检:${resolution.interpreterPath} 的 debugpy ${version} 不满足引擎 Python ` +
        `${pythonTarget.version} 的兼容策略(${want});按 docs/guide/python-debugger-compatibility.md 装对应版本`
    };
  }
  return {
    kind: 'ok',
    ...base,
    version,
    python,
    installSpec: debugpyInstallSpecFor(pythonTarget.version),
    message: `debugpy 预检:${resolution.interpreterPath} 的 debugpy ${version} 可用(引擎目标 Python ${pythonTarget.version})`
  };
}

/**
 * 资产树 debugpy 包实测版本(读 <assets>/scripts/common/debugpy/__init__.py
 * 的 __version__);目录不在/不是 debugpy 布局/读不了 → null。放行判定的
 * 核对料——「目录存在」不再当「包兼容」(DBG-COMPAT-04)。
 */
export function readAssetsDebugpyVersion(assetsRoot: string): string | null {
  if (!assetsRoot) {
    return null;
  }
  const initPath = path.join(assetsRoot, 'scripts', 'common', 'debugpy', '__init__.py');
  try {
    if (!fs.existsSync(initPath)) {
      return null;
    }
    return readDebugpyVersionFromSource(fs.readFileSync(initPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 放行判定(DBG-COMPAT-04 重铸):预检 ok → 放行;预检不过时引擎导入的
 * 是资产树包,包「存在」不够——读出版本并与目标策略核对:
 * - 目标已知且有策略:资产树版本可读且满足策略才放行(1.8.0 的资产树包
 *   不许给 3.7 工程放行;读不出版本=不可核对,拦下如实说明);
 * - 目标未知:无策略可判,资产树包可读即放行(兼容性不背书,状态面如实
 *   说 target-unknown);
 * - 已知版本但无支持线(如 3.6):资产树包也不放行(拦下,不赌引擎)。
 */
export function debugpyPreflightAllowsInjection(
  status: Pick<DebugpyPreflightStatus, 'kind'>,
  pythonTarget: PythonTarget,
  assetsPackageVersion: string | null
): boolean {
  if (status.kind === 'ok') {
    return true;
  }
  if (pythonTarget.version === null) {
    return assetsPackageVersion !== null;
  }
  const policy = debugpyPolicyFor(pythonTarget.version);
  if (policy === null) {
    return false;
  }
  return assetsPackageVersion !== null && debugpyVersionSatisfiesPolicy(assetsPackageVersion, policy);
}

/** 真实探测:spawn 解释器跑 -c 代码;起不来/超时按非零退出,永不抛 */
const runInterpreterCodeDefault = (
  interpreterPath: string,
  code: string
): Promise<{ stdout: string; exitCode: number | null }> =>
  new Promise(resolve => {
    try {
      const child = spawnProcess(interpreterPath, ['-c', code], { windowsHide: true });
      let stdout = '';
      let settled = false;
      const finish = (exitCode: number | null): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, exitCode });
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(-1);
      }, 10000);
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
      });
      child.on('error', () => finish(-1));
      child.on('close', exitCode => finish(exitCode));
    } catch {
      resolve({ stdout: '', exitCode: -1 });
    }
  });

/** 产品入口依赖(PRJ-004 解析链 + 真实 spawn) */
export function debugpyPreflightDeps(workspaceRoot?: string): DebugpyPreflightDeps {
  return {
    resolveInterpreter: () => resolveProfileInterpreter(workspaceRoot),
    runInterpreterCode: runInterpreterCodeDefault
  };
}
