import { describe, expect, it } from 'vitest';
import {
  buildLanguageServiceStatus,
  LanguageServiceStatusController,
  type LanguageServiceStatusInputs,
  type LanguageServiceStatusTimers
} from '../src/backend/languageServiceStatus';

// RUST-219(旧 UI-002)语言服务状态栏:纯核四态机(未知→失败→忙碌→就绪,
// 判定顺序固定)+控制器(事件驱动 refresh,忙碌期保活轮询落定即停)。
// 诚实边界:index=null 面不可用显示「未知」不装就绪;partial(部分索引)
// 无数据面不冒充——只有 failed/queued/running 三计数。

function inputs(overrides: Partial<LanguageServiceStatusInputs>): LanguageServiceStatusInputs {
  return {
    profileName: null,
    resourceRoot: null,
    index: { failed: 0, queued: 0, running: 0 },
    ...overrides
  };
}

describe('buildLanguageServiceStatus 四态机 (RUST-219)', () => {
  it('index=null → 未知脸,hasFailures/isBusy 双 false 不冒充', () => {
    const view = buildLanguageServiceStatus(inputs({ index: null }));
    expect(view.text).toContain('未知');
    expect(view.hasFailures).toBe(false);
    expect(view.isBusy).toBe(false);
  });

  it('failed>0 → error 脸带三计数,优先于忙碌判定', () => {
    const view = buildLanguageServiceStatus(
      inputs({ index: { failed: 2, queued: 1, running: 1 } })
    );
    expect(view.text).toContain('$(error)');
    expect(view.text).toContain('失败 2');
    expect(view.text).toContain('排队 1');
    expect(view.text).toContain('运行 1');
    expect(view.hasFailures).toBe(true);
    expect(view.isBusy).toBe(false);
  });

  it('running/queued>0 → busy 脉冲脸,isBusy=true 驱动保活轮询', () => {
    const busy = buildLanguageServiceStatus(inputs({ index: { failed: 0, queued: 3, running: 0 } }));
    expect(busy.text).toContain('$(sync~spin)');
    expect(busy.text).toContain('排队 3');
    expect(busy.isBusy).toBe(true);
    expect(busy.hasFailures).toBe(false);

    const running = buildLanguageServiceStatus(inputs({ index: { failed: 0, queued: 0, running: 1 } }));
    expect(running.text).toContain('运行 1');
    expect(running.isBusy).toBe(true);
  });

  it('全零 → 就绪脸,profile 与资源根缀在后面', () => {
    const view = buildLanguageServiceStatus(
      inputs({ profileName: 'proj', resourceRoot: 'assets' })
    );
    expect(view.text).toContain('$(check)');
    expect(view.text).toContain('就绪');
    expect(view.text.endsWith(' · proj · assets')).toBe(true);
    expect(view.isBusy).toBe(false);
  });

  it('profile/资源根未知 → 就绪脸无后缀,不编造', () => {
    const view = buildLanguageServiceStatus(inputs({}));
    expect(view.text).toContain('$(check)');
    expect(view.text).not.toContain(' · ');
  });

  it('只知资源根 → 后缀只含资源根段', () => {
    const view = buildLanguageServiceStatus(inputs({ resourceRoot: 'assets' }));
    expect(view.text.endsWith(' · assets')).toBe(true);
    expect(view.text).not.toContain('proj');
  });
});

/** 假钟:记录注册的轮询柄,tick 手动触发,pending/cleared 可断言 */
function fakeTimers() {
  const pending: Array<{ handle: object; handler: () => void; ms: number }> = [];
  const cleared: object[] = [];
  let seq = 0;
  const timers: LanguageServiceStatusTimers = {
    setInterval: (handler, ms) => {
      const handle = { id: ++seq };
      pending.push({ handle, handler, ms });
      return handle;
    },
    clearInterval: handle => {
      cleared.push(handle as object);
      const idx = pending.findIndex(entry => entry.handle === handle);
      if (idx >= 0) {
        pending.splice(idx, 1);
      }
    }
  };
  return {
    timers,
    tick(): void {
      for (const { handler } of [...pending]) {
        handler();
      }
    },
    pendingCount: (): number => pending.length,
    lastMs: (): number | undefined => pending[pending.length - 1]?.ms,
    clearedCount: (): number => cleared.length
  };
}

function fakeItem() {
  const calls: string[] = [];
  const item = {
    text: '',
    tooltip: undefined as string | { value: string } | undefined,
    command: undefined as string | undefined,
    show: () => calls.push('show'),
    dispose: () => calls.push('dispose')
  };
  return { item, calls };
}

describe('LanguageServiceStatusController (RUST-219)', () => {
  it('构造即渲染并 show,点击命令默认 kbengine.profile.health', () => {
    const { item, calls } = fakeItem();
    const clock = fakeTimers();
    let collected = 0;
    new LanguageServiceStatusController({
      createItem: () => item,
      collectInputs: () => {
        collected += 1;
        return inputs({ profileName: 'proj' });
      },
      timers: clock.timers
    });
    expect(calls).toContain('show');
    expect(collected).toBe(1);
    expect(item.command).toBe('kbengine.profile.health');
    expect(item.text).toContain('$(check)');
    expect(item.text).toContain('proj');
    expect(clock.pendingCount()).toBe(0);
  });

  it('忙碌期保活轮询,落定即停(轮询到 settled 自行 clearInterval)', () => {
    const { item } = fakeItem();
    const clock = fakeTimers();
    let status: LanguageServiceStatusInputs = inputs({ index: { failed: 0, queued: 1, running: 0 } });
    const controller = new LanguageServiceStatusController({
      createItem: () => item,
      collectInputs: () => status,
      timers: clock.timers,
      pollMs: 25
    });
    expect(clock.pendingCount()).toBe(1);
    expect(clock.lastMs()).toBe(25);
    clock.tick();
    expect(item.text).toContain('$(sync~spin)');
    expect(clock.pendingCount()).toBe(1);
    status = inputs({});
    clock.tick();
    expect(item.text).toContain('$(check)');
    expect(clock.pendingCount()).toBe(0);
    expect(clock.clearedCount()).toBe(1);
    controller.dispose();
  });

  it('dispose 清轮询与状态栏项,disposed 后 refresh 不再取数', () => {
    const { item, calls } = fakeItem();
    const clock = fakeTimers();
    let collected = 0;
    const controller = new LanguageServiceStatusController({
      createItem: () => item,
      collectInputs: () => {
        collected += 1;
        return inputs({ index: { failed: 0, queued: 5, running: 0 } });
      },
      timers: clock.timers
    });
    expect(clock.pendingCount()).toBe(1);
    controller.dispose();
    expect(clock.pendingCount()).toBe(0);
    expect(calls).toContain('dispose');
    const before = collected;
    controller.refresh();
    expect(collected).toBe(before);
  });
});
