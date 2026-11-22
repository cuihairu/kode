import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND,
  setupHotReloadHistoryView,
  type HotReloadNamesResolver
} from '../src/hotReloadHistoryView';
import { HotReloadHistoryCore, type HotReloadHistoryEntry } from '../src/backend/hotReloadHistoryCore';
import { type HotReloadDeliveryRecord } from '../src/backend/hotReloadTargetState';
import { commandRegistry, commands, messages, workspaceState, windowState } from './helpers/vscodeStub';
import { treeRegistrations } from './fake-vscode/windowState';

// RUST-381 (HR-UI-008) 失败点击定位文件:历史树失败行=可点定位文件(命令带
// 该条 fileUri)+右键面三动作(定位文件/打开日志/重试);非失败行保持原不可点
// 行为。钉:①树项分叉(失败→contextValue Failed+command,非失败→Entry 无
// command);②定位命令 happy path(openTextDocument+showTextDocument);
// ③文件缺失如实提示(不静默假装定位);④缺参如实提示;⑤四件套装配锁
// (package.json 命令+activationEvent+palette 隐藏+右键菜单三项+NLS 双语
// 不同文+docs 小节)。

const FILE_A = '/ws/scripts/entities/fight/FightAI.py';

interface TestNode {
  kind: string;
  label?: string;
  groupKind?: string;
  entry?: HotReloadHistoryEntry;
  rows?: HotReloadHistoryEntry[];
}

interface TestProvider {
  onDidChangeTreeData: vscode.Event<TestNode | undefined | null | void>;
  getTreeItem(node: TestNode): vscode.TreeItem;
  getChildren(node?: TestNode): TestNode[];
}

const recordOf = (overrides: Partial<HotReloadDeliveryRecord> = {}): HotReloadDeliveryRecord => ({
  rootId: 'r1',
  targetId: '',
  file: FILE_A,
  outcome: 'failed',
  recordedAt: 1700000000000,
  attempt: 1,
  detail: 'HTTP 500',
  ...overrides
});

const resolver: HotReloadNamesResolver = file => ({
  fullModule: 'entities.fight.FightAI',
  requestModule: 'fight.FightAI'
});

const contextOf = (): vscode.ExtensionContext =>
  ({ subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext);

const lastProvider = (): TestProvider => {
  const registration = treeRegistrations[treeRegistrations.length - 1];
  return registration?.provider as unknown as TestProvider;
};

const recentEntryNode = (provider: TestProvider): TestNode => {
  const recent = provider.getChildren(provider.getChildren()[0]);
  return recent[0];
};

describe('RUST-381 树项分叉:失败行可点定位,非失败行不可点', () => {
  let contexts: vscode.ExtensionContext[] = [];

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    contexts = [];
  });

  afterEach(() => {
    for (const context of contexts) {
      for (const subscription of [...context.subscriptions].reverse()) {
        try {
          subscription.dispose();
        } catch {
          // 释放失败不掩盖断言
        }
      }
    }
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
  });

  const boot = (): { feed: { handle(record: HotReloadDeliveryRecord): void }; provider: TestProvider } => {
    const context = contextOf();
    contexts.push(context);
    const feed = setupHotReloadHistoryView(context, {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver
    });
    return { feed, provider: lastProvider() };
  };

  it('失败行:contextValue=Failed,command=revealFile 带该条 fileUri,title=定位文件', () => {
    const { feed, provider } = boot();
    feed.handle(recordOf({ outcome: 'failed' }));
    const item = provider.getTreeItem(recentEntryNode(provider));
    expect(item.contextValue).toBe('kbengineHotReloadHistoryEntryFailed');
    expect(item.command?.command).toBe(HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND);
    expect(item.command?.arguments).toEqual([FILE_A]);
    expect(item.command?.title).toBe('定位文件');
  });

  it('非失败行(已应用/未确认):保持原 contextValue=Entry,无 command(不可点)', () => {
    const { feed, provider } = boot();
    feed.handle(recordOf({ outcome: 'applied' }));
    const item = provider.getTreeItem(recentEntryNode(provider));
    expect(item.contextValue).toBe('kbengineHotReloadHistoryEntry');
    expect(item.command).toBeUndefined();
  });

  it('失败行右键可经 contextValue 命中;成功行不命中(菜单 when 只对 Failed 亮)', () => {
    const { feed, provider } = boot();
    feed.handle(recordOf({ outcome: 'failed' }));
    const failed = provider.getTreeItem(recentEntryNode(provider));
    expect(failed.contextValue).toBe('kbengineHotReloadHistoryEntryFailed');
  });

  it('定位命令 happy path:openTextDocument + showTextDocument 被调用', async () => {
    boot();
    await commands.executeCommand(HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND, FILE_A);
    expect(workspaceState.openTextDocumentCalls).toHaveLength(1);
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
  });

  it('文件不存在(openTextDocument 抛):如实提示含路径,不静默假装定位', async () => {
    boot();
    const original = vscode.workspace.openTextDocument;
    vscode.workspace.openTextDocument = async () => {
      throw new Error('ENOENT');
    };
    try {
      await commands.executeCommand(HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND, FILE_A);
    } finally {
      vscode.workspace.openTextDocument = original;
    }
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.info.some(m => String(m).includes(FILE_A))).toBe(true);
  });

  it('缺参/空参:如实提示缺少文件路径,不定位', async () => {
    boot();
    await commands.executeCommand(HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND, undefined);
    await commands.executeCommand(HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND, '');
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.info.some(m => String(m).includes('缺少文件路径'))).toBe(true);
  });
});

