// 配置提示对账锁(用户令 2026-11-06):package.json contributes.configuration
// 逐键断言 ——
// ①每个键用 markdownDescription 且不再有裸 description(VS Code 设置 UI 只认
//   markdownDescription 渲染,description 里的 markdown 是死文本);
// ②每条提示含「默认值」段(设置界免查源码);
// ③带 enum 的键必须有 markdownEnumDescriptions 且逐选项各一句说明(新增
//   配置键的通用规则:enum 无选项说明 = 新键裸奔,一律红);
// ④描述里的配置指南链接锚点必须真存在于 docs/guide/configuration.md 标题
//   (slug 同 VitePress github-slugger 口径),防文档改标题后死链;
// ⑤与实现对账的关键默认值逐键锁死(hotReload.enabled 默认开、默认热更
//   8090 双带 module_name、telnet.host 回环、autoStart 三件套、路径双键
//   约定默认等)——描述漂移或新键裸奔,本文件先红。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

interface ConfigProperty {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  markdownEnumDescriptions?: string[];
  enumDescriptions?: string[];
  items?: { enum?: unknown[]; markdownEnumDescriptions?: string[] };
}

interface ConfigurationEntry {
  properties: Record<string, ConfigProperty>;
}

const loadProperties = (): Record<string, ConfigProperty> => {
  // KODE-I18N-001 起描述文案外置 package.nls*.json,manifest 只留 %key% 占位;
  // 本契约锁定的是解析后的提示文案(默认包),断言本体不变。
  const nls = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const resolveNls = (value: string): string =>
    value.replace(/^%([^%]+)%$/, (_m, key: string) => nls[key] ?? key);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: ConfigurationEntry | ConfigurationEntry[] };
  };
  const raw = pkg.contributes.configuration;
  const entries = Array.isArray(raw) ? raw : [raw];
  const merged: Record<string, ConfigProperty> = {};
  for (const entry of entries) {
    for (const [key, prop] of Object.entries(entry.properties)) {
      merged[key] = {
        ...prop,
        markdownDescription: typeof prop.markdownDescription === 'string'
          ? resolveNls(prop.markdownDescription)
          : prop.markdownDescription,
        markdownEnumDescriptions: prop.markdownEnumDescriptions?.map(resolveNls),
        items: prop.items
          ? { ...prop.items, markdownEnumDescriptions: prop.items.markdownEnumDescriptions?.map(resolveNls) }
          : undefined
      };
    }
  }
  return merged;
};

const props = loadProperties();
const keys = Object.keys(props).sort();

const GUIDE_URL_PREFIX = 'https://cuihairu.github.io/kode/guide/configuration';

/** 与 VitePress(github-slugger)同口径的标题 slug:去反引号、去标点(不补空格)、
 * 转小写、空格折连字符。docs 标题均为 ASCII,该实现与站内锚点一致。 */
