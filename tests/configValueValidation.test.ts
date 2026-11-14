/**
 * KSEM-CFG-05 配置值校验(纯核心)。
 *
 * 面分组:行号锚定(首现行/根包裹段不入/注释掩码)/类型面证据闸(引擎
 * 读取点与类型声明才查,value-only 候选与 defaults-comment 不查=诚实面)/
 * 字面量形态(整数带符号/浮点容整数/布尔仅 true·false 大小写不敏感)/
 * 枚举面与类型面优先级/list 与 string 不查/未知键面(custom 独有段归并
 * 首缺段边界,后代不重复登记)/真夹具全量直跑(thread_pool.init_create
 * 等真引擎读取点记录)。零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import { SERVER_CONFIG_ITEM_DOCS } from '../src/backend/serverConfigCatalog';
import { extractConfigContracts, contractRecordByPath } from '../src/backend/configContract';
import type { ConfigContractExtraction, ConfigContractRecord } from '../src/backend/configContract';
import { scanConfigFieldIdentities } from '../src/backend/configFieldIdentity';
import {
  computeConfigValueFindings,
  configPathLineIndex,
  configLineSpan,
} from '../src/backend/configValueValidation';
import type { ConfigXmlNode } from '../src/serverConfigMerge';

const fixtureXml = readFileSync(
  path.resolve(__dirname, '..', 'tests/fixtures/config/kbengine_defaults.xml'),
  'utf8',
);

const emptyStats = {
  total: 0, typed: 0, enumCommented: 0, repeatableNodes: 0,
  unitsNamed: 0, valueOnly: 0, engineReadSite: 0,
};

const extractionOf = (records: ConfigContractRecord[]): ConfigContractExtraction => ({
  records,
  baseline: { file: 'synthetic', lineCount: null, note: 'test' },
  stats: emptyStats,
});

const recordOf = (overrides: Partial<ConfigContractRecord> & { path: string }): ConfigContractRecord => ({
  valueKind: 'integer',
  evidence: 'engine-read-site',
  enumValues: [],
  unit: null,
  repeatable: false,
  dynamicKeys: false,
  source: 'test',
  unproven: [],
  valueOnlyCandidate: false,
  ...overrides,
});

const parse = (text: string): ConfigXmlNode => parseConfigXml(text) as ConfigXmlNode;

const codes = (findings: { code: string }[]): string[] => findings.map((f) => f.code);

describe('KSEM-CFG-05 config value validation', () => {
  it('line index records first-open lines, skips the root wrapper, survives comments', () => {
    const text = [
      '<root>',
      '<!-- <fakeSection> fake tag -->',
      '<thread_pool>',
      '<init_create>1</init_create>',
      '</thread_pool>',
      '</root>',
    ].join('\n');
    const lines = configPathLineIndex(text);
    expect(lines.get('thread_pool')).toBe(3);
    expect(lines.get('thread_pool.init_create')).toBe(4);
    expect(lines.has('fakeSection')).toBe(false);
    expect(lines.has('kbengine')).toBe(false);
  });

  it('repeated paths keep the first occurrence line', () => {
    const text = '<root><a><b>1</b></a><a><b>2</b></a></root>';
    const lines = configPathLineIndex(text);
    expect(lines.get('a')).toBe(1);
    expect(lines.get('a.b')).toBe(1);
  });

  it('type face: engine-read-site integer with malformed literal is an error', () => {
    const customXml = '<root><thread_pool><init_create>abc</init_create></thread_pool></root>';
    const extraction = extractionOf([
      recordOf({ path: 'thread_pool.init_create', valueKind: 'integer', evidence: 'engine-read-site' }),
    ]);
    const scan = scanConfigFieldIdentities(parse('<root><thread_pool><init_create>1</init_create></thread_pool></root>'), parse(customXml));
    const findings = computeConfigValueFindings({
      customText: customXml,
      customTree: parse(customXml),
      extraction,
      scan,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].code).toBe('kbengine.configValue.typeMismatch');
    expect(findings[0].args.expected).toBe('an integer');
    expect(findings[0].args.value).toBe('abc');
    expect(findings[0].line).toBe(1);
  });

  it('type face literals: signed integers pass, int passes float, malformed float fails', () => {
    const run = (value: string, valueKind: ConfigContractRecord['valueKind']): number => {
      const customXml = `<root><s><k>${value}</k></s></root>`;
      const extraction = extractionOf([
        recordOf({ path: 's.k', valueKind, evidence: 'defaults-type-annotation' }),
      ]);
      const scan = scanConfigFieldIdentities(parse('<root><s><k>1</k></s></root>'), parse(customXml));
      return computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan }).length;
    };
    expect(run('-5', 'integer')).toBe(0);
    expect(run('+7', 'integer8')).toBe(0);
    expect(run('5', 'float')).toBe(0);
    expect(run('1.5', 'float')).toBe(0);
    expect(run('1.2.3', 'float')).toBe(1);
    expect(run('1e3', 'integer')).toBe(1);
  });

  it('type face boolean: only true/false (case-insensitive), yes/1 are errors', () => {
    const run = (value: string): number => {
      const customXml = `<root><s><k>${value}</k></s></root>`;
      const extraction = extractionOf([
        recordOf({ path: 's.k', valueKind: 'boolean', evidence: 'defaults-type-annotation' }),
      ]);
      const scan = scanConfigFieldIdentities(parse('<root><s><k>true</k></s></root>'), parse(customXml));
      const findings = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
      return findings.length === 0 ? 0 : (findings[0].args.expected === 'true or false' ? 1 : -1);
    };
    expect(run('true')).toBe(0);
    expect(run('False')).toBe(0);
    expect(run('yes')).toBe(1);
    expect(run('1')).toBe(1);
  });

  it('evidence gate: value-only candidates and defaults-comment records are never checked', () => {
    const customXml = '<root><s><k>abc</k></s></root>';
    for (const evidence of ['defaults-value-only', 'defaults-comment'] as const) {
      const extraction = extractionOf([
        recordOf({ path: 's.k', valueKind: 'integer', evidence, valueOnlyCandidate: evidence === 'defaults-value-only' }),
      ]);
      const scan = scanConfigFieldIdentities(parse('<root><s><k>1</k></s></root>'), parse(customXml));
      const findings = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
      // 类型面不查(证据不足);未知键面也不该有(s.k 两树都在,fixed)
      expect(findings, evidence).toHaveLength(0);
    }
  });

  it('enum face: undocumented values warn with the documented set, documented pass', () => {
    const mk = (value: string) => {
      const customXml = `<root><trace_packet><debug_type>${value}</debug_type></trace_packet></root>`;
      const extraction = extractionOf([
        recordOf({
          path: 'trace_packet.debug_type',
          valueKind: 'enum',
          evidence: 'defaults-enum-comment',
          enumValues: [
            { value: '0', meaning: 'a' }, { value: '1', meaning: 'b' },
            { value: '2', meaning: 'c' }, { value: '3', meaning: 'd' },
          ],
        }),
      ]);
      const scan = scanConfigFieldIdentities(parse('<root><trace_packet><debug_type>0</debug_type></trace_packet></root>'), parse(customXml));
      return computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
    };
    expect(mk('2')).toHaveLength(0);
    const bad = mk('9');
    expect(bad).toHaveLength(1);
    expect(bad[0].severity).toBe('warning');
    expect(bad[0].code).toBe('kbengine.configValue.enumMismatch');
    expect(bad[0].args.values).toBe('0, 1, 2, 3');
  });

  it('enum evidence takes precedence: one warning, no duplicate type error', () => {
    const customXml = '<root><trace_packet><debug_type>abc</debug_type></trace_packet></root>';
    const extraction = extractionOf([
      recordOf({
        path: 'trace_packet.debug_type',
        valueKind: 'enum',
        evidence: 'engine-read-site',
        enumValues: [{ value: '0', meaning: 'a' }, { value: '1', meaning: 'b' }],
      }),
    ]);
    const scan = scanConfigFieldIdentities(parse('<root><trace_packet><debug_type>0</debug_type></trace_packet></root>'), parse(customXml));
    const findings = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
    expect(codes(findings)).toEqual(['kbengine.configValue.enumMismatch']);
  });

  it('string and list records are never checked (honest gaps)', () => {
    const customXml = '<root><s><k>anything goes</k></s><l><item>a</item><item>b</item></l></root>';
    const extraction = extractionOf([
      recordOf({ path: 's.k', valueKind: 'string', evidence: 'engine-read-site' }),
      recordOf({ path: 'l', valueKind: 'list', evidence: 'engine-read-site', repeatable: true }),
    ]);
    const scan = scanConfigFieldIdentities(parse('<root><s><k>x</k></s><l><item>i</item></l></root>'), parse(customXml));
    expect(computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan })).toHaveLength(0);
  });

  it('unknown-key face: custom-only sections collapse to one boundary finding', () => {
    const customXml = [
      '<root>',
      '<known><k>1</k></known>',
      '<myTools>',
      '<apiKey>x</apiKey>',
      '<retry>3</retry>',
      '<deep><v>1</v></deep>',
      '</myTools>',
      '</root>',
    ].join('\n');
    const defaultsXml = '<root><known><k>0</k></known></root>';
    const extraction = extractionOf([
      recordOf({ path: 'known.k', valueKind: 'integer', evidence: 'engine-read-site' }),
    ]);
    const scan = scanConfigFieldIdentities(parse(defaultsXml), parse(customXml));
    const findings = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
    const unknown = findings.filter((f) => f.code === 'kbengine.configValue.unknownKey');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].path).toBe('myTools');
    expect(unknown[0].severity).toBe('information');
    expect(unknown[0].line).toBe(3);
    // 已知字段合法值不产任何面
    expect(findings.some((f) => f.path === 'known.k')).toBe(false);
  });

  it('unknown-key face also fires for a custom-only leaf under a known section', () => {
    const customXml = '<root><known><k>1</k><extraLeaf>z</extraLeaf></known></root>';
    const defaultsXml = '<root><known><k>0</k></known></root>';
    const extraction = extractionOf([recordOf({ path: 'known.k', valueKind: 'integer', evidence: 'engine-read-site' })]);
    const scan = scanConfigFieldIdentities(parse(defaultsXml), parse(customXml));
    const unknown = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan })
      .filter((f) => f.code === 'kbengine.configValue.unknownKey');
    expect(unknown.map((f) => f.path)).toEqual(['known.extraLeaf']);
    expect(unknown[0].severity).toBe('information');
  });

  it('overridden fields with valid values produce nothing; empty-text leaves are skipped', () => {
    const customXml = '<root><s><k>  </k><n>5</n></s></root>';
    const defaultsXml = '<root><s><k>1</k><n>0</n></s></root>';
    const extraction = extractionOf([
      recordOf({ path: 's.k', valueKind: 'integer', evidence: 'engine-read-site' }),
      recordOf({ path: 's.n', valueKind: 'integer', evidence: 'engine-read-site' }),
    ]);
    const scan = scanConfigFieldIdentities(parse(defaultsXml), parse(customXml));
    expect(computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan })).toHaveLength(0);
  });

  it('findings sort by line then severity', () => {
    const customXml = [
      '<root>',
      '<tools><t>1</t></tools>',
      '<thread_pool><init_create>abc</init_create></thread_pool>',
      '</root>',
    ].join('\n');
    const defaultsXml = '<root><thread_pool><init_create>1</init_create></thread_pool></root>';
    const extraction = extractionOf([
      recordOf({ path: 'thread_pool.init_create', valueKind: 'integer', evidence: 'engine-read-site' }),
    ]);
    const scan = scanConfigFieldIdentities(parse(defaultsXml), parse(customXml));
    const findings = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
    expect(findings[0].severity).toBe('information');
    expect(findings[1].severity).toBe('error');
  });

  it('real fixture: typed engine-read-site records fire the error face on bad custom values', () => {
    const extraction = extractConfigContracts(fixtureXml, parse(fixtureXml), (() => {
      const sources: Record<string, string> = {};
      for (const [key, doc] of Object.entries(SERVER_CONFIG_ITEM_DOCS)) sources[key] = doc.source;
      return sources;
    })());
    const typed = extraction.records.filter(
      (r) => r.evidence === 'engine-read-site'
        && (r.valueKind === 'integer' || r.valueKind === 'integer8' || r.valueKind === 'float' || r.valueKind === 'boolean'),
    );
    expect(typed.length).toBeGreaterThanOrEqual(20);
    const probe = typed.find((r) => r.path === 'thread_pool.init_create');
    expect(probe).toBeDefined();

    const customXml = '<root><thread_pool><init_create>not-a-number</init_create></thread_pool></root>';
    const defaultsTree = parse(fixtureXml);
    const scan = scanConfigFieldIdentities(defaultsTree, parse(customXml));
    const findings = computeConfigValueFindings({ customText: customXml, customTree: parse(customXml), extraction, scan });
    const errors = findings.filter((f) => f.code === 'kbengine.configValue.typeMismatch');
    expect(errors.map((f) => f.path)).toContain('thread_pool.init_create');
    expect(errors[0].severity).toBe('error');
    // 真夹具的 defaults 树下同值合法
    expect(contractRecordByPath(extraction, 'thread_pool.init_create')?.evidence).toBe('engine-read-site');
  });

  it('configLineSpan trims to the value bounds and tolerates out-of-range lines', () => {
    const text = '<root>\n  <a><k>1</k></a>   \n</root>';
    expect(configLineSpan(text, 2)).toEqual({ start: 2, end: 17 });
    expect(configLineSpan(text, 9)).toEqual({ start: 0, end: 0 });
    expect(configLineSpan(text, 1)).toEqual({ start: 0, end: 6 });
  });
});
