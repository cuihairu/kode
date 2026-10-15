/**
 * KBEngine Python API 存根导出(功能差距盘点 G2,docs/reference-feature-gap.md):
 * kbeModuleIndex 的符号索引只服务 kode 自己的补全/悬停/跳转(虚拟桩文档
 * Pylance 看不见),Python 扩展只认 extraPaths 里的真实文件。把同一份索引
 * 导出成 `<工作区>/.kbengine/stubs/KBEngine.pyi`,配合 G1 的 extraPaths
 * 接线,`import KBEngine` 才能解析。内容与虚拟桩文档同源发射,不抄
 * KBEngine Nex X 的文件;内容与磁盘一致时零写,不打扰。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { buildKbeStubExportContent } from './kbeModuleIndex';

// Python 生态面的内容入口一并从这里出(单一进口处,调用方不必再引 kbeModuleIndex)
export { buildKbeStubExportContent } from './kbeModuleIndex';

export const PYTHON_STUB_EXPORT_SETTING = 'kbengine.python.stubExport';
/** 导出开关(kbengine.python.stubExport,默认开) */
export const PYTHON_STUB_EXPORT_ENABLED_DEFAULT = true;
export const KBE_STUB_FILE_NAME = 'KBEngine.pyi';

function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/');
}

/** 存根目录约定:.kbengine/stubs(kode 管理目录,与 debug.json 同居) */
export function kbeStubDir(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.kbengine', 'stubs');
}

export function kbeStubFilePath(workspaceRoot: string): string {
  return joinPath(kbeStubDir(workspaceRoot), KBE_STUB_FILE_NAME);
}

export interface StubExportDeps {
  /** 路径存在性判定(测试注入,装配层为 fs.existsSync) */
  exists: (path: string) => boolean;
  /** 读现有内容做一致性比对;读不到(权限等)按陈旧处理触发重写 */
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  /** 建存根目录(递归) */
  mkdir: (dir: string) => void;
}

/** 装配层默认注入:真 fs;readFile 失败回落空串(→ 判陈旧重写) */
export const fileSystemStubExportDeps: StubExportDeps = {
  exists: (candidate: string): boolean => fs.existsSync(candidate),
  readFile: (path: string): string => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  },
  writeFile: (path: string, content: string): void => {
    fs.writeFileSync(path, content, 'utf8');
  },
  mkdir: (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
  }
};

export interface StubExportOptions {
  /** 激活期自动导出传 true:全程零提示;命令面板手动导出保持播报 */
  silent?: boolean;
}

/**
 * 逐工作区把符号索引导出为 .kbengine/stubs/KBEngine.pyi。设置
 * `kbengine.python.stubExport` 关闭时只说明不动手;内容一致时零写;
 * 目录不可写(只读工作区等)告警并继续其余文件夹。返回实际写入的
 * 文件夹名列表。
 */
export async function exportKbeStubs(
  deps: StubExportDeps = fileSystemStubExportDeps,
  options: StubExportOptions = {}
): Promise<string[]> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.stubExport', PYTHON_STUB_EXPORT_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        'KBEngine 存根导出已关闭(kbengine.python.stubExport)'
      );
    }
    return [];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('未打开工作区,跳过 KBEngine 存根导出');
    }
    return [];
  }
  const desired = buildKbeStubExportContent();
  const written: string[] = [];
  const failed: string[] = [];
  for (const folder of folders) {
    const target = kbeStubFilePath(folder.uri.fsPath);
    // 一致性比对段防御:存在性判定/读取抛错(权限等)按陈旧处理触发重写
    let unchanged = false;
    try {
      unchanged = deps.exists(target) && deps.readFile(target) === desired;
    } catch {
      unchanged = false;
    }
    if (unchanged) {
      continue;
    }
    try {
      deps.mkdir(kbeStubDir(folder.uri.fsPath));
      deps.writeFile(target, desired);
      written.push(folder.name);
    } catch {
      // 目录不可写(只读挂载/权限):如实告警,不挡其余文件夹
      failed.push(folder.name);
    }
  }
  if (failed.length > 0 && !options.silent) {
    await vscode.window.showWarningMessage(
      `KBEngine 存根导出失败(目录不可写?): ${failed.join('、')}`
    );
  }
  if (written.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `已为 ${written.join('、')} 导出 KBEngine.pyi 存根(.kbengine/stubs/,配合 extraPaths 接线供 Python 扩展解析)`
    );
  }
  return written;
}
