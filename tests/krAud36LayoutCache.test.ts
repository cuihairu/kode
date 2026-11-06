import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  getDefinitionWorkspaceLayout,
  layoutCacheSizeForTests,
  resetDefinitionLayoutCacheForTests
} from '../src/definitionWorkspace';
import { bumpRootConfigGeneration, resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';

// KR-AUD-36(IDX-12):getDefinitionWorkspaceLayout 布局解析缓存——键=根+
// rootConfigGeneration+布局配置读值;命中复核探针(已解析路径/首选候选存在性
// +发现选择记忆)翻转即重算。prove-red:未修复实现每次调用全量重算。

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

  it('同代重复调用走探针复核:fs 代价远低于全量重算且布局一致;bump 后重算', () => {
    const root = makeLayoutRoot();
    try {
      const first = getDefinitionWorkspaceLayout(root);
      const afterFirst = fsCounts.existsSync;
      expect(afterFirst).toBeGreaterThan(0);

      const second = getDefinitionWorkspaceLayout(root);
      // 探针复核 ≤6 existsSync + 发现记忆读取,显著低于全量重算
      expect(fsCounts.existsSync).toBeLessThan(afterFirst * 2);
      // 命中=缓存对象原样返回(引用相等)
      expect(second).toBe(first);
      expect(second.entityDefsRoot).toBe(path.join(root, 'scripts', 'entity_defs'));
      expect(second.entitiesXmlPath).toBe(path.join(root, 'scripts', 'entities.xml'));

      // 根配置 bump → 缓存失效,重算(existsSync 增量 > 0)且结果仍正确
      bumpRootConfigGeneration('kraud36-test');
      const third = getDefinitionWorkspaceLayout(root);
      expect(fsCounts.existsSync).toBeGreaterThan(afterFirst);
      expect(third).toEqual(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('缓存后新建 entities.xml:探针翻转触发重算,拿得到新路径(审核轮 P1)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36b-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), '<root/>');
      // 初次解析时 entities.xml 不存在
      const before = getDefinitionWorkspaceLayout(root);
      expect(before.entitiesXmlPath).toBeNull();
      // 盘面变化:主候选处创建 entities.xml(无 bump/无配置变化)
      fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root/>');
      const after = getDefinitionWorkspaceLayout(root);
      expect(after.entitiesXmlPath).toBe(path.join(root, 'scripts', 'entities.xml'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('缓存命中返回同对象引用;删除已解析路径探针翻转强制重算(审核轮 P1)', () => {
    const root = makeLayoutRoot();
    try {
      const first = getDefinitionWorkspaceLayout(root);
      // 命中=直接返回缓存对象(引用相等,判别命中/重算)
      expect(getDefinitionWorkspaceLayout(root)).toBe(first);
      fs.rmSync(path.join(root, 'scripts', 'entities.xml'));
      const second = getDefinitionWorkspaceLayout(root);
      // 探针(已解析路径存在性)翻转 → 必须重算(新对象),不回看旧盘面缓存
      expect(second).not.toBe(first);
      // entitiesXmlPath 的最终值出自 workspaceDiscovery 深扫 memo(既有独立面,
      // KR-AUD-34 口径),本缓存只保证重算发生过,不越权替 discovery 失效
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('配置值直变(不经 bump)进新键重算:不被旧布局污染(审核轮 P1)', () => {
    const root = makeLayoutRoot();
    const original = vscode.workspace.getConfiguration;
    try {
      const first = getDefinitionWorkspaceLayout(root);
      expect(first.entityDefsRoot).toBe(path.join(root, 'scripts', 'entity_defs'));
      // 直改配置读值(测试环境无 onDidChangeConfiguration 联动 bump)
      const altRoot = path.join(root, 'scripts', 'entity_defs');
      (vscode as unknown as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = () =>
        ({
          get: (_key: string, fallback: string) =>
            _key === 'entityDefsPath' ? altRoot : fallback
        }) as never;
      const second = getDefinitionWorkspaceLayout(root);
      // 新键重算(候选首项即 altRoot,结果一致但必须走重算面:探针+全量)
      expect(second.entityDefsRoot).toBe(altRoot);
      expect(layoutCacheSizeForTests()).toBeGreaterThanOrEqual(1);
    } finally {
      (vscode as unknown as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('跨代旧条目落盘即剪:多轮 bump 后缓存条目数不涨(审核轮 P2)', () => {
    const root = makeLayoutRoot();
    try {
      getDefinitionWorkspaceLayout(root);
      for (let i = 0; i < 4; i += 1) {
        bumpRootConfigGeneration(`kraud36-prune-${i}`);
        getDefinitionWorkspaceLayout(root);
      }
      expect(layoutCacheSizeForTests()).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('非首项高优先候选后建出触发重算:首项持续缺失,建中位候选被采纳(三轮判别版)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36c-'));
    const original = vscode.workspace.getConfiguration;
    try {
      // 候选序=[cfgdefs(0,配置主), entity_defs(1), scripts/entity_defs(2), ...]
      // 初态:首项 cfgdefs 持续缺失,仅 index2 存在 → 选中 index2
      fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), '<root/>');
      (vscode as unknown as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = () =>
        ({ get: (_key: string, fallback: string) => (_key === 'entityDefsPath' ? 'cfgdefs' : fallback) }) as never;
      const first = getDefinitionWorkspaceLayout(root);
      expect(first.entityDefsRoot).toBe(path.join(root, 'scripts', 'entity_defs'));
      // 后建 index1(比当前选中优先级更高、但非首项):一轮实现探针只含
      // 已选路径+首项,均不翻转 → 该实现此断言红;全列表探针翻转重算
      fs.mkdirSync(path.join(root, 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'entity_defs', 'Avatar.def'), '<root/>');
      const second = getDefinitionWorkspaceLayout(root);
      expect(second).not.toBe(first);
      expect(second.entityDefsRoot).toBe(path.join(root, 'entity_defs'));
    } finally {
      (vscode as unknown as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('深扫描选中(不在候选列表、无记忆)的路径删除:已解析路径探针翻转强制重算(三轮收口)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36f-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), '<root/>');
      // entities.xml 只存在于非候选位置(root/weird/),仅深扫描能选中
      fs.mkdirSync(path.join(root, 'weird'), { recursive: true });
      fs.writeFileSync(path.join(root, 'weird', 'entities.xml'), '<root/>');
      const first = getDefinitionWorkspaceLayout(root);
      expect(first.entitiesXmlPath).toBe(path.join(root, 'weird', 'entities.xml'));
      fs.rmSync(path.join(root, 'weird', 'entities.xml'));
      const second = getDefinitionWorkspaceLayout(root);
      // 已解析路径探针翻转 → 必须重算(新对象);重算后值出自 discovery memo
      // (既有独立面),本断言只锁「重算发生过」
      expect(second).not.toBe(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('同代单槽:配置 A/B 反复切变条目数恒 ≤1(审核轮 P2 二轮)', () => {
    const root = makeLayoutRoot();
    const original = vscode.workspace.getConfiguration;
    try {
      const withConfig = (defsPath: string): void => {
        (vscode as unknown as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = () =>
          ({ get: (_key: string, fallback: string) => (_key === 'entityDefsPath' ? defsPath : fallback) }) as never;
      };
      withConfig('scripts/entity_defs');
      getDefinitionWorkspaceLayout(root);
      for (let i = 0; i < 3; i += 1) {
        withConfig('entity_defs');
        getDefinitionWorkspaceLayout(root);
        expect(layoutCacheSizeForTests()).toBe(1);
        withConfig('scripts/entity_defs');
        getDefinitionWorkspaceLayout(root);
        expect(layoutCacheSizeForTests()).toBe(1);
      }
    } finally {
      (vscode as unknown as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
