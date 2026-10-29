import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-002 拆开 Rust 骨架和正式 serving 状态:提案(R3 行)必须逐项记录
// 已存在的 server/shadow、未开放能力和切流门,不得把「骨架存在」写成
// 「迁移完成/已切流」。本测试把文档钉在代码事实上:
// ①提案 R3 记录含三面拆分(骨架已存在/能力未开放/切流门);
// ②shadow 覆盖面与 kodeCoreShadowFaces.ts 实际接入的 compare 面逐项相等
//   (新增 shadow 面必须同笔改提案记录);
// ③serving 门禁现状与 kodeCoreGate.ts 的 serveFromRust() 实现一致(恒
//   false=Rust 不服务);④切流前置清单指回 pr-012.md 且清单在档。

const root = join(__dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');
const proposal = read('docs/review/2026-10-23-rust-core-lsp-proposal.md');
const gate = read('src/kodeCoreGate.ts');
const faces = read('src/kodeCoreShadowFaces.ts');
const pr012 = read('docs/kode2/pr-012.md');

const R3_SECTION = proposal.slice(proposal.indexOf('- [ ] R3'), proposal.indexOf('- [ ] R4'));

describe('Rust 骨架与 serving 状态拆分记录(IDE-RST-002)', () => {
  it('R3 行保留原目标且拆出三面状态', () => {
    // 原目标文字留档
    expect(R3_SECTION).toContain('definition/hover');
    expect(R3_SECTION).toContain('TS 侧保留对照');
    // 三面拆分在位
    expect(R3_SECTION, '缺「骨架已存在」面').toContain('骨架已存在');
    expect(R3_SECTION, '缺「未开放」面').toContain('未开放');
    expect(R3_SECTION, '缺切流门面').toContain('serveFromRust');
    expect(R3_SECTION).toContain('切流前置条件');
  });

  it('骨架面如实:自研 stdio 泵而非 tower-lsp,server crate 四能力链在档', () => {
    expect(R3_SECTION).toContain('kode-protocol');
    expect(R3_SECTION).toMatch(/stdio/);
    for (const capability of ['definition', 'hover', 'completion', 'diagnostics']) {
      expect(R3_SECTION, `缺能力链 ${capability}`).toContain(capability);
    }
    // 代码事实:kode-server 四个能力模块文件都在
    for (const module of ['definition.rs', 'hover.rs', 'completion.rs', 'diagnostics.rs']) {
      expect(() => read(`crates/kode-server/src/${module}`), `缺 ${module}`).not.toThrow();
    }
  });

  it('shadow 覆盖记录与 kodeCoreShadowFaces 实际 compare 面逐项相等', () => {
    const wired = new Set<string>();
    for (const match of faces.matchAll(/gate\.compare\('([^']+)'/g)) {
      wired.add(match[1]);
    }
    // 现实:definition + diagnostics 两面已接,hover/completion 未接
    expect(wired).toEqual(new Set(['textDocument/definition', 'textDocument/diagnostic']));
    expect(R3_SECTION).toContain('definition');
    expect(R3_SECTION).toContain('diagnostics');
    expect(R3_SECTION, 'hover 未接 shadow 必须记为未开放').toMatch(/hover[^。]{0,40}(未|不)/);
    expect(R3_SECTION, 'completion 未接 shadow 必须记为未开放').toMatch(/completion[^。]{0,40}(未|不)/);
  });

  it('serving 门禁与切流门在档且与现实一致', () => {
    // 代码事实:serveFromRust() 恒 false
    expect(gate).toMatch(/serveFromRust\(\): boolean\s*\{\s*return false;\s*\}/);
    expect(R3_SECTION).toContain('恒 false');
    expect(R3_SECTION).toContain('pr-012');
    // 切流前置清单在档且未全勾
    expect(pr012).toContain('切流前置条件清单');
    const unchecked = (pr012.match(/^- \[ \]/gm) ?? []).length;
    expect(unchecked, 'pr-012 前置清单应仍有未勾项(全勾则本测试与提案需同笔更新)').toBeGreaterThan(0);
  });
});
