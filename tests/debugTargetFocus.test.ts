import { describe, expect, it } from 'vitest';
import {
  DEBUG_LISTENING_ROW_ACTIONS,
  DEBUG_LISTENING_ROW_ACTION_LIST,
  componentNameFromServerKey,
  runListeningRowFocus,
  type ListeningRowEffects,
  type ListeningRowResult
} from '../src/debugTargetFocus';

// Debug Targets「监听」行的下一步控件(端口模式补控件):提示文案、控件面、
// 三个动作的收口与命名实例行的诚实降级——副作用全经 effects 注入,这里直接
// 对账行为面(装配在 extension.ts)。

interface Recorded {
  attaches: string[];
  opens: Array<{ component: string; port: number }>;
  shows: Array<{ message: string; actions: readonly string[] }>;
}

const makeEffects = (
  options: {
    picks?: Array<string | undefined>;
    attach?: (component: string) => Promise<boolean>;
    open?: (component: string, port: number) => Promise<{ ok: boolean; detail: string }>;
  } = {}
): { effects: ListeningRowEffects; record: Recorded } => {
  const record: Recorded = { attaches: [], opens: [], shows: [] };
  const picks = [...(options.picks ?? [])];
  const effects: ListeningRowEffects = {
    attach: async component => {
      record.attaches.push(component);
      return options.attach ? await options.attach(component) : true;
    },
    openLaunchJson: async (component, port) => {
      record.opens.push({ component, port });
      return options.open
        ? await options.open(component, port)
        : { ok: true, detail: '已写入并打开' };
    },
    show: async (message, actions) => {
      record.shows.push({ message, actions });
      return picks.shift();
    }
  };
  return { effects, record };
};

describe('componentNameFromServerKey', () => {
  it('默认实例行=组件名;命名实例行只取组件段', () => {
    expect(componentNameFromServerKey('baseapp')).toBe('baseapp');
    expect(componentNameFromServerKey('cellapp#实例a')).toBe('cellapp');
  });
});

describe('runListeningRowFocus(监听行点击收口)', () => {
  it('默认实例行:提示带状态/端口/launch.json 指引,两个控件齐备', async () => {
    const { effects, record } = makeEffects();

    const result = await runListeningRowFocus('baseapp', 5678, effects);

    expect(result.outcome).toBe('dismissed'); // 没给选择=关掉
    expect(record.shows).toHaveLength(1);
    expect(record.shows[0].message).toContain('baseapp');
    expect(record.shows[0].message).toContain('listening on debugpy');
    expect(record.shows[0].message).toContain('debugpy 5678');
    expect(record.shows[0].message).toContain('launch.json');
    expect(record.shows[0].actions).toEqual([
      DEBUG_LISTENING_ROW_ACTIONS.attachNow,
      DEBUG_LISTENING_ROW_ACTIONS.openLaunch
    ]);
    expect(DEBUG_LISTENING_ROW_ACTION_LIST).toHaveLength(2);
    expect(record.attaches).toHaveLength(0);
    expect(record.opens).toHaveLength(0);
  });

  it('命名实例行点到「立即附加」也不发起(控件本就不给,防指错实例)', async () => {
    const { effects, record } = makeEffects({ picks: [DEBUG_LISTENING_ROW_ACTIONS.attachNow] });

    const result = await runListeningRowFocus('cellapp#实例a', 5709, effects);

    expect(result.outcome).toBe('dismissed');
    expect(record.attaches).toHaveLength(0);
  });

  it('默认实例行点立即附加:attach 收到组件名', async () => {
    const { effects, record } = makeEffects({ picks: [DEBUG_LISTENING_ROW_ACTIONS.attachNow] });

    const result = await runListeningRowFocus('baseapp', 5678, effects);

    expect(result.outcome).toBe('attached');
    expect(record.attaches).toEqual(['baseapp']);
    expect(record.opens).toHaveLength(0);
  });

  it('打开 launch.json:先按该口动态写条目再打开(port 原样透传)', async () => {
    const { effects, record } = makeEffects({ picks: [DEBUG_LISTENING_ROW_ACTIONS.openLaunch] });

    const result = await runListeningRowFocus('baseapp', 5690, effects);

    expect(result.outcome).toBe('launch-opened');
    expect(result.detail).toBe('已写入并打开');
    expect(record.opens).toEqual([{ component: 'baseapp', port: 5690 }]);
    expect(record.attaches).toHaveLength(0);
  });

  it('写 launch.json 失败:如实回 write-failed 带原因(装配层播报)', async () => {
    const { effects } = makeEffects({
      picks: [DEBUG_LISTENING_ROW_ACTIONS.openLaunch],
      open: async () => ({ ok: false, detail: 'launch.json 带注释(JSONC),为免破坏未改写' })
    });

    const result: ListeningRowResult = await runListeningRowFocus('baseapp', 5678, effects);

    expect(result.outcome).toBe('write-failed');
    expect(result.detail).toContain('注释');
  });

  it('行没带端口:打开时按 debugpy 缺省口 5678 写', async () => {
    const { effects, record } = makeEffects({ picks: [DEBUG_LISTENING_ROW_ACTIONS.openLaunch] });

    await runListeningRowFocus('loginapp', undefined, effects);

    expect(record.opens).toEqual([{ component: 'loginapp', port: 5678 }]);
    expect(record.shows[0].message).toContain('debugpy ?');
  });

  it('命名实例行:只给「打开 launch.json」(立即附加指不到该实例的口)', async () => {
    const { effects, record } = makeEffects({
      // 万一别处传了这个名字,也不能对实例行发起附加
      picks: [DEBUG_LISTENING_ROW_ACTIONS.attachNow]
    });

    const result = await runListeningRowFocus('cellapp#实例a', 5709, effects);

    expect(record.shows[0].actions).toEqual([DEBUG_LISTENING_ROW_ACTIONS.openLaunch]);
    expect(record.attaches).toHaveLength(0);
    expect(result.outcome).toBe('dismissed');
  });

  it('附加动作发起后无论附加结果如何都按 attached 收口(附加自身的成败有自己的提示)', async () => {
    const { effects, record } = makeEffects({
      picks: [DEBUG_LISTENING_ROW_ACTIONS.attachNow],
      attach: async () => false
    });

    const result = await runListeningRowFocus('baseapp', 5678, effects);

    expect(record.attaches).toEqual(['baseapp']);
    expect(result.outcome).toBe('attached');
  });
});
