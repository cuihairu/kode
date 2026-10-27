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

// 对象级(类粒度)负缓存回归(审核发现):修复前负缓存只凭「映射表非空」就
// 记录 miss——首扫尚未完成时,后续分块里的接口/组件类会经 ownerName 回溯
// 命中,却被提前记入 missingClassNames 永久误判为不存在(负缓存只在 .def
// 变更时清理,不会自愈)。修复后负缓存只在首扫成功落地后发布。
//
// 复现口径取自真实数据流:组件类不单独建索引(全量扫过滤 /components/、
// 定向解析同排除),只能经 ownerName 回溯到引用它的实体索引,组件属性以
// 槽名挂在实体索引里(identity.propertyPath = 槽名 healthPack,与悬停
// self.healthPack 的 member-access 同口径)。

/** Hero 实体:引用组件 HealthComp(槽名 healthPack)。 */
const HERO_DEF = [
  '<root>',
  '  <Components>',
  '    <healthPack>',
  '      <Type>HealthComp</Type>',
  '    </healthPack>',
  '  </Components>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

/** 组件自身 def:属性 regen(在 Hero 索引里以 healthPack.regen 出现)。 */
const HEALTH_COMP_DEF = [
  '<root>',
  '  <Properties>',
  '    <regen>',
  '      <Type>UINT32</Type>',
  '    </regen>',
  '  </Properties>',
  '</root>'
].join('\n');

/**
 * 分块闸:full-reindex 任务在 allowNext(n) 之前扣住(不执行),其余任务原样
 * 透传。首个分块(8 个 filler)先放行、第二个分块(Hero)后放行,复现
 * 「映射表非空但首扫未完」的中间态。
 */
class ChunkGateScheduler extends IndexScheduler {
  private allowed = 0;
  private holdQueue: Array<() => void> = [];
  private settled = 0;

  allowNext(count: number): void {
    this.allowed += count;
    this.flush();
  }

  private flush(): void {
    while (this.allowed > 0 && this.holdQueue.length > 0) {
      this.allowed -= 1;
      this.holdQueue.shift()!();
    }
  }

  get settledCount(): number {
    return this.settled;
  }

  override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (spec.kind !== 'full-reindex') {
      return super.enqueue(spec);
    }
    const release = new Promise<void>(resolve => { this.holdQueue.push(resolve); });
    this.flush();
    const wait = release
      .then(() => super.enqueue({ ...spec, run: async () => { await spec.run(); } }))
      .then(handle => handle.wait);
    wait.then(
      () => { this.settled += 1; },
      () => { this.settled += 1; }
    );
    wait.catch(() => undefined);
    return { id: -1, wait, cancel: () => undefined, state: () => 'queued' as IndexTaskState };
  }
}

