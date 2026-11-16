import { describe, expect, it } from 'vitest';
import {
  PROFILE_HEALTH_ISSUE_LABELS,
  collectProfileHealth,
  type ProfileHealthDeps
} from '../src/profileHealth';
import type { ProjectProfile } from '../src/projectProfiles';
import { IndexScheduler } from '../src/backend/indexScheduler';

// RUST-187:Project Doctor 的索引状态面——健康汇总第五类「索引停滞」。
// 判定与调度面同源(IndexScheduler.getStatus 计数):有终态失败任务
// (failed>0)才报,排队/运行中属正常推进不打扰;探针缺省或返回 null
// = 面不可用,如实不判定不冒充。入口给「重启窗口重建索引」。

const healthyProfile: ProjectProfile = {
  id: 'id-idx',
  displayName: 'proj',
  assetsRoot: '/ws/proj',
  engineRoot: '/ws/kbe',
  interpreterPath: '/opt/py/python3',
  interpreterSource: 'path'
};

const activeServiceFacts = {
  registered: true,
  isActive: true,
  installDirExists: true,
  extraPathsWritten: true
};

function baseDeps(): ProfileHealthDeps {
  return { exists: () => true };
}

describe('index-stalled health check (RUST-187)', () => {
  it('failed>0 时报索引停滞,消息带三计数,入口指向重启窗口', () => {
    const issues = collectProfileHealth(healthyProfile, activeServiceFacts, {
      ...baseDeps(),
      indexStatus: () => ({ failed: 2, queued: 1, running: 0 })
    });
    const stalled = issues.filter(issue => issue.kind === 'index-stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].message).toContain('失败 2');
    expect(stalled[0].message).toContain('排队 1');
    expect(stalled[0].entry.target).toBe('workbench.action.reloadWindow');
    expect(PROFILE_HEALTH_ISSUE_LABELS['index-stalled']).toBe('索引停滞');
  });

  it('failed=0 时排队/运行属正常推进,零打扰', () => {
    const issues = collectProfileHealth(healthyProfile, activeServiceFacts, {
      ...baseDeps(),
      indexStatus: () => ({ failed: 0, queued: 3, running: 1 })
    });
    expect(issues.filter(issue => issue.kind === 'index-stalled')).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });

  it('探针缺省或返回 null = 面不可用,不冒充判定', () => {
    const withoutProbe = collectProfileHealth(healthyProfile, activeServiceFacts, baseDeps());
    expect(withoutProbe.filter(issue => issue.kind === 'index-stalled')).toHaveLength(0);

    const probeNull = collectProfileHealth(healthyProfile, activeServiceFacts, {
      ...baseDeps(),
      indexStatus: () => null
    });
    expect(probeNull.filter(issue => issue.kind === 'index-stalled')).toHaveLength(0);
  });

  it('索引停滞排在四类环境问题之后(顺序固定末位)', () => {
    const brokenProfile: ProjectProfile = {
      ...healthyProfile,
      assetsRoot: '/gone',
      engineRoot: '',
      interpreterPath: null
    };
    const issues = collectProfileHealth(
      brokenProfile,
      { registered: false, isActive: false, installDirExists: false, extraPathsWritten: false },
      {
        exists: () => false,
        indexStatus: () => ({ failed: 1, queued: 0, running: 0 })
      }
    );
    expect(issues).toHaveLength(5);
    expect(issues[issues.length - 1].kind).toBe('index-stalled');
  });

  it('与调度面同源:真调度器失败任务驱动停滞判定', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 0 });
    const handle = scheduler.enqueue({
      kind: 'file',
      priority: 10,
      run: async () => {
        throw new Error('boom');
      }
    });
    await handle.wait.catch(() => undefined);
    const status = scheduler.getStatus();
    expect(status.failed).toBe(1);
    const issues = collectProfileHealth(healthyProfile, activeServiceFacts, {
      ...baseDeps(),
      indexStatus: () => scheduler.getStatus()
    });
    expect(issues.filter(issue => issue.kind === 'index-stalled')).toHaveLength(1);
  });

  it('wire 形状回钉:running 是活动任务对象,消息渲染 运行 1 而非 [object Object]', () => {
    // mock-vs-wire 漂移回钉:单测 mock 曾把 running 当数字,线上
    // SchedulerStatus.running 是活动任务对象(RUST-219 侦察发现),
    // 消息面按活动任务归一成 0/1,不得把对象插值进文案。
    const wireStatus = {
      failed: 1,
      queued: 2,
      running: { id: 7, kind: 'file' as const, priority: 10 }
    };
    const issues = collectProfileHealth(healthyProfile, activeServiceFacts, {
      ...baseDeps(),
      indexStatus: () => wireStatus
    });
    const stalled = issues.filter(issue => issue.kind === 'index-stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].message).toContain('运行 1');
    expect(stalled[0].message).not.toContain('object Object');
  });
});
