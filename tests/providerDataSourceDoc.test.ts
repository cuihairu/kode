import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-ARC-006 实际查询依赖图文档锁:docs/architecture/provider-data-sources.md
// 必须列出每个 provider 的数据源与允许副作用,并明确标注未完成迁移。
// 本测试把文档钉在代码事实上:①extension.ts 实际构造的每个 Provider 类
// 都要在文档里出现(新注册 provider 不补文档=红);②文档的 watcher 分布
// 清单与 src/ 实际 createFileSystemWatcher 计数逐文件对账(watcher 挪窝
// 不改文档=红);③未完成迁移标注在位;④诊断面两函数入册。

const root = join(__dirname, '..');
const docPath = join(root, 'docs/architecture/provider-data-sources.md');
const doc = readFileSync(docPath, 'utf8');
const extension = readFileSync(join(root, 'src/extension.ts'), 'utf8');

function countWatchers(): Map<string, number> {
  const counts = new Map<string, number>();
  const srcDir = join(root, 'src');
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        visit(full);
      } else if (name.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        const hits = (text.match(/createFileSystemWatcher\(/g) ?? []).length;
        if (hits > 0) {
          counts.set(`src/${name}`, (counts.get(`src/${name}`) ?? 0) + hits);
        }
      }
    }
  };
  visit(srcDir);
  return counts;
}

describe('实际查询依赖图文档(IDE-ARC-006)', () => {
  it('文档存在且含必需章节', () => {
    for (const section of [
      '# Provider 数据源与副作用清单',
      '## 1. 副作用边界',
      '## 2. Provider 清单',
      '## 3. 诊断面',
      '## 4. 共享服务与生命周期所有者',
      '## 5. watcher 分布',
      '## 6. 未完成迁移',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
  });

  it('extension.ts 实际构造的每个 Provider 都在文档中', () => {
    const constructed = new Set<string>();
    for (const match of extension.matchAll(/new ([A-Z][A-Za-z0-9]+)\(/g)) {
      const name = match[1];
      if (name.endsWith('Provider') || name === 'CallChainController') {
        constructed.add(name);
      }
    }
    expect(constructed.size).toBeGreaterThanOrEqual(15);
    for (const name of constructed) {
      expect(doc, `文档缺 provider ${name}`).toContain(name);
    }
  });

  it('watcher 分布清单与 src 实际计数逐文件对账', () => {
    const censusLine = doc.split('\n').find(line => line.startsWith('watcher 分布'));
    expect(censusLine, '缺 watcher 分布清单行').toBeDefined();
    const documented = new Map<string, number>();
    for (const match of (censusLine ?? '').matchAll(/([\w/.]+\.ts)=(\d+)/g)) {
      documented.set(match[1], Number(match[2]));
    }
    expect(documented).toEqual(countWatchers());
  });

  it('未完成迁移标注在位', () => {
    for (const marker of [
      '【未完成迁移】languageProviders.ts 单体',
      '【未完成迁移】签名帮助与补全文案',
      '【未完成迁移】entityMapping 双读',
      '【未完成迁移】模块自持 watcher',
    ]) {
      expect(doc, `缺标注 ${marker}`).toContain(marker);
    }
  });

  it('诊断面两函数入册', () => {
    expect(doc).toContain('validateDocument');
    expect(doc).toContain('validateEntitiesXmlDocument');
  });
});
