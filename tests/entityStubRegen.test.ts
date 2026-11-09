import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntityStubRegenController } from '../src/backend/entityStubRegen';

// C-22 交付①补:def 增删改 → entity 桩再生控制器。纯逻辑层:只盯 .def
// 尾缀;连续事件合并为一次尾沿再生;dispose 丢弃挂起计时不再生。

describe('EntityStubRegenController(C-22 交付①补:def 变更自动再生)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('.def 事件尾沿去抖触发一次再生;py/xml 事件即刻忽略', () => {
    const regenerate = vi.fn();
    const controller = new EntityStubRegenController({ regenerate }, 400);

    controller.onFileEvent('/proj/scripts/cell/Avatar.py');
    controller.onFileEvent('/proj/scripts/entity_defs/types.xml');
    vi.advanceTimersByTime(1000);
    expect(regenerate).not.toHaveBeenCalled();

    controller.onFileEvent('/proj/scripts/entity_defs/Avatar.def');
    vi.advanceTimersByTime(399);
    expect(regenerate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(regenerate).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('连续 .def 事件合并为一次再生(增删改同策)', () => {
    const regenerate = vi.fn();
    const controller = new EntityStubRegenController({ regenerate }, 400);

    controller.onFileEvent('/a/Monster.def');
    vi.advanceTimersByTime(200);
    controller.onFileEvent('/b/Avatar.def');
    vi.advanceTimersByTime(200);
    expect(regenerate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(regenerate).toHaveBeenCalledTimes(1);

    // 去抖窗口过后新事件重新触发(再生不吞后续变更)
    controller.onFileEvent('/a/Monster.def');
    vi.advanceTimersByTime(400);
    expect(regenerate).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('.DEF 大写尾缀同触发;dispose 丢弃挂起计时不再生', () => {
    const regenerate = vi.fn();
    const controller = new EntityStubRegenController({ regenerate }, 400);

    controller.onFileEvent('/proj/entity_defs/NPC.DEF');
    controller.dispose();
    vi.advanceTimersByTime(1000);
    expect(regenerate).not.toHaveBeenCalled();
  });
});
