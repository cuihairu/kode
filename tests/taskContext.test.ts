import { describe, expect, it } from 'vitest';
import {
  TEST_TASK_CONTEXT_STORAGE_KEY,
  captureTaskRunContext,
  compareTaskRunContexts,
  prepareTestRun,
  type TaskRunContext
} from '../src/taskContext';
import type { ProjectProfile } from '../src/projectProfiles';

// IDE-TSK-006 保存可重复运行的任务上下文:测试面板首次跑时快照
// profile 四要素(profileId/assetsRoot/engineRoot/解释器)存
// workspaceState;重跑钉住快照——活动 profile 切换/字段漂移只出提示
// 不换根,盘上根/解释器消失如实拒绝;换根唯一显式入口=跑一次
// kbengine.tests.list 重新捕获(验收:重跑同一 profile/解释器/环境,
// 不悄然换到另一个根)。

const PROFILE: ProjectProfile = {
  id: 'p1',
  displayName: '工程',
  assetsRoot: '/ws/proj/assets',
  engineRoot: '/ws/engine',
  interpreterPath: '/ws/py/python3',
  interpreterSource: 'setting'
};

const existsPaths = new Set(['/ws/proj/assets', '/ws/py/python3']);
const deps = { exists: (candidate: string): boolean => existsPaths.has(candidate) };

describe('captureTaskRunContext(全量快照)', () => {
  it('四要素逐字拷贝,之后改 profile 不影响已存上下文', () => {
    const context = captureTaskRunContext(PROFILE);
    expect(context).toEqual({
      profileId: 'p1',
      displayName: '工程',
      assetsRoot: '/ws/proj/assets',
      engineRoot: '/ws/engine',
      interpreterPath: '/ws/py/python3',
      interpreterSource: 'setting'
    });

    const mutated = { ...PROFILE, assetsRoot: '/other/assets' };
    expect(context.assetsRoot).toBe('/ws/proj/assets');
    void mutated;
  });

  it('存储键稳定(装配层与测试共用同一常量)', () => {
    expect(TEST_TASK_CONTEXT_STORAGE_KEY).toBe('kbengine.testTaskContext');
  });
});

describe('compareTaskRunContexts(漂移清单)', () => {
  it('一致为零漂移', () => {
    expect(compareTaskRunContexts(captureTaskRunContext(PROFILE), captureTaskRunContext(PROFILE))).toEqual([]);
  });

  it('根与解释器漂移各成一条点名', () => {
    const drifted: TaskRunContext = {
      ...captureTaskRunContext(PROFILE),
      assetsRoot: '/ws/other/assets',
      interpreterPath: '/ws/py2/python3'
    };
    const drifts = compareTaskRunContexts(captureTaskRunContext(PROFILE), drifted);
    expect(drifts).toHaveLength(2);
    expect(drifts.join('\n')).toContain('/ws/proj/assets');
    expect(drifts.join('\n')).toContain('/ws/py/python3');
  });

  it('引擎根漂移单独点名(四要素各自独立)', () => {
    const drifted: TaskRunContext = {
      ...captureTaskRunContext(PROFILE),
      engineRoot: '/ws/engine-other'
    };
    const drifts = compareTaskRunContexts(captureTaskRunContext(PROFILE), drifted);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain('引擎根:/ws/engine → /ws/engine-other');
  });
});

describe('prepareTestRun(重跑协议:钉住快照,换根必须显式)', () => {
  it('无已存上下文:捕获当前活动 profile 首跑', () => {
    const prepared = prepareTestRun(PROFILE, undefined, deps);
    expect(prepared.outcome).toBe('run');
    if (prepared.outcome === 'run') {
      expect(prepared.context.profileId).toBe('p1');
      expect(prepared.notes).toEqual([]);
    }
  });

  it('无活动 profile 且无已存:如实拒绝', () => {
    const prepared = prepareTestRun(null, undefined, deps);
    expect(prepared.outcome).toBe('refuse');
    if (prepared.outcome === 'refuse') {
      expect(prepared.message).toContain('活动 profile');
    }
  });

  it('活动 profile 已切换:重跑仍用已存上下文,提示如何显式换根', () => {
    const pinned = JSON.stringify(captureTaskRunContext(PROFILE));
    const other = { ...PROFILE, id: 'p2', assetsRoot: '/ws/other/assets' };
    existsPaths.add('/ws/other/assets');

    const prepared = prepareTestRun(other, pinned, deps);
    expect(prepared.outcome).toBe('run');
    if (prepared.outcome === 'run') {
      expect(prepared.context.profileId).toBe('p1');
      expect(prepared.context.assetsRoot).toBe('/ws/proj/assets');
      expect(prepared.notes.join('\n')).toContain('p1');
      expect(prepared.notes.join('\n')).toContain('kbengine.tests.list');
    }
  });

  it('同一 profile 字段漂移:仍用已存上下文,漂移点名进提示', () => {
    const pinned = JSON.stringify(captureTaskRunContext(PROFILE));
    const edited = { ...PROFILE, interpreterPath: '/ws/py-new/python3', interpreterSource: 'path' };
    existsPaths.add('/ws/py-new/python3');

    const prepared = prepareTestRun(edited, pinned, deps);
    expect(prepared.outcome).toBe('run');
    if (prepared.outcome === 'run') {
      expect(prepared.context.interpreterPath).toBe('/ws/py/python3');
      expect(prepared.notes.join('\n')).toContain('/ws/py/python3');
    }
  });

  it('已存根从盘上消失:如实拒绝点名根,不悄然换到别的根', () => {
    const pinned = JSON.stringify(captureTaskRunContext(PROFILE));
    const strictDeps = { exists: (candidate: string): boolean => candidate === '/ws/py/python3' };

    const prepared = prepareTestRun(PROFILE, pinned, strictDeps);
    expect(prepared.outcome).toBe('refuse');
    if (prepared.outcome === 'refuse') {
      expect(prepared.message).toContain('/ws/proj/assets');
      expect(prepared.message).toContain('不再存在');
    }
  });

  it('已存解释器从盘上消失:如实拒绝点名解释器', () => {
    const pinned = JSON.stringify(captureTaskRunContext(PROFILE));
    const strictDeps = { exists: (candidate: string): boolean => candidate === '/ws/proj/assets' };

    const prepared = prepareTestRun(PROFILE, pinned, strictDeps);
    expect(prepared.outcome).toBe('refuse');
    if (prepared.outcome === 'refuse') {
      expect(prepared.message).toContain('/ws/py/python3');
    }
  });

  it('已存上下文损坏(非 JSON):如实拒绝,不猜', () => {
    const prepared = prepareTestRun(PROFILE, '{oops', deps);
    expect(prepared.outcome).toBe('refuse');
    if (prepared.outcome === 'refuse') {
      expect(prepared.message).toContain('任务上下文');
    }
  });

  it('解释器缺失(null)的快照:按构建任务同一回退规则 python3,回退进提示', () => {
    const noInterpreter = { ...PROFILE, interpreterPath: null, interpreterSource: 'missing' };
    const pinned = JSON.stringify(captureTaskRunContext(noInterpreter));

    const prepared = prepareTestRun(noInterpreter, pinned, deps);
    expect(prepared.outcome).toBe('run');
    if (prepared.outcome === 'run') {
      expect(prepared.context.interpreterPath).toBeNull();
      expect(prepared.notes.join('\n')).toContain('python3');
    }
  });
});
