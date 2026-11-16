import { describe, expect, it } from 'vitest';
import { KBE_SYMBOLS } from '../src/kbeModuleIndex';
import { UNKNOWN_ENGINE_VALUE, type EngineApiMetadata } from '../src/backend/engineApiMetadata';
import {
  buildEngineProfileReport,
  classifyEngineVersion,
  countEngineFeatures,
  describeClassification,
  renderEngineProfileReport
} from '../src/backend/engineProfile';

// RUST-173 Engine profile:官方版本/分类(fork·custom 不猜)/版本宏探测/
// git commit+describe/KB-VER-002 特性分层聚合,unknown 不伪造;渲染双语。

const metadata = (overrides: Partial<EngineApiMetadata> = {}): EngineApiMetadata => ({
  version: '2.5.10',
  commit: 'abc123',
  describe: 'v2.5.10-dirty',
  ...overrides
});

describe('classifyEngineVersion(RUST-173)', () => {
  it('官方预设命中 → official;fork- 前缀(大小写不敏感)→ fork', () => {
    expect(classifyEngineVersion('3.7.3')).toBe('official');
    expect(classifyEngineVersion('2.5.10')).toBe('official');
    expect(classifyEngineVersion('fork-3.12')).toBe('fork');
    expect(classifyEngineVersion('FORK-x')).toBe('fork');
  });

  it('自由串 → custom:不猜是官方旧版还是魔改 fork(与 fork 前缀口径对齐)', () => {
    expect(classifyEngineVersion('v9.9-custom')).toBe('custom');
    expect(classifyEngineVersion('2.5.9')).toBe('custom');
  });

  it('非字符串/空串经 normalize 回落默认 3.7.3 → official', () => {
    expect(classifyEngineVersion('  ')).toBe('official');
  });
});

describe('countEngineFeatures(RUST-173)', () => {
  it('三档聚合;undefined 归 baseline(与 engineApiVersionAnnotation 口径一致)', () => {
    const counts = countEngineFeatures([
      { version: undefined },
      { version: 'baseline' },
      { version: 'fork' },
      { version: 'pending' },
      { version: 'fork' }
    ]);
    expect(counts).toEqual({ baseline: 2, fork: 2, pending: 1 });
  });

  it('缺省策展表:三档之和=KBE_SYMBOLS 总数(策展子集如实计数)', () => {
    const counts = countEngineFeatures();
    expect(counts.baseline + counts.fork + counts.pending).toBe(KBE_SYMBOLS.length);
    expect(counts.baseline).toBeGreaterThan(0);
  });
});

describe('buildEngineProfileReport(RUST-173)', () => {
  it('全 unknown metadata → detected/commit/describe null(不伪造);分类与分层照常', () => {
    const report = buildEngineProfileReport({
      settingVersion: '3.7.3',
      metadata: metadata({
        version: UNKNOWN_ENGINE_VALUE,
        commit: UNKNOWN_ENGINE_VALUE,
        describe: UNKNOWN_ENGINE_VALUE
      }),
      symbols: [{ version: 'fork' }]
    });
    expect(report.detectedVersion).toBeNull();
    expect(report.commit).toBeNull();
    expect(report.describe).toBeNull();
    expect(report.presetLabel).toContain('3.7.3');
    expect(report.classification).toBe('official');
    expect(report.featureCounts).toEqual({ baseline: 0, fork: 1, pending: 0 });
    // 官方基线下 fork 档符号带「需 fork」标注
    expect(report.forkLayerAnnotated).toBe(true);
  });

  it('探测命中 → 三字段如实透传;fork- 设置 → forkLayerAnnotated 关', () => {
    const report = buildEngineProfileReport({
      settingVersion: 'fork-3.12',
      metadata: metadata(),
      symbols: []
    });
    expect(report.detectedVersion).toBe('2.5.10');
    expect(report.commit).toBe('abc123');
    expect(report.describe).toBe('v2.5.10-dirty');
    expect(report.classification).toBe('fork');
    expect(report.presetLabel).toContain('Fork');
    expect(report.forkLayerAnnotated).toBe(false);
  });

  it('自由串设置 → presetLabel null + custom(不猜)', () => {
    const report = buildEngineProfileReport({ settingVersion: 'v9.9', metadata: metadata() });
    expect(report.presetLabel).toBeNull();
    expect(report.classification).toBe('custom');
    expect(report.settingVersion).toBe('v9.9');
  });
});

describe('renderEngineProfileReport(RUST-173)', () => {
  it('unknown 面如实写「未探测到/未知」,绝不占位编造', () => {
    const text = renderEngineProfileReport(buildEngineProfileReport({
      settingVersion: 'v9.9',
      metadata: metadata({
        version: UNKNOWN_ENGINE_VALUE,
        commit: UNKNOWN_ENGINE_VALUE,
        describe: UNKNOWN_ENGINE_VALUE
      })
    }));
    expect(text).toContain('v9.9');
    expect(text).toContain('custom version');
    expect(text).toContain('version marker not detected');
    expect(text).toContain('commit unknown');
    expect(text).toContain('describe unknown');
  });

  it('中文语境:探测/commit/分层/标注各行中文呈现', () => {
    const text = renderEngineProfileReport(buildEngineProfileReport({
      settingVersion: 'fork-3.12',
      metadata: metadata()
    }), 'zh-CN');
    expect(text).toContain('KBEngine 引擎档案');
    expect(text).toContain('探测到的版本标记: 2.5.10');
    expect(text).toContain('commit: abc123');
    expect(text).toContain('fork 层标注：关闭');
  });

  it('describeClassification 双语三档', () => {
    expect(describeClassification('official', 'zh-CN')).toContain('官方预设');
    expect(describeClassification('fork')).toContain('fork- prefix');
    expect(describeClassification('custom', 'zh-CN')).toContain('不猜');
  });
});
