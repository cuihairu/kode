/**
 * debug.json 的 jsonc 文件关联接线(用户令 2026-10-27 ②):
 * `.kbengine/debug.json` 是 JSONC(带注释,debugConfigBootstrap 用
 * stripJsonComments 解析),不是 JSON5——VS Code 默认按 json 处理,注释行
 * 直接划红线。把 files.associations 里 debug.json 的 glob 键(模块常量
 * JSONC_ASSOCIATION_PATTERN)写成 "jsonc"、落进工作区 .vscode/settings.json,
 * 编辑器即按 JSONC 着色与容忍注释。
 *
 * 托管口径照抄 pythonExtraPaths(盘点 G1):只动自己那一个键——pattern 键
 * 已有值(用户手填 json/json5/任何值)永不覆盖、零写入;写入过的用
 * workspaceState 记账,关闭命令只回收「自己写过且值未被改过」的键,用户
 * 改过的值原样保留。解析端(stripJsonComments)不认单引号/无引号键/尾逗号
 * 的 JSON5 写法,关联只影响编辑器体验,不改变解析事实。
 */

import * as vscode from 'vscode';

/** 同步开关(kbengine.jsoncAssociation,默认开) */
export const JSONC_ASSOCIATION_ENABLED_DEFAULT = true;
/** files.associations 里本扩展托管的唯一键 */
export const JSONC_ASSOCIATION_PATTERN = '**/.kbengine/debug.json';
export const JSONC_ASSOCIATION_LANGUAGE = 'jsonc';
/** workspaceState 记账键前缀(逐工作区根拼后缀,extraPaths managed key 同法) */
export const JSONC_ASSOCIATION_MANAGED_KEY = 'kbengine.jsoncAssociation.managed';

export interface JsoncAssociationSyncOptions {
  /** 激活期自动同步传 true:全程零提示,不打扰开窗 */
  silent?: boolean;
}

/** 配置值形态不由本扩展控制:非对象(含数组)按没有现值处理,不炸不整表清空 */
function associationsRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * 同步入口:逐工作区把 pattern 键写进该文件夹的 files.associations
 * (WorkspaceFolder 级 .vscode/settings.json)。设置关闭时只说明不动手;
 * pattern 键已有值时静默跳过(用户手填优先);静默模式全程零提示。
 */
export async function syncJsoncAssociation(
  context: vscode.ExtensionContext,
  options: JsoncAssociationSyncOptions = {}
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('jsoncAssociation', JSONC_ASSOCIATION_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        'debug.json 的 jsonc 文件关联已关闭(kbengine.jsoncAssociation)'
      );
    }
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('未打开工作区,跳过 debug.json 的 jsonc 文件关联');
    }
    return;
  }
  const written: string[] = [];
  for (const folder of folders) {
    const scoped = vscode.workspace.getConfiguration('files', folder);
    const associations = associationsRecord(scoped.get<unknown>('associations', {}));
    // 已有值(不论是 jsonc/json5/别的)一律不动:只动自己键的第一笔写入
    if (Object.prototype.hasOwnProperty.call(associations, JSONC_ASSOCIATION_PATTERN)) {
      continue;
    }
    const next = { ...associations, [JSONC_ASSOCIATION_PATTERN]: JSONC_ASSOCIATION_LANGUAGE };
    await scoped.update('associations', next, vscode.ConfigurationTarget.WorkspaceFolder);
    // 极简装配上下文没有 workspaceState:写入照做,只是不记账(关闭命令按未写过处理)
    await context.workspaceState?.update(
      `${JSONC_ASSOCIATION_MANAGED_KEY}:${folder.uri.fsPath}`,
      JSONC_ASSOCIATION_LANGUAGE
    );
    written.push(folder.name);
  }
  if (written.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `已为 ${written.join('、')} 写入 files.associations(debug.json 按 JSONC 处理,注释不再划红线)`
    );
  }
}

/**
 * 关闭命令(kbengine.jsoncAssociation.off):把开关设为 false(用户级),
 * 再逐工作区回收本扩展写入的 pattern 键。只回收「记账在且值未被改过」的
 * 键;用户接手改过的值原样保留,其余用户键一个不动。
 */
export async function disableJsoncAssociation(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace
    .getConfiguration('kbengine')
    .update('jsoncAssociation', false, vscode.ConfigurationTarget.Global);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const removed: string[] = [];
  for (const folder of folders) {
    const managedKey = `${JSONC_ASSOCIATION_MANAGED_KEY}:${folder.uri.fsPath}`;
    const remembered = context.workspaceState?.get<string>(managedKey);
    if (remembered === undefined) {
      continue;
    }
    const scoped = vscode.workspace.getConfiguration('files', folder);
    const associations = associationsRecord(scoped.get<unknown>('associations', {}));
    // 值被用户改过(≠记账值):键已归用户,不回收
    if (associations[JSONC_ASSOCIATION_PATTERN] !== remembered) {
      continue;
    }
    const rest = { ...associations };
    delete rest[JSONC_ASSOCIATION_PATTERN];
    // 没有剩余键时把 associations 整项移除(undefined),不留空对象在 settings.json
    await scoped.update(
      'associations',
      Object.keys(rest).length === 0 ? undefined : rest,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    await context.workspaceState?.update(managedKey, undefined);
    removed.push(folder.name);
  }
  const removalNote = removed.length > 0
    ? `已移除 ${removed.join('、')} 的 debug.json jsonc 关联(只回收本扩展写入的条目)`
    : '没有找到本扩展写入的关联(未写过/你手填过/状态已清),现有值一律未动';
  await vscode.window.showInformationMessage(
    `已把 kbengine.jsoncAssociation 设为 false。${removalNote};重新启用:设回 true 并重载窗口`
  );
}
