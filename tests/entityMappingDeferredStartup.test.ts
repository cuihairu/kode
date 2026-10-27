import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexScheduler, IndexTaskPriority } from '../src/indexScheduler';
import { EntityMappingManager } from '../src/entityMapping';
import { workspace as stubWorkspace } from './helpers/vscodeStub';

// EntityMappingManager 门控启动面(书 PR-002):deferStartup=true 构造零副作用
// (不建 watcher、不入队首扫),ensureStartup() 幂等启动且与直接激活路径逐行为
// 一致(watcher 三件套次序 + 同键首扫);查询入口的 ensureStartup 兜底保证
// deferred 模式下任何公开查询都不会悬死、结果口径不变。

const originalFindFiles = stubWorkspace.findFiles;
const originalCreateWatcher = stubWorkspace.createFileSystemWatcher;

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

describe('EntityMappingManager deferStartup(书 PR-002 工作区门控)', () => {
  let root = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gate-mapping-'));
    // watcher 三件套以 workspaceFolders[0] 为 pattern 前提,必须先落位
    stubWorkspace.workspaceFolders = [
      { uri: { fsPath: root } as never, name: 'gate', index: 0 }
    ];
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(
      path.join(defDir, 'Hero.def'),
      ['<root>', '  <Properties>', '  </Properties>', '</root>'].join('\n'),
      'utf8'
    );
    stubWorkspace.findFiles = (async () => [
      { fsPath: path.join(defDir, 'Hero.def') }
    ]) as unknown as typeof stubWorkspace.findFiles;
  });

  afterAll(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.createFileSystemWatcher = originalCreateWatcher;
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('默认构造(无 deferStartup):立即建 watcher 三件套并入队首扫(门控前行为回归)', async () => {
    let watchers = 0;
    stubWorkspace.createFileSystemWatcher = (() => {
      watchers += 1;
      return originalCreateWatcher.call(stubWorkspace, '**/*');
    }) as typeof stubWorkspace.createFileSystemWatcher;
    const scheduler = new IndexScheduler();
    const manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
    try {
      expect(watchers).toBe(3);
      await until(
        () => scheduler.getStatus().keyedTasks['entity-mapping-initial-scan'] !== undefined,
        'default constructor enqueues initial scan'
      );
    } finally {
      manager.dispose();
    }
  });

  it('deferStartup=true:构造零副作用——零 watcher、零入队', async () => {
    let watchers = 0;
    stubWorkspace.createFileSystemWatcher = (() => {
      watchers += 1;
      return originalCreateWatcher.call(stubWorkspace, '**/*');
    }) as typeof stubWorkspace.createFileSystemWatcher;
    const scheduler = new IndexScheduler();
    const manager = new EntityMappingManager(
      { subscriptions: [] } as never,
      scheduler,
      { deferStartup: true }
    );
    try {
      expect(watchers).toBe(0);
      expect(scheduler.getStatus().queued).toBe(0);
      expect(scheduler.getStatus().completed).toBe(0);
      // 宏任务后依旧零启动(不是延迟启动)
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(watchers).toBe(0);
      expect(scheduler.getStatus().completed).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('ensureStartup():幂等启动——watcher 三件套只建一次,首扫走同一 keyed 任务', async () => {
    let watchers = 0;
    stubWorkspace.createFileSystemWatcher = (() => {
      watchers += 1;
      return originalCreateWatcher.call(stubWorkspace, '**/*');
    }) as typeof stubWorkspace.createFileSystemWatcher;
    const scheduler = new IndexScheduler();
    const manager = new EntityMappingManager(
      { subscriptions: [] } as never,
      scheduler,
      { deferStartup: true }
    );
    try {
      manager.ensureStartup();
      manager.ensureStartup();
      manager.ensureStartup();
      expect(watchers).toBe(3);
      await manager.waitForInitialScan();
      expect(scheduler.getStatus().completed).toBeGreaterThanOrEqual(1);
    } finally {
      manager.dispose();
    }
  });

  it('deferred 模式查询兜底:resolveMethodDefinition 自动启动,不悬死且出结果', async () => {
    let watchers = 0;
    stubWorkspace.createFileSystemWatcher = (() => {
      watchers += 1;
      return originalCreateWatcher.call(stubWorkspace, '**/*');
    }) as typeof stubWorkspace.createFileSystemWatcher;
    const scheduler = new IndexScheduler();
    const manager = new EntityMappingManager(
      { subscriptions: [] } as never,
      scheduler,
      { deferStartup: true }
    );
    try {
      const result = await manager.resolveMethodDefinition(
        path.join(root, 'scripts', 'entity', 'Hero.py'),
        'nonexistentMethod'
      );
      expect(result).toBeNull();
      expect(watchers).toBe(3);
      // 兜底启动的首扫收敛:查询返回后 keyed 首扫最终完成(不永久 pending)
      await manager.waitForInitialScan();
      expect(scheduler.getStatus().completed).toBeGreaterThanOrEqual(1);
    } finally {
      manager.dispose();
    }
  });

  it('后台首扫尚未结束时 RequestLocal 可在两个批次之间执行', async () => {
    const previous = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async () => Array.from({ length: 24 }, (_, i) => ({
      fsPath: path.join(root, 'scripts', 'entity_defs', `Batch${i}.def`)
    }))) as unknown as typeof stubWorkspace.findFiles;
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 0 });
    const manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler, { deferStartup: true });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let parsed = 0;
    (manager as unknown as { parseDefFile: () => Promise<void> }).parseDefFile = async () => {
      parsed += 1;
      if (parsed === 1) { firstStarted(); await firstGate; }
    };
    try {
      manager.ensureStartup();
      await started;
      let ranAt = -1;
      const request = scheduler.enqueue({
        kind: 'single-file-update',
        priority: IndexTaskPriority.RequestLocal,
        run: async () => { ranAt = parsed; }
      });
      releaseFirst();
      await request.wait;
      expect(ranAt).toBe(8);
      await manager.waitForInitialScan();
      expect(parsed).toBe(24);
    } finally {
      releaseFirst();
      manager.dispose();
      stubWorkspace.findFiles = previous;
    }
  });
});
