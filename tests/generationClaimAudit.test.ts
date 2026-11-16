// RUST-243(旧 QA-014)文案审计钉:生成覆盖率达到门槛前不得标「所有
// Python 文件类型完整生成」。任务书(docs/kode2/qa-execution-plan.md
// QA-014)验收口径=文案审计测试:宣称面(README/CHANGELOG/docs 用户文档)
// 若出现该短语,必须同句带覆盖率数字(量测口径=typePreview typing 覆盖
// resolved/total 已解析占比,RUST-223 在案;RUST-157 spec「禁止 Any 占位
// 充当整文件已完成」同源纪律)。豁免单=引用性档案而非宣称面:
// docs/kode2(任务书自身,QA-014 定义引用该短语)、docs/review(验收纪要
// 对账引用)、docs/knowledge 与 docs/zh/knowledge(KBEngine 官方文档镜像,
// 外部资料)、docs/acceptance-evidence(证据存档)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CLAIM = '所有 Python 文件类型完整生成';
// 同句覆盖率数字放行规则:宣称必须自带量测证据(resolved/total 占比)。
const COVERAGE_NUMBER = /\d+(?:\.\d+)?\s*%/;

const EXEMPT_DIRS = new Set([
  'node_modules',
  '.vitepress',
  'kode2',
  'review',
  'knowledge',
  'acceptance-evidence'
]);

const collectMarkdown = (dir: string, out: string[]): void => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.has(entry.name)) {
        collectMarkdown(full, out);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
};

describe('RUST-243 生成宣称文案审计(旧 QA-014)', () => {
  it('宣称面出现「所有 Python 文件类型完整生成」必须同句带覆盖率数字', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const files: string[] = [];
    for (const top of ['README.md', 'CHANGELOG.md']) {
      if (fs.existsSync(path.join(repoRoot, top))) {
        files.push(path.join(repoRoot, top));
      }
    }
    const docsDir = path.join(repoRoot, 'docs');
    if (fs.existsSync(docsDir)) {
      collectMarkdown(docsDir, files);
    }
    expect(files.length, '宣称面收集非空(扫描自身必须有效,防路径失效假绿)').toBeGreaterThan(20);

    const hits: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes(CLAIM)) {
          hits.push(`${path.relative(repoRoot, file)}:${i + 1} ${line.trim()}`);
        }
      });
    }
    const violations = hits.filter(hit => !COVERAGE_NUMBER.test(hit));
    expect(
      violations,
      '宣称面出现完整生成宣称但同句无覆盖率数字——覆盖率达标前不得标' +
        '「所有 Python 文件类型完整生成」;确需表述时同句带 typePreview ' +
        'resolved/total 占比数字(RUST-223 口径)'
    ).toEqual([]);
  });
});
