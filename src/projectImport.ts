/**
 * 现有 KBEngine 项目导入(IDE-PRJ-003):选择资产根后按约定链识别
 * entities/defs/scripts/engine 四面,预览识别结果(缺失如实显示未识别),
 * 确认后建立项目 profile(IDE-PRJ-001 的稳定身份存储);Esc 取消零写入。
 * 识别只做存在性探测不改盘;entities/defs/scripts 四面全空(不像
 * KBEngine 资产根)时拒绝导入,宁缺勿猜。约定链与
 * workspaceDiscovery.DISCOVERY_CONVENTIONS 同源,不另立第二套约定。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DISCOVERY_CONVENTIONS } from './workspaceDiscovery';
import { ProjectProfileStore } from './projectProfiles';

/** 一次导入识别的结果:四面各报准确路径,null=未识别(如实预览) */
export interface ProjectLayoutIdentification {
  assetsRoot: string;
  entitiesXml: string | null;
  entityDefsRoot: string | null;
  scriptsRoot: string | null;
  engineRoot: string | null;
}

function firstExistingPath(base: string, relatives: readonly string[]): string | null {
  for (const relative of relatives) {
    const candidate = path.join(base, relative);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 引擎源码根:资产根、父目录、祖父目录下的 kbe 锚点文件——引擎仓通常是
 * 资产根的兄弟(如 <repo>/kbe + <repo>/demo/assets)。锚点文件都在 kbe/
 * 段下,命中即引擎根 = <base>/kbe;全 miss 为 null(纯资产目录常态)。
 */
function identifyEngineRoot(assetsRoot: string): string | null {
  const bases = [assetsRoot, path.dirname(assetsRoot), path.dirname(path.dirname(assetsRoot))];
  for (const base of bases) {
    const hit = DISCOVERY_CONVENTIONS.kbeSourceAnchors.some(anchor =>
      fs.existsSync(path.join(base, anchor))
    );
    if (hit) {
      return path.join(base, 'kbe');
    }
  }
  return null;
}

/**
 * 从所选资产根识别四面:entities.xml/entity_defs 走约定链;scripts 取
 * entities.xml 所在目录(entities.xml 在根上时 scripts 即根本身,未命中
 * entities.xml 时回落 <root>/scripts 存在性);engine 走兄弟仓锚点。
 */
export function identifyProjectLayout(assetsRoot: string): ProjectLayoutIdentification {
  const entitiesXml = firstExistingPath(assetsRoot, DISCOVERY_CONVENTIONS.entitiesXml);
  const entityDefsRoot = firstExistingPath(assetsRoot, DISCOVERY_CONVENTIONS.entityDefs);
  const scriptsRoot = entitiesXml ? path.dirname(entitiesXml) : firstExistingPath(assetsRoot, ['scripts']);
  return {
    assetsRoot,
    entitiesXml,
    entityDefsRoot,
    scriptsRoot,
    engineRoot: identifyEngineRoot(assetsRoot)
  };
}

/** 预览项:四面各一行,description 为准确路径或未识别 */
export interface ImportPreviewItem {
  label: string;
  description: string;
}

export function buildImportPreviewItems(identification: ProjectLayoutIdentification): ImportPreviewItem[] {
  const face = (label: string, value: string | null): ImportPreviewItem => ({
    label,
    description: value ?? '未识别'
  });
  return [
    face('entities', identification.entitiesXml),
    face('defs', identification.entityDefsRoot),
    face('scripts', identification.scriptsRoot),
    face('engine', identification.engineRoot)
  ];
}

/**
 * 导入命令体:选资产根 → 识别四面 → 预览确认 → 建立项目 profile。
 * 任一步取消(Esc/关闭对话框)即零写入;四面全空直接拒绝不出预览。
 */
export async function importExistingProject(context: {
  workspaceState?: vscode.Memento;
}): Promise<void> {
  const pickedFolders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    canSelectFiles: false,
    openLabel: '选择资产根'
  });
  const assetsRoot = pickedFolders?.[0]?.fsPath;
  if (!assetsRoot) {
    return;
  }

  const identification = identifyProjectLayout(assetsRoot);
  if (!identification.entitiesXml && !identification.entityDefsRoot && !identification.scriptsRoot) {
    await vscode.window.showWarningMessage(
      `未识别到 KBEngine 资产结构(entities/defs/scripts 均未命中),未导入: ${assetsRoot}`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [{ label: '导入', description: '按识别结果建立项目 profile' }, ...buildImportPreviewItems(identification)],
    { placeHolder: `核对识别结果(${assetsRoot})(选择"导入"继续,Esc 取消)` }
  );
  if (picked?.label !== '导入') {
    return;
  }

  const store = new ProjectProfileStore(context.workspaceState);
  const profile = await store.create({
    displayName: path.basename(assetsRoot) || assetsRoot,
    assetsRoot,
    engineRoot: identification.engineRoot ?? ''
  });
  await vscode.window.showInformationMessage(`已导入项目 profile: ${profile.displayName} (${profile.id})`);
}
