import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 激活期分阶段计时(KODE-PERF 激活排查):PROFILE_OUT 在模块载入时读环境
// 变量,故每个用例 vi.stubEnv + resetModules 动态导入拿独立实例。验收面:
// mark→flush 落盘 step/total 行;未设环境变量/无标记全直通零副作用;
// 落盘失败(目标不可写)被吞且标记复位,不影响激活。

describe('activationProfile(激活分阶段计时落盘)', () => {
  let outPath = '';
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-activate-profile-'));
    outPath = path.join(dir, 'profile.tsv');
    vi.resetModules();
  });

  it('设环境变量:mark 两段 flush 落盘 step/total;清空后二次 flush 零追加', async () => {
    vi.stubEnv('KODE_ACTIVATE_PROFILE_OUT', outPath);
    const mod = await import('../src/activationProfile');
    mod.markActivateStage('views');
    mod.markActivateStage('commands');
    mod.flushActivateProfile();
    const text = fs.readFileSync(outPath, 'utf8');
    const rows = text.trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('stage\tviews\tstep=');
    expect(rows[0]).toContain('total=');
    expect(rows[1]).toContain('stage\tcommands\tstep=');
    // 标记已复位:再次 flush 零追加(文件不变)
    mod.flushActivateProfile();
    expect(fs.readFileSync(outPath, 'utf8')).toBe(text);
  });

  it('无标记 flush 直通:不创建输出文件', async () => {
    vi.stubEnv('KODE_ACTIVATE_PROFILE_OUT', outPath);
    const mod = await import('../src/activationProfile');
    mod.flushActivateProfile();
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('落盘失败(输出指向目录)被吞:不抛错且标记复位', async () => {
    vi.stubEnv('KODE_ACTIVATE_PROFILE_OUT', dir);
    const mod = await import('../src/activationProfile');
    expect(() => {
      mod.markActivateStage('views');
      mod.flushActivateProfile();
    }).not.toThrow();
    // 标记已复位:即便随后把输出改回可写路径也无历史标记可写
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    mod.flushActivateProfile();
    expect(fs.existsSync(path.join(dir, 'profile.tsv'))).toBe(false);
  });

  it('未设环境变量:mark/flush 全直通零副作用', async () => {
    vi.stubEnv('KODE_ACTIVATE_PROFILE_OUT', '');
    const mod = await import('../src/activationProfile');
    expect(() => {
      mod.markActivateStage('views');
      mod.flushActivateProfile();
    }).not.toThrow();
    expect(fs.existsSync(outPath)).toBe(false);
  });
});
