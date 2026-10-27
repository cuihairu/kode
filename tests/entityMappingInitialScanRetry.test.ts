import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  IndexScheduler,
  IndexTaskHandle,
  IndexTaskKind,
  IndexTaskSpec,
  IndexTaskState
} from '../src/indexScheduler';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// 实体首扫失败重试回归(审核发现 :182):修复前 keyed 任务只启动真实扫描便
// 宣告完成(单槽调度器下这是刻意设计——首扫分块要作为独立后台任务插队),
// 真实扫描的失败被链尾 `.then(onFailure: () => resolve())` 静默转成「成功的
// initialScan」:等待者放行的永远是残缺快照,且调度器对 failed keyed 条目的
// 重排语义(A3-4)接不到实体扫描——树没坏时的一次性失败让整仓类永久缺席。
// 修复后:失败态显式记账(initialScanFailed),对象级冷查询入口有界重触发
// (MAX_INITIAL_SCAN_ATTEMPTS 次),成功补置完成位。

/**
 * 首扫注入器:让第 N 次 full-reindex 分块崩溃(其余原样透传)。
 * 实体首扫以 8 文件一分块入队;单分块拒绝即整扫 Promise.all 拒绝。
 */
class FailChunkScheduler extends IndexScheduler {
  private failRounds: number;
  failedChunks = 0;
  executedChunks = 0;

  constructor(failRounds: number) {
    super();
    this.failRounds = failRounds;
  }

  override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (spec.kind !== 'full-reindex') {
      return super.enqueue(spec);
    }
    if (this.failRounds > 0) {
      this.failRounds -= 1;
      this.failedChunks += 1;
      return super.enqueue({ ...spec, run: async () => { throw new Error('injected chunk crash'); } });
    }
    this.executedChunks += 1;
    return super.enqueue(spec);
  }
}

type ManagerInternals = {
  initialScanCompleted: boolean;
  initialScanFailed: boolean;
  initialScanAttempts: number;
  mappingIndexes: Map<string, unknown>;
};

const waitUntil = async (probe: () => boolean, what: string, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const writeWorkspace = (dir: string): void => {
  const hero = path.join(dir, 'scripts', 'entity_defs', 'Hero.def');
  fs.mkdirSync(path.dirname(hero), { recursive: true });
  fs.writeFileSync(hero, [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
};

describe('EntityMappingManager 首扫失败重试(审核发现 :182)', () => {
  it('首扫失败不转成功:失败态记账,冷查询重触发后补置完成位', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-emsretry-'));
    writeWorkspace(dir);
    const heroAbsolute = path.join(dir, 'scripts', 'entity_defs', 'Hero.def');
    const oldFolders = stubWorkspace.workspaceFolders;
    const oldFindFiles = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (pattern?: string) => {
      const p = String(pattern ?? '');
      if (p.endsWith('*.def')) { return [Uri.file(heroAbsolute)]; }
      return [];
    }) as typeof stubWorkspace.findFiles;
    try {
      const scheduler = new FailChunkScheduler(1);
      const manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
      const internals = manager as unknown as ManagerInternals;
      // 首扫分块被注入崩溃 → 真实扫描失败
      await waitUntil(() => scheduler.failedChunks === 1, 'first chunk crash');
      await waitUntil(() => internals.initialScanFailed, 'initialScanFailed booked');
      // 修复前:失败被静默转成功——没有失败态,后续查询永远拿残缺快照
      expect(internals.initialScanCompleted, '失败不得置完成位').toBe(false);
      expect(internals.initialScanAttempts).toBe(1);

      // 对象级冷查询:入口即重触发(第 2 次尝试)→ 分块这次真跑 → 成功补置完成位
      // (查询本身可走定向按需加载先行命中,不影响首扫完成位语义)
      await manager.resolvePropertyDefinitionForClass('Hero', 'hp');
      await waitUntil(() => internals.initialScanCompleted, 'retry completes scan', 8000);
      expect(internals.initialScanAttempts).toBe(2);
      expect(scheduler.executedChunks).toBeGreaterThanOrEqual(1);
      // 重试成功后 Hero 可经对象级解析命中(残缺快照自愈)
      const hit = await manager.resolvePropertyDefinitionForClass('Hero', 'hp');
      expect(hit, '重试成功后 Hero 必须可命中').not.toBeNull();
      expect(path.basename(hit!.defFile)).toBe('Hero.def');
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = oldFindFiles;
      stubWorkspace.workspaceFolders = oldFolders;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('持续失败的重触发有界:达到上限后冷查询不再重排扫描', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-emsbound-'));
    writeWorkspace(dir);
    const heroAbsolute = path.join(dir, 'scripts', 'entity_defs', 'Hero.def');
    const oldFolders = stubWorkspace.workspaceFolders;
    const oldFindFiles = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (pattern?: string) => {
      const p = String(pattern ?? '');
      if (p.endsWith('*.def')) { return [Uri.file(heroAbsolute)]; }
      return [];
    }) as typeof stubWorkspace.findFiles;
    try {
      const scheduler = new FailChunkScheduler(Number.MAX_SAFE_INTEGER);
      const manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
      const internals = manager as unknown as ManagerInternals;
      await waitUntil(() => internals.initialScanAttempts === 1, 'first attempt', 8000);
      // 每轮冷查询重排一次,直到 3 次尝试上限(之后树真坏也不无限打转);
      // 查询可走定向加载先行返回,重排是入口副作用,不依赖查询落空
      const capStart = Date.now();
      while (internals.initialScanAttempts < 3) {
        if (Date.now() - capStart > 8000) {
          throw new Error('timeout waiting for attempts reach cap');
        }
        await manager.resolvePropertyDefinitionForClass('Hero', 'hp');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const attemptsAtCap = internals.initialScanAttempts;
      expect(attemptsAtCap).toBe(3);
      expect(internals.initialScanCompleted).toBe(false);
      // 上限后:再查不再增加尝试(有界),负缓存闸保持关闭(不得基于残缺快照记 miss)
      const chunksBefore = scheduler.failedChunks;
      await manager.resolvePropertyDefinitionForClass('Hero', 'hp');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(internals.initialScanAttempts).toBe(attemptsAtCap);
      expect(scheduler.failedChunks).toBe(chunksBefore);
      expect((manager as unknown as { missingClassNames: Set<string> }).missingClassNames.has('Hero'))
        .toBe(false);
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = oldFindFiles;
      stubWorkspace.workspaceFolders = oldFolders;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
