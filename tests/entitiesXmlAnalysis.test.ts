import { describe, expect, it } from 'vitest';
import {
  ENTITIES_XML_DUPLICATE_CHECK,
  analyzeEntitiesXml
} from '../src/entitiesXmlAnalysis';

// entities.xml 清单分析(source-analysis 设计 D3)纯逻辑用例:同名重复条目
// 的发现面。引擎按首条静默合并(registerNewScriptDefModule,entitydef.cpp:
// 255-262),kode 以 warning 指出重复条目不生效。文档级装配(开关/诊断
// collection)在 languageProviders 与 extension 测试覆盖。

describe('analyzeEntitiesXml', () => {
  it('无重复条目时返回空结果', () => {
    const text = [
      '<root>',
      '  <Avatar hasBase="true"/>',
      '  <Monster hasCell="true"/>',
      '</root>'
    ].join('\n');
    expect(analyzeEntitiesXml(text)).toEqual([]);
  });

  it('同名重复条目产出一条落在第二条目开标签上的 warning', () => {
    const text = [
      '<root>',
      '  <Avatar hasBase="true"/>',
      '  <Avatar hasCell="true"/>',
      '</root>'
    ].join('\n');
    const findings = analyzeEntitiesXml(text);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.check).toBe(ENTITIES_XML_DUPLICATE_CHECK);
    expect(finding.severity).toBe('warning');
    expect(finding.name).toBe('Avatar');
    // 定位与长度锁死第二条目的整个开标签(<Avatar hasCell="true"/>)
    const expectedOffset = text.indexOf('<Avatar hasCell');
    const expectedEnd = text.indexOf('/>', expectedOffset) + 2;
    expect(finding.offset).toBe(expectedOffset);
    expect(finding.length).toBe(expectedEnd - expectedOffset);
    expect(finding.message).toContain('Avatar');
    expect(finding.message).toContain('重复');
    expect(finding.message).toContain('静默合并');
  });

  it('非自闭合重复条目同样命中', () => {
    const text = [
      '<root>',
      '  <Avatar>',
      '    <hasClient/>',
      '  </Avatar>',
      '  <Avatar/>',
      '</root>'
    ].join('\n');
    const findings = analyzeEntitiesXml(text);
    expect(findings).toHaveLength(1);
    const expectedOffset = text.lastIndexOf('<Avatar');
    expect(findings[0].offset).toBe(expectedOffset);
  });

  it('同名出现三次产出两条发现,均指向后续条目', () => {
    const text = '<root><Gate/><Gate/><Gate/></root>';
    const findings = analyzeEntitiesXml(text);
    expect(findings).toHaveLength(2);
    const firstDupAt = text.indexOf('<Gate/>');
    const firstDup = text.indexOf('<Gate/>', firstDupAt + '<Gate/>'.length);
    const secondDup = text.indexOf('<Gate/>', firstDup + '<Gate/>'.length);
    expect(findings.map(item => item.offset)).toEqual([firstDup, secondDup]);
  });

  it('同名子节点嵌在实体条目内不误报(只看清单直接子节点)', () => {
    const text = [
      '<root>',
      '  <Avatar>',
      '    <hasClient/>',
      '    <hasClient/>',
      '  </Avatar>',
      '</root>'
    ].join('\n');
    expect(analyzeEntitiesXml(text)).toEqual([]);
  });

  it('清单里的 root 伪条目与既有口径一致跳过', () => {
    const text = '<root><Avatar/><root/><root/></root>';
    const findings = analyzeEntitiesXml(text);
    // 两个 <root/> 子条目按既有 getRegisteredEntities 口径不参与清单
    expect(findings).toHaveLength(0);
  });

  it('解析失败的文本返回空结果(不虚构发现)', () => {
    expect(analyzeEntitiesXml('<not-closed')).toEqual([]);
    expect(analyzeEntitiesXml('')).toEqual([]);
  });

  it('分节格式(ClientServerEntities/ServerOnlyEntities)条目同样参与查重', () => {
    const text = [
      '<root>',
      '  <ClientServerEntities>',
      '    <Account hasBase="true"/>',
      '    <Avatar/>',
      '    <Avatar/>',
      '  </ClientServerEntities>',
      '  <ServerOnlyEntities/>',
      '</root>'
    ].join('\n');
    const findings = analyzeEntitiesXml(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe('Avatar');
    const firstAvatar = text.indexOf('<Avatar/>');
    const expectedOffset = text.indexOf('<Avatar/>', firstAvatar + '<Avatar/>'.length);
    expect(findings[0].offset).toBe(expectedOffset);
    expect(text.slice(findings[0].offset, findings[0].offset + findings[0].length)).toBe('<Avatar/>');
  });

  it('同名实体跨分节容器重复登记同样命中', () => {
    const text = '<root><ClientServerEntities><Guard/></ClientServerEntities>'
      + '<ServerOnlyEntities><Guard/></ServerOnlyEntities></root>';
    const findings = analyzeEntitiesXml(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe('Guard');
  });

  it('分节容器本身不计入实体清单,容器内实体的同名子标签不误报', () => {
    const text = [
      '<root>',
      '  <ClientServerEntities>',
      '    <Avatar>',
      '      <hasClient/>',
      '      <hasClient/>',
      '    </Avatar>',
      '  </ClientServerEntities>',
      '</root>'
    ].join('\n');
    expect(analyzeEntitiesXml(text)).toEqual([]);
  });
});
