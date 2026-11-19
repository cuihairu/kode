import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  clearIndexLogRecentLines,
  getIndexLogRecentLines,
  INDEX_LOG_CHANNEL_NAME,
  indexLog,
  setIndexLogClockForTests
} from '../src/backend/indexLog';
import { clearRecentJumpLogs, jumpLog, setJumpLogEnabled } from '../src/navigationLog';
import { IndexScheduler } from '../src/backend/indexScheduler';
import { EntityMappingManager } from '../src/entityMapping';
import { setScanStageProgressClockForTests } from '../src/backend/scanStageProgress';
import { windowState, workspace as stubWorkspace } from './helpers/vscodeStub';

// WARM-VISIBILITY-004 刀 B:统一「KBEngine Index」输出通道。
//   - 常开(无开关,Navigation 静默教训);四源标签 + 相对时间戳;
//   - 镜像面:def 全量索引完成/慢文件两条事实行与 Navigation 一对一;
//   - 决策路径流量(jumpLog debug/决策行)不进本通道;
//   - 测试桩按通道名入账(windowState.channels),与 navigationLog 同基建。

const channelLines = (): string[] => {
  const channel = windowState.channels.find(entry => entry.name === INDEX_LOG_CHANNEL_NAME);
  return (channel ? channel.lines.slice() : []).map(line => line.replace(/\n$/, ''));
};

const countIn = (lines: string[], needle: string): number =>
  lines.filter(line => line.includes(needle)).length;

afterEach(() => {
  setIndexLogClockForTests(null);
  setScanStageProgressClockForTests(null);
  setJumpLogEnabled(false);
  clearRecentJumpLogs();
  clearIndexLogRecentLines();
  // 通道对象被模块缓存跨用例持有:行账本就地清空,防跨用例残留
  for (const name of [INDEX_LOG_CHANNEL_NAME, 'KBEngine Navigation']) {
    const entry = windowState.channels.find(channel => channel.name === name);
    if (entry) { entry.lines.length = 0; }
  }
});

describe('indexLog 通道行为', () => {
  it('常开通道:行格式 = 相对时间戳 + 源标签 + 文本;通道按名入账', () => {
    let clock = 10_000;
    setIndexLogClockForTests(() => clock);
    indexLog('discovery', 'def 首扫开始:3 个 .def');
    clock = 11_500;
    indexLog('event-index', '事件/方法索引首扫开始:12 个 .py');
    const lines = channelLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[+0.0s][kode-index][discovery] def 首扫开始:3 个 .def');
    expect(lines[1]).toBe('[+1.5s][kode-index][event-index] 事件/方法索引首扫开始:12 个 .py');
    // 环形缓冲与通道行同序同文(取证口径与 Navigation recent 一致)
    expect(getIndexLogRecentLines().slice(-2)).toEqual(lines);
  });

  it('惰性消息与决策路径隔离:jumpLog 行永不进 Index 通道', () => {
    setJumpLogEnabled(true);
    indexLog('python-index', () => 'py 全仓索引完成 5 个文件');
    jumpLog('debug', '决策路径细节 hover→def Hero');
    const index = channelLines();
    expect(index).toHaveLength(1);
    expect(index[0]).toContain('py 全仓索引完成');
    // 决策路径只在 Navigation 通道,一对一镜像面不含它
    const navigation = windowState.channels.find(entry => entry.name === 'KBEngine Navigation');
    expect(navigation?.lines.join('')).toContain('决策路径细节');
  });
});

describe('发现链镜像(WARM-VISIBILITY-004 刀 B 集成面)', () => {
  let root = '';
  const originalFindFiles = stubWorkspace.findFiles;
  const originalCreateWatcher = stubWorkspace.createFileSystemWatcher;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-indexlog-'));
    stubWorkspace.workspaceFolders = [
      { uri: { fsPath: root } as never, name: 'indexlog', index: 0 }
    ];
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    const defPaths = Array.from({ length: 3 }, (_, i) => {
      const file = path.join(defDir, `Log${i}.def`);
      fs.writeFileSync(file, ['<root>', '  <Properties>', '  </Properties>', '</root>'].join('\n'), 'utf8');
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

  it('jumpLog 开:完成行 Navigation/Index 一对一;关:Index 照出(常开红线)', async () => {
    // 轮 1:jumpLog 开
    setJumpLogEnabled(true);
    let scheduler = new IndexScheduler({ interactiveCooldownMs: 0 });
    let manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler, { deferStartup: true });
    await manager.waitForInitialScan();
    manager.dispose();
    const navOn = windowState.channels.find(entry => entry.name === 'KBEngine Navigation')?.lines ?? [];
    const idxOn = channelLines();
    expect(countIn(navOn, 'def 全量索引完成')).toBe(1);
    expect(countIn(idxOn, 'def 全量索引完成')).toBe(1);
    expect(countIn(idxOn, 'def 首扫开始:3 个 .def')).toBe(1);

    // 轮 2:jumpLog 关(默认态)——Navigation 静默,Index 照出。
    // (通道对象在两轮间被同一模块缓存持有,不重置账本,按增量断言)
    const navBefore = (windowState.channels.find(entry => entry.name === 'KBEngine Navigation')?.lines ?? []).length;
    const idxBefore = channelLines().length;
    setJumpLogEnabled(false);
    scheduler = new IndexScheduler({ interactiveCooldownMs: 0 });
    manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler, { deferStartup: true });
    await manager.waitForInitialScan();
    manager.dispose();
    const navAfter = windowState.channels.find(entry => entry.name === 'KBEngine Navigation')?.lines ?? [];
    const idxAfter = channelLines();
    // Navigation 零新增(jumpLog 关:连完成行都不出)
    expect(navAfter.length).toBe(navBefore);
    // Index 通道照出(常开红线):起扫 + 完成各一
    expect(countIn(idxAfter.slice(idxBefore), 'def 首扫开始:3 个 .def')).toBe(1);
    expect(countIn(idxAfter.slice(idxBefore), 'def 全量索引完成')).toBe(1);
  });
});
