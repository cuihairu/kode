/**
 * KSEM-CFG-04 配置键与枚举补全(纯核心)。
 *
 * 面分组:上下文解析三态(标签名补全/元素文本取值/属性区无建议)/注释
 * 掩码偏移稳定 / 父路径限定键建议(根层/段内/去重/详情挂契约证据)/
 * 值建议诚实面(枚举逐值/Boolean 注解 true/false/其余类型空)/真夹具
 * (942 行 defaults)全量直跑。零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import { SERVER_CONFIG_ITEM_DOCS } from '../src/backend/serverConfigCatalog';
import { extractConfigContracts } from '../src/backend/configContract';
import { scanConfigFieldIdentities } from '../src/backend/configFieldIdentity';
import {
  parseConfigCompletionContext,
  suggestConfigKeys,
  suggestConfigValues,
  provideConfigCompletions,
} from '../src/backend/configCompletion';
import type { ConfigXmlNode } from '../src/serverConfigMerge';

const fixtureXml = readFileSync(
  path.resolve(__dirname, '..', 'tests/fixtures/config/kbengine_defaults.xml'),
  'utf8',
);
const tree = parseConfigXml(fixtureXml) as ConfigXmlNode;
const catalogSources: Record<string, string> = {};
for (const [key, doc] of Object.entries(SERVER_CONFIG_ITEM_DOCS)) {
  catalogSources[key] = doc.source;
}
const extraction = extractConfigContracts(fixtureXml, tree, catalogSources);
const scan = scanConfigFieldIdentities(tree, null);

const offsetOf = (text: string, marker: string): number => {
  const index = text.indexOf(marker);
  expect(index, `marker ${marker} not found`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('KSEM-CFG-04 config completion', () => {
  it('context parse: after "<" with a partial tag name is key completion', () => {
    const text = '<root>\n\t<trace_packet>\n\t\t<de';
    const context = parseConfigCompletionContext(text, text.length);
    expect(context.parentPath).toBe('trace_packet');
    expect(context.tagPrefix).toBe('de');
    expect(context.valuePath).toBeNull();
    expect(context.prefix).toBe('de');
  });

  it('context parse: inside element text is value completion for that element', () => {
    const text = '<root><trace_packet><debug_type>';
    const context = parseConfigCompletionContext(text, text.length);
    expect(context.parentPath).toBe('trace_packet.debug_type');
    expect(context.tagPrefix).toBeNull();
    expect(context.valuePath).toBe('trace_packet.debug_type');
  });

  it('context parse: attribute region yields no suggestions (honest empty)', () => {
    const text = '<root><trace_packet x="1"';
    const context = parseConfigCompletionContext(text, text.length);
    expect(context.tagPrefix).toBeNull();
    expect(context.valuePath).toBeNull();
    expect(context.prefix).toBe('');
  });

  it('context parse: comment masking keeps offsets stable', () => {
    const text = '<root>\n<!-- <debug_type> fake tag -->\n<trace_packet>\n\t\t<de';
    const context = parseConfigCompletionContext(text, text.length);
    expect(context.parentPath).toBe('trace_packet');
    expect(context.tagPrefix).toBe('de');
  });

  it('context parse: sibling close tags pop the stack correctly', () => {
    const text = '<root><a><b>1</b></a><c>';
    const context = parseConfigCompletionContext(text, text.length);
    expect(context.parentPath).toBe('c');
    expect(context.valuePath).toBe('c');
  });

  it('key suggestions are limited to exactly one more segment under the parent path', () => {
    const items = suggestConfigKeys(scan, extraction, 'trace_packet', '');
    const labels = items.map((item) => item.label);
    expect(labels).toContain('debug_type');
    expect(labels).toContain('disables');
    // 子孙不得越级出现
    expect(labels.every((label) => !label.includes('.'))).toBe(true);
  });

  it('root-level key suggestions include top sections and top leaves', () => {
    const labels = suggestConfigKeys(scan, extraction, '', '').map((item) => item.label);
    expect(labels).toContain('gameUpdateHertz');
    expect(labels).toContain('trace_packet');
    expect(labels).toContain('channelCommon');
    // 根层只建议一段键:子孙路径不得越级出现(父路径限定)
    expect(labels.every((label) => !label.includes('.'))).toBe(true);
  });

  it('key suggestions are deduped and prefix-filtered case-insensitively', () => {
    const all = suggestConfigKeys(scan, extraction, '', '');
    const unique = new Set(all.map((item) => item.label));
    expect(unique.size).toBe(all.length);
    const filtered = suggestConfigKeys(scan, extraction, '', 'GAMEUPDATE');
    expect(filtered.map((item) => item.label)).toEqual(['gameUpdateHertz']);
  });

  it('key detail carries contract evidence (enum record vs plain section)', () => {
    const items = suggestConfigKeys(scan, extraction, 'trace_packet', '');
    const debugType = items.find((item) => item.label === 'debug_type');
    expect(debugType!.detail).toContain('enum');
    // disables 是 CFG-02 list 记录(<item> 重复),详情带 list 面;
    // 纯容器段(trace_packet 自身)无 CFG-02 记录,才是 section
    const disables = items.find((item) => item.label === 'disables');
    expect(disables!.detail).toContain('list');
    const tracePacket = suggestConfigKeys(scan, extraction, '', '')
      .find((item) => item.label === 'channelCommon');
    expect(tracePacket!.detail).toBe('section');
  });

  it('value suggestions: enum contracts give every value with its meaning', () => {
    const items = suggestConfigValues(extraction, 'trace_packet.debug_type', '');
    expect(items.map((item) => item.label)).toEqual(['0', '1', '2', '3']);
    expect(items[0].kind).toBe('enum-value');
    expect(items[0].detail).toContain('Not output');
    expect(suggestConfigValues(extraction, 'publish.state', '')).toHaveLength(2);
  });

  it('value suggestions: boolean annotation gives exactly true/false', () => {
    const booleanPath = extraction.records.find(
      (record) => record.evidence === 'defaults-type-annotation' && record.valueKind === 'boolean',
    );
    expect(booleanPath).toBeDefined();
    const items = suggestConfigValues(extraction, booleanPath!.path, '');
    expect(items.map((item) => item.label)).toEqual(['true', 'false']);
  });

  it('value suggestions: value-only candidates stay empty (no default echo, no guessing)', () => {
    const items = suggestConfigValues(extraction, 'gameUpdateHertz', '');
    expect(items).toEqual([]);
    expect(suggestConfigValues(extraction, 'no.such.key', '')).toEqual([]);
  });

  it('entry provideConfigCompletions routes tag vs value contexts', () => {
    const keyText = '<root><trace_packet>\n\t\t<de';
    const keyItems = provideConfigCompletions(keyText, keyText.length, scan, extraction);
    expect(keyItems.some((item) => item.label === 'debug_type')).toBe(true);
    const valueText = '<root><trace_packet><debug_type>';
    const valueItems = provideConfigCompletions(valueText, valueText.length, scan, extraction);
    expect(valueItems.map((item) => item.label)).toEqual(['0', '1', '2', '3']);
    const attrText = '<root><trace_packet x=';
    expect(provideConfigCompletions(attrText, attrText.length, scan, extraction)).toEqual([]);
  });

  it('prefix filtering applies to value suggestions too', () => {
    expect(
      suggestConfigValues(extraction, 'trace_packet.debug_type', '1').map((item) => item.label),
    ).toEqual(['1']);
  });

  it('offset of a real fixture position resolves through comments (offset stability on real file)', () => {
    // 开标签内(标签名后未闭合):父路径=trace_packet,标签补全态
    const openMarker = '\t\t<debug_type>';
    const openOffset = offsetOf(fixtureXml, openMarker) + openMarker.length - 3;
    const openContext = parseConfigCompletionContext(fixtureXml, openOffset);
    expect(openContext.parentPath).toBe('trace_packet');
    expect(openContext.tagPrefix).not.toBeNull();
    // 标签闭合后下一个字符:取值态,valuePath=完整路径
    const offset = offsetOf(fixtureXml, openMarker) + openMarker.length + 1;
    const context = parseConfigCompletionContext(fixtureXml, offset);
    expect(context.parentPath).toBe('trace_packet.debug_type');
    expect(context.valuePath).toBe('trace_packet.debug_type');
  });
});
