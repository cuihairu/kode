/**
 * KSEM-CFG-06 配置来源面(纯核心)。
 *
 * 面分组:来源信息(custom 覆盖优先/defaults 回落/两树皆缺=不存在)/敏感
 * 键判定与脱敏(password 族命中,entityID 不误伤;首字符+***;明文永不
 * 出现在证据块)/证据块双语与诚实缺省(容器段无值不渲染生效值行,无单位
 * 不渲染单位行)/路径解析(标签名态/取值态/闭标签行恢复/属性区 null)/
 * 行定位(defaults 原文与最终渲染文,注释掩码,首现行)。零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import {
  configSourceInfo,
  renderSourceEvidenceBlock,
  configPathAtText,
  configDeclarationLine,
  isSensitiveConfigKey,
  maskSensitiveValue,
} from '../src/backend/configSourceFace';
import type { ConfigXmlNode } from '../src/serverConfigMerge';

const parse = (text: string): ConfigXmlNode => parseConfigXml(text) as ConfigXmlNode;

const defaultsXml = '<root><baseapp><gameUpdateHertz>30</gameUpdateHertz><telnet_service><password>pwd123456</password></telnet_service></baseapp></root>';

describe('KSEM-CFG-06 config source face', () => {
  it('source info: custom override wins, defaults fallback, missing is honest', () => {
    const defaultsTree = parse(defaultsXml);
    const customTree = parse('<root><baseapp><gameUpdateHertz>20</gameUpdateHertz></baseapp></root>');
    const overridden = configSourceInfo('baseapp.gameUpdateHertz', customTree, defaultsTree, null);
    expect(overridden.exists).toBe(true);
    expect(overridden.sourceLayer).toBe('custom');
    expect(overridden.effectiveValue).toBe('20');
    const fallback = configSourceInfo('baseapp.telnet_service.password', customTree, defaultsTree, null);
    expect(fallback.sourceLayer).toBe('defaults');
    expect(fallback.effectiveValue).toBe('pwd123456');
    const missing = configSourceInfo('baseapp.nope', customTree, defaultsTree, null);
    expect(missing.exists).toBe(false);
    expect(missing.sourceLayer).toBeNull();
    const noTrees = configSourceInfo('baseapp.gameUpdateHertz', null, null, null);
    expect(noTrees.exists).toBe(false);
  });

  it('unit evidence comes from the CFG-02 record only; no record means no unit', () => {
    const defaultsTree = parse(defaultsXml);
    const extraction = {
      records: [{
        path: 'baseapp.gameUpdateHertz', valueKind: 'integer' as const,
        evidence: 'engine-read-site' as const, enumValues: [], unit: '秒',
        repeatable: false, dynamicKeys: false, source: 't', unproven: [], valueOnlyCandidate: false,
      }],
      baseline: { file: 't', lineCount: null, note: '' },
      stats: { total: 1, typed: 1, enumCommented: 0, repeatableNodes: 0, unitsNamed: 1, valueOnly: 0, engineReadSite: 1 },
    };
    const withUnit = configSourceInfo('baseapp.gameUpdateHertz', null, defaultsTree, extraction);
    expect(withUnit.unit).toBe('秒');
    expect(configSourceInfo('baseapp.gameUpdateHertz', null, defaultsTree, null).unit).toBeNull();
  });

  it('sensitive key detection: password family hits, structural keys do not', () => {
    expect(isSensitiveConfigKey('telnet_service.password')).toBe(true);
    expect(isSensitiveConfigKey('baseapp.http_cb_prefix')).toBe(false);
    expect(isSensitiveConfigKey('dbmgr.auth.secretToken')).toBe(true);
    expect(isSensitiveConfigKey('loginapp.api_key')).toBe(true);
    expect(isSensitiveConfigKey('cellapp.entityIDAllocator')).toBe(false);
  });

  it('masking keeps the first character only; short values mask completely', () => {
    expect(maskSensitiveValue('pwd123456')).toBe('p***');
    expect(maskSensitiveValue('x')).toBe('***');
    expect(maskSensitiveValue('')).toBe('***');
  });

  it('evidence block never contains the plaintext of sensitive values', () => {
    const defaultsTree = parse(defaultsXml);
    const info = configSourceInfo('baseapp.telnet_service.password', null, defaultsTree, null);
    const zh = renderSourceEvidenceBlock(info, 'zh')!;
    const en = renderSourceEvidenceBlock(info, 'en')!;
    expect(zh).toContain('p***');
    expect(zh).not.toContain('pwd123456');
    expect(en).toContain('p***');
    expect(en).not.toContain('pwd123456');
    expect(zh).toContain('引擎默认生效');
    expect(en).toContain('engine default');
  });

  it('evidence block renders override source, value, and unit for plain fields (bilingual)', () => {
    const defaultsTree = parse(defaultsXml);
    const customTree = parse('<root><baseapp><gameUpdateHertz>20</gameUpdateHertz></baseapp></root>');
    const extraction = {
      records: [{
        path: 'baseapp.gameUpdateHertz', valueKind: 'integer' as const,
        evidence: 'engine-read-site' as const, enumValues: [], unit: '秒',
        repeatable: false, dynamicKeys: false, source: 't', unproven: [], valueOnlyCandidate: false,
      }],
      baseline: { file: 't', lineCount: null, note: '' },
      stats: { total: 1, typed: 1, enumCommented: 0, repeatableNodes: 0, unitsNamed: 1, valueOnly: 0, engineReadSite: 1 },
    };
    const info = configSourceInfo('baseapp.gameUpdateHertz', customTree, defaultsTree, extraction);
    const zh = renderSourceEvidenceBlock(info, 'zh')!;
    expect(zh).toContain('kbengine.xml` 覆盖');
    expect(zh).toContain('生效值:`20`');
    expect(zh).toContain('单位:秒');
    const en = renderSourceEvidenceBlock(info, 'en')!;
    expect(en).toContain('overridden by the project');
    expect(en).toContain('Effective value: `20`');
    expect(en).toContain('Unit: 秒');
  });

  it('evidence block is null for missing paths and omits absent value/unit rows for containers', () => {
    const defaultsTree = parse(defaultsXml);
    expect(renderSourceEvidenceBlock(configSourceInfo('baseapp.nope', null, defaultsTree, null), 'zh')).toBeNull();
    const section = configSourceInfo('baseapp.telnet_service', null, defaultsTree, null);
    const block = renderSourceEvidenceBlock(section, 'zh')!;
    expect(block).toContain('来源:');
    expect(block).not.toContain('生效值:');
    expect(block).not.toContain('单位:');
  });

  it('path resolution: tag-name state, value state, close-tag recovery, attribute region null', () => {
    const text = [
      '<root>',
      '  <baseapp>',
      '    <gameUpdateHertz>20</gameUpdateHertz>',
      '  </baseapp>',
      '</root>',
    ].join('\n');
    // 标签名态:光标在 <gameUpdateHertz 开标签名内
    const openTagOffset = text.indexOf('<gameUpdateHertz') + '<gameUpdateHert'.length;
    expect(configPathAtText(text, openTagOffset)).toBe('baseapp.gameUpdateHertz');
    // 取值态:光标在值文本内
    const valueOffset = text.indexOf('>20') + 1;
    expect(configPathAtText(text, valueOffset)).toBe('baseapp.gameUpdateHertz');
    // 闭标签行尾恢复:光标在 </gameUpdateHertz> 之后
    const closeOffset = text.indexOf('</gameUpdateHertz>') + '</gameUpdateHertz>'.length;
    expect(configPathAtText(text, closeOffset)).toBe('baseapp.gameUpdateHertz');
    // 属性区:无建议面
    expect(configPathAtText('<root><baseapp attr="1"', '<root><baseapp attr='.length)).toBeNull();
  });

  it('declaration lines resolve in defaults text and rendered final text (comment-masked, first open)', () => {
    const defaultsText = [
      '<root>',
      '<!-- <gameUpdateHertz> fake -->',
      '<baseapp>',
      '<gameUpdateHertz>30</gameUpdateHertz>',
      '</baseapp>',
      '</root>',
    ].join('\n');
    expect(configDeclarationLine(defaultsText, 'baseapp.gameUpdateHertz')).toBe(4);
    expect(configDeclarationLine(defaultsText, 'baseapp.nope')).toBeNull();
    const rendered = '<root><baseapp>\n<!-- 说明 -->\n<gameUpdateHertz>20</gameUpdateHertz>\n</baseapp></root>';
    expect(configDeclarationLine(rendered, 'baseapp.gameUpdateHertz')).toBe(3);
  });
});
