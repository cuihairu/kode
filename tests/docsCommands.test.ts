import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// 批95「文档与源码核对」防漂移锁:package.json 贡献的每条命令必须以
// `### \`kbengine.xxx\`` 小节见于 docs/guide/commands.md(反向:文档不得
// 记载不存在的命令);核心文档不得回潮已知失实表述(模板数 5、旧双层
// 测试计数、旧统计口径)。本批复核即因命令文档缺 4 条、多处统计漂移
// 而起,锁死防再犯。

const root = join(__dirname, '..');

interface PackageJsonShape {
  contributes: {
    commands: Array<{ command: string }>;
    configuration: { properties: Record<string, unknown> } | Array<{ properties: Record<string, unknown> }>;
  };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJsonShape;
const commandIds = pkg.contributes.commands.map(entry => entry.command);
const commandsMd = readFileSync(join(root, 'docs', 'guide', 'commands.md'), 'utf8');

/** package.json 贡献的全部 `kbengine.*` 设置键(configuration 可能是数组分段) */
const contributedSettingKeys = (): string[] => {
  const configuration = pkg.contributes.configuration;
  const properties = Array.isArray(configuration)
    ? Object.assign({}, ...configuration.map(section => section.properties))
    : configuration.properties;
  return Object.keys(properties);
};

const zhConfigurationMd = readFileSync(join(root, 'docs', 'zh', 'guide', 'configuration.md'), 'utf8');
const enConfigurationMd = readFileSync(join(root, 'docs', 'guide', 'configuration.md'), 'utf8');

const documentedCommands = (): string[] => {
  const pattern = /^### `(kbengine\.[^\s`]+)`$/gm;
  const found: string[] = [];
  let match = pattern.exec(commandsMd);
  while (match !== null) {
    found.push(match[1]);
    match = pattern.exec(commandsMd);
  }
  return found;
};

describe('docs 命令覆盖与失实表述锁', () => {
  it('package.json 每条贡献命令都以小节见于 docs/guide/commands.md', () => {
    expect(commandIds.length).toBeGreaterThanOrEqual(23);
    const documented = documentedCommands();
    const missing = commandIds.filter(id => !documented.includes(id));
    expect(missing, `缺文档小节的命令: ${missing.join(', ')}`).toEqual([]);
  });

  it('docs/guide/commands.md 的小节命令都真实存在于 package.json', () => {
    const unknown = documentedCommands().filter(id => !commandIds.includes(id));
    expect(unknown, `文档记载了不存在的命令: ${unknown.join(', ')}`).toEqual([]);
  });

  it('核心文档不再出现已知失实表述', () => {
    const staleMarkers = [
      '5 个预定义模板',
      '216 用例',
      '110 用例',
      '@vscode/test-electron',
      '7000+ 行',
      '19 个 TypeScript',
      '25 个 TypeScript'
    ];
    for (const doc of ['README.md', 'PROJECT_SUMMARY.md', 'COMPLETED_FEATURES.md', 'CHANGELOG.md']) {
      const text = readFileSync(join(root, doc), 'utf8');
      const hits = staleMarkers.filter(marker => text.includes(marker));
      expect(hits, `${doc} 回潮失实表述: ${hits.join(', ')}`).toEqual([]);
    }
  });

  // 批145 设置项文档对账:批136-142 陆续新增的 9 个设置项(hotReload.* 已在表内,
  // 余下 clientSdk.outputDir / python.extraPathsSync / python.stubExport /
  // python.stubDir)从未进过 docs/guide/configuration.md 的「kbengine.* 设置项
  // 总览」——用户照文档配不上项。此锁与上方命令锁同一形状:双向对账,但范围只取
  // 「设置项总览」表(命令 id 同为 kbengine.* 前缀,散文里还点名了已移除的旧设置,
  // 全量正则扫会把它们误判成失实,故只认表内行)。
  const overviewTableRows = (text: string, headingPattern: RegExp): string[] => {
    const lines = text.split('\n');
    const rows: string[] = [];
    let inside = false;
    for (const line of lines) {
      if (headingPattern.test(line)) {
        inside = true;
        continue;
      }
      if (inside && /^## /.test(line)) break;
      if (inside) {
        const match = line.match(/^\| `(kbengine\.[A-Za-z][A-Za-z0-9_.]*)`/);
        if (match) rows.push(match[1]);
      }
    }
    return rows;
  };

  it('package.json 每条贡献设置项都在中英配置说明总览表里', () => {
    const keys = contributedSettingKeys();
    expect(keys.length).toBeGreaterThanOrEqual(41);
    const zhRows = overviewTableRows(zhConfigurationMd, /^## kbengine\.\* 设置项总览/);
    const enRows = overviewTableRows(enConfigurationMd, /^## Overview of `kbengine\.\*` Settings/);
    const missingZh = keys.filter(key => !zhRows.includes(key));
    const missingEn = keys.filter(key => !enRows.includes(key));
    expect(missingZh, `zh 总览表缺设置项: ${missingZh.join(', ')}`).toEqual([]);
    expect(missingEn, `en 总览表缺设置项: ${missingEn.join(', ')}`).toEqual([]);
  });

  it('配置说明总览表不记载 package.json 里不存在的设置项', () => {
    const keys = contributedSettingKeys();
    const zhRows = overviewTableRows(zhConfigurationMd, /^## kbengine\.\* 设置项总览/);
    const enRows = overviewTableRows(enConfigurationMd, /^## Overview of `kbengine\.\*` Settings/);
    const unknown = [...zhRows, ...enRows].filter(key => !keys.includes(key));
    expect(unknown, `总览表记载了不存在的设置项: ${[...new Set(unknown)].join(', ')}`).toEqual([]);
  });
});

// D-2(2026-10-24):设置项文档对账扩展到 features.md 的 Settings 表 ——
// configuration.md 总览表锁(上方)落地后仍有 5 个新键漏进 features.md
// (hover.asyncBudgetMs / python.apiMetadata / python.callChainHints /
// python.callChainView / webviewConsoleLogs)。此锁与总览表锁同形状:
// 双向对账键覆盖(中英 features.md 同锁,防只补一边);另对标量(字符串/
// 数字/布尔)默认值逐键核对 —— 文档行写错默认值(如改了 package.json
// 忘了文档)是本锁要堵的另一类漂移。
// 数组/对象默认(httpRequests 等)在 features.md 是截断展示,只查行存在
// 不比内容;callChainView/typeData/asyncBudgetMs 等键由此锁自动滚动覆盖,
// 不再逐键补断言。
const featuresMd = readFileSync(join(root, 'docs', 'features.md'), 'utf8');
const zhFeaturesMd = readFileSync(join(root, 'docs', 'zh', 'features.md'), 'utf8');

const contributedSettings = (): Record<string, { type?: string; default?: unknown }> => {
  const configuration = pkg.contributes.configuration;
  return Array.isArray(configuration)
    ? Object.assign({}, ...configuration.map(section => section.properties))
    : configuration.properties;
};

const featuresSettingRows = (text: string): Map<string, string> => {
  const rows = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\| `(kbengine\.[A-Za-z][A-Za-z0-9_.]*)` \| (.+?) \|/);
    if (match) {
      rows.set(match[1], match[2].trim());
    }
  }
  return rows;
};

/** 非贡献键但属扩展真实读取的运行时键(features.md 白名单,见 src/managedDir.ts) */
const FEATURES_RUNTIME_KEYS = new Set(['kbengine.managedDir']);

describe('features.md Settings 表与 package.json 对账', () => {
  const featureDocs: Array<[string, string]> = [
    ['docs/features.md', featuresMd],
    ['docs/zh/features.md', zhFeaturesMd]
  ];

  it('package.json 每条贡献设置项都见于 features.md Settings 表', () => {
    const missing: string[] = [];
    for (const [label, text] of featureDocs) {
      const rows = featuresSettingRows(text);
      for (const key of contributedSettingKeys()) {
        if (!rows.has(key)) {
          missing.push(`${label}: ${key}`);
        }
      }
    }
    expect(missing, `features.md Settings 表缺设置项: ${missing.join(', ')}`).toEqual([]);
  });

  it('features.md Settings 表不记载未贡献的键(运行时键白名单除外)', () => {
    const keys = new Set(contributedSettingKeys());
    const unknown: string[] = [];
    for (const [label, text] of featureDocs) {
      for (const key of featuresSettingRows(text).keys()) {
        if (!keys.has(key) && !FEATURES_RUNTIME_KEYS.has(key)) {
          unknown.push(`${label}: ${key}`);
        }
      }
    }
    expect(unknown, `features.md 记载了未贡献的设置项: ${unknown.join(', ')}`).toEqual([]);
  });

  it('标量默认值与 package.json 一致(数组/对象只查行不比内容)', () => {
    const scalar = (value: unknown): value is string | number | boolean =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    const mismatches: string[] = [];
    for (const [label, text] of featureDocs) {
      const rows = featuresSettingRows(text);
      for (const [key, property] of Object.entries(contributedSettings())) {
        if (!scalar(property.default)) {
          continue;
        }
        const documented = rows.get(key);
        if (documented === undefined) {
          continue; // 行缺失由第一条用例负责
        }
        const normalized = documented.replace(/^`/, '').replace(/`$/, '');
        if (normalized !== JSON.stringify(property.default)) {
          mismatches.push(`${label} ${key}: 文档 ${documented} ≠ package.json ${JSON.stringify(property.default)}`);
        }
      }
    }
    expect(mismatches, `默认值漂移: ${mismatches.join('; ')}`).toEqual([]);
  });
});