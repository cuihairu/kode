// UX-REVIEW-006c 验证面:工作台 QuickPick 的分组选择、取消、分隔行不可
// 执行、命令异常如实上抛、原有一二个动作逐项可达;清单外不夹带无命令的
// 可选项(不以隐藏高级功能或新增无法执行的按钮充数)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { l10nText } from '../src/nlsRuntime';
import { setL10nBundle } from './fake-vscode/l10n';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { commands as vscodeCommands } from './fake-vscode/commandRegistry';
import { window as fakeWindow } from './fake-vscode/windowState';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';

interface WorkbenchItem {
  label: string;
  command?: string;
  description?: string;
  detail?: string;
  kind?: number;
}

/**
 * 工作台 12 个原有动作与其分组(与 src/activate/monitoring.ts 清单一致)。
 * 分组标签函数形态调用期取词(010e 教训):模块加载期固化会锁死英文,
 * zh 态用户路径断言(分组行/按中文标签选中)将全部失真。
 */
function workbenchGroups(): Array<{ label: string; commands: string[] }> {
  return [
    {
      label: l10nText('Project and environment'),
      commands: [
        'kbengine.discovery.report',
        'kbengine.extension.identity',
        'kbengine.project.doctor',
        'kbengine.compatibility.check'
      ]
    },
    {
      label: l10nText('Server and runtime'),
      commands: [
        'kbengine.monitoring.show',
        'kbengine.profile.start',
        'kbengine.runtimeQuery.show',
        'kbengine.spaces.query'
      ]
    },
    {
      label: l10nText('Data and development'),
      commands: [
        'kbengine.database.open',
        'kbengine.database.checkAllDrift',
        'kbengine.symbolReferences.show',
        'kbengine.clientSdk.generate'
      ]
    }
  ];
}

const ALL_ACTIONS = workbenchGroups().flatMap(group => group.commands);

interface WorkbenchRun {
  executed: string[];
  context: ExtensionContext;
  lists: WorkbenchItem[][];
  optionsList: Array<Record<string, unknown> | undefined>;
  failure: unknown;
}

/** 装配扩展、拦截 showQuickPick/executeCommand、触发 workbench 命令并还原 */
async function openWorkbench(options: {
  pick?: (items: WorkbenchItem[]) => unknown;
  execute?: (command: string) => Promise<unknown>;
}): Promise<WorkbenchRun> {
  const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
  activate(context);
  await new Promise(resolve => setTimeout(resolve, 100));

  const executed: string[] = [];
  const lists: WorkbenchItem[][] = [];
  const optionsList: Array<Record<string, unknown> | undefined> = [];
  let failure: unknown;
  const originalExecute = vscodeCommands.executeCommand;
  const originalPick = vscode.window.showQuickPick;
  vscodeCommands.executeCommand = (async command => {
    executed.push(command);
    if (options.execute) return options.execute(command);
    return undefined;
  }) as typeof vscode.commands.executeCommand;
  vscode.window.showQuickPick = (async (items: unknown, quickPickOptions?: unknown) => {
    const list = items as WorkbenchItem[];
    lists.push(list);
    optionsList.push(quickPickOptions as Record<string, unknown> | undefined);
    return options.pick ? options.pick(list) : undefined;
  }) as typeof vscode.window.showQuickPick;

  const registration = commandRegistry.registrations.get('kbengine.workbench.show');
  expect(registration, 'kbengine.workbench.show 未注册').toBeDefined();
  await registration!.handler().catch(error => {
    failure = error;
  });

  vscodeCommands.executeCommand = originalExecute;
  vscode.window.showQuickPick = originalPick;
  return { executed, context, lists, optionsList, failure };
}

function disposeAll(context: ExtensionContext): void {
  for (const disposable of context.subscriptions) disposable.dispose();
}

beforeEach(() => {
  commandRegistry.reset();
});

afterEach(() => {
  fakeWindow.showQuickPick = async (): Promise<undefined> => undefined;
  setL10nBundle(null);
});

