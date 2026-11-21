import { describe, expect, it } from 'vitest';

import {
  analyzeEntitiesImpact,
  formatEntitiesImpactReport,
  parseEntityRegistrations
} from '../src/backend/hotReloadEntitiesImpact';

// RUST-399(HR-HASH-012):entities.xml 实体注册项变化 → 受影响实体标注与注册
// 版本状态报告。判据:
// - 实体注册 = <root> 子元素,元素名 = 注册名;属性 hasBase/hasCell/hasClient/
//   config 与子元素一并入形;
// - 形状规范化(去注释/空白/子序排序+属性)变=注册项变化;
// - 注册项变化 = 增/删/形状变;任何变化 = 引擎实体注册表版本变化,需重启加载,
//   Python reload 不替代注册表变更;
// - 受影响实体逐条点名,含注册属性变化 delta(hasBase/hasCell/hasClient/config)。

const ENTITIES_XML = [
  '<root>',
  '  <Account hasClient="true"></Account>',
  '  <Avatar config="kbengine_avatar_defaults"/>',
  '  <Spaces/>',
  '  <Monster hasBase="true" hasCell="true"/>',
  '</root>'
].join('\n');

describe('RUST-399 parseEntityRegistrations(entities.xml 注册表)', () => {
  it('解析注册表:名→注册项(属性+形状)', () => {
    const table = parseEntityRegistrations(ENTITIES_XML);
    expect([...table.keys()].sort()).toEqual(['Account', 'Avatar', 'Monster', 'Spaces']);
    // config 属性入形(换 config 即改绑默认配置集,必判变化)
    expect(table.get('Avatar')!.shape).toContain('config=kbengine_avatar_defaults');
    expect(table.get('Account')!.attributes).toEqual({ hasClient: 'true' });
    expect(table.get('Monster')!.attributes).toEqual({ hasBase: 'true', hasCell: 'true' });
  });

  it('解析不了根 → 空表(如实不造)', () => {
    expect(parseEntityRegistrations('not xml').size).toBe(0);
    expect(parseEntityRegistrations('').size).toBe(0);
  });

  it('重复注册名首见保留(BTreeMap entry/or_insert 同口径)', () => {
    const table = parseEntityRegistrations(
      '<root>\n  <Dup hasClient="true"/>\n  <Dup hasBase="true"/>\n</root>'
    );
    expect([...table.keys()]).toEqual(['Dup']);
    expect(table.get('Dup')!.attributes).toEqual({ hasClient: 'true' });
  });
});

describe('RUST-399 analyzeEntitiesImpact(影响报告)', () => {
  it('无变化 → 无 changed/无 affected,注册表版本未变', () => {
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: ENTITIES_XML
    });
    expect(report.changedEntities).toEqual([]);
    expect(report.anyAffected).toBe(false);
    expect(report.changedEntityCount).toBe(0);
  });

  it('实体新增 → 受影响(注册表版本变化,需重启加载)', () => {
    const after = ENTITIES_XML.replace(
      '</root>',
      '  <NewEntity hasBase="true" hasCell="true" hasClient="true"/>\n</root>'
    );
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    expect(report.changedEntities.map(change => `${change.name}:${change.change}`)).toEqual([
      'NewEntity:added'
    ]);
    expect(report.anyAffected).toBe(true);
    expect(report.versionStatus).toContain('装载期读 entities.xml');
  });

  it('实体删除 → 受影响(注册表不再含该类型)', () => {
    const after = ENTITIES_XML.replace('  <Spaces/>\n', '');
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    expect(report.changedEntities.map(change => `${change.name}:${change.change}`)).toEqual([
      'Spaces:removed'
    ]);
    expect(report.anyAffected).toBe(true);
  });

  it('注册属性变化(hasClient 开关)→ 受影响并点名 delta', () => {
    const after = ENTITIES_XML.replace(
      '<Account hasClient="true">',
      '<Account hasClient="true" hasBase="true">'
    );
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    expect(report.changedEntities.map(change => `${change.name}:${change.change}`)).toEqual([
      'Account:changed'
    ]);
    expect(report.changedEntities[0]!.reason).toContain('hasBase: (无) → true');
  });

  it('config 属性变化(默认配置集换绑)→ 受影响并点名 delta', () => {
    const after = ENTITIES_XML.replace(
      '<Avatar config="kbengine_avatar_defaults"/>',
      '<Avatar config="kbengine_avatar_new_defaults"/>'
    );
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    expect(report.changedEntities[0]!.reason).toContain(
      'config: kbengine_avatar_defaults → kbengine_avatar_new_defaults'
    );
  });

  it('注册属性删除(hasClient 移除)→ 受影响并点名 delta(→ 无)', () => {
    const after = ENTITIES_XML.replace(
      '<Account hasClient="true"></Account>',
      '<Account></Account>'
    );
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    expect(report.changedEntities[0]!.reason).toContain('hasClient: true → (无)');
  });

  it('纯注释/空白变化 → 形状不变,非结构性(不产生 changed)', () => {
    const after = ENTITIES_XML.replace(
      '  <Avatar config="kbengine_avatar_defaults"/>',
      '  <!-- 改注释 -->\n  <Avatar\n    config="kbengine_avatar_defaults"\n  />'
    );
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    expect(report.changedEntities).toEqual([]);
    expect(report.anyAffected).toBe(false);
  });

  it('子元素注册结构变化(实体带子配置节点)→ 受影响', () => {
    const before = [
      '<root>',
      '  <Portal hasClient="true">',
      '    <Interfaces><Interface> I_Teleport </Interface></Interfaces>',
      '  </Portal>',
      '</root>'
    ].join('\n');
    const after = before.replace('<Interface> I_Teleport </Interface>', '<Interface> I_Portal </Interface>');
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: before,
      afterEntitiesXml: after
    });
    expect(report.changedEntities.map(change => `${change.name}:${change.change}`)).toEqual([
      'Portal:changed'
    ]);
    expect(report.changedEntities[0]!.reason).toContain('子元素注册结构变化');
  });
});

describe('RUST-399 formatEntitiesImpactReport(报告回显)', () => {
  it('有注册变化 → 点名实体 + 注册表版本变化 + 需重启', () => {
    const after = ENTITIES_XML.replace(
      '<Avatar config="kbengine_avatar_defaults"/>',
      '<Avatar config="kbengine_avatar_new_defaults"/>'
    );
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: after
    });
    const text = formatEntitiesImpactReport(report);
    expect(text).toContain('Avatar');
    expect(text).toContain('注册表版本变化');
    expect(text).toContain('需重启加载');
  });

  it('零变化 → 无实体注册项变化', () => {
    const report = analyzeEntitiesImpact({
      beforeEntitiesXml: ENTITIES_XML,
      afterEntitiesXml: ENTITIES_XML
    });
    expect(formatEntitiesImpactReport(report)).toBe('entities.xml 无实体注册项变化');
  });
});
