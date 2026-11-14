/**
 * KSEM-CFG-02 配置权威契约提取(纯核心)。
 *
 * 面分组:全量提取与版本基线 / 类型注解面(Type: X 48 处)/ 枚举组
 * (匿名组 publish.state + 父段具名组 trace_packet.debug_type)/ 可重复
 * 节点(<item>)/ 单位面(秒/bit)/ 单值非枚举诚实 / 仅默认值候选非约束 /
 * 目录取证升档(serverconfig.cpp)/ 不猜的面(unproven 恒含 range、
 * dynamicKeys 恒 false)/ 统计一致性。真夹具 tests/fixtures/config/
 * kbengine_defaults.xml(942 行引擎字节镜像)全量直跑,零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import { SERVER_CONFIG_ITEM_DOCS } from '../src/backend/serverConfigCatalog';
import {
  extractConfigContracts,
  contractRecordByPath,
  enumGroupsFromComments,
} from '../src/backend/configContract';

const fixturePath = path.resolve(__dirname, '..', 'tests/fixtures/config/kbengine_defaults.xml');
const fixtureXml = readFileSync(fixturePath, 'utf8');
const tree = parseConfigXml(fixtureXml);
if (tree === null) {
  throw new Error('fixture defaults XML must parse');
}
const catalogSources: Record<string, string> = {};
for (const [key, doc] of Object.entries(SERVER_CONFIG_ITEM_DOCS)) {
  catalogSources[key] = doc.source;
}
const extraction = extractConfigContracts(fixtureXml, tree, catalogSources);

describe('KSEM-CFG-02 config contract extraction', () => {
  it('extracts the full defaults tree with pinned baseline', () => {
    // 189=夹具字节镜像的叶子+<item> 列表节点数(钉死漂移闸)
    expect(extraction.records.length).toBe(189);
    expect(extraction.baseline.lineCount).toBe(942);
    expect(extraction.baseline.file).toContain('kbengine_defaults.xml');
    expect(extraction.baseline.note).toContain('快照钉死');
    expect(extraction.baseline.note).toContain('since-version');
    for (const record of extraction.records) {
      expect(record.path.length).toBeGreaterThan(0);
      expect(record.path.startsWith('root.')).toBe(false);
    }
  });

  it('type annotations become typed records (not candidates)', () => {
    // 48 处 'Type:' 文本中,部分在容器注释里随枚举组优先(publish.state 等)
    expect(extraction.stats.typed).toBeGreaterThanOrEqual(35);
    const bits = contractRecordByPath(extraction, 'bitsPerSecondToClient');
    expect(bits).toBeDefined();
    expect(bits!.valueKind).toBe('integer');
    expect(bits!.evidence).toBe('defaults-type-annotation');
    expect(bits!.valueOnlyCandidate).toBe(false);
  });

  it('anonymous enum group attaches to its own element (publish.state)', () => {
    const state = contractRecordByPath(extraction, 'publish.state');
    expect(state).toBeDefined();
    expect(state!.valueKind).toBe('enum');
    expect(state!.evidence).toBe('defaults-enum-comment');
    expect(state!.enumValues.map((v) => `${v.value}=${v.meaning}`)).toEqual([
      '0=debug',
      '1=release',
    ]);
  });

  it('parent-section named enum group propagates to the child leaf (trace_packet.debug_type)', () => {
    const debugType = contractRecordByPath(extraction, 'trace_packet.debug_type');
    expect(debugType).toBeDefined();
    expect(debugType!.valueKind).toBe('enum');
    expect(debugType!.source).toContain('父段注释枚举块');
    expect(debugType!.source).toContain('目录取证');
    expect(debugType!.enumValues.length).toBe(4);
    expect(debugType!.enumValues[0]).toEqual({ value: '0', meaning: expect.stringContaining('Not output') });
  });

  it('repeatable <item> nodes are recorded as list contracts', () => {
    const disables = contractRecordByPath(extraction, 'trace_packet.disables');
    expect(disables).toBeDefined();
    expect(disables!.repeatable).toBe(true);
    expect(disables!.valueKind).toBe('list');
    expect(extraction.stats.repeatableNodes).toBeGreaterThanOrEqual(1);
  });

  it('units named by comments are recorded; pure numbers in parens are not units', () => {
    const shutdown = contractRecordByPath(extraction, 'shutdown_time');
    expect(shutdown).toBeDefined();
    expect(shutdown!.unit).not.toBeNull();
    expect(shutdown!.unit).toContain('秒');
    expect(extraction.stats.unitsNamed).toBeGreaterThanOrEqual(1);
    for (const record of extraction.records) {
      if (record.unit !== null) {
        expect(record.unit).not.toMatch(/^\(?\d+\)?$/);
      }
    }
  });

  it('a single value-hint line is NOT promoted to an enum', () => {
    const congestion = contractRecordByPath(extraction, 'channelCommon.reliableUDP.congestionControl');
    expect(congestion).toBeDefined();
    expect(congestion!.valueKind).not.toBe('enum');
    expect(congestion!.enumValues.length).toBe(0);
  });

  it('enum group parser faces: header-less prose closes groups; <2 values dropped', () => {
    expect(enumGroupsFromComments('debug_type:\n0: a\n1: b\nuse_logfile:\nprose line\n2: c')).toEqual([
      { header: 'debug_type', values: [{ value: '0', meaning: 'a' }, { value: '1', meaning: 'b' }] },
    ]);
    expect(enumGroupsFromComments('only:\n0: single value')).toEqual([]);
  });

  it('default-value-only shapes stay candidates and never claim constraints', () => {
    const hertz = contractRecordByPath(extraction, 'gameUpdateHertz');
    expect(hertz).toBeDefined();
    expect(hertz!.valueKind).toBe('integer');
    expect(hertz!.evidence).toBe('defaults-value-only');
    expect(hertz!.valueOnlyCandidate).toBe(true);
    expect(hertz!.unproven).toContain('type-full-picture');
    expect(extraction.stats.valueOnly).toBeGreaterThan(0);
  });

  it('catalog anchors pointing at engine read sites upgrade evidence', () => {
    expect(extraction.stats.engineReadSite).toBeGreaterThanOrEqual(10);
    const upgraded = extraction.records.filter((r) => r.evidence === 'engine-read-site');
    for (const record of upgraded) {
      expect(record.source).toContain('目录取证:');
      expect(catalogSources[record.path]).toContain('serverconfig.cpp');
    }
  });

  it('nothing is guessed: range unproven everywhere, dynamicKeys never claimed', () => {
    for (const record of extraction.records) {
      expect(record.unproven, record.path).toContain('range');
      expect(record.dynamicKeys).toBe(false);
      expect(record.unproven).toContain('dynamicKeys');
    }
    const serialized = JSON.stringify(extraction.records);
    expect(serialized.includes('maxValue')).toBe(false);
    expect(serialized.includes('minValue')).toBe(false);
  });

  it('stats are self-consistent with the records', () => {
    expect(extraction.stats.total).toBe(extraction.records.length);
    expect(extraction.stats.typed).toBe(
      extraction.records.filter((r) => r.evidence === 'defaults-type-annotation').length,
    );
    expect(extraction.stats.enumCommented).toBe(
      extraction.records.filter((r) => r.evidence === 'defaults-enum-comment').length,
    );
    expect(extraction.stats.engineReadSite).toBe(
      extraction.records.filter((r) => r.evidence === 'engine-read-site').length,
    );
    // 证据档位五臂互斥、恰分桶全部记录;valueOnlyCandidate 按候选旗标
    // 独立计数(引擎锚升档保留候选旗标:锚证明读取,不证明类型全貌)
    const primaryBuckets = extraction.records.map((r) => {
      if (r.evidence === 'engine-read-site') { return 'engine'; }
      if (r.evidence === 'defaults-enum-comment') { return 'enum'; }
      if (r.evidence === 'defaults-type-annotation') { return 'typed'; }
      if (r.evidence === 'defaults-value-only') { return 'valueOnly'; }
      return 'list'; // defaults-comment = <item> 可重复节点记录
    });
    const counts = primaryBuckets.reduce<Record<string, number>>((acc, kind) => {
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts.engine).toBe(extraction.stats.engineReadSite);
    expect(counts.enum).toBe(extraction.stats.enumCommented);
    expect(counts.typed).toBe(extraction.stats.typed);
    expect(counts.list).toBe(extraction.stats.repeatableNodes);
    expect(
      counts.engine + counts.enum + counts.typed + counts.valueOnly + counts.list,
    ).toBe(extraction.stats.total);
    // 候选旗标计数(可能含引擎升档记录:旗标保留=类型面仍是单值形态)
    expect(extraction.stats.valueOnly).toBe(
      extraction.records.filter((r) => r.valueOnlyCandidate).length,
    );
    expect(extraction.stats.valueOnly).toBeGreaterThanOrEqual(counts.valueOnly);
  });

  it('contract lookup by path returns undefined for unknown keys', () => {
    expect(contractRecordByPath(extraction, 'no.such.key')).toBeUndefined();
  });
});
