import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { TypesXmlCodeLensProvider } from '../src/languageProviders';
import { registerTypeStorageIndexWatchers } from '../src/typeStorageIndexWatchers';
import { allFileSystemWatchers, workspaceState } from './fake-vscode/workspaceState';

// IDE-ARC-005 共享索引唯一生命周期所有者:全仓服务(watcher/worker/缓存)
// 由装配层(组合根+activate 激活器,SRC-001 起)统一创建与释放;provider
// 不私建第二套全仓服务。
// 本增量落点:TypesXmlCodeLensProvider 不再在构造器里私建 def/types.xml/
// entities.xml 三枚全仓 watcher(此前其 dispose 也从未被装配层调用=泄漏),
// 改由装配线模块 typeStorageIndexWatchers 建 watcher 并以 Disposable 交
// context.subscriptions 统一释放;共享 WorkspaceIndex 与 worker/快照缓存
// 的装配层所有权(extension 唯一构造 + subscriptions 释放 + deactivate
// 收 worker/快照)一并钉死。

const root = join(__dirname, '..');

describe('全仓服务生命周期归装配层(IDE-ARC-005)', () => {
  it('构造 TypesXmlCodeLensProvider 不再创建任何 watcher', () => {
    workspaceState.reset();
    const before = allFileSystemWatchers.length;
    const provider = new TypesXmlCodeLensProvider();
    try {
      expect(allFileSystemWatchers.length).toBe(before);
    } finally {
      provider.dispose();
    }
  });

  it('装配线模块建三枚全仓 watcher,dispose 后事件不再分发', () => {
    workspaceState.reset();
    let refreshed = 0;
    const disposable = registerTypeStorageIndexWatchers(() => { refreshed += 1; });
    try {
      expect(allFileSystemWatchers.map(watcher => (watcher as unknown as { pattern?: string }).pattern ?? ''))
        .toEqual(['**/*.def', '**/types.xml', '**/entities.xml']);
      const defWatcher = allFileSystemWatchers[0] as unknown as { fireChange: (uri: vscode.Uri) => void };
      defWatcher.fireChange(vscode.Uri.file('/ws/scripts/entity_defs/Hero.def'));
      expect(refreshed).toBe(1);
    } finally {
      disposable.dispose();
    }
    // dispose 后监听已拆:同 watcher 再 fire 不再回调
    const defWatcher = allFileSystemWatchers[0] as unknown as { fireChange: (uri: vscode.Uri) => void };
    defWatcher.fireChange(vscode.Uri.file('/ws/scripts/entity_defs/Hero.def'));
    expect(refreshed).toBe(1);
  });

  it('languageProviders 不再私建 watcher(全仓 watch 只住装配线模块)', () => {
    // KODE-ARCH-001:拆分后源文本锁覆盖 barrel + 全部子模块
    const lpSources = ['src/languageProviders.ts',
      ...readdirSync(join(root, 'src/languageProviders')).filter(f => f.endsWith('.ts')).map(f => `src/languageProviders/${f}`)];
    const source = lpSources.map(p => readFileSync(join(root, p), 'utf8')).join('\n');
    expect(source.includes('createFileSystemWatcher'), 'provider 面不得私建全仓 watcher').toBe(false);
  });

  it('装配层接线:组合根/激活器注册 watcher 装配线并释放 provider 实例;共享索引唯一构造', () => {
    // SRC-001 起装配层=组合根 extension.ts + src/activate/* 激活器
    const activateSources = readdirSync(join(root, 'src/activate'))
      .filter(f => f.endsWith('.ts')).map(f => `src/activate/${f}`);
    const assembly = ['src/extension.ts', ...activateSources]
      .map(p => readFileSync(join(root, p), 'utf8')).join('\n');
    expect(assembly.includes('registerTypeStorageIndexWatchers')).toBe(true);
    expect(assembly.includes('typesXmlCodeLensProviderImpl.fireConfigurationChanged')).toBe(true);
    // impl 实例(含事件订阅)也进 subscriptions,不是只推注册面
    expect(assembly.includes('context.subscriptions.push(typesXmlCodeLensProvider, typesXmlCodeLensProviderImpl)')).toBe(true);
    // 共享索引全仓只此一处构造,ensureStarted 只由装配层启动
    // (KODE-ARCH-001:languageProviders 源面含拆分子模块)
    const sources = ['src/extension.ts', ...activateSources, 'src/languageProviders.ts',
      ...readdirSync(join(root, 'src/languageProviders')).filter(f => f.endsWith('.ts')).map(f => `src/languageProviders/${f}`),
      'src/eventApi.ts'];
    let assemblyConstructions = 0;
    for (const relative of sources) {
      const text = readFileSync(join(root, relative), 'utf8');
      const constructions = (text.match(/new WorkspaceIndex\(/g) ?? []).length;
      if (relative === 'src/extension.ts' || relative.startsWith('src/activate/')) {
        assemblyConstructions += constructions;
      } else {
        expect(constructions, `${relative} 不得私建第二套全仓索引`).toBe(0);
      }
    }
    expect(assemblyConstructions).toBe(1);
    expect(assembly.includes('context.subscriptions.push(sharedWorkspaceIndex)')).toBe(true);
  });

  it('worker 与快照缓存由装配层 deactivate 统一释放(既有面回归锁)', () => {
    const extension = readFileSync(join(root, 'src/extension.ts'), 'utf8');
    expect(extension.includes('disposePythonParserWorker();')).toBe(true);
    expect(extension.includes('releaseAllDocumentSnapshots();')).toBe(true);
  });
});
