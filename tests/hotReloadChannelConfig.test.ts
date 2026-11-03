import { describe, expect, it } from 'vitest';
import { runHotReloadChannelConfigCommand } from '../src/hotReloadChannelConfig';
import type { HotReloadChannelConfigDeps, HotReloadChannelConfigUi } from '../src/hotReloadChannelConfig';
import type { ReloadChannelConfig } from '../src/hotReloadTransport';
import type { ProjectProfile } from '../src/projectProfiles';

// IDE-HOT-102:部署级热更通道配置面板流程——选 profile → 选通道(未配/官方/
// HTTP)→ 逐项收集参数 → 保存/探测/取消;探测只走注入的 probe(不写
// profile),确认保存才落 profile;全程每步可取消。

const profile = (id: string, displayName: string): ProjectProfile => ({
  id,
  displayName,
  assetsRoot: '/ws/assets',
  engineRoot: '/ws/engine',
  interpreterPath: null,
  interpreterSource: 'missing'
});

/** 脚本化 UI:每步弹出一个脚本结果(选择项从 items 里按谓词挑) */
type UiStep = (args: { items?: Array<{ label: string }>; prompt?: string; value?: string; message?: string }) => Promise<unknown>;

const scriptedUi = (steps: UiStep[]): HotReloadChannelConfigUi => ({
  showQuickPick: items => {
    const step = steps.shift();
    if (!step) {
      throw new Error('ui script exhausted at quickPick');
    }
    return step({ items });
  },
  showInputBox: options => {
    const step = steps.shift();
    if (!step) {
      throw new Error('ui script exhausted at inputBox');
    }
    return step({ prompt: options.prompt, value: options.value });
  },
  showInformationMessage: message => {
    const step = steps.shift();
    if (!step) {
      throw new Error('ui script exhausted at info');
    }
    return step({ message });
  },
  showErrorMessage: message => {
    const step = steps.shift();
    if (!step) {
      throw new Error('ui script exhausted at error');
    }
    return step({ message });
  }
});

const makeDeps = (
  overrides: Partial<HotReloadChannelConfigDeps> & { profiles?: ProjectProfile[] } = {}
): HotReloadChannelConfigDeps & { saved: Array<{ id: string; config: ReloadChannelConfig | undefined }> } => {
  const saved: Array<{ id: string; config: ReloadChannelConfig | undefined }> = [];
  return {
    saved,
    listProfiles: () => overrides.profiles ?? [profile('p1', '主线服')],
    saveHotReload: async (id, config) => {
      saved.push({ id, config });
      return profile(id, '主线服');
    },
    ui: overrides.ui ?? scriptedUi([]),
    ...(overrides.probe ? { probe: overrides.probe } : {})
  };
};

const pickProfile = (): UiStep => async ({ items }) => items![0];
const pickChannel = (value: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { value?: string }).value === value) ?? items![0];
const pickFinal = (action: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { action?: string }).action === action) ?? items![0];
const input = (value: string | undefined): UiStep => async () => value;

describe('hotReloadChannelConfig 流程 (IDE-HOT-102)', () => {
  it('无 profile → 提示并返回 false,不写任何 profile', async () => {
    const deps = makeDeps({ profiles: [] });
    const seen: string[] = [];
    deps.ui = scriptedUi([async ({ message }) => {
      seen.push(message ?? '');
      return undefined;
    }]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
    expect(seen.join('')).toContain('无部署 profile');
  });

  it('选未配通道 + 保存 → 清除 hotReload(回落既有通道)', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([pickProfile(), pickChannel('unset'), pickFinal('save'), async () => undefined]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(true);
    expect(deps.saved).toEqual([{ id: 'p1', config: undefined }]);
  });

  it('选 HTTP 通道 → 收集 url/method/body → 保存', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([
      pickProfile(),
      pickChannel('http'),
      input('http://127.0.0.1:8000/hotfix'),
      input('put'),
      input('${files}'),
      pickFinal('save'),
      async () => undefined
    ]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(true);
    expect(deps.saved).toEqual([
      {
        id: 'p1',
        config: {
          channel: 'http',
          http: {
            name: 'hot-reload',
            url: 'http://127.0.0.1:8000/hotfix',
            method: 'PUT',
            headers: {},
            body: '${files}',
            enabled: true,
            keybinding: ''
          }
        }
      }
    ]);
  });

  it('选官方通道 → 收集 host/port/密码 → 探测(注入 probe,不写 profile)', async () => {
    const deps = makeDeps();
    const probed: ReloadChannelConfig[] = [];
    deps.probe = async config => {
      probed.push(config);
      return { ok: true, detail: '控制台可连' };
    };
    deps.ui = scriptedUi([
      pickProfile(),
      pickChannel('kbengine-official'),
      input('127.0.0.1'),
      input('2560'),
      input('pw'),
      pickFinal('probe'),
      async ({ message }) => {
        expect(message).toContain('连通性测试通过');
        return undefined;
      }
    ]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
    expect(probed).toEqual([
      { channel: 'kbengine-official', official: { host: '127.0.0.1', port: 2560, password: 'pw', fullReload: true } }
    ]);
  });

  it('探测失败 → 错误提示,照常不写 profile', async () => {
    const deps = makeDeps();
    deps.probe = async () => ({ ok: false, detail: '端点不可达' });
    deps.ui = scriptedUi([
      pickProfile(),
      pickChannel('http'),
      input('http://127.0.0.1:8000/hotfix'),
      input('POST'),
      input('${files}'),
      pickFinal('probe'),
      async ({ message }) => {
        expect(message).toContain('连通性测试失败');
        return undefined;
      }
    ]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('未配通道选探测 → 提示无通道可探测,不写', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([
      pickProfile(),
      pickChannel('unset'),
      pickFinal('probe'),
      async ({ message }) => {
        expect(message).toContain('无通道可探测');
        return undefined;
      }
    ]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('官方通道端口非法 → 错误提示并中止(不落参数也不写)', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([
      pickProfile(),
      pickChannel('kbengine-official'),
      input('127.0.0.1'),
      input('70000'),
      async ({ message }) => {
        expect(message).toContain('端口无效');
        return undefined;
      }
    ]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('保存失败(profile 没了)→ 错误提示返回 false', async () => {
    const deps = makeDeps();
    deps.saveHotReload = async () => null;
    deps.ui = scriptedUi([
      pickProfile(),
      pickChannel('unset'),
      pickFinal('save'),
      async ({ message }) => {
        expect(message).toContain('保存失败');
        return undefined;
      }
    ]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
  });

  it('通道选择取消 → false 不写 profile', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([pickProfile(), async () => undefined]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('最终一步取消 → false 不写 profile', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([pickProfile(), pickChannel('unset'), pickFinal('cancel')]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('HTTP 收集取消(url 空)→ false 不写 profile', async () => {
    const deps = makeDeps();
    deps.ui = scriptedUi([pickProfile(), pickChannel('http'), input(undefined)]);
    expect(await runHotReloadChannelConfigCommand(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });
});
