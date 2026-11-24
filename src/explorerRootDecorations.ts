/**
 * 活动 profile 双根 Explorer 角标(2026-11-24 用户需求):已识别的
 * engineRoot / assetsRoot 目录在文件树获得 FileDecoration(badge + 主题色
 * + tooltip),给「这两个目录在哪」一个恒在的可见锚。与 FOLDER-COLOR-001
 * 互补:那面只装饰「文件」(目录零输出),本面只装饰两根目录本身,且无
 * 开关门——双根是档案记录的事实,不是装饰偏好。来源=活动 profile 字段
 * 优先,空轴回退 kbengine.* 同名设置;根不在盘上=不标(幽灵路径如实不
 * 装饰)。读取/判定经注入面,测试用假体同形(对齐 folderColorDecorations
 * 先例)。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { resolveActiveProfile } from './activeProfile';
import { l10nText } from './nlsRuntime';

export interface ExplorerRootDecorationDeps {
  /** engineRoot 现值(profile 优先,空轴回退设置;''=未识别) */
  engineRoot(): string;
  /** assetsRoot 现值(同上) */
  assetsRoot(): string;
  /** 目录在盘判定(根不存在不标;异常=不在盘) */
  exists(fsPath: string): boolean;
}

export interface ExplorerRootFace {
  badge: string;
  colorId: string;
  tooltip: string;
}

/**
 * 路径同一判定:分隔符与尾分隔符归一后整串比较;win32 再整路小写
 * (盘符大小写等差异不误分);空串永不相等(未识别轴不标)。
 */
export function sameExplorerRootPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalize = (value: string): string => {
    const unified = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? unified.toLowerCase() : unified;
  };
  const a = normalize(left);
  return a.length > 0 && a === normalize(right);
}

/** 轴标签(tooltip 用;走 l10n 调用期求值,语言切换即时生效) */
function explorerRootLabelOf(axis: 'engine' | 'assets'): string {
  return axis === 'engine'
    ? l10nText('KBEngine engine root')
    : l10nText('KBEngine assets root');
}

/**
 * 双根面孔解析(纯核):engine=K/蓝,assets=A/橙,同目录=KA/蓝;
 * 两轴都未识别/根不在盘/路径不命中=undefined(零装饰输出)。
 */
export function resolveExplorerRootFace(
  fsPath: string,
  deps: ExplorerRootDecorationDeps
): ExplorerRootFace | undefined {
  const engineRoot = deps.engineRoot();
  const assetsRoot = deps.assetsRoot();
  const engineMarked =
    engineRoot !== '' && deps.exists(engineRoot) && sameExplorerRootPath(fsPath, engineRoot);
  const assetsMarked =
    assetsRoot !== '' && deps.exists(assetsRoot) && sameExplorerRootPath(fsPath, assetsRoot);
  if (!engineMarked && !assetsMarked) {
    return undefined;
  }
  if (engineMarked && assetsMarked) {
    return {
      badge: 'KA',
      colorId: 'charts.blue',
      tooltip: `${explorerRootLabelOf('engine')} + ${explorerRootLabelOf('assets')}`
    };
  }
  return engineMarked
    ? { badge: 'K', colorId: 'charts.blue', tooltip: explorerRootLabelOf('engine') }
    : { badge: 'A', colorId: 'charts.orange', tooltip: explorerRootLabelOf('assets') };
}

/** 文件树角标 provider:只装饰双根目录本身,其余路径零输出 */
export class ExplorerRootDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly deps: ExplorerRootDecorationDeps) {}

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.FileDecoration | undefined {
    const face = resolveExplorerRootFace(uri.fsPath, this.deps);
    if (!face) {
      return undefined;
    }
    return new vscode.FileDecoration(face.badge, face.tooltip, new vscode.ThemeColor(face.colorId));
  }

  /** profile 切换/根设置变更通知(VS Code 重渲染角标) */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** 生产装配面:profile 字段优先,空轴回退 kbengine.* 同名设置 */
export function explorerRootDecorationDeps(
  context: vscode.ExtensionContext
): ExplorerRootDecorationDeps {
  const readSettingRoot = (section: string): string =>
    vscode.workspace.getConfiguration('kbengine').get<string>(section, '') ?? '';
  return {
    engineRoot: () => resolveActiveProfile(context.workspaceState)?.engineRoot || readSettingRoot('engineRoot'),
    assetsRoot: () => resolveActiveProfile(context.workspaceState)?.assetsRoot || readSettingRoot('assetsRoot'),
    exists: fsPath => {
      try {
        return fs.statSync(fsPath).isDirectory();
      } catch {
        return false;
      }
    }
  };
}
