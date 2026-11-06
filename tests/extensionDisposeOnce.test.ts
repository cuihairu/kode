import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../src/extension';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { windowState } from './fake-vscode/windowState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { tests as testsRegistry } from './fake-vscode/core';
import { workspace, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// KR-AUD-57:extension 拆卸链里 serverManager.dispose() 被连调两次(一次裸调
// 丢 promise,一次 await)——进程表清理本身幂等,故此前无症状,但语义上拆卸
// 每个资源恰好一次。这里以计数子类钉死「恰好一次」。

const disposeCounter = vi.hoisted(() => ({ serverManagerDisposeCalls: 0 }));

vi.mock('../src/serverManager', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/serverManager')>();
  class CountingServerManager extends actual.KBEngineServerManager {
    constructor(...args: ConstructorParameters<typeof actual.KBEngineServerManager>) {
      super(...args);
    }

    override async dispose(): Promise<void> {
      disposeCounter.serverManagerDisposeCalls += 1;
      await super.dispose();
    }
  }
  return { ...actual, KBEngineServerManager: CountingServerManager };
});

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  extensionPath: path.resolve(__dirname, '..'),
  extension: { extensionKind: 'workspace' }
});

beforeEach(() => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  workspaceState.reset();
  panelRegistry.reset();
  testsRegistry.reset();
  workspace.workspaceFolders = [];
  workspace.findFiles = async () => [] as ReturnType<typeof Uri.file>[];
  disposeCounter.serverManagerDisposeCalls = 0;
});

describe('KR-AUD-57: 拆卸链 serverManager.dispose 恰好一次', () => {
  it('context.subscriptions 全量 dispose 后 serverManager.dispose 只被调用一次', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-dispose57-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    try {
      const context = makeContext();
      activate(context);
      expect(disposeCounter.serverManagerDisposeCalls).toBe(0);
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
      expect(disposeCounter.serverManagerDisposeCalls).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
