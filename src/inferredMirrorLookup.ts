/**
 * KODE-CFG-017-R 消费面：源 .py → `.kbengine/inferred` 镜像读取与 hover 富化。
 * 镜像路径 = `<workspaceRoot>/<managedDir>/inferred/<工作区相对路径>`
 * （mirrorPrefixFor + scripts 相对路径的合成，见 docs/design/kode-cfg-017-consumer.md §3）。
 *
 * 铁律（T-04 禁遮蔽）：镜像**绝不**进 extraPaths / 导入解析（pythonExtraPaths
 * 管理段只含 scripts 根 + `.kbengine/stubs`）；本模块是纯只读消费面。
 * 缺省口径：workspace 根缺失 / 越界 / 文件缺失 / 读失败 / 无注解 → 一律 null，
 * 调用方静默回退现有行为（不抛错、不刷通知，与 inferPipeline 自动面同口径）。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { getWorkspaceRootForDocument } from './definitionWorkspace';
import { readManagedDirSetting, resolveManagedDirName } from './pythonStubExport';
import {
  extractParamAnnotations,
  extractReturnAnnotation,
  extractVariableAnnotation,
  mirrorPathForSource
} from './backend/inferredEnrichment';

/** 读源 .py 对应的镜像全文；任何缺失/失败 → null（静默回退）。 */
export function readInferredMirrorText(sourceFsPath: string): string | null {
  const root = getWorkspaceRootForDocument({ fileName: sourceFsPath });
  if (!root) {
    return null;
  }
  const managedDir = resolveManagedDirName(readManagedDirSetting()).name;
  const mirrorPath = mirrorPathForSource(root, managedDir, sourceFsPath);
  if (!mirrorPath) {
    return null;
  }
  try {
    return fs.readFileSync(mirrorPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 镜像兜底 hover：整条 KBEngine 域解析链未命中时，普通 Python 符号按镜像
 * 推断注解出最小悬停（返回注解 + 形参注解表；无返回注解再试变量/属性注解）。
 * 镜像缺失或无注解 → null（回退既有链为 null 的结果，只补缺不覆盖）。
 */
export function createInferredMirrorHover(
  document: vscode.TextDocument,
  word: string
): vscode.Hover | null {
  if (!/^[A-Za-z_]\w*$/.test(word)) {
    return null;
  }
  const mirrorText = readInferredMirrorText(document.fileName);
  if (!mirrorText) {
    return null;
  }
  const returnType = extractReturnAnnotation(mirrorText, word);
  const variableType = returnType ? null : extractVariableAnnotation(mirrorText, word);
  const inferredType = returnType ?? variableType;
  if (!inferredType) {
    return null;
  }
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${word}**\n\n`);
  markdown.appendMarkdown(`**推断类型**: \`${returnType ? `-> ${returnType}` : inferredType}\`\n\n`);
  if (returnType) {
    const params = extractParamAnnotations(mirrorText, word);
    if (params.length > 0) {
      markdown.appendMarkdown(
        `**参数**: ${params.map(p => `\`${p.name}: ${p.type}\``).join(', ')}\n\n`
      );
    }
  }
  markdown.appendMarkdown('_来自 .kbengine/inferred 推断镜像（只读，不进导入解析）_');
  return new vscode.Hover(markdown);
}
