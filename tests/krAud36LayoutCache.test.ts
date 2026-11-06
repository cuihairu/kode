import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefinitionWorkspaceLayout, resetDefinitionLayoutCacheForTests } from '../src/definitionWorkspace';
import { bumpRootConfigGeneration, resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';

// KR-AUD-36(IDX-12):getDefinitionWorkspaceLayout 布局解析无缓存——悬停热路径
// (languageProviders.ts 等)每次调用都重新 existsSync 一整串候选+发现兜底扫描。
// 要求:按 rootConfigGeneration 键控缓存——同代内重复调用零 existsSync 增量,
// bump 后重算。prove-red:未修复实现第二次调用 existsSync 增量 > 0。

const fsCounts = vi.hoisted(() => ({ existsSync: 0 }));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: ((p: fs.PathLike) => {
      fsCounts.existsSync += 1;
      return actual.existsSync(p);
    }) as typeof fs.existsSync
  };
});

const makeLayoutRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), '<root> <Avatar/> </root>');
  fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root/>');
  return root;
};

describe('KR-AUD-36 布局解析按 rootConfigGeneration 缓存', () => {
  afterEach(() => {
    resetDefinitionLayoutCacheForTests();
    resetRootConfigGenerationForTests();
    fsCounts.existsSync = 0;
    vi.restoreAllMocks();
  });

  it('同代重复调用零 existsSync 增量且布局一致;bump 后重算', () => {
    const root = makeLayoutRoot();
    try {
      const first = getDefinitionWorkspaceLayout(root);
      const afterFirst = fsCounts.existsSync;
      expect(afterFirst).toBeGreaterThan(0);

      const second = getDefinitionWorkspaceLayout(root);
      expect(fsCounts.existsSync).toBe(afterFirst);
      expect(second).toEqual(first);
      expect(second.entityDefsRoot).toBe(path.join(root, 'scripts', 'entity_defs'));

      // 根配置 bump → 缓存失效,重算(existsSync 增量 > 0)且结果仍正确
      bumpRootConfigGeneration('kraud36-test');
      const third = getDefinitionWorkspaceLayout(root);
      expect(fsCounts.existsSync).toBeGreaterThan(afterFirst);
      expect(third).toEqual(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
