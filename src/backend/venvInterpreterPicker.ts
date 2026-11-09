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
import {
  type DiscoveredVenv,
  parsePythonVersionOutput,
  scanVenvs
} from './venvDiscovery';
import type { InterpreterResolution, InterpreterSource } from '../profileInterpreter';
import { DEFAULT_VENV_DIRECTORY_NAMES } from '../quickActionConfig';

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
  current: () => InterpreterResolution;
  discovered: () => DiscoveredVenv[];
  pathInterpreter: () => string | null;
  showQuickPick: (items: InterpreterPickItem[]) => Promise<InterpreterPickItem | undefined>;
  writeInterpreterSetting: (value: string | null) => Promise<void>;
  report: (message: string) => Promise<void>;
  createVenv: () => Promise<'created' | null>;
}

/**
 * 选择命令体:选中环境 → 写 kbengine.python.interpreterPath(即刻生效,
 * 解析链读实时配置);Esc 零写入;「创建新 venv…」转创建流。
 */
export async function selectInterpreter(
  deps: SelectInterpreterDeps
): Promise<'selected' | 'created' | null> {
  const current = deps.current();
  const picked = await deps.showQuickPick(
    buildInterpreterPickItems({
      current,
      discovered: deps.discovered(),
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
  timeoutMs: number
): Promise<{ exitCode: number | null; stderr: string }> =>
  new Promise(resolve => {
    let stderrTail = '';
    let settled = false;
    const child = spawn(file, args, { timeout: timeoutMs });
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

/** 真实依赖侧:进度态里跑 python -m venv(异步,超时 kill) */
export const runVenvModuleProcess = (base: string, target: string): Promise<{ exitCode: number | null; stderr: string }> =>
  runProcess(base, ['-m', 'venv', target], 300_000);

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
