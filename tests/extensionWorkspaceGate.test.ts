import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { windowState } from './fake-vscode/windowState';
import {
  lastFileSystemWatcher,
  workspace,
  workspaceState
} from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { RelativePattern, Uri, type ExtensionContext } from './fake-vscode/core';

// 激活期工作区门控(书 PR-002 / AUDIT-003 负案例):
//   负案例:纯 Python 工作区(特征探测零命中)→ EntityMappingManager 的
//           watcher 三件套不创建、后台扫描不入队、调度器零任务;
//   正案例:工作区含 .def 特征 → 门控放行,与门控前激活期行为一致
//           (watcher 三件套次序 types→def→python 保留);
//   fail-open:探测抛错按 KBEngine 工作区放行。
// 观测面:EntityMappingManager.ensureStartup 的可辨识产物 = workspace 首根
// 前缀的 `**/*.py` watcher(watchPythonFiles 独有;其余组件的 watcher 都是
// 无根前缀全局 glob 或 .kbengine 路径)。

const until = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

const originalFindFiles = workspace.findFiles;
const originalCreateWatcher = workspace.createFileSystemWatcher;

/** 记账 createFileSystemWatcher,按 pattern 收集(RelativePattern 解包成
 * `base/glob` 文本——IDE-ACC-011 起 entityMapping 三件套以 RelativePattern
 * 注册,joinPath 字符串会被真机宿主百分号编码成死 pattern) */
const recordWatchers = (): string[] => {
  const patterns: string[] = [];
  const original = workspace.createFileSystemWatcher;
  workspace.createFileSystemWatcher = ((pattern: unknown) => {
    if (pattern instanceof RelativePattern) {
      patterns.push(`${String(pattern.base)}/${pattern.pattern}`);
    } else {
      patterns.push(String(pattern));
    }
    return original.call(workspace, pattern);
  }) as typeof workspace.createFileSystemWatcher;
  return patterns;
};

beforeEach(() => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  panelRegistry.reset();
  workspaceState.reset();
  workspace.workspaceFolders = [];
  workspace.findFiles = async () => [] as Uri[];
  lastFileSystemWatcher.current = null;
});

afterEach(() => {
  workspace.findFiles = originalFindFiles;
  workspace.createFileSystemWatcher = originalCreateWatcher;
});

describe('extension activate 工作区门控(书 PR-002)', () => {
  it('负案例:纯 Python 工作区激活——零 EntityMapping watcher、调度器零任务', async () => {
    workspace.workspaceFolders = [
      { uri: Uri.file('/ws/plain-py'), name: 'plain-py', index: 0 }
    ];
    // findFiles 默认 [] → 特征零命中
    const patterns = recordWatchers();

    const context = makeContext();
    try {
      activate(context);
      // 门控探测异步:静置后确认 EntityMapping 的根前缀 python watcher 永不出现
      await new Promise(resolve => setTimeout(resolve, 500));
      const managerPythonWatcher = patterns.find(p => p.endsWith('/**/*.py'));
      expect(managerPythonWatcher).toBeUndefined();
      // 静置再确认:不会迟到的启动
      const countAtSettle = patterns.length;
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(patterns.length).toBe(countAtSettle);
    } finally {
      deactivate();
      disposeAll(context);
    }
  });

  it('正案例:含 .def 特征的工作区激活——门控放行,watcher 三件套补齐', async () => {
    workspace.workspaceFolders = [
      { uri: Uri.file('/ws/kbe'), name: 'kbe', index: 0 }
    ];
    workspace.findFiles = (async () => [
      Uri.file('/ws/kbe/scripts/entity_defs/Hero.def')
    ]) as typeof workspace.findFiles;
    const patterns = recordWatchers();

    const context = makeContext();
    try {
      activate(context);
      // 门控放行 → ensureStartup 建三件套;python watcher(根前缀 **/*.py)
      // 最后创建(既有次序契约)
      await until(
        () => patterns.some(p => p.endsWith('/**/*.py')),
        'gate-promoted manager watchers'
      );
      const pythonIndex = patterns.findIndex(p => p.endsWith('/**/*.py'));
      const defIndex = patterns.findIndex(p => p.endsWith('/**/*.def') && p.startsWith('/ws/kbe'));
      const typesIndex = patterns.findIndex(p => p.includes('{types,alias}.xml'));
      expect(defIndex).toBeGreaterThan(-1);
      expect(typesIndex).toBeGreaterThan(-1);
      expect(pythonIndex).toBeGreaterThan(typesIndex);
      expect(pythonIndex).toBeGreaterThan(defIndex);
    } finally {
      deactivate();
      disposeAll(context);
    }
  });

  it('正案例:探测抛错 fail-open——按 KBEngine 工作区放行', async () => {
    workspace.workspaceFolders = [
      { uri: Uri.file('/ws/kbe'), name: 'kbe', index: 0 }
    ];
    workspace.findFiles = (async () => {
      throw new Error('vscode api down');
    }) as typeof workspace.findFiles;
    const patterns = recordWatchers();

    const context = makeContext();
    try {
      activate(context);
      await until(
        () => patterns.some(p => p.endsWith('/**/*.py')),
        'fail-open manager watchers'
      );
    } finally {
      deactivate();
      disposeAll(context);
    }
  });
});
