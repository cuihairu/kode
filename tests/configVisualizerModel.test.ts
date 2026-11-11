// configVisualizerModel:三树对齐投影(docs/design/config-visualization.md
// §4/§6,KODE-CFG-VIZ-001)。镜像 configCoreContract.mergeConfigXml 四分支
// 语义;断言面=三态主轴、显式重申、容器整名替换(§4.2-1)、重名 <item>
// 整表替换(§4.2-2)+ `name[k]` 限定路径、列表截断(§6.1)、进程/全局分组
// (§3.1)、键详情装配(文案库/片段/源注释,§4.3)。
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VIZ_LIST_VALUE_LIMIT,
  buildConfigVizKeyDetail,
  buildConfigVizSummary,
  type ConfigVizTreeInput
} from '../src/configVisualizerModel';
import { renderConfigXml, type ConfigXmlNode } from '../src/serverConfigMerge';

const leaf = (name: string, text: string, comments?: string[]): ConfigXmlNode => ({
  name,
  text,
  children: [],
  ...(comments ? { sourceComments: comments } : {})
});
const node = (name: string, children: ConfigXmlNode[]): ConfigXmlNode => ({
  name,
  text: '',
  children
});

const makeInput = (
  defaults: ConfigXmlNode,
  custom: ConfigXmlNode | null,
  merged: ConfigXmlNode,
  paths: { defaultsPath?: string | null; customPath?: string | null } = {}
): ConfigVizTreeInput => ({
  defaultsTree: defaults,
  customTree: custom,
  merged,
  defaultsPath: paths.defaultsPath ?? '/defaults/kbengine_defaults.xml',
  customPath: 'customPath' in paths ? (paths.customPath ?? null) : '/assets/res/server/kbengine.xml'
});

const byPath = (summary: ReturnType<typeof buildConfigVizSummary>, sectionId: string) => {
  const section = summary?.groups.flatMap(group => group.sections).find(s => s.id === sectionId);
  expect(section, `section ${sectionId}`).toBeDefined();
  return new Map(section!.keys.map(key => [key.path, key]));
};

describe('三态主轴(§4.1)', () => {
  const defaults = node('root', [node('baseapp', [leaf('rate', '1000'), leaf('debugMode', '0')])]);
  const custom = node('root', [node('baseapp', [leaf('rate', '2000'), leaf('extraMode', '1')])]);
  const merged = node('root', [
    node('baseapp', [leaf('rate', '2000'), leaf('debugMode', '0'), leaf('extraMode', '1')])
  ]);

  it('覆盖/仅默认/仅新增各归其位,restated 如实', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    expect(summary).not.toBeNull();
    expect(summary!.defaultsOnly).toBe(false);
    const keys = byPath(summary, 'baseapp');
    expect(keys.get('rate')).toMatchObject({ name: 'rate', state: 'overridden', restated: false });
    expect(keys.get('debugMode')?.state).toBe('defaults-only');
    expect(keys.get('extraMode')?.state).toBe('custom-only');
  });

  it('显式重申:覆盖值等于默认值时仍标覆盖,restated=true', () => {
    const restatedDefaults = node('root', [node('baseapp', [leaf('rate', '2000')])]);
    const summary = buildConfigVizSummary(makeInput(restatedDefaults, custom, merged));
    const keys = byPath(summary, 'baseapp');
    expect(keys.get('rate')).toMatchObject({ state: 'overridden', restated: true });
  });

  it('defaultsOnly:customTree 缺失时全键 defaults-only,警示条事实成立', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, null, merged));
    expect(summary!.defaultsOnly).toBe(true);
    const keys = byPath(summary, 'baseapp');
    expect(keys.get('rate')?.state).toBe('defaults-only');
  });

  it('defaultsTree/merged 缺失返回 null(无配置空态,不伪造三态)', () => {
    const full = makeInput(defaults, custom, merged);
    expect(buildConfigVizSummary({ ...full, defaultsTree: null })).toBeNull();
    expect(buildConfigVizSummary({ ...full, merged: null })).toBeNull();
  });

  it('路径与投影一致性:defaultsPath/customPath 原样透出', () => {
    const summary = buildConfigVizSummary(
      makeInput(defaults, custom, merged, { defaultsPath: '/d.xml', customPath: null })
    );
    expect(summary!.defaultsPath).toBe('/d.xml');
    expect(summary!.customPath).toBeNull();
  });
});

