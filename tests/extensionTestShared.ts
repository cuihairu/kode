// SRC-010:extension.test.ts 按功能域拆分——共享装配脚手架抽到本模块。
// 各域文件(profileCommands/hotreload/pythonIndex/misc)与 extension.test.ts
// 的端到端装配 describe 共用;本文件置于 tests/ 下(非 tests/helpers/),
// 使 makeContext 的 path.resolve(__dirname,'..') 解析到仓库根(extensionPath
// 指向真实 package.json),不因移入子目录而偏移。
import * as path from 'path';
import { RelativePattern, Uri, type ExtensionContext } from './fake-vscode/core';
import { tests as testsRegistry } from './fake-vscode/core';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { windowState } from './fake-vscode/windowState';
import { workspaceState, workspace } from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import packageJson from '../package.json';

export const until = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

interface DeclaredPackageJson {
  contributes: {
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
  };
}

export const declared = (packageJson as unknown as DeclaredPackageJson).contributes;

export const BAD_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>NO_SUCH_FLAG</Flags>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

export const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  // IDE-REL-007 复现配置摘要命令读自身 package.json 的布尔贡献项;
  // 仓库根即真实清单(activation 面不读它,仅该命令与身份命令按需读)。
  extensionPath: path.resolve(__dirname, '..'),
  // 宿主侧判定读 context.extension.extensionKind(真 API 自带)
  extension: { extensionKind: 'workspace' }
});

export const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

/** 每测试文件 beforeEach 的重置体:清空各 fake 注册表与工作区扫描面。 */
export const resetExtensionTestState = (): void => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  workspaceState.reset();
  panelRegistry.reset();
  testsRegistry.reset();
  workspace.workspaceFolders = [];
  workspace.findFiles = async () => [] as Uri[];
};

/** watcher pattern 归一化文本(RelativePattern 解包;IDE-ACC-011) */
export const watcherPatternKey = (pattern: unknown): string =>
  pattern instanceof RelativePattern
    ? `${String(pattern.base)}/${pattern.pattern}`
    : String(pattern);
