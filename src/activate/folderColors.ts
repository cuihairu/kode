/**
 * 工作区目录着色装配(FOLDER-COLOR-001):FileDecorationProvider 注册 +
 * 双条件门(开关开启+Kode 主题族)+ 配置/主题变更实时关停。
 *
 * 门口径(用户令 2026-11-18 终版):`kbengine.folderColors.enabled`=true
 * 且 `workbench.colorTheme` 命中 Kode 主题族(package.json contributes.themes
 * 的「KBEngine」前缀 label 族——族成员即前缀判定,无需读包对账),任一
 * 不满足=零装饰输出,与未安装无异。切走 Kode 主题即时停(onDidChangeConfiguration
 * 触发 provider.refresh + onGateChanged 回调让自有树视图同步换/卸图标)。
 * 真源规则集读 `kbengine.folderColors.rules`(数组序第一条赢),未配置=
 * 内置默认;脏配置条目滤除,如实不猜。
 */

import * as vscode from 'vscode';

import { resolveActiveProfile } from '../activeProfile';
import {
  DEFAULT_FOLDER_COLOR_RULES,
  folderColorsActive,
  resolveFolderColor,
  type FolderColorRule,
  type FolderColorSemantic
} from '../backend/folderColorRules';
import { FolderColorDecorationProvider } from '../folderColorDecorations';
import type { TreeIconPathOverride } from '../explorerProvidersModel';

/** 语义名合法词表(rules 配置校验用,与纯核类型一一对应) */
const KNOWN_SEMANTICS: ReadonlySet<string> = new Set<string>([
  'assets',
  'venv',
  'docs',
  'configs',
  'logs',
  'process'
]);

/** Kode 主题族=label 前缀(真源 package.json contributes.themes,全族前缀一致) */
export const KODE_THEME_LABEL_PREFIX = 'KBEngine';

/** 实体树四分组类别(与 definitionWorkspace 的 DefinitionCategory 值域一致) */
export type FolderColorGroupCategory = 'type' | 'entity' | 'interface' | 'component';

/**
 * 实体树分组彩色 SVG 图标(FOLDER-COLOR-001 面②:自有视图,TreeItem.iconPath
 * 官方 API;assets 在 resources/icons/folder-colors/,与语义规则一一对应)。
 * 门关(双条件缺一)=undefined → ExplorerGroupItem 走默认 ThemeIcon。
 */
export function folderColorGroupIconPath(
  extensionUri: vscode.Uri,
  category: FolderColorGroupCategory,
  active: boolean
): TreeIconPathOverride | undefined {
  if (!active) {
    return undefined;
  }
  return vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'folder-colors', `group-${category}.svg`);
}

export interface FolderColorActivationDeps {
  readonly context: vscode.ExtensionContext;
  /** 门翻转时的联动回调(自有树视图换/卸分组图标) */
  readonly onGateChanged: () => void;
}

/** 读总开关(默认 true;2026-11-27 用户令:enabled 即开,主题不联动) */
export function folderColorsEnabledFromConfig(config: { get<T>(section: string, defaultValue: T): T }): boolean {
  return config.get<boolean>('folderColors.enabled', true);
}

/** rules 配置读取+校验:非数组/全脏=内置默认;条目脏字段滤除(glob 非空串+
 * 语义在词表内;enabled 缺省 true)。数组序即命中优先序,原样保留 */
export function folderColorRulesFromConfig(raw: unknown): readonly FolderColorRule[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_FOLDER_COLOR_RULES;
  }
  const rules: FolderColorRule[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const candidate = entry as { glob?: unknown; semantic?: unknown; enabled?: unknown };
    if (typeof candidate.glob !== 'string' || candidate.glob.length === 0) {
      continue;
    }
    if (typeof candidate.semantic !== 'string' || !KNOWN_SEMANTICS.has(candidate.semantic)) {
      continue;
    }
    rules.push({
      glob: candidate.glob,
      semantic: candidate.semantic as FolderColorSemantic,
      enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : true
    });
  }
  return rules;
}

/** 多根工作区:目标文件落在哪个根下就用哪个根做相对锚(都不含=不解析) */
function workspaceRootFor(fsPath: string): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath.replace(/\\/g, '/');
    const target = fsPath.replace(/\\/g, '/');
    if (target === root || target.startsWith(`${root}/`)) {
      return folder.uri.fsPath;
    }
  }
  return null;
}

/** 启用门现值(2026-11-27 用户令:只看 enabled;主题不再参与;每次求值即时生效) */
export function folderColorsGateNow(enabled: boolean, themeLabel: string): boolean {
  return folderColorsActive(enabled, themeLabel, []);
}

/** 装配:注册 provider + 配置/主题变更监听(门/规则变化即时重渲染) */
export function activateFolderColorDecorations(deps: FolderColorActivationDeps): FolderColorDecorationProvider {
  const { context } = deps;
  const readEnabled = () =>
    folderColorsEnabledFromConfig(vscode.workspace.getConfiguration('kbengine'));
  const readThemeLabel = () => vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
  const readRules = () => folderColorRulesFromConfig(vscode.workspace.getConfiguration('kbengine').get('folderColors.rules'));

  const provider = new FolderColorDecorationProvider({
    isActive: () => folderColorsGateNow(readEnabled(), readThemeLabel()),
    resolveFace: fsPath => {
      const workspaceRoot = workspaceRootFor(fsPath);
      if (workspaceRoot === null) {
        return null;
      }
      const profile = resolveActiveProfile(context.workspaceState);
      return resolveFolderColor(fsPath, {
        workspaceRoot,
        assetsRoot: profile?.assetsRoot || undefined,
        rules: readRules()
      });
    },
    isDirectory: async fsPath => {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
        // FileType 真值按位判目录(File=1/Directory=2;logErrorScan 同判法,
        // 数值字面量兼容 fake-vscode 无 FileType 枚举面)
        return (stat.type & 2) !== 0;
      } catch {
        return false;
      }
    }
  });

  context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('kbengine.folderColors') ||
        event.affectsConfiguration('workbench.colorTheme')
      ) {
        provider.refresh();
        deps.onGateChanged();
      }
    })
  );
  context.subscriptions.push(provider);
  return provider;
}
