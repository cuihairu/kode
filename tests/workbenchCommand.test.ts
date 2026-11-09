// UX-REVIEW-006c 验证面:工作台 QuickPick 的分组选择、取消、分隔行不可
// 执行、命令异常如实上抛、原有一二个动作逐项可达;清单外不夹带无命令的
// 可选项(不以隐藏高级功能或新增无法执行的按钮充数)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { l10nText } from '../src/nlsRuntime';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { commands as vscodeCommands } from './fake-vscode/commandRegistry';
import { window as fakeWindow } from './fake-vscode/windowState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

interface WorkbenchItem {
  label: string;
  command?: string;
  description?: string;
  detail?: string;
  kind?: number;
}

/** 工作台 12 个原有动作与其分组(与 src/activate/monitoring.ts 清单一致) */
const WORKBENCH_GROUPS: Array<{ label: string; commands: string[] }> = [
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

const ALL_ACTIONS = WORKBENCH_GROUPS.flatMap(group => group.commands);

interface WorkbenchRun {
  executed: string[];
  context: ExtensionContext;
  lists: WorkbenchItem[][];
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
  let failure: unknown;
  const originalExecute = vscodeCommands.executeCommand;
  const originalPick = vscode.window.showQuickPick;
  vscodeCommands.executeCommand = (async command => {
    executed.push(command);
    if (options.execute) return options.execute(command);
    return undefined;
  }) as typeof vscode.commands.executeCommand;
  vscode.window.showQuickPick = (async (items: unknown) => {
    const list = items as WorkbenchItem[];
    lists.push(list);
    return options.pick ? options.pick(list) : undefined;
  }) as typeof vscode.window.showQuickPick;

  const registration = commandRegistry.registrations.get('kbengine.workbench.show');
  expect(registration, 'kbengine.workbench.show 未注册').toBeDefined();
  await registration!.handler().catch(error => {
    failure = error;
  });

  vscodeCommands.executeCommand = originalExecute;
  vscode.window.showQuickPick = originalPick;
  return { executed, context, lists, failure };
}

function disposeAll(context: ExtensionContext): void {
  for (const disposable of context.subscriptions) disposable.dispose();
}

beforeEach(() => {
  commandRegistry.reset();
});

afterEach(() => {
  fakeWindow.showQuickPick = async (): Promise<undefined> => undefined;
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
    expect(groups).toEqual(WORKBENCH_GROUPS);
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
});
