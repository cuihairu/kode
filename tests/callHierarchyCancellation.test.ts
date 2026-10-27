import { expect, it, vi } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineCallHierarchyProvider } from '../src/languageProviders';
import { Uri } from './helpers/vscodeStub';

it.each(['incoming', 'outgoing'] as const)('%s 调用层级取消后停止处理索引结果', async direction => {
  let release!: (index: unknown) => void;
  const lookup = new Promise(resolve => { release = resolve; });
  const manager = Object.assign(Object.create(EntityMappingManager.prototype), {
    ensureStartup: vi.fn(),
    ensureIndexForPythonFile: vi.fn(() => lookup)
  }) as EntityMappingManager;
  const provider = new KBEngineCallHierarchyProvider(manager);
  const token = { isCancellationRequested: false };
  const item = { uri: Uri.file('/ws/a.py'), name: 'method' };
  const pending = direction === 'incoming'
    ? provider.provideCallHierarchyIncomingCalls(item as never, token as never)
    : provider.provideCallHierarchyOutgoingCalls(item as never, token as never);
  token.isCancellationRequested = true;
  // 如果取消后仍遍历索引，getter 会抛错。
  release({ get pythonMethods() { throw new Error('must not scan after cancellation'); } });
  await expect(pending).resolves.toEqual([]);
});

it('取消时定向归属查询不继续回查或记录负缓存', async () => {
  let release!: (value: undefined) => void;
  const targeted = new Promise<undefined>(resolve => { release = resolve; });
  const find = vi.fn(() => undefined);
  const findTargeted = vi.fn(() => targeted);
  const missingOwnerPaths = new Set<string>();
  const manager = Object.assign(Object.create(EntityMappingManager.prototype), {
    ensureStartup: vi.fn(), missingOwnerPaths, initialScanCompleted: true,
    findIndexForPythonFile: find, ensureIndexTargeted: findTargeted
  }) as EntityMappingManager;
  const token = { isCancellationRequested: false };
  const pending = manager.getIncomingPythonMethodCalls('/ws/a.py', 'method', token as never);
  expect(findTargeted).toHaveBeenCalledWith('a', token, '/ws/a.py');
  token.isCancellationRequested = true;
  release(undefined);
  expect(await pending).toEqual([]);
  expect(find).toHaveBeenCalledTimes(1);
  expect(missingOwnerPaths.size).toBe(0);
});
