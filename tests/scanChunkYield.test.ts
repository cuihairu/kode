import { describe, expect, it } from 'vitest';

import {
  SCAN_CHUNK_SIZE,
  SCAN_INTERACTIVE_COOLDOWN_MS,
  scanChunkYieldDelayMs
} from '../src/backend/pythonClassIndex';

// ENGINE-LIB-SCAN-005 刀4:全扫分块 16→4 + 块前交互冷却让路。
//   - 让路判定=纯函数(时钟读点在调用方),与 kodeCoreCorpusMirror
//     defaultMirrorYield / indexScheduler DEFAULT_INTERACTIVE_COOLDOWN_MS
//     同一 50ms 口径;
//   - 信标陈旧/时钟异常(负差)不让路;窗内按剩余时长让。
// (块大小与让路的行为集成在 scheduler 满载面已有门禁,此处锁契约常量。)

describe('scan chunk yield(ENGINE-LIB-SCAN-005 刀4)', () => {
  it('常量契约:块 4 文件,冷却窗 50ms(与调度器单一口径)', () => {
    expect(SCAN_CHUNK_SIZE).toBe(4);
    expect(SCAN_INTERACTIVE_COOLDOWN_MS).toBe(50);
  });

  it('信标刚刷新:按窗内剩余时长让路', () => {
    expect(scanChunkYieldDelayMs(10_020, 10_000)).toBe(30);
    expect(scanChunkYieldDelayMs(10_049, 10_000)).toBe(1);
  });

  it('信标陈旧(出窗)不让路;时钟异常(负差)不让路', () => {
    expect(scanChunkYieldDelayMs(10_050, 10_000)).toBe(0);
    expect(scanChunkYieldDelayMs(10_500, 10_000)).toBe(0);
    expect(scanChunkYieldDelayMs(10_000, 10_020)).toBe(0);
  });
});
