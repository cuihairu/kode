import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-007 defChain 迁移取舍记录锁:docs/review/2026-10-29-defchain-migration-tradeoff.md
// 验收口径:对拍接口/组件/缺失文件/环语义,并量测 Parent hover 的 IPC 成本。
// 数字来自 2026-10-29 本机单轮合成语料探针(临时文件,已删;方法在记录内
// 复述可复现),跨机器绝对值禁止比较(PERF-015)。

const root = join(__dirname, '..');
const doc = readFileSync(
  join(root, 'docs/review/2026-10-29-defchain-migration-tradeoff.md'),
  'utf8'
);

describe('defChain 迁移取舍记录(IDE-RST-007)', () => {
  it('四节齐备', () => {
    for (const section of [
      '# defChain 迁移取舍',
      '## 1. 语义对拍面(接口/组件/缺失文件/环)',
      '## 2. Parent hover 路径与耗时',
      '## 3. IPC 成本量测',
      '## 4. 采纳/暂缓结论',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
  });

  it('语义四面逐项对照(TS 有/Rust 缺的边界如实)', () => {
    expect(doc).toMatch(/接口|Interfaces/);
    expect(doc).toMatch(/组件|Components/);
    expect(doc).toMatch(/缺失文件|defPath.*null|缺文件/);
    expect(doc).toMatch(/环|cycleTruncated|截断/);
    // Rust 侧现状点名:ChainNode 只有 entity/parent,环诊断 Span 0,0
    expect(doc).toMatch(/ChainNode/);
    expect(doc).toMatch(/Span/);
    expect(doc).toContain('r2-index-inventory');
  });

  it('实测数字与口径在档(单轮/合成语料/PERF-015)', () => {
    for (const fact of ['1.929', '0.564', '1.071', '0.407']) {
      expect(doc, `缺实测数字 ${fact}`).toContain(fact);
    }
    expect(doc).toContain('单轮');
    expect(doc).toContain('合成语料');
    expect(doc).toContain('PERF-015');
  });

  it('Parent hover 路径事实在档(交互路径/无缓存/buildDefChain)', () => {
    expect(doc).toMatch(/getDefChainHover|buildDefChain/);
    expect(doc).toMatch(/无缓存|每次.*重|不.*缓存/);
    expect(doc).toMatch(/hover/);
  });

  it('结论为暂缓且 IPC 判据方向如实(IPC 不构成否决,语义缺口是)', () => {
    expect(doc).toMatch(/暂缓/);
    expect(doc).toMatch(/复评触发|触发条件/);
    // 与 RST-006 相反方向:此处 Rust 往返低于 TS 实付,否决理由是语义缺口
    expect(doc).toMatch(/IPC 不构成|IPC 不是|语义缺口/);
  });
});
