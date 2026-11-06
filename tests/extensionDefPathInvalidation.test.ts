import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { getRootConfigGeneration, getRootConfigLastBumpReason } from '../src/rootConfigGeneration';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { windowState } from './fake-vscode/windowState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { tests as testsRegistry } from './fake-vscode/core';
import { configurationOverrides, workspace, workspaceEvents, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// KR-AUD-55:kbengine.entityDefsPath / kbengine.entitiesXmlPath 两键不在配置
// 失效清单——entities.xml 与 entity_defs 是 schema/索引的数据源,改了指向
// 却不 bump rootConfigGeneration、不刷新 schema 面板,旧快照继续喂旧路径。
// 口径与 db/bin/configPath 分支一致:bump + schema 预览/模拟刷新。

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
});

const fireConfigChanged = (section: string): void => {
  workspaceEvents.configurationChanged.fire({
    affectsConfiguration: (key: string) => key === 'kbengine' || key === section
  });
};

describe('KR-AUD-55: defs 布局两键变更触发 schema/索引失效', () => {
  for (const section of ['kbengine.entityDefsPath', 'kbengine.entitiesXmlPath']) {
    it(`${section} 变更 bump rootConfigGeneration`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-defpaths-'));
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', { [section.replace('kbengine.', '')]: 'scripts/other_defs' });
      try {
        const context = makeContext();
        activate(context);
        const generationBefore = getRootConfigGeneration();
        fireConfigChanged(section);
        expect(getRootConfigGeneration()).toBeGreaterThan(generationBefore);
        expect(getRootConfigLastBumpReason()).toBe('def-paths');
        for (const disposable of context.subscriptions) {
          disposable.dispose();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 8000);
  }
});
