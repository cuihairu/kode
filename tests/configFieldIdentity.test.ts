/**
 * KSEM-CFG-03 统一配置字段身份(纯核心)。
 *
 * 面分组:身份串四轴合成与解析往返(含动态段 ~ 标记)/ 非良构身份不猜 /
 * 单字段溯源三态(fixed/dynamic-extension/dynamic-segment-child)与覆盖
 * 溯源 / 双树全量对扫统计 / 真夹具(942 行 defaults)固定字段身份。全部
 * 纯函数直查,零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import {
  configFieldIdentity,
  parseConfigFieldIdentity,
  classifyConfigField,
  scanConfigFieldIdentities,
  collectConfigTreePaths,
} from '../src/backend/configFieldIdentity';
import type { ConfigXmlNode } from '../src/serverConfigMerge';

const VERSION = 'kbengine-defaults-942';

const defaultsTree = parseConfigXml(
  '<root><baseapp><archivePeriod>300</archivePeriod></baseapp>'
  + '<trace_packet><debug_type>0</debug_type></trace_packet></root>',
) as ConfigXmlNode;
const customTree = parseConfigXml(
  '<root><baseapp><archivePeriod>600</archivePeriod></baseapp>'
  + '<trace_packet><customFlag>1</customFlag></trace_packet>'
  + '<myservice><host>127.0.0.1</host></myservice></root>',
) as ConfigXmlNode;

describe('KSEM-CFG-03 config field identity', () => {
  it('identity string composes the four axes and round-trips', () => {
    const id = configFieldIdentity({
      root: 'final',
      path: 'trace_packet.debug_type',
      project: 'proj-a',
      version: VERSION,
    });
    expect(id).toBe(`final://proj-a@${VERSION}/trace_packet.debug_type`);
    const parsed = parseConfigFieldIdentity(id);
    expect(parsed).toEqual({
      root: 'final',
      project: 'proj-a',
      version: VERSION,
      path: 'trace_packet.debug_type',
      dynamicSegments: [],
    });
  });

  it('null project serializes to the empty slot and parses back to null', () => {
    const id = configFieldIdentity({
      root: 'defaults',
      path: 'gameUpdateHertz',
      project: null,
      version: VERSION,
    });
    expect(id).toBe(`defaults://@${VERSION}/gameUpdateHertz`);
    const parsed = parseConfigFieldIdentity(id);
    expect(parsed!.project).toBeNull();
    expect(parsed!.root).toBe('defaults');
  });

  it('dynamic segments are marked with ~ and recover on parse', () => {
    const id = configFieldIdentity({
      root: 'final',
      path: 'myservice.host',
      project: 'proj-a',
      version: VERSION,
    }, ['myservice']);
    expect(id).toBe(`final://proj-a@${VERSION}/myservice~.host`);
    const parsed = parseConfigFieldIdentity(id);
    expect(parsed!.path).toBe('myservice.host');
    expect(parsed!.dynamicSegments).toEqual(['myservice']);
  });

  it('malformed identities are rejected, not guessed', () => {
    expect(parseConfigFieldIdentity('bogus://proj-a@v1/a.b')).toBeNull();
    expect(parseConfigFieldIdentity('final://proj-a/a.b')).toBeNull();
    expect(parseConfigFieldIdentity(`final://proj-a@${VERSION}/`)).toBeNull();
    expect(parseConfigFieldIdentity(`final://pro@ja@${VERSION}/a.b`)).toBeNull();
    expect(parseConfigFieldIdentity(`final://proj-a@${VERSION}`)).toBeNull();
  });

  it('marked dynamic segment parse is legitimate (marker round-trips)', () => {
    const parsed = parseConfigFieldIdentity(`final://proj-a@${VERSION}/a~.b`);
    expect(parsed!.path).toBe('a.b');
    expect(parsed!.dynamicSegments).toEqual(['a']);
  });

  it('fixed fields resolve with both-layer provenance and override flag', () => {
    const record = classifyConfigField(defaultsTree, customTree, 'baseapp.archivePeriod');
    expect(record.kind).toBe('fixed');
    expect(record.definedInDefaults).toBe(true);
    expect(record.definedInCustom).toBe(true);
    expect(record.overriddenByCustom).toBe(true);
    expect(record.dynamicSegments).toEqual([]);
  });

  it('custom-only leaf under a known section is a dynamic extension', () => {
    const record = classifyConfigField(defaultsTree, customTree, 'trace_packet.customFlag');
    expect(record.kind).toBe('dynamic-extension');
    expect(record.definedInDefaults).toBe(false);
    expect(record.definedInCustom).toBe(true);
    expect(record.dynamicSegments).toEqual(['customFlag']);
  });

  it('children of a custom-only section are dynamic-segment-child, not new dynamic segments', () => {
    const record = classifyConfigField(defaultsTree, customTree, 'myservice.host');
    expect(record.kind).toBe('dynamic-segment-child');
    // 只有首缺段 myservice 入 dynamicSegments;host 是它的子字段
    expect(record.dynamicSegments).toEqual(['myservice']);
    expect(record.definedInDefaults).toBe(false);
  });

  it('full two-tree scan partitions fields into fixed/extension/segment-child', () => {
    const scan = scanConfigFieldIdentities(defaultsTree, customTree);
    // 容器段也是可定位/可覆盖的字段(整段覆盖是 kbengine.xml 常规实践)
    expect(scan.fields.map((f) => f.path)).toEqual([
      'baseapp',
      'baseapp.archivePeriod',
      'myservice',
      'myservice.host',
      'trace_packet',
      'trace_packet.customFlag',
      'trace_packet.debug_type',
    ]);
    expect(scan.fixed).toBe(4); // baseapp(覆盖)+archivePeriod(覆盖)+trace_packet(覆盖)+debug_type
    expect(scan.dynamicExtension).toBe(2); // myservice(段) + trace_packet.customFlag(叶)
    expect(scan.dynamicSegmentChild).toBe(1); // myservice.host
    expect(scan.overridden).toBe(3); // baseapp/trace_packet(容器)+archivePeriod(叶)
    expect(
      scan.fixed + scan.dynamicExtension + scan.dynamicSegmentChild,
    ).toBe(scan.fields.length);
  });

  it('collectConfigTreePaths skips the root wrapper and keeps item lists', () => {
    const tree = parseConfigXml(
      '<root><a><b>1</b></a><list><item>x</item><item>y</item></list></root>',
    ) as ConfigXmlNode;
    expect(collectConfigTreePaths(tree)).toEqual(['a', 'a.b', 'list']);
  });

  it('real fixture defaults yield fixed identities against the pinned snapshot', () => {
    const fixtureXml = readFileSync(
      path.resolve(__dirname, '..', 'tests/fixtures/config/kbengine_defaults.xml'),
      'utf8',
    );
    const tree = parseConfigXml(fixtureXml) as ConfigXmlNode;
    const scan = scanConfigFieldIdentities(tree, null);
    expect(scan.fields.length).toBeGreaterThan(150);
    expect(scan.dynamicExtension).toBe(0);
    expect(scan.dynamicSegmentChild).toBe(0);
    expect(scan.overridden).toBe(0);
    const identity = configFieldIdentity({
      root: 'defaults',
      path: 'trace_packet.debug_type',
      project: null,
      version: VERSION,
    });
    const parsed = parseConfigFieldIdentity(identity)!;
    expect(parsed.version).toBe(VERSION);
    expect(
      scan.fields.some((f) => f.path === parsed.path && f.kind === 'fixed'),
    ).toBe(true);
  });
});
