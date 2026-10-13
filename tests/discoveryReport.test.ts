import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_DEPTH,
  DEFAULT_SCAN_MAX_VISITED,
  buildDiscoveryReport,
  renderDiscoveryReport,
  resetDiscoveryState,
  setDiscoveryChoice
} from '../src/workspaceDiscovery';
import type { DiscoveredCandidateSet, DiscoveryFieldLabel, DiscoveryLayoutFacts } from '../src/workspaceDiscovery';
import { getDefinitionWorkspaceLayout } from '../src/definitionWorkspace';
import { configurationOverrides } from './helpers/vscodeStub';

// 发现与定位诊断(批127):定位失败不再静默。报告的输入 facts 由装配层组装,
// 纯逻辑层只做存在性盘点与来源标注;全部用例走真实文件系统临时树。

let root = '';

const p = (...segments: string[]) => path.join(root, ...segments);

const write = (relative: string, content = '<xml/>') => {
  const target = p(...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const mkdir = (relative: string) => {
  fs.mkdirSync(p(...relative.split('/')), { recursive: true });
};

// 与 extension.ts 装配同口径:layout + 配置原值(binPath 侧直接给生效值,
// 报告只负责盘点,不重复管理器的自动检测逻辑)
const factsFor = (binPath = ''): DiscoveryLayoutFacts => {
  const layout = getDefinitionWorkspaceLayout(root);
  const overrides = configurationOverrides.get('kbengine') ?? {};
  const setting = (key: string): string =>
    typeof overrides[key] === 'string' ? (overrides[key] as string) : '';
  return {
    entityDefsRoot: layout.entityDefsRoot || '',
    entityScriptsRoot: layout.entityScriptsRoot,
    interfacesRoot: layout.interfacesRoot,
    componentsRoot: layout.componentsRoot,
    entitiesXmlPath: layout.entitiesXmlPath,
    typesXmlPath: layout.typesXmlPath,
    entityDefsPathSetting: setting('entityDefsPath'),
    entitiesXmlPathSetting: setting('entitiesXmlPath'),
    // types.xml 无独立配置项,布局内硬编码候选链
    typesXmlPathSetting: '',
    configPath: setting('configPath'),
    binPathSetting: setting('binPath'),
    binPath
  };
};

const GENERATED_AT = '2026-10-13T00:00:00.000Z';

const fieldByLabel = (label: DiscoveryFieldLabel) => {
  const report = buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT);
  return report.fields.find(field => field.label === label);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-report-'));
  resetDiscoveryState();
  configurationOverrides.delete('kbengine');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  configurationOverrides.delete('kbengine');
});

describe('buildDiscoveryReport(约定树:全 ok)', () => {
  it('labels convention hits as ok/convention', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');

    const entityDefs = fieldByLabel('实体定义目录 entity_defs');
    expect(entityDefs?.status).toBe('ok');
    expect(entityDefs?.source).toBe('convention');
    expect(entityDefs?.resolved).toBe(p('scripts/entity_defs'));
    expect(entityDefs?.explicitConfig).toBeNull();
    expect(entityDefs?.conventionHits).toContain(p('scripts/entity_defs'));

    const entities = fieldByLabel('entities.xml');
    expect(entities?.status).toBe('ok');
    expect(entities?.resolved).toBe(p('scripts/entities.xml'));

    const types = fieldByLabel('types.xml');
    expect(types?.status).toBe('ok');
    expect(types?.resolved).toBe(p('scripts/entity_defs/types.xml'));
  });

  it('labels derived interfaces/components from an existing defs root', () => {
    mkdir('scripts/entity_defs/interfaces');
    mkdir('scripts/entity_defs/components');

    const interfaces = fieldByLabel('接口目录 interfaces');
    expect(interfaces?.status).toBe('ok');
    expect(interfaces?.source).toBe('derived');
    expect(interfaces?.resolved).toBe(p('scripts/entity_defs/interfaces'));

    const components = fieldByLabel('组件目录 components');
    expect(components?.status).toBe('ok');
    expect(components?.resolved).toBe(p('scripts/entity_defs/components'));
  });
});

