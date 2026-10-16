/**
 * VS Code 官方变量替换(批141,任务单 kode-varfix.md 用户令:「是 VS Code 的
 * 变量替换语法」):仓内此前有两套互不相干的实现——workspacePath 的
 * `${workspaceFolder}`/`${env:}` 静默空串口径,与 quickActionConfig 的
 * `${workspaceFolder:Name}` 抛错口径,且两套都缺官方变量表里其余成员。
 * 本模块作唯一真源,两处旧实现改为委派,不再各写一份。
 *
 * 官方变量表(执行单要求「照官方变量表实现」,至少覆盖用户点名的 8 个):
 * https://code.visualstudio.com/docs/reference/variables-in-scope-files
 *
 * 未解析变量的两种口径(各自调用方按语义选,行为与批141 前保持一致):
 * - `empty`(默认):替换为空串。路径类设置沿用旧口径,读不到就当没写,
 *   不因为一个环境变量不存在就让整个扩展装配失败。
 * - `throw`:直接报错并带上出错的表达式。quick action 这类「跑错就是
 *   静默假成功」的命令沿用旧口径——脚本被跑成「路径为空」比报错更糟。
 */

import * as path from 'path';

export interface VariableFolderRef {
  fsPath: string;
  name: string;
}

export interface VariableContext {
  /** 多根工作区按 vscode.workspace.workspaceFolders 顺序传入 */
  folders: readonly VariableFolderRef[];
  /** 当前打开的文件(vscode.window.activeTextEditor?.document.fileName) */
  filePath?: string;
  /** 进程工作目录,${cwd} 用 */
  cwd?: string;
  /** 用户主目录,${userHome} 用 */
  userHome?: string;
  /** 平台路径分隔符,${pathSeparator} 用;不注入时按宿主平台推导 */
  pathSeparator?: string;
  /** 环境变量表,${env:NAME} 用;不注入时读 process.env */
  env?: Record<string, string | undefined>;
}

export type UnresolvedPolicy = 'empty' | 'throw';

const VARIABLE_PATTERN = /\$\{([^${}]*)\}/g;

/** ${relativeFile} 判定:文件在某个工作区根之下才给出相对路径 */
function isUnderRoot(filePath: string, root: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

/**
 * 按名字取工作区根:不传名字取第一个(与 ${workspaceFolder} 官方语义一致),
 * 传名字按 folder.name 精确匹配。取不到返回 null,由调用方按未解析口径处理。
 */
export function resolveWorkspaceFolderRef(
  name: string | undefined,
  folders: readonly VariableFolderRef[]
): VariableFolderRef | null {
  if (folders.length === 0) {
    return null;
  }
  if (name === undefined) {
    return folders[0];
  }
  return folders.find(folder => folder.name === name) ?? null;
}

function basenameOf(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function dirnameOf(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index === -1) {
    return '';
  }
  if (index === 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

function resolveExpression(
  expression: string,
  context: VariableContext
): string | undefined {
  const [key, ...rest] = expression.split(':');
  const argument = rest.length > 0 ? rest.join(':') : undefined;

  if (key === 'workspaceFolder' || key === 'workspaceFolderBasename') {
    const folder = resolveWorkspaceFolderRef(argument, context.folders);
    if (folder === null) {
      return undefined;
    }
    return key === 'workspaceFolder' ? folder.fsPath : basenameOf(folder.fsPath);
  }

  if (key === 'env') {
    const table = context.env ?? process.env;
    // 「${env:NAME}」必须带名:裸 ${env} 不猜第一个环境变量,按未解析处理
    const name = rest.join(':');
    return name.length > 0 ? table[name] : undefined;
  }

  if (key === 'file' || key === 'fileBasename' || key === 'fileBasenameNoExtension'
    || key === 'fileDirname' || key === 'fileExtname'
    || key === 'relativeFile' || key === 'relativeFileDirname') {
    const filePath = context.filePath;
    if (filePath === undefined) {
      return undefined;
    }
    if (key === 'file') {
      return filePath;
    }
    if (key === 'fileDirname') {
      return dirnameOf(filePath);
    }
    if (key === 'fileBasename' || key === 'fileBasenameNoExtension') {
      const fileName = basenameOf(filePath);
      if (key === 'fileBasename') {
        return fileName;
      }
      const stemDot = fileName.lastIndexOf('.');
      return stemDot <= 0 ? fileName : fileName.slice(0, stemDot);
    }
    if (key === 'fileExtname') {
      const fileName = basenameOf(filePath);
      const dot = fileName.lastIndexOf('.');
      return dot <= 0 ? '' : fileName.slice(dot);
    }
    // 相对族:落在某个工作区根之下才给相对写法,区外文件回退绝对路径
    // (与 VS Code 同款语义:工作区外的文件没有「相对工作区」可言)
    const owner = context.folders.find(folder => isUnderRoot(filePath, folder.fsPath));
    const relative = owner ? filePath.replace(/\\/g, '/').slice(owner.fsPath.replace(/\\/g, '/').replace(/\/+$/, '').length + 1) : filePath;
    return key === 'relativeFile' ? relative : dirnameOf(relative);
  }

  if (key === 'cwd') {
    return context.cwd;
  }

  if (key === 'userHome') {
    return context.userHome;
  }

  if (key === 'pathSeparator') {
    // 走 node 的 path.sep 而非 process.platform 三元:宿主平台在测试里不可变,
    // 写死三元会让另一侧分支永远走不到,覆盖率上是一条假缺口
    return context.pathSeparator ?? path.sep;
  }

  return undefined;
}

/**
 * 按 VS Code 官方变量表替换一段文本里的全部 ${...}。同一段文本里可混用多个
 * 变量(URL、路径都行),嵌套与未闭合的 `$` 原样保留。
 */
export function substituteVariables(
  text: string,
  context: VariableContext,
  policy: UnresolvedPolicy = 'empty'
): string {
  return text.replace(VARIABLE_PATTERN, (raw, expression: string) => {
    const value = resolveExpression(expression, context);
    if (value === undefined) {
      if (policy === 'throw') {
        throw new Error(`变量无法解析: ${raw}`);
      }
      return '';
    }
    return value;
  });
}
