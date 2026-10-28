/**
 * 项目 profile 的 Python 解释器来源(IDE-PRJ-004):profile 明确记录用哪个
 * 解释器、来自哪里。解析链:显式设置 kbengine.python.interpreterPath(存在
 * 才采用,支持 ${workspaceFolder})→ PATH 里的 python3/python → 都找不到记
 * 缺失状态(不伪造路径)。来源三值:setting/path/missing,随路径一并落进
 * profile 记录;显示面 describeInterpreterState 把缺失状态明说。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type InterpreterSource = 'setting' | 'path' | 'missing';

export interface InterpreterResolution {
  /** 找到的解释器绝对路径;null=缺失(如实记录,不伪造) */
  interpreterPath: string | null;
  interpreterSource: InterpreterSource;
}

/** 显示文案里的来源标签 */
export const INTERPRETER_SOURCE_LABELS: Record<InterpreterSource, string> = {
  setting: '设置',
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
        platform === 'win32' ? [`${name}.exe`, name] : [name];
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

/** 解析链输入(注入面:测试给定 PATH/平台/设置原值) */
export interface InterpreterResolutionInputs {
  /** kbengine.python.interpreterPath 配置原值 */
  interpreterSetting?: string;
  /** ${workspaceFolder} 展开基底 */
  workspaceRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

export function resolveInterpreterWith(inputs: InterpreterResolutionInputs): InterpreterResolution {
  const configured = (inputs.interpreterSetting ?? '').trim();
  if (configured) {
    const expanded = configured.replace(/\$\{workspaceFolder\}/g, inputs.workspaceRoot ?? '');
    if (fs.existsSync(expanded)) {
      return { interpreterPath: expanded, interpreterSource: 'setting' };
    }
  }
  const onPath = locateInterpreterOnPath(inputs.pathEnv, inputs.platform);
  if (onPath) {
    return { interpreterPath: onPath, interpreterSource: 'path' };
  }
  return { interpreterPath: null, interpreterSource: 'missing' };
}

/** 产品入口:读真实配置与 PATH */
export function resolveProfileInterpreter(workspaceRoot?: string): InterpreterResolution {
  let configured = '';
  try {
    configured =
      vscode.workspace.getConfiguration('kbengine').get<string>('python.interpreterPath', '') ?? '';
  } catch {
    configured = '';
  }
  return resolveInterpreterWith({
    interpreterSetting: configured,
    workspaceRoot,
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
  return 'Python 解释器: 缺失(未找到 python3/python,可在设置 kbengine.python.interpreterPath 指定)';
}