describe('kbengine.workbench.show', () => {
  it('registers and dispatches a grouped workflow entry', async () => {
    const run = await openWorkbench({
      pick: items => {
        expect(items.filter(item => item.kind === vscode.QuickPickItemKind.Separator)).toHaveLength(3);
        const actions = items.filter(item => item.command);
        expect(actions.every(item => Boolean(item.description))).toBe(true);
        expect(actions.map(item => item.command)).toEqual(ALL_ACTIONS);
        return actions.find(item => item.command === 'kbengine.project.doctor');
      }
    });
    expect(run.executed).toEqual(['kbengine.project.doctor']);
    expect(run.failure).toBeUndefined();

    expect(deactivate()).toBeUndefined();
    disposeAll(run.context);
  });

  it('lists only registered commands: every action reachable, no dead buttons', async () => {
    const run = await openWorkbench({ pick: () => undefined });
    const list = run.lists[0]!;
    const actions = list.filter(item => item.command);
    // 清单 = 既有 12 个动作,不多不少;每个动作在注册表里真实可达
    expect(actions.map(item => item.command)).toEqual(ALL_ACTIONS);
    for (const command of ALL_ACTIONS) {
      expect(commandRegistry.registrations.has(command), `${command} 未注册`).toBe(true);
    }
    // 除分隔行外没有无 command 的可选项:清单外不夹带充数项
    const nonSeparators = list.filter(item => item.kind !== vscode.QuickPickItemKind.Separator);
    expect(nonSeparators).toEqual(actions);
    expect(run.failure).toBeUndefined();
    disposeAll(run.context);
  });

  it('groups the 12 actions under three user-task separators', async () => {
    const run = await openWorkbench({ pick: () => undefined });
    const groups: Array<{ label: string; commands: string[] }> = [];
    for (const item of run.lists[0]!) {
      if (item.kind === vscode.QuickPickItemKind.Separator) {
        groups.push({ label: item.label, commands: [] });
      } else if (item.command) {
        expect(groups.length, '动作出现在首个分隔行之前').toBeGreaterThan(0);
        groups[groups.length - 1]!.commands.push(item.command);
      }
    }
    expect(groups).toEqual(workbenchGroups());
    expect(run.failure).toBeUndefined();
    disposeAll(run.context);
  });

  it('dispatches each listed action when selected', async () => {
    for (const command of ALL_ACTIONS) {
      const run = await openWorkbench({
        pick: items => items.find(item => item.command === command)
      });
      expect(run.executed).toEqual([command]);
      expect(run.failure).toBeUndefined();
      disposeAll(run.context);
    }
  });

  it('cancel without selection dispatches nothing', async () => {
    const run = await openWorkbench({ pick: () => undefined });
    expect(run.executed).toEqual([]);
    expect(run.failure).toBeUndefined();
    disposeAll(run.context);
  });

  it('selecting a group separator dispatches nothing', async () => {
    const run = await openWorkbench({
      pick: items => items.find(item => item.kind === vscode.QuickPickItemKind.Separator)
    });
    expect(run.lists[0]!.some(item => item.kind === vscode.QuickPickItemKind.Separator)).toBe(true);
    expect(run.executed).toEqual([]);
    expect(run.failure).toBeUndefined();
    disposeAll(run.context);
  });

  it('propagates a failing target command instead of swallowing it', async () => {
    const run = await openWorkbench({
      pick: items => items.find(item => item.command === 'kbengine.monitoring.show'),
      execute: async () => {
        throw new Error('target command failed');
      }
    });
    expect(run.executed).toEqual(['kbengine.monitoring.show']);
    expect(run.failure).toBeInstanceOf(Error);
    expect((run.failure as Error).message).toBe('target command failed');
    disposeAll(run.context);
  });

  // UX-REVIEW-010f zh-cn 用户路径:注入 zh bundle 后同一入口整条走通——
  // 分组行/动作标签/描述/占位全部中文,用户按中文标签选中仍落到同一稳定
  // 命令 ID(选择面随语言,派发面不随语言);zh 态取消同样零派发。
  // prove-red 对:把 monitoring.ts 的取词临时冻结为模块加载期常量(旧错误
  // 形态)→ zh 态列表全英文、按中文标签选不中 → 本例红;还原调用期取词 → 绿。
  it('zh-cn bundle: the same user path shows Chinese and dispatches by stable command id', async () => {
    setL10nBundle(zhCnBundle as Record<string, string>);
    const zhGroups = workbenchGroups();
    const targetZhLabel = `$(search) ${l10nText('Find project files')}`;
    const run = await openWorkbench({
      pick: items => {
        // 分组行与动作清单两态同构:标签随语言,命令序列逐位一致
        expect(
          items.filter(item => item.kind === vscode.QuickPickItemKind.Separator).map(item => item.label)
        ).toEqual(zhGroups.map(group => group.label));
        const actions = items.filter(item => item.command);
        expect(actions.map(item => item.command)).toEqual(ALL_ACTIONS);
        // zh 态:动作标签与描述均为中文(用户看得见的面),命令字段不动
        expect(actions.every(item => /[一-龥]/.test(item.label))).toBe(true);
        expect(actions.every(item => item.description !== undefined && /[一-龥]/.test(item.description))).toBe(true);
        // 用户按「查找项目文件」中文标签选中(与英文态用例按命令 ID 选中等价)
        return items.find(item => item.label === targetZhLabel);
      }
    });
    expect(run.optionsList[0]?.placeHolder).toBe(l10nText('Choose a KBEngine task'));
    expect(run.executed).toEqual(['kbengine.discovery.report']);
    expect(run.failure).toBeUndefined();
    disposeAll(run.context);

    // zh 态取消(Esc/关闭)同样零派发
    const cancelRun = await openWorkbench({ pick: () => undefined });
    expect(cancelRun.executed).toEqual([]);
    expect(cancelRun.failure).toBeUndefined();
    disposeAll(cancelRun.context);
  });
});