const waitForSettles = async (scheduler: ChunkGateScheduler, target: number, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (scheduler.settledCount < target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`scheduler chunk did not settle (settled=${scheduler.settledCount}, want=${target})`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const pollFor = async (probe: () => Promise<unknown>, timeoutMs = 2000): Promise<unknown> => {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) { return value; }
    if (Date.now() - start > timeoutMs) { return null; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

describe('EntityMappingManager 对象级负缓存(首扫未完不得凭表非空记 miss)', () => {
  it('首扫进行中的接口/组件类 miss 不落死,首扫落地后经 ownerName 回溯命中', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-objnegcache-'));
    const fillers = Array.from({ length: 8 }, (_, offset) => {
      const name = `Filler${offset}`;
      const relative = path.join('scripts', 'entity_defs', `${name}.def`);
      const absolute = path.join(dir, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '<root><Properties/></root>', 'utf8');
      return { name, absolute };
    });
    const heroAbsolute = path.join(dir, 'scripts', 'entity_defs', 'Hero.def');
    fs.mkdirSync(path.dirname(heroAbsolute), { recursive: true });
    fs.writeFileSync(heroAbsolute, HERO_DEF, 'utf8');
    const compAbsolute = path.join(dir, 'scripts', 'entity_defs', 'components', 'HealthComp.def');
    fs.mkdirSync(path.dirname(compAbsolute), { recursive: true });
    fs.writeFileSync(compAbsolute, HEALTH_COMP_DEF, 'utf8');
    // 组件类的 ownerName 回溯经 pythonOwnerFiles 注册:候选路径之一
    // scripts/cell/components/HealthComp.py 需在盘上存在
    const compPy = path.join(dir, 'scripts', 'cell', 'components', 'HealthComp.py');
    fs.mkdirSync(path.dirname(compPy), { recursive: true });
    fs.writeFileSync(compPy, 'class HealthComp:\n\tdef regen_now(self):\n\t\treturn 0\n', 'utf8');

    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    // 全量 def glob 按 8 filler → Hero 顺序返回(分块1=filler,分块2=Hero);
    // 定点 glob 按同名返回;非 def glob 空。组件在 components/ 下,被扫描
    // 的 entities 过滤与定向解析的目录排除一并拒之门外(只能经回溯命中)。
    const defOrder = [...fillers.map(item => item.absolute), heroAbsolute];
    stubWorkspace.findFiles = (async (pattern?: string) => {
      const p = String(pattern ?? '');
      if (p.includes('*.py')) { return []; }
      if (p.endsWith('*.def')) { return defOrder.map(file => Uri.file(file)); }
      const base = p.replace(/\*\*\//, '');
      if (base.endsWith('.def')) {
        const match = defOrder.find(file => path.basename(file) === base);
        return match ? [Uri.file(match)] : [];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;

    try {
      const scheduler = new ChunkGateScheduler();
      const manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
      const managerDebug = manager as unknown as {
        mappingIndexes: Map<string, unknown>;
        missingClassNames: Set<string>;
        semanticIndex: {
          findEntityByClassName: (className: string) => { defFile: string } | null;
          entitiesByClassName: Map<string, unknown>;
        };
      };

      // 放行第一个分块(8 个 filler)→ 映射表并入、首扫仍推进(Hero 分块扣住)
      scheduler.allowNext(1);
      await waitForSettles(scheduler, 1);
      expect([...managerDebug.mappingIndexes.keys()])
        .toEqual(expect.arrayContaining(fillers.map(item => item.name)));

      // 中间态:映射表非空,但首扫未落地。HealthComp 此时确实是 miss——
      // 但修复前这一查会把 HealthComp 记入 missingClassNames 永久落死。
      // 查询路径取槽名 healthPack:组件属性在实体索引里以槽名(单段)出现,
      // 悬停 self.healthPack 即走此路径(与产品 member-access 同口径)。
      expect(await manager.resolvePropertyDefinitionForClass('HealthComp', 'healthPack'))
        .toBeNull();
      expect(managerDebug.missingClassNames.has('HealthComp'),
        '首扫进行中不得发布对象级负缓存')
        .toBe(false);

      // 放行第二个分块(Hero 解析 → HealthComp 经 ownerName 回溯可命中)
      scheduler.allowNext(1);
      await waitForSettles(scheduler, 2);
      // 等 initialScan 落地(负缓存闸门放开的时点)
      const hit = await pollFor(
        () => manager.resolvePropertyDefinitionForClass('HealthComp', 'healthPack'));
      // 修复前:HealthComp 已被负缓存,首扫落地后仍 null(永久误判)。
      expect(hit, '首扫落地后 HealthComp 必须经 ownerName 回溯命中,不得被负缓存误判')
        .not.toBeNull();
      expect(managerDebug.missingClassNames.has('HealthComp')).toBe(false);
      // 组件类不单独建索引:取到的仍是 owner 实体索引,属性落在组件 def
      const located = hit as { defFile: string; line: number; identity: { ownerName: string; propertyPath: string } };
      expect(path.basename(located.defFile)).toBe('HealthComp.def');
      expect(located.identity.ownerName).toBe('HealthComp');
      expect(located.identity.propertyPath).toBe('healthPack');
      expect(managerDebug.semanticIndex.findEntityByClassName('HealthComp')).not.toBeNull();
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
