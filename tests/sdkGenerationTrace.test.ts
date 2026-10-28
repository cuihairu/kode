import { describe, expect, it } from 'vitest';
import {
  formatSdkEngineTraceLines,
  makeSdkEngineTrace
} from '../src/sdkGenerationTrace';

// IDE-SDK-004 为 SDK 输出记录引擎版本与提交:生成物头部可追溯输入引擎
// (版本宏+git 提交,探测面=readEngineApiMetadata 现有面);探测不到时
// 写 unknown 字面量,不猜不空缺。

describe('makeSdkEngineTrace(trace 归一)', () => {
  it('完整 metadata → 原值透传', () => {
    expect(makeSdkEngineTrace({ version: '2.5.10', commit: 'f85ad81' })).toEqual({
      engineVersion: '2.5.10',
      engineCommit: 'f85ad81'
    });
  });

  it('metadata 为 null → 全 unknown', () => {
    expect(makeSdkEngineTrace(null)).toEqual({ engineVersion: 'unknown', engineCommit: 'unknown' });
  });

  it('字段空串 → 该字段 unknown(不产空行)', () => {
    expect(makeSdkEngineTrace({ version: '', commit: 'f85ad81' })).toEqual({
      engineVersion: 'unknown',
      engineCommit: 'f85ad81'
    });
    expect(makeSdkEngineTrace({ version: '2.5.10', commit: '' })).toEqual({
      engineVersion: '2.5.10',
      engineCommit: 'unknown'
    });
  });
});

describe('formatSdkEngineTraceLines(生成物头部的引擎行)', () => {
  it('版本与提交各一行,带注释前缀', () => {
    const lines = formatSdkEngineTraceLines({ engineVersion: '2.5.10', engineCommit: 'f85ad81' });
    expect(lines).toEqual(['// 引擎版本: 2.5.10', '// 引擎提交: f85ad81']);
  });

  it('探测不到 → 两行都写 unknown 字面量', () => {
    const lines = formatSdkEngineTraceLines({ engineVersion: 'unknown', engineCommit: 'unknown' });
    expect(lines).toEqual(['// 引擎版本: unknown', '// 引擎提交: unknown']);
  });
});
