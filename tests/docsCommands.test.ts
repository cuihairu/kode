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
  contributes: { commands: Array<{ command: string }> };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJsonShape;
const commandIds = pkg.contributes.commands.map(entry => entry.command);
const commandsMd = readFileSync(join(root, 'docs', 'guide', 'commands.md'), 'utf8');

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
});
