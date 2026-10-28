import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDatabaseSchemaCacheForTests,
  flushTypeStorageUsageColdBuildForTests,
  getDatabaseSchemaCacheStatsForTests,
  getTypeStorageUsageIndexReadOnly,
  invalidateTypeStorageUsageIndex,
  onTypeStorageUsageIndexPublished,
  setTypeStorageUsageBackgroundDispatcher
} from '../src/databaseSchema';

// 2026-10-28 审核整改(SCH-009 冷路径):getTypeStorageUsageIndexReadOnly 的
// 冷读不再在交互线程整仓构建——本次只回空表并派发后台一次构建,同根去重,
// 构建完成后经 onTypeStorageUsageIndexPublished 通知渲染面刷新。

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setTypeStorageUsageBackgroundDispatcher(null);
  await flushTypeStorageUsageColdBuildForTests();
  invalidateTypeStorageUsageIndex();
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch9c-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    '<root>\n  <Gold/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Properties>',
    '    <coin>',
    '      <Type>ITEM_ID</Type>',
    '      <Persistent>true</Persistent>',
    '    </coin>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  return root;
}

describe('IDE-SCH-009:用法索引冷路径后台化', () => {
  it('冷读返回空表且交互线程零快照探测,后台构建完成后可读', async () => {
    const root = makeWorkspace();
    const baseline = getDatabaseSchemaCacheStatsForTests();

    // 冷读:不整仓构建——空表返回,零快照探测(hits/misses 双零增长)
    const cold = getTypeStorageUsageIndexReadOnly(root);
    expect(cold.size).toBe(0);
    const statsAfterColdRead = getDatabaseSchemaCacheStatsForTests();
    expect(statsAfterColdRead.hits).toBe(baseline.hits);
    expect(statsAfterColdRead.misses).toBe(baseline.misses);

    // 后台构建排干后:同根再读即命中聚合(ITEM_ID → Gold.coin)
    await flushTypeStorageUsageColdBuildForTests();
    const warm = getTypeStorageUsageIndexReadOnly(root);
    const itemIdUsages = warm.get('ITEM_ID') || [];
    expect(itemIdUsages.some(usage =>
      usage.entity === 'Gold' && usage.property === 'coin')).toBe(true);
  });

  it('冷构建经注册派发器入队,同根去重,发布回调触发', async () => {
    const root = makeWorkspace();

    // 手动闸派发器:捕获构建体但不执行——证明构建不在冷读栈上发生
    const dispatchedRuns: Array<() => Promise<void>> = [];
    let releaseDispatch: (() => void) | null = null;
    setTypeStorageUsageBackgroundDispatcher(run =>
      new Promise<void>(resolve => {
        dispatchedRuns.push(run);
        releaseDispatch = resolve;
      }));

    const published = vi.fn();
    const unsubscribe = onTypeStorageUsageIndexPublished(published);

    try {
      expect(dispatchedRuns.length).toBe(0);
      const cold = getTypeStorageUsageIndexReadOnly(root);
      expect(cold.size).toBe(0);
      // 派发发生在微任务边界(构建链 .then),不在冷读同步栈上
      await Promise.resolve();
      expect(dispatchedRuns.length).toBe(1);
      // 同根在途去重:第二次冷读不再追加构建
      getTypeStorageUsageIndexReadOnly(root);
      expect(dispatchedRuns.length).toBe(1);
    } finally {
      // 断言失败也要放行构建链,否则模块级链条永久卡死毒化后续测试
      if (dispatchedRuns.length > 0) { await dispatchedRuns[0](); }
      releaseDispatch?.();
    }
    await flushTypeStorageUsageColdBuildForTests();
    await new Promise<void>(resolve => { setImmediate(resolve); }); // 链尾通知落地
    const populated = getTypeStorageUsageIndexReadOnly(root);
    expect((populated.get('ITEM_ID') || []).some(usage =>
      usage.entity === 'Gold' && usage.property === 'coin')).toBe(true);
    expect(published).toHaveBeenCalled();
    unsubscribe();
  });
});
