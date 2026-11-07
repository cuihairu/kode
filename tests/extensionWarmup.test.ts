import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { window as stubWindow, windowState } from './fake-vscode/windowState';
import {
  workspace as stubWorkspace,
  workspaceState as stubWorkspaceFakes
} from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// BG-WARM 装配面:KBEngine 工作区激活 → 后台预热自动启动(不等面板),
// 状态栏进度可取消(withProgress Window 位);纯 Python 工作区不启动。
// 预热完成写 workspaceState 标记;dispose(含 deactivate)取消在跑预热。

interface RecordedProgress {
  options: unknown;
  resolve: () => void;
  reports: Array<{ message?: string }>;
  cancelled: boolean;
  taskStarted: boolean;
}

const until = async (predicate: () => boolean, timeoutMs = 6000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const makeContext = (): ExtensionContext => {
  const store = new Map<string, unknown>();
  return {
    subscriptions: [],
    extensionUri: Uri.file('/workspace/ext'),
    workspaceState: {
      get: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) { store.delete(key); } else { store.set(key, value); }
        return Promise.resolve();
      }
    }
  } as ExtensionContext;
};

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

const recorded: Record<string, unknown> = {};
const markerKey = 'kbengine.backgroundWarmup.completed';
const originalWithProgress = stubWindow.withProgress;

beforeEach(() => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  panelRegistry.reset();
  stubWorkspaceFakes.reset();
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.findFiles = async () => [] as Uri[];
  recorded.progress = null;
});

afterEach(() => {
  stubWindow.withProgress = originalWithProgress;
});

describe('BG-WARM 激活装配', () => {
  it('KBEngine 工作区激活:后台预热自动启动,withProgress 状态栏进度可取消', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file('/ws/kbe'), name: 'kbe', index: 0 }
    ];
    stubWorkspace.findFiles = (async () => [
      Uri.file('/ws/kbe/scripts/entity_defs/Hero.def')
    ]) as typeof stubWorkspace.findFiles;

    const progresses: RecordedProgress[] = [];
    stubWindow.withProgress = ((options: unknown, task: (progress: { report: (info: unknown) => void }, token: unknown) => Promise<unknown>) => {
      const record: RecordedProgress = { options, resolve: () => undefined, reports: [], cancelled: false, taskStarted: false };
      const progress = { report: (info: unknown) => { record.reports.push(info as { message?: string }); } };
      record.taskStarted = true;
      progresses.push(record);
      return task(progress, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined })
      }) as Promise<unknown>;
    }) as typeof stubWindow.withProgress;

    const context = makeContext();
    try {
      activate(context);
      // 预热管线在门控放行后启动:withProgress(Window 位)被调用且任务体已启动。
      // KODE-PERF 起,首扫也在实体浏览器视图位出 withProgress(cancellable=false,
      // title=扫描实体与脚本索引…)——按 title 选出预热这条,断言口径不变。
      const warmupTitle = (record: RecordedProgress): string =>
        String((record.options as { title?: string }).title ?? '');
      await until(
        () => progresses.some(record => warmupTitle(record).includes('预热')),
        'warmup progress started'
      );
      const warmupRecord = progresses.find(record => warmupTitle(record).includes('预热'))!;
      const options = warmupRecord.options as { location?: unknown; title?: string; cancellable?: boolean };
      expect(options.cancellable).toBe(true);
      expect(options.title).toContain('预热');
      // 完成后写 workspaceState 标记(空 fake 工作区管线轻,应快速完成)
      await until(() => {
        const marker = context.workspaceState?.get<{ generation: string }>(markerKey);
        return marker !== undefined;
      }, 'warmup marker written');
    } finally {
      deactivate();
      disposeAll(context);
    }
  });

  it('纯 Python 工作区(门控未放行):不启动后台预热', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file('/ws/plain-py'), name: 'plain-py', index: 0 }
    ];
    let withProgressCalls = 0;
    stubWindow.withProgress = ((_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
      withProgressCalls += 1;
      return task({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
    }) as typeof stubWindow.withProgress;

    const context = makeContext();
    try {
      activate(context);
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(withProgressCalls).toBe(0);
      expect(context.workspaceState?.get(markerKey)).toBeUndefined();
    } finally {
      deactivate();
      disposeAll(context);
    }
  });
});
