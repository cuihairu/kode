import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexScheduler } from '../src/backend/indexScheduler';
import { EntityMappingManager } from '../src/entityMapping';
import { setScanStageProgressClockForTests } from '../src/backend/scanStageProgress';
import { workspace as stubWorkspace } from './helpers/vscodeStub';

// WARM-VISIBILITY-004 刀 A:发现链首扫 def 逐文件节流进度。
// waitForInitialScan(onProgress) 注入回调 → performScanEntityMappings 的
// 批扫环经 createScanProgressReporter 节流上报「实体发现链 def N/M」。
// 时钟钉死(断言确定性);25 个真实小 .def 走真实 parseDefFile 链。

const originalFindFiles = stubWorkspace.findFiles;
const originalCreateWatcher = stubWorkspace.createFileSystemWatcher;

describe('EntityMappingManager 首扫进度上报(WARM-VISIBILITY-004 刀 A)', () => {
  let root = '';
  let defPaths: { fsPath: string }[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-def-progress-'));
    stubWorkspace.workspaceFolders = [
      { uri: { fsPath: root } as never, name: 'progress', index: 0 }
    ];
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    defPaths = Array.from({ length: 25 }, (_, i) => {
      const file = path.join(defDir, `Prog${i}.def`);
      fs.writeFileSync(
        file,
        ['<root>', '  <Properties>', '  </Properties>', '</root>'].join('\n'),
        'utf8'
      );
      return { fsPath: file };
    });
    stubWorkspace.findFiles = (async () => defPaths) as unknown as typeof stubWorkspace.findFiles;
  });

  afterAll(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.createFileSystemWatcher = originalCreateWatcher;
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('25 个 def:计数边界 10 报一档(钉死时钟),终报 25/25 收口', async () => {
    setScanStageProgressClockForTests(() => 1000);
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 0 });
    const manager = new EntityMappingManager(
      { subscriptions: [] } as never,
      scheduler,
      { deferStartup: true }
    );
    const details: string[] = [];
    try {
      await manager.waitForInitialScan(detail => { details.push(detail); });
    } finally {
      manager.dispose();
      setScanStageProgressClockForTests(null);
    }
    // 钉死时钟 1000:首报 10/25 放行,20/25 被时间闸拦,终报 25/25 恒发
    expect(details).toEqual(['实体发现链 def 10/25', '实体发现链 def 25/25']);
  });

  it('未注入回调:首扫照常完成,零异常(默认路径无状态栏)', async () => {
    setScanStageProgressClockForTests(() => 1000);
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 0 });
    const manager = new EntityMappingManager(
      { subscriptions: [] } as never,
      scheduler,
      { deferStartup: true }
    );
    try {
      await manager.waitForInitialScan();
      expect(manager.isInitialScanComplete()).toBe(true);
    } finally {
      manager.dispose();
      setScanStageProgressClockForTests(null);
    }
  });
});
