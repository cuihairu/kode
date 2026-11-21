import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { FingerprintStats, formatFingerprintStats } from '../src/backend/hotReloadFingerprintStats';
import { setupDefFingerprintInspector, type DefFingerprintDeps } from '../src/defFingerprintInspector';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher,
  messages,
  windowState
} from './helpers/vscodeStub';
import { workspaceEvents } from './fake-vscode/workspaceState';

// RUST-403(旧 HR-HASH-016)指纹增量统计:让「单文件修改不触发全项目 Hash
// 重算」可观测。判据:
// - FingerprintStats 记账面:recordCompute 累计字节+重算文件数;依赖遍历
//   累计节点数;负数/小数防御 clamp;reset 清零;formatFingerprintStats 回显;
// - 性能面(Inspector 装配):语料 ~300 个 .def 在内容表里,保存其中一个 →
//   读面恰好被调一次(只读被存文件),rehashedFiles=1,bytesRead=该文件字节
//   数,其余语料零触达(若实现劣化成全项目重扫,字节数/文件数会膨胀到语料
//   总量,一眼可见);
// - 依赖面(hotReload 装配):types.xml 首见建档后二次变更 → reverse-dependency
//   闭包命中数记进 affectedDependencyNodes(与影响报告同源)。

const TYPES_BEFORE = '<types>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</types>\n';
const TYPES_AFTER = '<types>\n  <ITEM_ID> UINT32 </ITEM_ID>\n</types>\n';
const DEF_USING_ITEM = `<root>
  <Properties>
    <item>
      <Type>ITEM_ID</Type>
    </item>
  </Properties>
</root>
`;

describe('FingerprintStats 记账面(RUST-403)', () => {
  it('累计:recordCompute 字节+文件数,recordDependencyTraversal 节点数', () => {
    const stats = new FingerprintStats();
    stats.recordCompute(120);
    stats.recordCompute(80, 2);
    stats.recordDependencyTraversal(3);
    expect(stats.view()).toEqual({ bytesRead: 200, rehashedFiles: 3, affectedDependencyNodes: 3 });
  });

  it('防御:负数/小数按 0/floor 计,不污染账', () => {
    const stats = new FingerprintStats();
    // 负数字节按 0 计(防御),但该次调用仍是「算了一个文件」(rehashedFiles
    // 缺省 1,只 clamp 字节面);小数按 floor 截断。
    stats.recordCompute(-50);
    stats.recordCompute(7.9);
    stats.recordDependencyTraversal(-1);
    stats.recordDependencyTraversal(2.5);
    expect(stats.view()).toEqual({ bytesRead: 7, rehashedFiles: 2, affectedDependencyNodes: 2 });
  });

  it('reset 清零后重新累计', () => {
    const stats = new FingerprintStats();
    stats.recordCompute(100);
    stats.recordDependencyTraversal(4);
    stats.reset();
    expect(stats.view()).toEqual({ bytesRead: 0, rehashedFiles: 0, affectedDependencyNodes: 0 });
    stats.recordCompute(10);
    expect(stats.view().bytesRead).toBe(10);
  });

  it('formatFingerprintStats 回显(OUTPUT/审计同源)', () => {
    expect(formatFingerprintStats({ bytesRead: 512, rehashedFiles: 1, affectedDependencyNodes: 2 })).toBe(
      '指纹统计: bytes read=512 B, rehashed files=1, affected dependency nodes=2'
    );
  });
});