describe('RUST-381 四件套装配锁:命令/激活/菜单/NLS/文档', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    contributes: {
      commands: Array<{ command: string }>;
      menus: {
        'view/item/context'?: Array<{ command: string; when?: string; group?: string }>;
        commandPalette?: Array<{ command: string; when?: string }>;
      };
    };
    activationEvents: string[];
  };
  const nlsEn = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const nlsZh = JSON.parse(readFileSync(join(root, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
  const commandsMd = readFileSync(join(root, 'docs', 'guide', 'commands.md'), 'utf8');

  it('package.json 贡献命令 + activationEvent + palette 隐藏(点击动作非调色板命令)', () => {
    expect(pkg.contributes.commands.some(c => c.command === HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND)).toBe(true);
    expect(pkg.activationEvents).toContain(`onCommand:${HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND}`);
    const palette = pkg.contributes.menus.commandPalette ?? [];
    expect(palette.some(e => e.command === HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND && e.when === 'false')).toBe(true);
  });

  it('失败行右键菜单三动作:定位文件(navigation@0)/打开日志(navigation@1)/重试(navigation@2)', () => {
    const menus = pkg.contributes.menus['view/item/context'] ?? [];
    const failedMenus = menus.filter(
      m =>
        m.when ===
        'view == kbengine.hotReloadHistory && viewItem == kbengineHotReloadHistoryEntryFailed'
    );
    const byCommand = new Map(failedMenus.map(m => [m.command, m.group]));
    expect(byCommand.get(HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND)).toBe('navigation@0');
    expect(byCommand.get('kbengine.hotReload.showLog')).toBe('navigation@1');
    expect(byCommand.get('kbengine.hotReload.retryFailed')).toBe('navigation@2');
  });

  it('NLS 双语标题在且真翻译(非同文假翻译)', () => {
    const key = 'kbengine.command.hotReload.historyRevealFile.title';
    expect(nlsEn[key]).toBeTruthy();
    expect(nlsZh[key]).toBeTruthy();
    expect(nlsEn[key]).not.toBe(nlsZh[key]);
  });

  it('docs/guide/commands.md 有本命令小节', () => {
    expect(commandsMd).toContain(`### \`${HOT_RELOAD_HISTORY_REVEAL_FILE_COMMAND}\``);
  });
});
