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