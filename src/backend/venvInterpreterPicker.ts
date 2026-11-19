/**
 * 解释器状态栏展示、QuickPick 选择与一键创建 venv(PY-ENV 二期)。
 * 状态栏项显示当前解释器(venv 名/版本/来源徽标 auto|configured|PATH|
 * missing),点击进 QuickPick:当前项打头(✓),其后是工作区发现的环境,
 * PATH 解释器,列表尾「创建新 venv…」。选中写入
 * kbengine.python.interpreterPath(workspace 级)即刻生效——解析链每次读
 * 实时配置,无需重载。创建流:选目录(默认 <root>/.venv)→ 基础解释器
 * (PATH 链)缺失如实提示绝不伪造 → 进度态跑 python -m venv → 完成后直接
 * 对目标验真(不依赖扫描范围)再自动选中;命令失败带 stderr、建出但验不过
 * 的环境绝不入选。
 *
 * 全部交互面依赖注入(showQuickPick/进度/spawn/设置写入),本模块不直接
 * import vscode——单测用内存替身;extension.ts 只做薄装配。
 */

import { l10nText } from '../nlsRuntime';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
  type DiscoveredVenv,
  parsePythonVersionOutput,
  scanVenvs
} from './venvDiscovery';
import type { InterpreterResolution, InterpreterSource } from '../profileInterpreter';
import { DEFAULT_VENV_DIRECTORY_NAMES } from './quickActionConfig';

/** 状态栏/选择器的来源徽标:配置>自动>PATH,缺失明说 */
export function interpreterSourceBadge(source: InterpreterSource): string {
  switch (source) {
    case 'setting':
      return 'configured';
    case 'venv':
      return 'auto';
    case 'path':
      return 'PATH';
    default:
      return 'missing';
  }
}

/** Python 解释器选择器状态栏项的属主扩展(2026-11-10 用户令,venv/Pylance
 * 去重):ms-python.python 在状态栏渲染解释器选择器,本扩展再显示一个相同
 * venv 是重复。 */
export const PYTHON_INTERPRETER_EXTENSION_ID = 'ms-python.python';

/**
 * 解释器状态栏项是否应显示(venv/Pylance 去重;2026-11-17 收紧为安装即让位):
 * Python 扩展**已安装** → 隐藏本扩展的项;未安装 → 显示本扩展项。
 *
 * 为什么按安装而非 isActive 判:它是懒激活扩展,本扩展先激活时它多半还没
 * 激活——按 isActive 判我们先出镜,等它激活后状态栏双份,而
 * extensions.onDidChange 只在安装/卸载/启用/禁用发火(激活不发),补判无门。
 * 安装即让位=管理权在安装时就成立,从起初无双份窗口。纯决策,安装事实由
 * 调用方采集(getExtension(...) !== undefined),便于单测。隐藏时不丢功能:
 * 选择/创建 venv 仍经命令面板 kbengine.python.selectInterpreter / createVenv。
 */
export function shouldShowInterpreterStatusBar(pythonExtensionInstalled: boolean): boolean {
  return !pythonExtensionInstalled;
}

/** 状态栏一行文案:$(python) <名> <版本>(徽标);缺失态明说 */
export function interpreterStatusBarText(
  resolution: InterpreterResolution,
  version?: string | null
): string {
  if (!resolution.interpreterPath) {
    return l10nText('$(circle-slash) Python interpreter missing');
  }
  const segments = resolution.interpreterPath.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? resolution.interpreterPath;
  // 环境布局(.../<env>/bin|Scripts/python*)独立于来源识别:选中的 venv 写进
  // 设置后来源变 configured,状态栏仍要显示环境目录名,不能退化成 python。
  // 但环境目录名只在确知是环境时顶上——来源=venv(工作区扫描已验真)或目录
  // 名命中 venv 命名名单(.venv/venv/.kbenv);否则(/usr/bin/python3、/opt/py/
  // bin/python 这类系统/裸路径)退回二进制名,不猜一个环境出来。
  const parent = segments[segments.length - 2];
  const inEnvLayout = parent === 'bin' || parent === 'Scripts';
  const parentDirName = segments[segments.length - 3];
  const knownEnv =
    inEnvLayout &&
    parentDirName !== undefined &&
    (resolution.interpreterSource === 'venv' || DEFAULT_VENV_DIRECTORY_NAMES.includes(parentDirName));
  const name = knownEnv && parentDirName ? parentDirName : last;
  const versionPart = version ? ` ${version}` : '';
  return `$(python) ${name}${versionPart} (${interpreterSourceBadge(resolution.interpreterSource)})`;
}

