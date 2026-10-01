import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// 扩展图标资产锁(批89:COMPLETED_FEATURES「创建扩展图标」收口)。
// assets/icon.svg 为矢量真源,assets/icon.png(256×256)为 Marketplace 图标,
// 两者均由 scripts/generate-icon.mjs 零依赖纯脚本自同源几何常量产出;
// 此处锁定:声明一致、PNG 结构合规、SVG 无字体依赖、产物与脚本字节同步。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconPng = path.join(root, 'assets', 'icon.png');
const iconSvg = path.join(root, 'assets', 'icon.svg');

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
) as {
  icon: string;
  contributes: {
    viewsContainers: { activitybar: Array<{ id: string; icon: string }> };
  };
};

describe('扩展图标资产', () => {
  it('package.json Marketplace 图标指向 assets/icon.png 且活动栏容器图标文件在位', () => {
    expect(pkg.icon).toBe('assets/icon.png');
    expect(fs.existsSync(iconPng)).toBe(true);
    expect(fs.existsSync(iconSvg)).toBe(true);

    // 活动栏 viewsContainer 图标本批未动,锁定其文件存在防静默破坏
    for (const container of pkg.contributes.viewsContainers.activitybar) {
      expect(
        fs.existsSync(path.join(root, container.icon)),
        `活动栏容器 ${container.id} 图标 ${container.icon} 应存在`
      ).toBe(true);
    }
  });

  it('PNG 为 ≥128×128 的 8-bit RGBA 合法图像', () => {
    const buf = fs.readFileSync(iconPng);
    expect(
      buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toBe(true);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBeGreaterThanOrEqual(128);
    expect(height).toBeGreaterThanOrEqual(128);
    expect(buf[24]).toBe(8); // 位深
    expect(buf[25]).toBe(6); // 颜色类型 RGBA
    expect(buf.length).toBeGreaterThan(8 + 25); // 结构非空
  });

  it('SVG 矢量真源几何自洽且无字体依赖', () => {
    const svg = fs.readFileSync(iconSvg, 'utf8');
    expect(svg).toContain('viewBox="0 0 256 256"');
    expect(svg).toContain('rx="56"');
    expect(svg).toContain('linearGradient');
    // K 字三笔(圆帽描边),不使用 <text>:渲染与字体环境无关
    expect(svg).toContain('stroke-linecap="round"');
    expect((svg.match(/M84 64 L84 192/) ?? [])[0]).toBeTruthy();
    expect(svg).not.toContain('<text');
  });

  it('重新生成产物与已提交资产字节同步(脚本与资产不漂移)', () => {
    const pngBefore = fs.readFileSync(iconPng);
    const svgBefore = fs.readFileSync(iconSvg);
    execFileSync(process.execPath, [path.join(root, 'scripts', 'generate-icon.mjs')], {
      cwd: root
    });
    expect(fs.readFileSync(iconPng).equals(pngBefore)).toBe(true);
    expect(fs.readFileSync(iconSvg).equals(svgBefore)).toBe(true);
  });
});