describe('buildDiscoveryReport(失败可见:此前静默的情形)', () => {
  it('surfaces the silent fallback to a non-existent path on an empty workspace', () => {
    // 空工作区:layout 把 def 根回落到约定首项(不存在的 scripts/entity_defs),
    // 批127 之前全程无信号。来源仍标约定链(值确来自候选链),但状态与
    // 问题项明确指出"当前值不存在"
    const entityDefs = fieldByLabel('实体定义目录 entity_defs');
    expect(entityDefs?.status).toBe('missing');
    expect(entityDefs?.source).toBe('convention');
    expect(entityDefs?.resolved).toBe(p('scripts/entity_defs'));

    const report = buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT);
    const issue = report.issues.find(item => item.label === '实体定义目录 entity_defs');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain(p('scripts/entity_defs'));
    expect(issue?.remediation).toContain('kbengine.entityDefsPath');
  });

  it('reports an explicit config that points nowhere', () => {
    // 绝对路径形态:最终取用值与配置同基,来源标显式配置
    configurationOverrides.set('kbengine', { entityDefsPath: p('ghost-defs') });

    const entityDefs = fieldByLabel('实体定义目录 entity_defs');
    expect(entityDefs?.explicitConfig).toBe(p('ghost-defs'));
    expect(entityDefs?.explicitConfigExists).toBe(false);
    expect(entityDefs?.status).toBe('missing');
    expect(entityDefs?.source).toBe('explicit-config');
  });

  it('labels a resolved value outside every tracked source as fallback', () => {
    // facts 是调用方供给的(函数契约允许任意解析结果):装配层之外的未来
    // 调用面可能传入任何值;不在显式/记忆/约定/深扫描且不在磁盘上 → 回落
    const report = buildDiscoveryReport(
      root,
      { ...factsFor(), entityDefsRoot: p('nowhere-defs') },
      undefined,
      GENERATED_AT
    );
    const entityDefs = report.fields.find(field => field.label === '实体定义目录 entity_defs');
    expect(entityDefs?.resolved).toBe(p('nowhere-defs'));
    expect(entityDefs?.status).toBe('missing');
    expect(entityDefs?.source).toBe('fallback');
  });

  it('labels a caller-supplied existing value outside every tracked source as derived', () => {
    // 同上契约:值存在但不在显式/记忆/约定/深扫描任一来源里(目录名不叫
    // entity_defs,深扫描看不见它)——如实标 derived,不冒充任何来源
    mkdir('elsewhere');
    const report = buildDiscoveryReport(
      root,
      { ...factsFor(), entityDefsRoot: p('elsewhere') },
      undefined,
      GENERATED_AT
    );
    const entityDefs = report.fields.find(field => field.label === '实体定义目录 entity_defs');
    expect(entityDefs?.status).toBe('ok');
    expect(entityDefs?.source).toBe('derived');
  });

  it('treats an empty def-root fact as unresolved (missing, source none)', () => {
    // 契约允许空串:视为未解析,与"回落到不存在的约定首项"区分开
    const report = buildDiscoveryReport(
      root,
      { ...factsFor(), entityDefsRoot: '' },
      undefined,
      GENERATED_AT
    );
    const entityDefs = report.fields.find(field => field.label === '实体定义目录 entity_defs');
    expect(entityDefs?.resolved).toBeNull();
    expect(entityDefs?.status).toBe('missing');
    expect(entityDefs?.source).toBe('none');
  });

  it('labels a unique deep-scan hit as deep-scan', () => {
    mkdir('deep/nested/entity_defs');

    const entityDefs = fieldByLabel('实体定义目录 entity_defs');
    expect(entityDefs?.status).toBe('ok');
    expect(entityDefs?.source).toBe('deep-scan');
    expect(entityDefs?.resolved).toBe(p('deep/nested/entity_defs'));
    expect(entityDefs?.scanHits).toEqual([p('deep/nested/entity_defs')]);
  });

  it('labels a remembered choice as remembered-choice', () => {
    mkdir('pick/entity_defs');
    setDiscoveryChoice(root, 'entityDefs', p('pick/entity_defs'));

    const entityDefs = fieldByLabel('实体定义目录 entity_defs');
    expect(entityDefs?.status).toBe('ok');
    expect(entityDefs?.source).toBe('remembered-choice');
    expect(entityDefs?.remembered).toBe(p('pick/entity_defs'));
  });

  it('drops a remembered choice whose directory no longer exists', () => {
    // 记忆选择指向已删除的目录:报告的"记忆选择"栏如实过滤为无,
    // 最终取用回落约定链(layout 侧 getDiscoveryChoice 同口径过滤)
    setDiscoveryChoice(root, 'entityDefs', p('gone/entity_defs'));

    const entityDefs = fieldByLabel('实体定义目录 entity_defs');
    expect(entityDefs?.remembered).toBeNull();
    expect(entityDefs?.resolved).toBe(p('scripts/entity_defs'));
    expect(entityDefs?.status).toBe('missing');
  });

  it('marks entities.xml ambiguous when two candidates exist but none was picked', () => {
    write('d1/entities.xml');
    write('d2/entities.xml');

    const entities = fieldByLabel('entities.xml');
    expect(entities?.status).toBe('ambiguous');
    expect(entities?.resolved).toBeNull();
    expect(entities?.scanHits).toHaveLength(2);

    const report = buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT);
    const issue = report.issues.find(item => item.label === 'entities.xml');
    expect(issue?.message).toContain('2 个候选');
  });

  it('does not call a fully-missing entities.xml ambiguous (zero hits are missing)', () => {
    const entities = fieldByLabel('entities.xml');
    expect(entities?.status).toBe('missing');
    expect(entities?.resolved).toBeNull();
  });
});