const headingSlug = (heading: string): string =>
  heading
    .replace(/`/g, '')
    .replace(/[^\w\- ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/ /g, '-');

const loadGuideSlugs = (): Set<string> => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'docs/guide/configuration.md'), 'utf8');
  const slugs = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^#{2,4} (.+)$/.exec(line);
    if (match) {
      slugs.add(headingSlug(match[1]));
    }
  }
  return slugs;
};

describe('package.json configuration prompt contract', () => {
  it('collects the full key inventory', () => {
    expect(keys.length).toBeGreaterThanOrEqual(110);
    expect(props['kbengine.hotReload.enabled']).toBeDefined();
  });

  it('every key ships markdownDescription and no bare description', () => {
    const bare: string[] = [];
    const empty: string[] = [];
    for (const key of keys) {
      const prop = props[key];
      if (typeof prop.markdownDescription !== 'string' || prop.markdownDescription.length === 0) {
        empty.push(key);
      }
      if ('description' in prop) {
        bare.push(key);
      }
    }
    expect(empty).toEqual([]);
    expect(bare).toEqual([]);
  });

  it('every markdownDescription carries a 默认值 section', () => {
    const missing = keys.filter(key => !props[key].markdownDescription?.includes('默认值'));
    expect(missing).toEqual([]);
  });

  it('every markdownDescription carries a 详见 doc link (guide deep link or relative path)', () => {
    // 任务口径:链接可以是配置指南深链,也可以是相对路径文档(player-clone 等专题页)
    const missing = keys.filter(key => !props[key].markdownDescription?.includes('详见 ['));
    expect(missing).toEqual([]);
  });

  it('every enum property documents every option via markdownEnumDescriptions', () => {
    const offenders: string[] = [];
    for (const key of keys) {
      const prop = props[key];
      const enumValues = prop.enum ?? prop.items?.enum;
      if (!enumValues) {
        continue;
      }
      // 选项说明允许两种落位:标量 enum 在键上,数组 items.enum 在 items 里
      const docs = prop.markdownEnumDescriptions ?? prop.items?.markdownEnumDescriptions;
      if (!Array.isArray(docs) || docs.length !== enumValues.length) {
        offenders.push(key);
        continue;
      }
      // 每个选项一句说明:非空且含「何时选/后果」的可读句子(至少带中文冒号或句长下限)
      for (const doc of docs) {
        if (typeof doc !== 'string' || doc.length < 12) {
          offenders.push(key);
          break;
        }
      }
      // 旧 enumDescriptions 键不得残留(设置 UI 只认 markdown 前缀)
      if ('enumDescriptions' in prop) {
        offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('guide link anchors resolve to real configuration.md headings', () => {
    const slugs = loadGuideSlugs();
    const dead: string[] = [];
    for (const key of keys) {
      const md = props[key].markdownDescription ?? '';
      const links = md.matchAll(new RegExp(`\\[配置指南\\]\\(${GUIDE_URL_PREFIX}#([^)]+)\\)`, 'g'));
      for (const match of links) {
        if (!slugs.has(match[1])) {
          dead.push(`${key} -> #${match[1]}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('reconciled defaults match implementation truth', () => {
    const expected: Record<string, unknown> = {
      // hotReload.ts readHotReloadSettings:缺省/类型错一律回落「开」
      'kbengine.hotReload.enabled': true,
      // globs 不再声明默认值(声明会让 VS Code 预填 ["**/*.py"],assetsRoot 派生
      // 永远走不到,见 hot-reload-design.md §11.1);未设 = undefined → 派生
      'kbengine.hotReload.globs': undefined,
      'kbengine.hotReload.debounceMs': 500,
      // HR-WATCH-001 触发源模式:默认推荐保存面(readHotReloadSettings 回落口径同)
      'kbengine.hotReload.triggerMode': 'onSave',
      // HR-PR-08 发送 provider 插槽:默认关=readHotReloadSettings 回落口径,
      // 键关面不进链(装配钉 hotReloadProviderWiring)
      'kbengine.hotReload.sendViaProviders': false,
      // definitionWorkspace.ts getDefinitionWorkspaceLayout 约定链
      'kbengine.entityDefsPath': 'scripts/entity_defs',
      'kbengine.entitiesXmlPath': 'scripts/entities.xml',
      // telnetService.ts readTelnetSettings 回环兜底
      'kbengine.telnet.host': '127.0.0.1',
      // extension.ts 日志缓冲 maxLogEntries → logCollector 裁剪上限
      'kbengine.maxLogEntries': 10000,
      // serverManager.ts startAutoComponents 缺省三件套
      'kbengine.autoStart': ['machine', 'logger', 'dbmgr'],
      'kbengine.webviewLocale': 'auto',
      // hoverLocale.ts readHoverLanguageSetting:缺省/非法值一律回落 auto
      'kbengine.hover.language': 'auto',
      'kbengine.debug.sessionEndBehavior': 'detach',
      'kbengine.infer.sourceWrite': 'managed',
      'kbengine.entity.methodStubBody': 'pass',
      // 2026-11-08 用户令「直接切」:core.backend 默认 ts → rust(实现与
      // package.json 双轨同步,本表是两轨对账面)。
      'kbengine.core.backend': 'rust'
    };
    const drifted: string[] = [];
    for (const [key, want] of Object.entries(expected)) {
      const got = props[key]?.default;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        drifted.push(`${key}: package.json=${JSON.stringify(got)} implementation=${JSON.stringify(want)}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('default hot reload request facts stay locked in the prompt text', () => {
    for (const key of ['kbengine.hotReload.enabled', 'kbengine.hotReload.actionName']) {
      const md = props[key]?.markdownDescription ?? '';
      expect(md, key).toContain('8090');
      expect(md, key).toContain('module_name');
    }
  });

  it('the three option-less enums now carry per-option guidance', () => {
    const optionDocs: Record<string, Record<string, string>> = {
      'kbengine.debug.sessionEndBehavior': {
        detach: '断开调试器',
        'stop-process': '停止'
      },
      'kbengine.infer.sourceWrite': {
        managed: '.kbengine',
        user: 'scripts'
      },
      'kbengine.entity.methodStubBody': {
        pass: '空体',
        raise: 'NotImplementedError'
      }
    };
    for (const [key, perOption] of Object.entries(optionDocs)) {
      const enumValues = props[key]?.enum as string[] | undefined;
      expect(enumValues, key).toBeDefined();
      const docs = props[key]?.markdownEnumDescriptions ?? [];
      enumValues!.forEach((value, index) => {
        expect(docs[index], `${key}[${value}]`).toContain(perOption[value]);
      });
    }
  });
});
