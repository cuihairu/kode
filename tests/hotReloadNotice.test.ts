import { describe, expect, it, vi } from 'vitest';
import {
  HOT_RELOAD_NOTICE_KEY,
  HOT_RELOAD_NOTICE_MESSAGE,
  showHotReloadFirstRunNotice
} from '../src/hotReloadNotice';

// 首次激活非模态提示(用户令 2026-11-06):热更默认开启后第一次激活弹一次,
// 可永久关闭(记 flag,不再打扰),不挡编辑器(非模态);选「立即关闭」直接写回
// 配置关掉。

const makeMemento = (): { get: <T>(key: string, defaultValue?: T) => T | undefined; update: (key: string, value: unknown) => Promise<void>; store: Map<string, unknown> } => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T,>(key: string, defaultValue?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    }
  };
};

describe('showHotReloadFirstRunNotice(首激活提示,一次性)', () => {
  it('首次激活弹一次并记 flag,第二次不再弹(可永久关闭)', async () => {
    const memento = makeMemento();
    const shown: string[] = [];
    const deps = {
      isShown: (): boolean => memento.get<boolean>(HOT_RELOAD_NOTICE_KEY) === true,
      markShown: async (): Promise<void> => memento.update(HOT_RELOAD_NOTICE_KEY, true),
      show: async (message: string): Promise<undefined> => {
        shown.push(message);
        return undefined;
      }
    };

    expect(await showHotReloadFirstRunNotice(deps)).toBe(true);
    expect(shown).toEqual([HOT_RELOAD_NOTICE_MESSAGE]);

    expect(await showHotReloadFirstRunNotice(deps)).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('提示文案点名端点与一键关入口,且非模态(走 showInformationMessage 面)', () => {
    expect(HOT_RELOAD_NOTICE_MESSAGE).toContain('127.0.0.1:8090/hotfix?module_name=');
    expect(HOT_RELOAD_NOTICE_MESSAGE).toContain('module_name=<模块名>');
    expect(HOT_RELOAD_NOTICE_MESSAGE).toContain('kbengine.hotReload.toggle');
    expect(HOT_RELOAD_NOTICE_MESSAGE).not.toContain('modal');
  });

  it('选「立即关闭」即写回关闭配置', async () => {
    const memento = makeMemento();
    const turnOff = vi.fn(async (): Promise<void> => undefined);
    const deps = {
      isShown: (): boolean => memento.get<boolean>(HOT_RELOAD_NOTICE_KEY) === true,
      markShown: async (): Promise<void> => memento.update(HOT_RELOAD_NOTICE_KEY, true),
      show: async (): Promise<string> => '立即关闭',
      turnOff
    };

    expect(await showHotReloadFirstRunNotice(deps)).toBe(true);
    expect(turnOff).toHaveBeenCalledTimes(1);
    // 关过一次也不再提示
    expect(await showHotReloadFirstRunNotice(deps)).toBe(false);
  });

  it('提示已标记过则一次都不弹(零打扰)', async () => {
    const memento = makeMemento();
    await memento.update(HOT_RELOAD_NOTICE_KEY, true);
    const show = vi.fn(async (): Promise<undefined> => undefined);
    expect(
      await showHotReloadFirstRunNotice({
        isShown: () => memento.get<boolean>(HOT_RELOAD_NOTICE_KEY) === true,
        markShown: async () => memento.update(HOT_RELOAD_NOTICE_KEY, true),
        show
      })
    ).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });
});