describe('buildDiscoveryReport(资产根与引擎侧)', () => {
  it('probes res/server/kbengine.xml under the configured assets root', () => {
    write('assets/res/server/kbengine.xml');
    configurationOverrides.set('kbengine', { configPath: p('assets') });

    const configField = fieldByLabel('资产根 kbengine.configPath');
    expect(configField?.status).toBe('ok');
    expect(configField?.resolved).toBe(p('assets'));
    expect(configField?.conventionHits).toEqual([p('assets/res/server/kbengine.xml')]);
  });

  it('resolves a relative configPath against the workspace root', () => {
    write('assets/res/server/kbengine.xml');
    configurationOverrides.set('kbengine', { configPath: 'assets' });

    const configField = fieldByLabel('资产根 kbengine.configPath');
    expect(configField?.resolved).toBe(p('assets'));
    expect(configField?.status).toBe('ok');
  });

  it('reports configPath missing when the probe file is absent', () => {
    mkdir('assets');
    configurationOverrides.set('kbengine', { configPath: p('assets') });

    const configField = fieldByLabel('资产根 kbengine.configPath');
    expect(configField?.status).toBe('missing');
    expect(configField?.conventionHits).toEqual([]);
    const report = buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT);
    expect(report.issues.find(item => item.label === '资产根 kbengine.configPath')?.remediation)
      .toContain('res/server/kbengine.xml');
  });

  it('labels an empty configPath as missing with remediation', () => {
    const configField = fieldByLabel('资产根 kbengine.configPath');
    expect(configField?.status).toBe('missing');
    expect(configField?.source).toBe('none');
    expect(configField?.explicitConfig).toBeNull();
  });

  it('labels an effective binPath from the manager as explicit-config or derived', () => {
    // 设置非空:生效值即显式配置(目录无需真实存在,存在性由 status 表达)
    configurationOverrides.set('kbengine', { binPath: p('engine/kbe/bin/server') });
    const explicitReport = buildDiscoveryReport(
      root,
      factsFor(p('engine/kbe/bin/server')),
      undefined,
      GENERATED_AT
    );
    const explicit = explicitReport.fields.find(
      field => field.label === '引擎二进制 kbengine.binPath'
    );
    expect(explicit?.source).toBe('explicit-config');
    expect(explicit?.status).toBe('missing');
    expect(explicit?.explicitConfig).toBe(p('engine/kbe/bin/server'));

    // 设置为空而生效值非空:kbe 源码根自动检测推导
    configurationOverrides.delete('kbengine');
    write('kbe/src/lib/entitydef/entitydef.cpp');
    const derivedReport = buildDiscoveryReport(
      root,
      factsFor(p('kbe/bin/server')),
      undefined,
      GENERATED_AT
    );
    const derived = derivedReport.fields.find(
      field => field.label === '引擎二进制 kbengine.binPath'
    );
    expect(derived?.status).toBe('missing');
    expect(derived?.source).toBe('derived');
    expect(derived?.scanHits).toEqual([p('kbe')]);
  });

  it('derives messages_fixed.xml from the kbe source root', () => {
    write('kbe/src/lib/entitydef/entitydef.cpp');
    write('kbe/res/server/messages_fixed.xml');

    const messages = fieldByLabel('引擎消息消息表 messages_fixed.xml');
    expect(messages?.status).toBe('ok');
    expect(messages?.source).toBe('derived');
    expect(messages?.resolved).toBe(p('kbe/res/server/messages_fixed.xml'));
  });

  it('labels a deep-scan-only messages_fixed.xml hit as deep-scan', () => {
    // 纯资产仓:无 kbe 源码锚点、无 entitydef.cpp,深扫描兜底命中唯一
    // messages_fixed.xml —— 来源标 deep-scan 而非 derived
    write('deep/nested/messages_fixed.xml');

    const messages = fieldByLabel('引擎消息消息表 messages_fixed.xml');
    expect(messages?.status).toBe('ok');
    expect(messages?.source).toBe('deep-scan');
    expect(messages?.resolved).toBe(p('deep/nested/messages_fixed.xml'));
    expect(messages?.scanHits).toEqual([p('deep/nested/messages_fixed.xml')]);
  });
});

