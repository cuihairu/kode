import { expect, it, vi } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';

it('未知文件归属冷 miss 不等待全仓扫描，也不缓存部分快照的 miss', async () => {
  const scan = vi.fn(() => new Promise<void>(() => {}));
  const missingOwnerPaths = new Set<string>();
  const manager = Object.assign(Object.create(EntityMappingManager.prototype), {
    missingOwnerPaths,
    initialScanCompleted: false,
    findIndexForPythonFile: vi.fn(() => undefined),
    ensureIndexTargeted: vi.fn(async () => undefined),
    scanEntityMappings: scan
  }) as {
    ensureIndexForPythonFile(file: string): Promise<unknown>;
  };
  await expect(manager.ensureIndexForPythonFile('/ws/Unknown.py')).resolves.toBeUndefined();
  expect(scan).not.toHaveBeenCalled();
  expect(missingOwnerPaths.size).toBe(0);
});