describe('Inspector 装配性能面:单文件保存不触发全项目重算(RUST-403)', () => {
  beforeEach(() => {
    windowState.reset();
  });

  const CORPUS_SIZE = 300;
  const corpus = (): Record<string, string> => {
    const contents: Record<string, string> = {};
    for (let i = 0; i < CORPUS_SIZE; i += 1) {
      contents[`/ws/entities/entity-${i}.def`] = `<root>\n  <Properties>\n    <hp>\n      <Type> UINT32 </Type>\n    </hp>\n  </Properties>\n</root>\n`;
    }
    return contents;
  };

  it('保存一个 .def:读面恰好一次(只读被存文件),stats 反映增量工作量', () => {
    const contents = corpus();
    const SAVED = '/ws/entities/entity-7.def';
    const readPaths: string[] = [];
    const stats = new FingerprintStats();
    const deps: DefFingerprintDeps = {
      readSnapshot: fsPath => {
        readPaths.push(fsPath);
        return fsPath in contents ? { content: contents[fsPath], source: 'disk' } : null;
      },
      now: () => 1,
      lastMd5Check: () => null
    };
    setupDefFingerprintInspector({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      deps,
      stats
    });

    workspaceEvents.documentSaved.fire({ uri: { fsPath: SAVED } });

    // 只读了被保存的那个文件——语料其余 299 个零触达(若实现劣化成全项目
    // 重扫,此断言立即炸:readPaths 会膨胀到语料总量)。
    expect(readPaths).toEqual([SAVED]);
    const expectedBytes = Buffer.byteLength(contents[SAVED], 'utf8');
    expect(stats.view()).toEqual({
      bytesRead: expectedBytes,
      rehashedFiles: 1,
      affectedDependencyNodes: 0
    });
    // 回显面同步(统计口径可审计,不只在内存)
    expect(formatFingerprintStats(stats.view())).toContain(`bytes read=${expectedBytes} B`);
    expect(formatFingerprintStats(stats.view())).toContain('rehashed files=1');
  });

  it('第二次保存另一文件:读面仍各只一次,字节数累加(跨文件不互相重算)', () => {
    const contents = corpus();
    const A = '/ws/entities/entity-0.def';
    const B = '/ws/entities/entity-1.def';
    const readPaths: string[] = [];
    const stats = new FingerprintStats();
    const deps: DefFingerprintDeps = {
      readSnapshot: fsPath => {
        readPaths.push(fsPath);
        return fsPath in contents ? { content: contents[fsPath], source: 'disk' } : null;
      },
      now: () => 1,
      lastMd5Check: () => null
    };
    setupDefFingerprintInspector({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      deps,
      stats
    });

    workspaceEvents.documentSaved.fire({ uri: { fsPath: A } });
    workspaceEvents.documentSaved.fire({ uri: { fsPath: B } });

    expect(readPaths).toEqual([A, B]);
    const totalBytes =
      Buffer.byteLength(contents[A], 'utf8') + Buffer.byteLength(contents[B], 'utf8');
    expect(stats.view()).toEqual({ bytesRead: totalBytes, rehashedFiles: 2, affectedDependencyNodes: 0 });
  });

  it('非 .def 保存/不可读:零记账(过滤面不进增量账)', () => {
    const contents = corpus();
    const stats = new FingerprintStats();
    const deps: DefFingerprintDeps = {
      readSnapshot: fsPath => (fsPath in contents ? { content: contents[fsPath], source: 'disk' } : null),
      now: () => 1,
      lastMd5Check: () => null
    };
    setupDefFingerprintInspector({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      deps,
      stats
    });

    workspaceEvents.documentSaved.fire({ uri: { fsPath: '/ws/scripts/x.py' } });
    workspaceEvents.documentSaved.fire({ uri: { fsPath: '/ws/gone.def' } });
    expect(stats.view()).toEqual({ bytesRead: 0, rehashedFiles: 0, affectedDependencyNodes: 0 });
  });
});

describe('hotReload 装配依赖面:types.xml 闭包命中数入账(RUST-403)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    messages.warning.length = 0;
    channels.length = 0;
  });

  const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => void } => {
    const handles = new Map<unknown, () => void>();
    let nextHandle = 0;
    return {
      tick: () => {
        const callbacks = [...handles.values()];
        handles.clear();
        for (const callback of callbacks) {
          callback();
        }
      },
      timers: {
        set: (callback): unknown => {
          const handle = nextHandle++;
          handles.set(handle, callback);
          return handle;
        },
        clear: (handle): void => {
          handles.delete(handle);
        }
      }
    };
  };

  const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  it('types.xml 首见建档不入账;二次变更 → affectedDependencyNodes=闭包命中数', async () => {
    let content = TYPES_BEFORE;
    const stats = new FingerprintStats();
    const clock = makeTimers();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.py', '**/*.xml'] }
    });
    setupHotReload(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      () => true,
      {
        timers: clock.timers,
        targetState: {
          store: new HotReloadTargetStateStore({ now: () => 1 }),
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          readFileContent: async () => content
        },
        collectDefsForTypesImpact: async () => [{ name: 'Monster.def', text: DEF_USING_ITEM }],
        fingerprintStats: stats
      }
    );
    const fire = (): void => {
      lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/entity_defs/types.xml' } as never);
      clock.tick();
    };

    // 首见:建档基线,不影响报告 → 依赖账仍零
    fire();
    await flush();
    expect(stats.view().affectedDependencyNodes).toBe(0);

    // 二次(内容变):reverse-dependency 闭包命中 1 个 .def(Monster.def)
    content = TYPES_AFTER;
    fire();
    await flush();
    expect(stats.view()).toEqual({ bytesRead: 0, rehashedFiles: 0, affectedDependencyNodes: 1 });
  });

  it('未注入 fingerprintStats:装配不记账也不崩(缺省行为保持)', async () => {
    let content = TYPES_BEFORE;
    const clock = makeTimers();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.py', '**/*.xml'] }
    });
    setupHotReload(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      () => true,
      {
        timers: clock.timers,
        targetState: {
          store: new HotReloadTargetStateStore({ now: () => 1 }),
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          readFileContent: async () => content
        },
        collectDefsForTypesImpact: async () => [{ name: 'Monster.def', text: DEF_USING_ITEM }]
      }
    );
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/entity_defs/types.xml' } as never);
    clock.tick();
    await flush();
    content = TYPES_AFTER;
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/entity_defs/types.xml' } as never);
    clock.tick();
    await flush();
    // 无统计句柄:只要求不抛(影响报告照常出,不因缺统计回退)
    expect(channels.find(entry => entry.name === 'KBEngine 热更新')?.lines.join('\n') ?? '').toContain('Monster.def');
  });
});
