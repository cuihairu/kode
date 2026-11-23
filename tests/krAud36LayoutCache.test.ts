import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDefinitionWorkspaceLayout,
  layoutCacheSizeForTests,
  resetDefinitionLayoutCacheForTests
} from '../src/definitionWorkspace';
import { setActiveProfileScanRoot } from '../src/scanRoots';
import { bumpRootConfigGeneration, resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';

// KR-AUD-36(IDX-12):getDefinitionWorkspaceLayout 布局解析缓存——键=根+
// rootConfigGeneration+布局输入 assetsBase(2026-11-23 起:entityDefsPath/
// entitiesXmlPath 配置项删除,布局由 assetsRoot 计算);命中复核探针(已解析
// 路径/首选候选存在性+发现选择记忆)翻转即重算。prove-red:未修复实现每次
// 调用全量重算。

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

  it('assetsBase 直变(不经 bump)进新键重算:不被旧布局污染(审核轮 P1)', () => {
    // 布局输入已从 entityDefsPath 配置读值换成 assetsBase(2026-11-23 用户令:
    // 目录固定由 assetsRoot 计算)——直变面用活动 profile 资产根驱动(解析链
    // 首位,免配置 stub; setActiveProfileScanRoot 测试面与 profile 接线同源)
    const root = makeLayoutRoot();
    const altBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36-alt-'));
    fs.mkdirSync(path.join(altBase, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(altBase, 'scripts', 'entity_defs', 'Avatar.def'), '<root/>');
    try {
      const first = getDefinitionWorkspaceLayout(root);
      expect(first.entityDefsRoot).toBe(path.join(root, 'scripts', 'entity_defs'));
      setActiveProfileScanRoot(altBase);
      const second = getDefinitionWorkspaceLayout(root);
      // 新键重算(assetsBase 入键,候选首项=altBase/scripts/entity_defs)
      expect(second.entityDefsRoot).toBe(path.join(altBase, 'scripts', 'entity_defs'));
      expect(layoutCacheSizeForTests()).toBeGreaterThanOrEqual(1);
    } finally {
      setActiveProfileScanRoot(null);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(altBase, { recursive: true, force: true });
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

  it('非首项高优先候选后建出触发重算:首项持续缺失,建首项被采纳(三轮判别版)', () => {
    // assetsBase=profile 根,候选序=[scripts/entity_defs(0), entity_defs(1), ...]
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36c-'));
    const altBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36d-'));
    try {
      // 初态:首项(altBase/scripts/entity_defs)缺失,仅 index1 存在 → 选中 index1
      fs.mkdirSync(path.join(altBase, 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(altBase, 'entity_defs', 'Avatar.def'), '<root/>');
      setActiveProfileScanRoot(altBase);
      const first = getDefinitionWorkspaceLayout(root);
      expect(first.entityDefsRoot).toBe(path.join(altBase, 'entity_defs'));
      // 后建 index0(比当前选中优先级更高、但此前缺失):一轮实现探针只含
      // 已选路径,不翻转 → 该实现此断言红;全列表探针翻转重算
      fs.mkdirSync(path.join(altBase, 'scripts', 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(altBase, 'scripts', 'entity_defs', 'Avatar.def'), '<root/>');
      const second = getDefinitionWorkspaceLayout(root);
      expect(second).not.toBe(first);
      expect(second.entityDefsRoot).toBe(path.join(altBase, 'scripts', 'entity_defs'));
    } finally {
      setActiveProfileScanRoot(null);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(altBase, { recursive: true, force: true });
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

  it('同代单槽:assetsBase A/B 反复切变条目数恒 ≤1(审核轮 P2 二轮)', () => {
    // 键内布局输入从配置读值换成 assetsBase(见上),切变面同换 profile 资产根
    const root = makeLayoutRoot();
    const altBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kraud36e-'));
    fs.mkdirSync(path.join(altBase, 'scripts', 'entity_defs'), { recursive: true });
    try {
      const withBase = (base: string | null): void => { setActiveProfileScanRoot(base); };
      withBase(root);
      getDefinitionWorkspaceLayout(root);
      for (let i = 0; i < 3; i += 1) {
        withBase(altBase);
        getDefinitionWorkspaceLayout(root);
        expect(layoutCacheSizeForTests()).toBe(1);
        withBase(root);
        getDefinitionWorkspaceLayout(root);
        expect(layoutCacheSizeForTests()).toBe(1);
      }
    } finally {
      setActiveProfileScanRoot(null);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(altBase, { recursive: true, force: true });
    }
  });
});
