import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexScheduler, IndexTaskPriority } from '../src/indexScheduler';
import { scheduleBackgroundSchemaWarmup } from '../src/schemaWarmup';
import {
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaCacheStatsForTests,
  getDatabaseSchemaSnapshot
} from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-SCH-006:schema 重建后台任务——首扫后逐实体入队统一调度器(非交互
// 优先级),冷构建发生在后台;交互查询只命中已热缓存;取消即刻止步。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  workspace.textDocuments = [];
  workspace.workspaceFolders = originalFolders;
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(entityNames: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch6-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    `<root>\n${entityNames.map(name => `  <${name}/>`).join('\n')}\n</root>\n`, 'utf8');
  for (const name of entityNames) {
    fs.writeFileSync(path.join(root, 'scripts/entity_defs', `${name}.def`), [
      '<root>',
      '  <Properties>',
      '    <value>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </value>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  }
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return root;
}

describe('IDE-SCH-006:schema 重建后台任务', () => {
  it('预热完成后缓存就位:交互查询直接命中(同一对象,不再付冷构建)', async () => {
    const root = makeWorkspace(['Gold', 'Silver']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    clearDatabaseSchemaCacheForTests();
    const scheduler = new IndexScheduler();
    try {
      const handle = scheduleBackgroundSchemaWarmup(scheduler, root, ['Gold', 'Silver']);
      const built = await handle.wait;
      expect(built).toBe(2);
      expect(handle.builtCount()).toBe(2);
      expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);

      const missesBefore = getDatabaseSchemaCacheStatsForTests().misses;
      const snapshot = getDatabaseSchemaSnapshot('Gold', root);
      expect(snapshot).not.toBeNull();
      expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(missesBefore); // 命中,零重建
      expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(1);
    } finally {
      scheduler.dispose();
    }
  });

  it('取消即刻止步:闸门挂起时取消,后续实体不再构建(分块可响应)', async () => {
    const root = makeWorkspace(['Gold', 'Silver', 'Bronze']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    clearDatabaseSchemaCacheForTests();
    const scheduler = new IndexScheduler();
    try {
      let gate: (() => void) | null = null;
      let seenFirst = false;
      const handle = scheduleBackgroundSchemaWarmup(scheduler, root, ['Gold', 'Silver', 'Bronze'], {
        beforeBuild: async entityName => {
          if (entityName === 'Gold' && !seenFirst) {
            seenFirst = true;
            await new Promise<void>(resolve => { gate = resolve; });
          }
        }
      });
      // Gold 任务挂在闸门上:此刻取消 → Gold 不构建,排队中的 Silver/Bronze 全撤
      await new Promise(resolve => setImmediate(resolve));
      handle.cancel();
      expect(gate).not.toBeNull();
      (gate as () => void)();
      const built = await handle.wait;
      expect(built).toBe(0); // 闸门期间取消:未产出任何新快照
      expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });

  it('后台预热受交互限流:编辑高峰让路,交互任务不被冷构建阻塞', async () => {
    const root = makeWorkspace(['Gold']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    clearDatabaseSchemaCacheForTests();
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 10_000 });
    try {
      // 交互任务先跑一次 → 冷却窗打开(窗内后台任务不上主线程)
      await scheduler.enqueue({
        kind: 'single-file-update',
        priority: IndexTaskPriority.CurrentFileLight,
        run: async () => undefined
      }).wait;

      const handle = scheduleBackgroundSchemaWarmup(scheduler, root, ['Gold']);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(handle.builtCount()).toBe(0); // 冷却窗内:零冷构建上主线程
      const status = scheduler.getStatus();
      expect(status.queuedByPriority[IndexTaskPriority.NonInteractive]).toBeGreaterThanOrEqual(1);

      // 窗内再来交互任务:即刻执行,不等预热
      const interactiveDone: string[] = [];
      await scheduler.enqueue({
        kind: 'single-file-update',
        priority: IndexTaskPriority.CurrentFileLight,
        run: async () => { interactiveDone.push('interactive'); }
      }).wait;
      expect(interactiveDone).toEqual(['interactive']);

      handle.cancel();
      expect(await handle.wait).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });

  it('句柄 cancel 幂等:重复取消不炸,运行中任务过闸后不再构建', async () => {
    const root = makeWorkspace(['Gold']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    clearDatabaseSchemaCacheForTests();
    const scheduler = new IndexScheduler();
    try {
      let releaseGate: (() => void) | null = null;
      const handle = scheduleBackgroundSchemaWarmup(scheduler, root, ['Gold'], {
        beforeBuild: async () => { await new Promise<void>(resolve => { releaseGate = resolve; }); }
      });
      await new Promise(resolve => setImmediate(resolve)); // Gold 已在跑(挂闸)
      handle.cancel('first');
      handle.cancel('second'); // 幂等
      (releaseGate as () => void)(); // 放行:过闸后见取消旗标,不构建
      expect(await handle.wait).toBe(0);
      expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });
});
