import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// 扩展图标资产锁(批89 收口,批90 按用户点名改写):resources/logo.png 是
// 用户的设计资产,package.json Marketplace 图标与 README 展示均声明接线到
// 该文件。此处只锁声明接线与文件在位——不自行替换、不生成代餐(用户令:
// 缺设计资产直接问用户要)。批90 同时锁住两类已点名纠正的回归:README 不
// 得再引本地 SVG(vsce 打包禁令,CI 36813241293 红点)、不得再留虚构的
// Marketplace 安装途径。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logoPath = path.join(root, 'resources', 'logo.png');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  icon: string;
  contributes: {
    viewsContainers: { activitybar: Array<{ id: string; icon: string }> };
  };
};

describe('扩展图标资产(用户设计资源)', () => {
  it('package.json Marketplace 图标声明指向 resources/logo.png 且文件在位', () => {
    expect(pkg.icon).toBe('resources/logo.png');
    expect(fs.existsSync(logoPath)).toBe(true);
  });

  it('logo.png 为 ≥128 的 8-bit RGBA 合法 PNG(达 Marketplace 底线)', () => {
    const buf = fs.readFileSync(logoPath);
    expect(
      buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toBe(true);
    expect(buf.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(buf.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
    expect(buf[24]).toBe(8);
    expect(buf[25]).toBe(6);
  });

  it('活动栏 viewsContainer 图标声明的文件均在位', () => {
    for (const container of pkg.contributes.viewsContainers.activitybar) {
      expect(
        fs.existsSync(path.join(root, container.icon)),
        `活动栏容器 ${container.id} 图标 ${container.icon} 应存在`
      ).toBe(true);
    }
  });

  it('README 无本地 SVG 引用且无虚构的 Marketplace 安装途径(批90 点名回归锁)', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    // 本地(相对路径)SVG 引用违反 vsce 打包检查;shields.io 绝对 URL 徽章不受限
    // (批100 修正:7010811 把徽章改写为 HTML <img> 单行形态,原 <img[^>]+
    // src="[^"]+\.svg" 连绝对 URL 一并命中,与自身注释口径相悖——收敛为仅
    // 禁非 http(s) 的 src,HTML 形态同样受锁)
    expect(readme).not.toMatch(/<img[^>]+src="(?!https?:)[^"]+\.svg"/);
    expect(readme).not.toMatch(/\]\([^)]*assets\/[^)]*\.svg\)/);
    // 虚构上架途径:市场安装命令、市场搜索暗示(绝对 URL 徽章除外)
    expect(readme).not.toContain('install-extension cuihairu.kode');
    expect(readme).not.toContain('从 VSCode Marketplace 安装');
    expect(readme).not.toContain('搜索 `Kode');
  });
});