/** QuickPick 单条目(测试与装配共用形状) */
export interface InterpreterPickItem {
  label: string;
  description?: string;
  detail?: string;
  /** 该条对应要写入的设置值;create 条目无 */
  interpreterPath?: string;
  /** 当前生效项(✓ 打头) */
  current?: boolean;
  /** 工作区发现的环境 */
  venv?: DiscoveredVenv;
  /** PATH 解释器条目 */
  pathEntry?: boolean;
  /** 「创建新 venv…」条目 */
  create?: boolean;
}

export const VENV_CREATE_ITEM_LABEL = l10nText('$(add) Create a new venv…');

/** 选择器条目组装(纯函数):当前 → 发现的环境 → PATH → 创建 */
export function buildInterpreterPickItems(inputs: {
  current: InterpreterResolution;
  discovered: DiscoveredVenv[];
  pathInterpreter: string | null;
}): InterpreterPickItem[] {
  const items: InterpreterPickItem[] = [];
  if (inputs.current.interpreterPath) {
    items.push({
      label: `✓ ${inputs.current.interpreterPath}`,
      description: l10nText('current ({source})', { source: interpreterSourceBadge(inputs.current.interpreterSource) }),
      interpreterPath: inputs.current.interpreterPath,
      current: true
    });
  }
  for (const env of inputs.discovered) {
    items.push({
      label: `$(package) ${env.name}`,
      description: env.rootPath,
      detail: `${env.interpreterPath}(${env.envKind === 'conda' ? 'conda' : 'venv'})`,
      interpreterPath: env.interpreterPath,
      venv: env
    });
  }
  if (inputs.pathInterpreter) {
    items.push({
      label: `$(globe) ${inputs.pathInterpreter}`,
      description: 'PATH',
      interpreterPath: inputs.pathInterpreter,
      pathEntry: true
    });
  }
  items.push({ label: VENV_CREATE_ITEM_LABEL, create: true });
  return items;
}

export interface SelectInterpreterDeps {
  /** 同步或异步都收(异步面=KODE-RESP-010 缓存发现;热值即时返回,冷值在途
   * 扫描不卡主线程),调用处无需区分 */
  current: () => InterpreterResolution | Promise<InterpreterResolution>;
  discovered: () => DiscoveredVenv[] | Promise<DiscoveredVenv[]>;
  pathInterpreter: () => string | null;
  showQuickPick: (items: InterpreterPickItem[]) => Promise<InterpreterPickItem | undefined>;
  writeInterpreterSetting: (value: string | null) => Promise<void>;
  report: (message: string) => Promise<void>;
  createVenv: () => Promise<'created' | null>;
}

/**
 * 选择命令体:选中环境 → 写 kbengine.python.interpreterPath(即刻生效,
 * 解析链读实时配置);Esc 零写入;「创建新 venv…」转创建流。current/discovered
 * 允许异步——装配处接缓存异步发现(KODE-RESP-010)后,列表先出已有候选
 * (缓存热值),冷启动也只有一段带预算的异步扫描,不卡命令线程。
 */
export async function selectInterpreter(
  deps: SelectInterpreterDeps
): Promise<'selected' | 'created' | null> {
  const current = await deps.current();
  const picked = await deps.showQuickPick(
    buildInterpreterPickItems({
      current,
      discovered: await deps.discovered(),
      pathInterpreter: deps.pathInterpreter()
    })
  );
  if (!picked) {
    return null;
  }
  if (picked.create) {
    return (await deps.createVenv()) === 'created' ? 'created' : null;
  }
  if (!picked.interpreterPath) {
    return null;
  }
  await deps.writeInterpreterSetting(picked.interpreterPath);
  await deps.report(
    l10nText(
      'Python interpreter switched: {path} (written to kbengine.python.interpreterPath, effective immediately)',
      { path: picked.interpreterPath }
    )
  );
  return 'selected';
}

export interface CreateVenvDeps {
  workspaceRoot: string | undefined;
  /**
   * 选放置 venv 的父目录(对话框只能选已存在的目录,默认工作区根);
   * null=用户取消。目标目录固定为所选父目录下的 .venv(python -m venv
   * 自己落目录,不要求父目录里预先存在 .venv)。
   */
  pickTargetParentDir: (defaultDir: string) => Promise<string | null>;
  /** 基础解释器(设置存在才采用 → PATH 链);null=缺失(如实提示,绝不伪造) */
  baseInterpreter: () => string | null;
  /** 目标目录已存在且非空(占用,拒绝创建) */
  targetDirectoryExistsNonEmpty: (dir: string) => boolean;
  /** 进度态里跑 python -m venv(异步,不阻塞扩展宿主) */
  runVenvModule: (
    baseInterpreterPath: string,
    targetDir: string
  ) => Promise<{ exitCode: number | null; stderr: string }>;
  /** 创建后直接对目标目录验真(不依赖扫描范围;null=验不过) */
  verifyTarget: (dir: string) => string | null;
  writeInterpreterSetting: (value: string | null) => Promise<void>;
  report: (message: string) => Promise<void>;
}

