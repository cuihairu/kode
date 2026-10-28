import { describe, expect, it } from 'vitest';
import {
  isDependencySatisfied,
  resolveLaunchOrder,
  type DependencyReadyState,
  type LaunchTargetSpec
} from '../src/launchDependencies';
import { SERVER_COMPONENTS } from '../src/serverManager';

// IDE-RUN-005 启动项直接依赖声明:LaunchTargetSpec.dependsOn 声明直接依赖,
// resolveLaunchOrder 拓扑排序(可检测环并报告环路径);isDependencySatisfied
// 是唯一「依赖成功」判据——记录存在且 status=Running 才算就绪,Starting/
// 缺席/放弃等待一律不算成功(不会被当作已满足)。

const spec = (key: string, ...dependsOn: string[]): LaunchTargetSpec => ({ key, dependsOn });

describe('resolveLaunchOrder', () => {
  it('orders the canonical component chain with every dependency first', () => {
    // 用真实 SERVER_COMPONENTS 声明:输入乱序,输出必须满足依赖先行
    const shuffled = [...SERVER_COMPONENTS].reverse();
    const targets = shuffled.map(component => ({
      key: component.name,
      dependsOn: [...(component.dependsOn ?? [])]
    }));

    const result = resolveLaunchOrder(targets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const position = new Map(result.order.map((key, index) => [key, index]));
    for (const component of SERVER_COMPONENTS) {
      for (const dependency of component.dependsOn ?? []) {
        expect(position.get(dependency), `${dependency} 应在 ${component.name} 之前`).toBeLessThan(
          position.get(component.name) as number
        );
      }
    }
    // machine 是全链根,必须排第一
    expect(result.order[0]).toBe('machine');
  });

  it('detects a cycle and reports the cycle path', () => {
    const result = resolveLaunchOrder([
      spec('a', 'c'),
      spec('b', 'a'),
      spec('c', 'b')
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('cycle');
    if (result.kind !== 'cycle') return;
    expect(result.cycle[0]).toBe(result.cycle.at(-1));
    expect([...result.cycle].slice(0, -1).sort()).toEqual(['a', 'b', 'c']);
  });

  it('detects a self-dependency as a one-node cycle', () => {
    const result = resolveLaunchOrder([spec('a', 'a'), spec('b')]);
    expect(result).toEqual({ ok: false, kind: 'cycle', cycle: ['a', 'a'] });
  });

  it('allows dependencies outside the launch group as runtime gates', () => {
    // 只启动 baseapp:其依赖 dbmgr/baseappmgr 不在本组,排序照常,就绪与否留给运行期判定
    const result = resolveLaunchOrder([spec('baseapp', 'baseappmgr'), spec('cellapp', 'cellappmgr')]);
    expect(result).toEqual({ ok: true, order: ['baseapp', 'cellapp'] });
  });

  it('breaks ties by input order for independent targets', () => {
    const result = resolveLaunchOrder([spec('logger'), spec('interfaces'), spec('machine')]);
    expect(result).toEqual({ ok: true, order: ['logger', 'interfaces', 'machine'] });
  });
});

describe('isDependencySatisfied', () => {
  const running = (state: Partial<DependencyReadyState> = {}): DependencyReadyState => ({
    status: 'running',
    ...state
  });

  it('accepts an exact instance that is ready', () => {
    const entries = new Map<string, DependencyReadyState>([
      ['cellapp#b', running()]
    ]);
    expect(isDependencySatisfied('cellapp#b', entries)).toBe(true);
  });

  it('rejects a starting, missing, or given-up dependency', () => {
    const entries = new Map<string, DependencyReadyState>([
      ['cellapp#a', running({ status: 'starting' })],
      ['cellapp#c', running({ status: 'starting', readinessGivenUp: 'timeout' })]
    ]);
    // 在途:不算成功
    expect(isDependencySatisfied('cellapp#a', entries)).toBe(false);
    // 放弃等待后停在 Starting:不算成功
    expect(isDependencySatisfied('cellapp#c', entries)).toBe(false);
    // 缺席:不算成功
    expect(isDependencySatisfied('cellapp#d', entries)).toBe(false);
    expect(isDependencySatisfied('machine', entries)).toBe(false);
  });

  it('treats an unqualified dependency as satisfied by any ready instance', () => {
    // 组件级依赖:任一实例就绪即满足(多实例面,RUN-001 口径)
    const entries = new Map<string, DependencyReadyState>([
      ['cellappmgr', running({ status: 'starting' })],
      ['cellappmgr#b', running()]
    ]);
    expect(isDependencySatisfied('cellappmgr', entries)).toBe(true);

    const allStarting = new Map<string, DependencyReadyState>([
      ['cellappmgr', running({ status: 'starting' })]
    ]);
    expect(isDependencySatisfied('cellappmgr', allStarting)).toBe(false);
  });
});
