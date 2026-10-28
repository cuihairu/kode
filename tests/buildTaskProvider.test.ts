import { describe, expect, it } from 'vitest';
import { KbengineBuildTaskProvider, BUILD_TASK_SOURCE } from '../src/buildTaskProvider';
import { BUILD_TASK_TYPE } from '../src/buildTaskSpec';
import { ProcessExecution, Task, TaskScope } from './helpers/vscodeStub';

// IDE-TSK-002 构建 TaskProvider:任务列表(Run Task)逐 profile 出一条
// 脚本编译检查任务——Task 的 definition/name/source 与执行四要素全部
// 来自 TSK-001 的 spec;resolveTask 按 tasks.json 里的 profileId 反解。
// 取消终止对应执行由 ProcessExecution 的平台行为承担(VS Code 任务
// 面板终止即杀进程树),如实写明不冒领。

const profiles = [
  {
    id: 'p-1',
    displayName: '主工程',
    assetsRoot: '/ws/demo/assets',
    interpreterPath: '/usr/bin/python3.12'
  },
  {
    id: 'p-2',
    displayName: '外网服',
    assetsRoot: '/ws/online/assets',
    interpreterPath: null
  }
];

describe('KbengineBuildTaskProvider(任务列表构建项,DBG 之外的新面)', () => {
  it('逐 profile 一条任务:definition 带 profileId,执行四要素来自 spec', () => {
    const provider = new KbengineBuildTaskProvider({ getProfiles: () => profiles });

    const tasks = provider.provideTasks();

    expect(tasks).toHaveLength(2);
    const first = tasks[0];
    expect(first.definition).toEqual({ type: BUILD_TASK_TYPE, profileId: 'p-1' });
    expect(first.name).toContain('主工程');
    expect(first.source).toBe(BUILD_TASK_SOURCE);
    expect(first.scope).toBe(TaskScope.Workspace);
    const execution = first.execution as ProcessExecution;
    expect(execution.process).toBe('/usr/bin/python3.12');
    expect(execution.args).toEqual(['-m', 'compileall', '-q', '/ws/demo/assets/scripts']);
    expect(execution.options?.cwd).toBe('/ws/demo/assets');
    expect(execution.options?.env).toEqual({ PYTHONUTF8: '1' });
  });

  it('无解释器的 profile:任务执行面回退 python3(与 spec 同口径)', () => {
    const provider = new KbengineBuildTaskProvider({ getProfiles: () => profiles });

    const second = provider.provideTasks()[1];

    expect((second.execution as ProcessExecution).process).toBe('python3');
    expect(second.name).toContain('外网服');
  });

  it('resolveTask:tasks.json 条目按 profileId 反解到该 profile 的任务', () => {
    const provider = new KbengineBuildTaskProvider({ getProfiles: () => profiles });

    const resolved = provider.resolveTask(
      new Task({ type: BUILD_TASK_TYPE, profileId: 'p-2' }, TaskScope.Workspace, '从 tasks.json 来', 'kode')
    );

    expect(resolved).toBeDefined();
    expect((resolved!.execution as ProcessExecution).options?.cwd).toBe('/ws/online/assets');
    expect(resolved!.name).toContain('外网服');
  });

  it('resolveTask:未知 profileId/缺 profileId 如实 undefined(不猜)', () => {
    const provider = new KbengineBuildTaskProvider({ getProfiles: () => profiles });

    expect(
      provider.resolveTask(
        new Task({ type: BUILD_TASK_TYPE, profileId: 'nope' }, TaskScope.Workspace, 'x', 'kode')
      )
    ).toBeUndefined();
    expect(
      provider.resolveTask(new Task({ type: BUILD_TASK_TYPE }, TaskScope.Workspace, 'x', 'kode'))
    ).toBeUndefined();
  });
});
