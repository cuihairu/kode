/**
 * 项目 profile 的 Python 解释器来源(IDE-PRJ-004):profile 明确记录用哪个
 * 解释器、来自哪里。解析链:显式设置 kbengine.python.interpreterPath(存在
 * 才采用,支持 ${workspaceFolder})→ 工作区环境深扫(kbengine.python.
 * interpreterPath 为空时,venvDiscovery 按 pyvenv.cfg/conda-meta 证据 +
 * 解释器二进制验真,深度封顶剪枝;目录名清单作同深度优先提示,PY-ENV;
 * 比裸 PATH python 更贴近项目意图)→ PATH 里的 python3/python → 都
 * 找不到记缺失状态(不伪造路径)。来源四值:setting/venv/path/missing,随
 * 路径一并落进 profile 记录;显示面 describeInterpreterState 把缺失状态
 * 明说。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DEFAULT_VENV_DIRECTORY_NAMES,
  normalizeVenvDirectoryNames
} from './quickActionConfig';
import { scanVenvs } from './backend/venvDiscovery';

export type InterpreterSource = 'setting' | 'venv' | 'path' | 'missing';

export interface InterpreterResolution {
  /** 找到的解释器绝对路径;null=缺失(如实记录,不伪造) */
  interpreterPath: string | null;
  interpreterSource: InterpreterSource;
}

/** 显示文案里的来源标签 */
export const INTERPRETER_SOURCE_LABELS: Record<InterpreterSource, string> = {
  setting: '设置',
  venv: '工作区 venv',
  path: 'PATH',
  missing: '缺失'
};

/** PATH 查找的候选名(windows 按 .exe 后缀另查一遍) */
const PATH_CANDIDATES = ['python3', 'python'];

/**
 * 在给定 PATH 环境串里找解释器:逐目录按候选名探测(只做存在性探测,不
 * 执行);windows 平台同时探测 .exe 后缀。找不到返回 null,不猜。
 */
export function locateInterpreterOnPath(
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!pathEnv) {
    return null;
  }
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of PATH_CANDIDATES) {
      const candidates =
        // WIN-3:.cmd shim(pipx/部分分发的 PATH 形态)与 .exe 同列——找到的
        // 绝对路径交给 spawnProcess 经 cmd /c 运行。
        platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
      for (const candidate of candidates) {
        const fullPath = path.join(dir, candidate);
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
  }
  return null;
}

/** 解析链输入(注入面:测试给定 PATH/平台/设置原值/venv 目录名清单) */
export interface InterpreterResolutionInputs {
  /** kbengine.python.interpreterPath 配置原值 */
  interpreterSetting?: string;
  /** ${workspaceFolder} 展开基底 + venv 探测根 */
  workspaceRoot?: string;
  /** venv 目录名清单(默认 .venv/venv/.kbenv);省略用默认 */
  venvDirectoryNames?: string[];
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

/**
 * 工作区 venv 解释器探测(PY-ENV):按目录名清单在 workspaceRoot 逐名找
 * <name>/<bin|Scripts>/python[3][.exe](只做存在性探测,不执行);找不到
 * 返回 null,不猜。win32 走 Scripts/python.exe,unix 走 bin/python 再
 * bin/python3。
 */
export function locateVenvInterpreter(
  workspaceRoot: string,
  venvDirectoryNames: string[],
  platform: NodeJS.Platform = process.platform
): string | null {
  const scriptsDir = platform === 'win32' ? 'Scripts' : 'bin';
  const candidates =
    platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python', 'python3'];
  for (const name of venvDirectoryNames) {
    const binDir = path.join(workspaceRoot, name, scriptsDir);
    for (const candidate of candidates) {
      const fullPath = path.join(binDir, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

export function resolveInterpreterWith(inputs: InterpreterResolutionInputs): InterpreterResolution {
  const configured = (inputs.interpreterSetting ?? '').trim();
  if (configured) {
    const expanded = configured.replace(/\$\{workspaceFolder\}/g, inputs.workspaceRoot ?? '');
    if (fs.existsSync(expanded)) {
      return { interpreterPath: expanded, interpreterSource: 'setting' };
    }
  }
  // PY-ENV 二期:设置为空(或设置失效)时,深扫 workspaceRoot 下的环境
  // (pyvenv.cfg/conda-meta 证据 + 解释器二进制验真,深度封顶剪枝;venv
  // 目录名清单作同深度优先级提示);置于 PATH 之前——工作区 venv 比裸 PATH
  // python 更贴近项目意图。来源如实记 venv,不伪造路径。
  if (inputs.workspaceRoot) {
    const scanned = scanVenvs(inputs.workspaceRoot, {
      platform: inputs.platform,
      preferredNames: inputs.venvDirectoryNames ?? [...DEFAULT_VENV_DIRECTORY_NAMES]
    });
    if (scanned.length > 0) {
      return { interpreterPath: scanned[0].interpreterPath, interpreterSource: 'venv' };
    }
  }
  const onPath = locateInterpreterOnPath(inputs.pathEnv, inputs.platform);
  if (onPath) {
    return { interpreterPath: onPath, interpreterSource: 'path' };
  }
  return { interpreterPath: null, interpreterSource: 'missing' };
}

/** 产品入口:读真实配置与 PATH;workspaceRoot 缺省取首个工作区文件夹 */
export function resolveProfileInterpreter(workspaceRoot?: string): InterpreterResolution {
  let configured = '';
  let venvNames: string[] = [...DEFAULT_VENV_DIRECTORY_NAMES];
  try {
    configured =
      vscode.workspace.getConfiguration('kbengine').get<string>('python.interpreterPath', '') ?? '';
    venvNames = normalizeVenvDirectoryNames(
      vscode.workspace.getConfiguration('kbengine').get('python.venvDirectories')
    );
  } catch {
    configured = '';
  }
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return resolveInterpreterWith({
    interpreterSetting: configured,
    workspaceRoot: root,
    venvDirectoryNames: venvNames,
    pathEnv: process.env.PATH,
    platform: process.platform
  });
}

/**
 * 显示面:profile 的解释器状态一行文案——路径+来源,或明说缺失与补救
 * 入口(设置键名),供工作台健康汇总/导入确认复用。
 */
export function describeInterpreterState(profile: {
  interpreterPath: string | null;
  interpreterSource: string;
}): string {
  if (profile.interpreterPath) {
    const source = (Object.keys(INTERPRETER_SOURCE_LABELS) as InterpreterSource[]).find(
      key => key === profile.interpreterSource
    );
    return `Python 解释器: ${profile.interpreterPath}(来源: ${
      source ? INTERPRETER_SOURCE_LABELS[source] : profile.interpreterSource
    })`;
  }
  return 'Python 解释器: 缺失(未找到 python3/python;可指定设置 kbengine.python.interpreterPath,或在工作区按 kbengine.python.venvDirectories(默认 .venv/venv/.kbenv)建 venv)';
}
