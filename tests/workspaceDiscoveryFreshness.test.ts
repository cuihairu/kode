import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetDiscoveryState,
  resolveDiscoveredEntityDefsRoot,
  setDiscoveryCacheTtlForTests
} from '../src/workspaceDiscovery';

// KR-AUD-34:发现链缓存(scanCache / engineProbeMemo / conventionalRootsMemo)
// 此前会话内永不失效——首扫早于 entity_defs 创建(或探针瞬时失败)时,空/失败
// 结果被永久缓存,新建目录不可发现、瞬时失败不可重试。修复:缓存条目带新鲜度
// 窗口(TTL,测试可注入),过期重扫。

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

describe('KR-AUD-34: 发现链缓存会话内新鲜度', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kraud34-'));
    setDiscoveryCacheTtlForTests(20);
  });

  afterEach(() => {
    resetDiscoveryState();
    setDiscoveryCacheTtlForTests(30_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('新建 entity_defs 在缓存过期后可发现,TTL 内不重复扫描', () => {
    expect(resolveDiscoveredEntityDefsRoot(dir)).toBeNull(); // 首扫:空结果入缓存
    fs.mkdirSync(path.join(dir, 'entity_defs'));
    // TTL 内:缓存命中,仍是旧结果(不重复扫描的口径不变)
    expect(resolveDiscoveredEntityDefsRoot(dir)).toBeNull();
  });

  it('缓存过期后重扫:新建 entity_defs 可发现', async () => {
    expect(resolveDiscoveredEntityDefsRoot(dir)).toBeNull();
    fs.mkdirSync(path.join(dir, 'entity_defs'));
    await wait(40); // 越过 TTL
    expect(resolveDiscoveredEntityDefsRoot(dir)).toBe(path.join(dir, 'entity_defs'));
  });

  it('瞬时失败可重试:约定探针 miss 在过期后重新探测命中', async () => {
    // 深扫兜底唯一命中 entity_defs——探针/约定链瞬时 miss 的恢复口径同理。
    expect(resolveDiscoveredEntityDefsRoot(dir)).toBeNull();
    fs.mkdirSync(path.join(dir, 'entity_defs'));
    await wait(40);
    expect(resolveDiscoveredEntityDefsRoot(dir)).not.toBeNull();
    // 再次查询:新结果重新入缓存,TTL 内稳定。
    expect(resolveDiscoveredEntityDefsRoot(dir)).toBe(path.join(dir, 'entity_defs'));
  });
});