/**
 * 创建流:选父目录 → 占用预检 → 基础解释器缺失如实拒绝 → python -m venv
 * (失败带 stderr)→ 目标直接验真 → 自动选中写入设置。每一步失败都明说
 * 原因,不伪造成功。
 */
export async function createVenvFlow(deps: CreateVenvDeps): Promise<'created' | null> {
  if (!deps.workspaceRoot) {
    await deps.report(l10nText('No workspace open; cannot create a venv'));
    return null;
  }
  const parent = await deps.pickTargetParentDir(deps.workspaceRoot);
  if (!parent) {
    return null;
  }
  const target = path.join(parent, '.venv');
  if (deps.targetDirectoryExistsNonEmpty(target)) {
    await deps.report(
      l10nText('Target directory already exists and is not empty; refusing to create (avoid overwriting): {path}', { path: target })
    );
    return null;
  }
  const base = deps.baseInterpreter();
  if (!base) {
    await deps.report(
      l10nText(
        'Missing a base Python interpreter (neither kbengine.python.interpreterPath nor PATH has a usable python3/python); cannot create a venv; specify a working system interpreter first'
      )
    );
    return null;
  }
  const run = await deps.runVenvModule(base, target);
  if (run.exitCode !== 0) {
    const tail = run.stderr.trim().split('\n').slice(-3).join('; ');
    await deps.report(
      l10nText('python -m venv failed (exit code {code}): {tail}', { code: run.exitCode ?? -1, tail: tail || l10nText('no stderr output') })
    );
    return null;
  }
  // 创建后直接对目标验真(环境证据 + 解释器二进制),不依赖扫描范围——
  // 目标在扫描深度之外也照常选用;验不过(缺 pyvenv.cfg 或二进制)如实
  // 报告,绝不把没验证的路径写进设置。
  const interpreterPath = deps.verifyTarget(target);
  if (!interpreterPath) {
    await deps.report(
      l10nText(
        'venv command ran but {path} did not pass verification (missing pyvenv.cfg or interpreter binary); not selected',
        { path: target }
      )
    );
    return null;
  }
  await deps.writeInterpreterSetting(interpreterPath);
  await deps.report(l10nText('venv created and selected: {path}', { path: interpreterPath }));
  return 'created';
}

/** 异步跑一个进程,collect stdout/stderr,超时 kill;不阻塞扩展宿主 */
const runProcess = (
  file: string,
  args: string[],
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void
): Promise<{ exitCode: number | null; stderr: string }> =>
  new Promise(resolve => {
    let stderrTail = '';
    let settled = false;
    const child = spawn(file, args, { timeout: timeoutMs });
    onSpawn?.(child);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    const finish = (exitCode: number | null, stderr: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode, stderr });
    };
    child.on('error', error => finish(-1, error.message));
    child.on('close', code => finish(code, stderrTail));
  });

/** 真实依赖侧:进度态里跑 python -m venv(异步,超时 kill);onSpawn 供
 * withProgress 取消令牌接子进程柄(RUST-222,取消=kill,半成品由验真面如实拒) */
export const runVenvModuleProcess = (
  base: string,
  target: string,
  onSpawn?: (child: ChildProcess) => void
): Promise<{ exitCode: number | null; stderr: string }> =>
  runProcess(base, ['-m', 'venv', target], 300_000, onSpawn);

/** 真实依赖侧:异步探 <python> --version(5s 超时);失败如实 null */
export const probePythonVersion = async (interpreterPath: string): Promise<string | null> => {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        interpreterPath,
        ['--version'],
        { timeout: 5000 },
        (error, stdout, stderr) => {
          if (error && !stdout && !stderr) {
            reject(error);
            return;
          }
          resolve(`${stdout}${stderr}`);
        }
      );
    });
    return parsePythonVersionOutput(output);
  } catch {
    return null;
  }
};

/** 真实依赖侧:扫描工作区根(导出转发,便于装配处单一 import) */
export const scanWorkspaceVenvs = scanVenvs;