describe('buildDiscoveryReport(扫描元信息)', () => {
  it('carries scan metadata and no issue when everything resolves', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');

    const report = buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT);
    expect(report.workspaceRoot).toBe(root);
    expect(report.generatedAt).toBe('2026-10-13T00:00:00.000Z');
    expect(report.scanVisited).toBeGreaterThan(0);
    expect(report.scanTruncated).toBe(false);
    expect(report.scanMaxDepth).toBe(DEFAULT_SCAN_DEPTH);
    expect(report.scanMaxVisited).toBe(DEFAULT_SCAN_MAX_VISITED);
    // 资产根/引擎侧未配置仍计为问题(它们不属于 def 树,但属启动链路)
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues.every(issue => issue.label !== '实体定义目录 entity_defs')).toBe(true);
    expect(report.issues.every(issue => issue.label !== 'entities.xml')).toBe(true);
  });

  it('registers a truncation issue when the injected scan set is cut short', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');

    // 截断的扫描形态无法用正常小工作区复现(默认上限 20000 条目),经
    // scanOverride 注入;报告必须标注"零命中 ≠ 真没有"
    const truncated: DiscoveredCandidateSet = {
      entityDefs: [],
      entitiesXml: [],
      typesXml: [],
      kbeSourceRoots: [],
      messagesXml: [],
      scanVisited: 5,
      scanTruncated: true
    };
    const report = buildDiscoveryReport(root, factsFor(), truncated, GENERATED_AT);
    expect(report.scanVisited).toBe(5);
    expect(report.scanTruncated).toBe(true);
    const scanIssue = report.issues.find(issue => issue.label === '深扫描');
    expect(scanIssue?.message).toContain('触顶截断');
    expect(scanIssue?.remediation).toContain('显式配置对应路径项');
    expect(renderDiscoveryReport(report)).toContain('已截断(命中集可能不全)');
  });
});

describe('renderDiscoveryReport(可复制回传的文本)', () => {
  it('renders headers, per-field detail, and issues', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');

    const report = buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT);
    const text = renderDiscoveryReport(report);

    expect(text).toContain('Kode 发现与定位诊断');
    expect(text).toContain(`工作区: ${root}`);
    expect(text).toContain('生成时间: 2026-10-13T00:00:00.000Z');
    expect(text).toContain(`深扫描: 访问 ${report.scanVisited} 条目, 未截断`);
    expect(text).toContain('[ok] 实体定义目录 entity_defs');
    expect(text).toContain('来源: 约定链');
    expect(text).toContain('显式配置: (无)');
    expect(text).toContain(`约定链命中: ${p('scripts/entity_defs')}`);
    expect(text).toContain('记忆选择: (无)');
    expect(text).toMatch(/问题 \d+ 项/);
    expect(text).toContain('补救: ');
  });

  it('renders explicit-config existence as a suffixed hint (present and absent)', () => {
    // 显式配置栏要能一眼看出"配了但指错地方":存在性后缀(存在)/(不存在)
    mkdir('picked-defs');
    configurationOverrides.set('kbengine', {
      entityDefsPath: p('picked-defs'),
      binPath: p('ghost-bin')
    });

    const report = buildDiscoveryReport(
      root,
      factsFor(p('ghost-bin')),
      undefined,
      GENERATED_AT
    );
    const text = renderDiscoveryReport(report);

    expect(text).toContain(`显式配置: ${p('picked-defs')} (存在)`);
    expect(text).toContain(`显式配置: ${p('ghost-bin')} (不存在)`);
  });

  it('shows the non-existent convention entries separately from hits', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');

    const text = renderDiscoveryReport(
      buildDiscoveryReport(root, factsFor(), undefined, GENERATED_AT)
    );
    expect(text).toContain('约定链未命中: ');
    expect(text).toContain(p('entity_defs'));
  });
});