describe('容器整名替换(§4.2-1)', () => {
  it('叶换容器:新名 = 新增,旧叶值不再成行(不装纯新增假象)', () => {
    const defaults = node('root', [node('baseapp', [leaf('cb', 'x')])]);
    const custom = node('root', [node('baseapp', [node('cb', [leaf('y', '1')])])]);
    const merged = node('root', [node('baseapp', [node('cb', [leaf('y', '1')])])]);
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    const keys = byPath(summary, 'baseapp');
    expect(keys.has('cb')).toBe(false);
    expect(keys.get('cb.y')?.state).toBe('custom-only');
  });

  it('容器换叶:形状替换归覆盖,键在 defaults 里存在过', () => {
    const defaults = node('root', [node('baseapp', [node('cb', [leaf('y', '1')])])]);
    const custom = node('root', [node('baseapp', [leaf('cb', 'z')])]);
    const merged = node('root', [node('baseapp', [leaf('cb', 'z')])]);
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    const keys = byPath(summary, 'baseapp');
    expect(keys.get('cb')).toMatchObject({ state: 'overridden', restated: false });
    expect(keys.get('cb')?.finalValue).toBe('z');
  });
});

describe('重名 <item> 整表替换(§4.2-2)', () => {
  // 双侧各两 item → 整表替换:merged 子树 = 覆盖侧;表内条目全标覆盖,
  // restated 仍按位次对齐 defaults 如实对拍
  const defaults = node('root', [
    node('baseapp', [node('disables', [leaf('item', 'a'), leaf('item', 'b')])])
  ]);
  const custom = node('root', [
    node('baseapp', [node('disables', [leaf('item', '9'), leaf('item', 'b')])])
  ]);
  const merged = node('root', [
    node('baseapp', [node('disables', [leaf('item', '9'), leaf('item', 'b')])])
  ]);

  it('重名兄弟取 name[k] 限定路径(1-based 全限定),条目全标覆盖', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    const keys = byPath(summary, 'baseapp');
    expect([...keys.keys()].sort()).toEqual(['disables.item[1]', 'disables.item[2]']);
    expect(keys.get('disables.item[1]')?.state).toBe('overridden');
    expect(keys.get('disables.item[2]')?.state).toBe('overridden');
  });

  it('restated 在整表替换下仍如实:item[2] 重申成立,item[1] 重申不成立', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    const keys = byPath(summary, 'baseapp');
    expect(keys.get('disables.item[1]')?.restated).toBe(false);
    expect(keys.get('disables.item[2]')?.restated).toBe(true);
  });

  it('详情带 mergedByTableReplace 标注,限定路径可寻址回树', () => {
    const detail = buildConfigVizKeyDetail(makeInput(defaults, custom, merged), 'baseapp', 'disables.item[2]');
    expect(detail).not.toBeNull();
    expect(detail!.mergedByTableReplace).toBe(true);
    expect(detail!.restated).toBe(true);
    expect(detail!.defaultValue).toBe('b');
    expect(detail!.overrideValue).toBe('b');
    expect(detail!.fragmentXml).toBe('<item> b </item>');
  });
});

describe('列表截断(§6.1:列表保扫读、详情保真相)', () => {
  const longText = 'x'.repeat(200);
  const defaults = node('root', [node('baseapp', [leaf('big', 'short')])]);
  const custom = node('root', [node('baseapp', [leaf('big', longText)])]);
  const merged = node('root', [node('baseapp', [leaf('big', longText)])]);

  it('超限截断到 120 并按 truncateNote 附尾注', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged), {
      truncateNote: chars => `…(${chars})`
    });
    const entry = byPath(summary, 'baseapp').get('big')!;
    expect(CONFIG_VIZ_LIST_VALUE_LIMIT).toBe(120);
    expect(entry.finalValue.startsWith('x'.repeat(CONFIG_VIZ_LIST_VALUE_LIMIT))).toBe(true);
    expect(entry.finalValue.endsWith('…(200)')).toBe(true);
  });

  it('无 truncateNote 时安静截断;详情区 finalValue 永不截断', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    expect(byPath(summary, 'baseapp').get('big')?.finalValue).toHaveLength(CONFIG_VIZ_LIST_VALUE_LIMIT);
    const detail = buildConfigVizKeyDetail(makeInput(defaults, custom, merged), 'baseapp', 'big');
    expect(detail!.finalValue).toBe(longText);
  });
});

