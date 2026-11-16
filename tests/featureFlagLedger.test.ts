// RUST-245(旧 QA-016)守卫:feature flag 台账(docs/kode2/feature-flags.md)
// 锁两件事——台账里每个大型功能 flag 在 package.json 配置面真实存在(台账不
// 写幻影开关),且在 tests/ 有开关测试(台账不写无测试覆盖的开关)。台账
// 结构(保护的旧实现/移除条件/当前状态)一并锁定。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const LEDGER = path.resolve(__dirname, '../docs/kode2/feature-flags.md');
const THIS_FILE = __filename;

const collectTestFiles = (dir: string, out: string[]): void => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
};

describe('RUST-245 feature flag 台账守卫(旧 QA-016)', () => {
  const ledger = fs.readFileSync(LEDGER, 'utf8');

  it('台账存在且含移除闸四要素结构', () => {
    for (const heading of ['保护的旧实现', '移除条件', '当前状态', '移除闸机械面']) {
      expect(ledger.includes(heading), `台账缺结构要素: ${heading}`).toBe(true);
    }
  });

  it('台账里每个大型功能 flag 在配置面真实存在且 tests/ 有开关测试', () => {
    const flags = [...ledger.matchAll(/`(kbengine\.[a-zA-Z0-9.]+)`/g)].map(m => m[1]);
    const unique = [...new Set(flags)];
    expect(unique.length, '台账未登记任何 flag(账面失效)').toBeGreaterThan(0);
    expect(unique, '台账必须登记核心双轨开关 kbengine.core.backend').toContain('kbengine.core.backend');

    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const configs = Array.isArray(pkg.contributes?.configuration)
      ? pkg.contributes.configuration
      : pkg.contributes?.configuration
        ? [pkg.contributes.configuration]
        : [];
    const configKeys = new Set<string>();
    for (const config of configs) {
      for (const key of Object.keys(config?.properties ?? {})) {
        configKeys.add(key);
      }
    }
    expect(configKeys.size, 'package.json 贡献配置面为空(解析失效)').toBeGreaterThan(0);

    const testFiles: string[] = [];
    collectTestFiles(path.resolve(__dirname), testFiles);
    expect(testFiles.length, 'tests/ 收集为空(路径失效)').toBeGreaterThan(100);

    for (const flag of unique) {
      expect(
        configKeys.has(flag),
        `台账登记的 flag 在 package.json 无此配置键(幻影开关): ${flag}`
      ).toBe(true);
      const covered = testFiles.some(
        file => file !== THIS_FILE && fs.readFileSync(file, 'utf8').includes(flag)
      );
      expect(covered, `台账登记的 flag 在 tests/ 无开关测试提及: ${flag}`).toBe(true);
    }
  });

  it('核心开关三值与默认在台账账面如实(kill-switch 语义不漂移)', () => {
    expect(ledger.includes('`ts`'), '台账缺 ts(kill-switch)值').toBe(true);
    expect(ledger.includes('`rust`'), '台账缺 rust(服务轨道)值').toBe(true);
    expect(ledger.includes('`shadow`'), '台账缺 shadow(对拍)值').toBe(true);
    expect(ledger, '台账须记默认值 rust(2026-11-08 切流)').toContain('默认 `rust`');
    expect(ledger, '台账须记非法值回落 ts 的 kill-switch 语义').toContain('一律回落 `ts`');
  });
});
