import { describe, expect, it } from 'vitest';
import {
  materializeHotReloadGlobs,
  materializeHotReloadGlob,
  type HotReloadGlobsConfig
} from '../src/backend/hotReloadGlobsMaterialize';

// 热更 globs 默认值生成(用户令 2026-11-12):把派生口径的监视范围写进配置,
// 给用户可见可改的靶子。两条红线各有测试:
// - 形态:生成给绝对路径(显式 globs 走 createFileSystemWatcher,不展开
//   ${workspaceFolder},变量形态写回即静默失效);
// - 幂等:已显式写过(含空数组)一律不动,不覆盖用户意图。

const config = (raw: unknown, captured: unknown[] = []): HotReloadGlobsConfig => ({
  readRaw: () => raw,
  update: (patterns) => {
    captured.push(patterns);
    return Promise.resolve();
  }
});

describe('materializeHotReloadGlob(形态红线)', () => {
  it('资产根 → 绝对路径 + py 递归后缀', () => {
    expect(materializeHotReloadGlob('/ws/assets')).toBe('/ws/assets/**/*.py');
  });

  it('Windows 反斜杠与尾斜杠归一', () => {
    expect(materializeHotReloadGlob('C:\\ws\\assets\\')).toBe('C:/ws/assets/**/*.py');
  });

  it('空根 → 空串(调用方按缺根如实报错,绝不写全扫形态)', () => {
    expect(materializeHotReloadGlob('')).toBe('');
    expect(materializeHotReloadGlob('   ')).toBe('');
    // 裸斜杠归一后只剩空串,同样按缺根处理——不产出 `/**/*.py` 全扫形态
    expect(materializeHotReloadGlob('/')).toBe('');
  });

  it('绝不产出 ${workspaceFolder} 变量形态(派生口径不可写回)', () => {
    const pattern = materializeHotReloadGlob('/ws/assets');
    expect(pattern).not.toContain('${workspaceFolder}');
  });
});

describe('materializeHotReloadGlobs(幂等与守口)', () => {
  const depsOf = (raw: unknown, root = '/ws/assets') => {
    const captured: unknown[] = [];
    return {
      deps: { config: config(raw, captured), resolveAssetsRoot: () => root },
      captured
    };
  };

  it('未写 globs → 生成并写回绝对路径形态', async () => {
    const { deps, captured } = depsOf(undefined);
    const result = await materializeHotReloadGlobs(deps);
    expect(result.written).toBe('/ws/assets/**/*.py');
    expect(captured).toEqual([['/ws/assets/**/*.py']]);
  });

  it('已显式配置(含空数组=显式不监视)→ 不动,不覆盖用户意图', async () => {
    const { deps, captured } = depsOf([]);
    expect((await materializeHotReloadGlobs(deps)).skipped).toBe('explicit');
    expect(captured).toEqual([]);

    const explicit = depsOf(['/other/**/*.py']);
    expect((await materializeHotReloadGlobs(explicit.deps)).skipped).toBe('explicit');
    expect(explicit.captured).toEqual([]);
  });

  it('类型写坏(非数组)按未写处理 → 生成覆盖', async () => {
    const { deps, captured } = depsOf('not-an-array');
    expect((await materializeHotReloadGlobs(deps)).written).toBe('/ws/assets/**/*.py');
    expect(captured).toEqual([['/ws/assets/**/*.py']]);
  });

  it('未写但解不到资产根 → 不写空值,如实跳过', async () => {
    const { deps, captured } = depsOf(undefined, '');
    expect((await materializeHotReloadGlobs(deps)).skipped).toBe('no-assets-root');
    expect(captured).toEqual([]);
  });
});