describe('进程段/全局段分组(§3.1)', () => {
  it('伪根下 <root> 包裹二层照常定位(真实 kbengine_defaults.xml 形态,镜像 find_among_layers)', () => {
    // 真实文件:resolve 伪根(name='')单根名为 root,组件段在包裹二层
    const pseudo = node('', [node('root', [node('baseapp', [leaf('rate', '1')])])]);
    const summary = buildConfigVizSummary(makeInput(pseudo, null, pseudo));
    expect(summary!.groups[0].id).toBe('process');
    expect(summary!.groups[0].sections.map(s => s.id)).toEqual(['baseapp']);
    const detail = buildConfigVizKeyDetail(makeInput(pseudo, null, pseudo), 'baseapp', 'rate');
    expect(detail).not.toBeNull();
    expect(detail!.finalValue).toBe('1');
  });

  const defaults = node('root', [node('baseapp', [leaf('rate', '1')]), node('customGlobal', [leaf('g', '2')])]);
  const custom = node('root', [node('baseapp', [leaf('rate', '1')]), node('customGlobal', [leaf('g', '2')])]);
  const merged = node('root', [node('baseapp', [leaf('rate', '1')]), node('customGlobal', [leaf('g', '2')])]);

  it('引擎 10 进程段进 process 组,其余进 global 组,组内序保持 merged 序', () => {
    const summary = buildConfigVizSummary(makeInput(defaults, custom, merged));
    expect(summary!.groups[0].id).toBe('process');
    expect(summary!.groups[0].sections.map(s => s.id)).toEqual(['baseapp']);
    expect(summary!.groups[1].id).toBe('global');
    expect(summary!.groups[1].sections.map(s => s.id)).toEqual(['customGlobal']);
  });

  it('段清单计数:键数/覆盖数/仅新增数与 keys 一致', () => {
    const d = node('root', [node('baseapp', [leaf('a', '1'), leaf('b', '2')])]);
    const c = node('root', [node('baseapp', [leaf('a', '9'), leaf('n', '3')])]);
    const m = node('root', [node('baseapp', [leaf('a', '9'), leaf('b', '2'), leaf('n', '3')])]);
    const summary = buildConfigVizSummary(makeInput(d, c, m))!;
    const section = summary.groups[0].sections[0];
    expect(section.keyCount).toBe(3);
    expect(section.overrideCount).toBe(1);
    expect(section.customOnlyCount).toBe(1);
    expect(section.keys).toHaveLength(3);
  });
});

describe('键详情装配(§4.3/§6)', () => {
  const defaults = node('root', [
    node('baseapp', [leaf('rate', '1000', ['// 限频注释', '// 第二行'])])
  ]);
  const custom = node('root', [node('baseapp', [leaf('rate', '2000')])]);
  const merged = node('root', [
    node('baseapp', [leaf('rate', '2000', ['// 限频注释', '// 第二行'])])
  ]);
  const input = makeInput(defaults, custom, merged);

  it('三值对照 + sourceComments 原文 + 片段渲染', () => {
    const detail = buildConfigVizKeyDetail(input, 'baseapp', 'rate', 'zh')!;
    expect(detail).toMatchObject({
      sectionId: 'baseapp',
      path: 'rate',
      state: 'overridden',
      restated: false,
      defaultValue: '1000',
      overrideValue: '2000',
      finalValue: '2000'
    });
    expect(detail.sourceComments).toEqual(['// 限频注释', '// 第二行']);
    // 片段走 renderConfigXml 既有口径:带源注释的叶子注释放值后(元素内部,
    // tinyxml2 IntText 只认首个文本子节点,值前放注释会把数值读成默认值)
    expect(detail.fragmentXml).toBe(
      ['<rate>', '\t2000', '\t<!-- // 限频注释 -->', '\t<!-- // 第二行 -->', '</rate>'].join('\n')
    );
  });

  it('文案库命中真实条目(baseapp.archivePeriod),未收录键如实 null', () => {
    const d = node('root', [node('baseapp', [leaf('archivePeriod', '20')])]);
    const i = makeInput(d, null, node('root', [node('baseapp', [leaf('archivePeriod', '20')])]));
    const hit = buildConfigVizKeyDetail(i, 'baseapp', 'archivePeriod', 'zh')!;
    expect(hit.catalogDoc).toContain('自动存档的时间周期');
    expect(hit.catalogSource).toBe('kbe/res/server/kbengine_defaults.xml:618');
    const miss = buildConfigVizKeyDetail(input, 'baseapp', 'rate', 'zh')!;
    expect(miss.catalogDoc).toBeNull();
    expect(miss.catalogSource).toBeNull();
  });

  it('容器路径:叶记录缺席按节点在位对齐兜底,片段=整子树', () => {
    const d = node('root', [node('baseapp', [node('cb', [leaf('y', '1')])])]);
    const c = node('root', [node('baseapp', [node('cb', [leaf('y', '9')])])]);
    const m = node('root', [node('baseapp', [node('cb', [leaf('y', '9')])])]);
    const detail = buildConfigVizKeyDetail(makeInput(d, c, m), 'baseapp', 'cb')!;
    expect(detail.state).toBe('overridden');
    expect(detail.finalValue).toBe('');
    expect(detail.fragmentXml).toBe(renderConfigXml(node('cb', [leaf('y', '9')]), 0));
    expect(detail.defaultValue).toBeNull();
    expect(detail.overrideValue).toBeNull();
  });

  it('键不在 merged 树内/段不存在 → null(前端保持原详情)', () => {
    expect(buildConfigVizKeyDetail(input, 'baseapp', 'nope')).toBeNull();
    expect(buildConfigVizKeyDetail(input, 'nosuch', 'rate')).toBeNull();
  });
});
