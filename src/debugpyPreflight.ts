/**
 * 调试前解释器 debugpy 预检(IDE-DBG-003):autoDebugpy 注入消费的 debugpy
 * 包由「所选解释器」同步而来(syncDebugpyPackage)。注入联动发起前先在该
 * 解释器上探 debugpy——缺解释器/缺包/版本过老各给一行可操作状态(路径、
 * 安装命令、设置键),不等注入阶段才在引擎里 Traceback 出未知失败。
 * 资产树已同步过包时引擎导入的是资产树包,不依赖本机解释器,照常放行
 * (debugpyPreflightAllowsInjection)。
 */

import { spawn } from 'child_process';
import { compareVersions, EMBEDDED_PYTHON_VERSION, MIN_DEBUGPY_VERSION } from './autoDebugpy';
import { resolveProfileInterpreter, type InterpreterResolution } from './profileInterpreter';

export type DebugpyPreflightKind = 'ok' | 'interpreter-missing' | 'debugpy-missing' | 'debugpy-outdated';

export interface DebugpyPreflightStatus {
  kind: DebugpyPreflightKind;
  /** 探测的解释器路径;interpreter-missing 为 null */
  interpreterPath: string | null;
  /** 探到的 debugpy 版本;缺包/缺解释器为 null */
  version: string | null;
  /** 一行可操作文案(注入联动直接进 LogHub) */
  message: string;
}

/** 探测代码:打印 debugpy 版本;缺包时 import 即失败(非零退出) */
const VERSION_PROBE_CODE = 'import debugpy\nprint(debugpy.__version__)\n';

export interface DebugpyPreflightDeps {
  resolveInterpreter(): InterpreterResolution;
  /** 在解释器上跑一段代码拿 stdout(注入面);异常/失败按非零退出 */
  runInterpreterCode(
    interpreterPath: string,
    code: string
  ): Promise<{ stdout: string; exitCode: number | null }>;
}

/**
 * 预检本体:解析链(设置→PATH,PRJ-004 同一链)拿解释器,跑版本探测,
 * 过 MIN_DEBUGPY_VERSION 闸(内嵌 Python 兼容线,与同步侧同一闸)。
 */
export async function checkInterpreterDebugpy(
  deps: DebugpyPreflightDeps
): Promise<DebugpyPreflightStatus> {
  const resolution = deps.resolveInterpreter();
  if (!resolution.interpreterPath) {
    return {
      kind: 'interpreter-missing',
      interpreterPath: null,
      version: null,
      message: 'debugpy 预检:未找到所选 Python 解释器,注入前先在设置 kbengine.python.interpreterPath 指定并安装 debugpy'
    };
  }
  const probe = await deps.runInterpreterCode(resolution.interpreterPath, VERSION_PROBE_CODE);
  const version = probe.exitCode === 0
    ? probe.stdout.trim().split(/\r?\n/).filter(line => line.length > 0).pop()?.trim() ?? ''
    : '';
  if (version.length === 0 || !/^\d/.test(version)) {
    return {
      kind: 'debugpy-missing',
      interpreterPath: resolution.interpreterPath,
      version: null,
      message: `debugpy 预检:${resolution.interpreterPath} 没有 debugpy(先在该解释器执行 pip install -U debugpy,再运行 kbengine.python.debugpySync 同步进资产树)`
    };
  }
  if (compareVersions(version, MIN_DEBUGPY_VERSION) < 0) {
    return {
      kind: 'debugpy-outdated',
      interpreterPath: resolution.interpreterPath,
      version,
      message: `debugpy 预检:${resolution.interpreterPath} 的 debugpy ${version} 低于内嵌 Python ${EMBEDDED_PYTHON_VERSION} 所需的 ${MIN_DEBUGPY_VERSION}(先 pip install -U debugpy 升级)`
    };
  }
  return {
    kind: 'ok',
    interpreterPath: resolution.interpreterPath,
    version,
    message: `debugpy 预检:${resolution.interpreterPath} 的 debugpy ${version} 可用`
  };
}

/**
 * 放行判定:预检不过但资产树已同步过包 → 照常注入(引擎导入的是资产树
 * 包,不依赖本机解释器);预检不过且资产树无包 → 拦下提前给状态(注入
 * 必在引擎里 Traceback,那正是要避免的未知失败)。
 */
export function debugpyPreflightAllowsInjection(
  status: Pick<DebugpyPreflightStatus, 'kind'>,
  assetsPackageExists: boolean
): boolean {
  return status.kind === 'ok' || assetsPackageExists;
}

/** 真实探测:spawn 解释器跑 -c 代码;起不来/超时按非零退出,永不抛 */
const runInterpreterCodeDefault = (
  interpreterPath: string,
  code: string
): Promise<{ stdout: string; exitCode: number | null }> =>
  new Promise(resolve => {
    try {
      const child = spawn(interpreterPath, ['-c', code], { windowsHide: true });
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
