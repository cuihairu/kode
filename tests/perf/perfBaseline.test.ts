import { describe, expect, it } from 'vitest';

// 只 import 纯函数模块,绝不 import v02Baseline.bench(会把整个基线 suite
// 注册进主 unit 门,30k 资产生成+全场景在单测里跑)
import {
  buildBaselineSnapshot,
  serializeBaselineSnapshot,
  type PerfBaselineSnapshot,
  type RecordedMetrics
} from './perfBaseline';

// RUST-028 基线快照面:schema kode-perf-baseline/1,键序=插入序(JSON 文本
// 稳定可 diff),空记录=空 scenarios 诚实出快照(不抛不猜)。

const META = {
  createdAt: '2026-11-15T00:00:00.000Z',
  node: 'v24.21.0',
  platform: 'linux',
  cpus: 14,
  largeFiles: 30000
};

describe('perf 基线快照序列化(RUST-028)', () => {
  it('场景→指标→样本三层结构保序落快照,元数据逐项入档', () => {
    const recorded: RecordedMetrics = new Map([
      [
        'large-30k',
        new Map([
          ['V02.large-30k.warm.hover', { values: [1.5, 2.74], unit: 'ms' }],
          ['V02.large-30k.activation.defScanWall', { values: [370.02], unit: 'ms' }]
        ])
      ],
      ['big-py', new Map([['V02.big-py.warm.hover', { values: [0.02], unit: 'ms' }]])]
    ]);

    const snapshot = buildBaselineSnapshot(recorded, META);
    expect(snapshot.schema).toBe('kode-perf-baseline/1');
    // 场景序与场景内指标序都=插入序
    expect(Object.keys(snapshot.scenarios)).toEqual(['large-30k', 'big-py']);
    expect(Object.keys(snapshot.scenarios['large-30k'])).toEqual([
      'V02.large-30k.warm.hover',
      'V02.large-30k.activation.defScanWall'
    ]);
    expect(snapshot.scenarios['large-30k']['V02.large-30k.warm.hover']).toEqual({
      values: [1.5, 2.74],
      unit: 'ms'
    });
    expect(snapshot.createdAt).toBe('2026-11-15T00:00:00.000Z');
    expect(snapshot.node).toBe('v24.21.0');
    expect(snapshot.platform).toBe('linux');
    expect(snapshot.cpus).toBe(14);
    expect(snapshot.largeFiles).toBe(30000);
  });

  it('空记录=空 scenarios(诚实空快照,不抛不猜)', () => {
    const snapshot = buildBaselineSnapshot(new Map(), META);
    expect(snapshot.scenarios).toEqual({});
    expect(snapshot.schema).toBe('kode-perf-baseline/1');
  });

  it('serialize=缩进 2+尾换行的稳定 JSON 文本,round-trip 保真', () => {
    const snapshot = buildBaselineSnapshot(
      new Map([
        ['s', new Map([['V02.s.m', { values: [1], unit: 'ms' }]])]
      ]),
      META
    );
    const text = serializeBaselineSnapshot(snapshot);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('  "schema": "kode-perf-baseline/1"');
    expect(text).toContain('"largeFiles": 30000');
    const round = JSON.parse(text) as PerfBaselineSnapshot;
    expect(round).toEqual(snapshot);
  });
});
