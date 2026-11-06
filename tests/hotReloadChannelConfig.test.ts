import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HTTP_RECEIVER_BODY,
  DEFAULT_HTTP_RECEIVER_URL,
  runHotReloadChannelConfigCommand
} from '../src/hotReloadChannelConfig';
import type {
  HotReloadChannelConfigCommandOptions,
  HotReloadChannelConfigDeps,
  HotReloadChannelConfigUi
} from '../src/hotReloadChannelConfig';
import type { ReloadChannelConfig } from '../src/hotReloadTransport';
import type { ProjectProfile } from '../src/projectProfiles';

// IDE-HOT-102 + 快捷启用(本批):部署级热更通道配置面板——单 profile 直接进
// 预设首屏(自研接收器[推荐] / KBEngine 官方 / 未配置 + 「高级配置」),多 profile
// 先选 profile,合计 ≤2 步;选预设即按默认参数(本机端口/路径 + JSON 对象体)
// 一键探活,通过才落 profile、零输入框;多步流(选通道 → 逐项收参数 → 保存/探测)
// 保留在高级配置里(entry='advanced' 为状态栏一键修的直达入口)。探测只走注入的
// probe(不写 profile),确认保存才落 profile;全程每步可取消。

const profile = (id: string, displayName: string): ProjectProfile => ({
  id,
  displayName,
  assetsRoot: '/ws/assets',
  engineRoot: '/ws/engine',
  interpreterPath: null,
  interpreterSource: 'missing'
});

/** 脚本化 UI:每步弹出一个脚本结果(选择项从 items 里按谓词挑)+ 调用计数 */
type UiStep = (
  args: {
    items?: Array<{ label: string }>;
    prompt?: string;
    value?: string;
    message?: string;
  }
) => Promise<unknown>;

interface UiCalls {
  quickPick: number;
  inputBox: number;
  info: string[];
  error: string[];
}

const makeUi = (steps: UiStep[]): { ui: HotReloadChannelConfigUi; calls: UiCalls } => {
  const calls: UiCalls = { quickPick: 0, inputBox: 0, info: [], error: [] };
  const next = (where: string): UiStep => {
    const step = steps.shift();
    if (!step) {
      throw new Error(`ui script exhausted at ${where}`);
    }
    return step;
  };
  const ui: HotReloadChannelConfigUi = {
    showQuickPick: <T extends { label: string }>(items: T[]): Promise<T | undefined> => {
      calls.quickPick += 1;
      return next('quickPick')({ items }) as Promise<T | undefined>;
    },
    showInputBox: options => {
      calls.inputBox += 1;
      return next('inputBox')({ prompt: options.prompt, value: options.value }) as Promise<
        string | undefined
      >;
    },
    showInformationMessage: message => {
      calls.info.push(message);
      return next('info')({ message }) as Promise<unknown>;
    },
    showErrorMessage: message => {
      calls.error.push(message);
      return next('error')({ message }) as Promise<unknown>;
    }
  };
  return { ui, calls };
};

/** 只给步骤、不关心计数的薄壳 */
const scriptedUi = (steps: UiStep[]): HotReloadChannelConfigUi => makeUi(steps).ui;

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

const run = (
  deps: HotReloadChannelConfigDeps,
  options?: HotReloadChannelConfigCommandOptions
): Promise<boolean> => runHotReloadChannelConfigCommand(deps, options ?? {});

/** 多 profile 场景的选 profile 步骤(单 profile 直用,不弹这一步) */
const pickProfile = (): UiStep => async ({ items }) => items![0];
/** 预设首屏(自研接收器/官方/未配置/高级配置)按 preset 挑 */
const pickPreset = (value: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { preset?: string }).preset === value) ?? items![0];
/** 高级配置里的通道选择(未配/官方/HTTP)按 value 挑 */
const pickChannel = (value: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { value?: string }).value === value) ?? items![0];
const pickFinal = (action: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { action?: string }).action === action) ?? items![0];
const input = (value: string | undefined): UiStep => async () => value;
const infoStep = (assert?: (message: string) => void): UiStep => async ({ message }) => {
  assert?.(message ?? '');
  return undefined;
};
const errorStep = (assert?: (message: string) => void): UiStep => async ({ message }) => {
  assert?.(message ?? '');
  return undefined;
};
/** 进高级配置:预设首屏选「高级配置」 */
const toAdvanced = (): UiStep => pickPreset('advanced');

const DEFAULT_HTTP_CONFIG: ReloadChannelConfig = {
  channel: 'http',
  http: {
    name: 'hot-reload',
    url: DEFAULT_HTTP_RECEIVER_URL,
    method: 'POST',
    headers: {},
    body: DEFAULT_HTTP_RECEIVER_BODY,
    enabled: true,
    keybinding: ''
  }
};

describe('hotReloadChannelConfig 快捷启用流(预设一键启用)', () => {
  it('单 profile 直接进预设首屏:默认参数 + 探活通过即启用,全程 1 步(零输入框)', async () => {
    const deps = makeDeps();
    const probed: ReloadChannelConfig[] = [];
    deps.probe = async config => {
      probed.push(config);
      return { ok: true, detail: '端点可达(HTTP 200)' };
    };
    const { ui, calls } = makeUi([
      pickPreset('http-receiver'),
      infoStep(message => {
        expect(message).toContain('自研接收器');
        expect(message).toContain('探活通过');
      })
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(true);
    // 首屏即预设列表(单 profile 不弹 profile 选择),不弹任何输入框
    expect(calls.quickPick).toBe(1);
    expect(calls.inputBox).toBe(0);
    // 默认请求体是 JSON 对象(能带 targetId/sender_digests,才可能收到 applied)
    expect(DEFAULT_HTTP_CONFIG.http?.body).toBe('{"files":${files}}');
    expect(probed).toEqual([DEFAULT_HTTP_CONFIG]);
    expect(deps.saved).toEqual([{ id: 'p1', config: DEFAULT_HTTP_CONFIG }]);
  });

  it('多 profile → 先选 profile 再进预设首屏,合计 2 步(≤2 步口径)', async () => {
    const deps = makeDeps({ profiles: [profile('p1', '主线服'), profile('p2', '压测服')] });
    deps.probe = async () => ({ ok: true, detail: 'ok' });
    const { ui, calls } = makeUi([pickProfile(), pickPreset('http-receiver'), infoStep()]);
    deps.ui = ui;
    expect(await run(deps)).toBe(true);
    expect(calls.quickPick).toBe(2);
    expect(calls.inputBox).toBe(0);
    expect(deps.saved).toHaveLength(1);
  });

  it('预设自研接收器探活失败 → 不启用(不写 profile),错误提示点名高级配置', async () => {
    const deps = makeDeps();
    deps.probe = async () => ({ ok: false, detail: '端点不可达(ECONNREFUSED)' });
    const { ui, calls } = makeUi([
      pickPreset('http-receiver'),
      errorStep(message => {
        expect(message).toContain('探活不通');
        expect(message).toContain('高级配置');
      })
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
    expect(calls.quickPick).toBe(1);
    expect(calls.inputBox).toBe(0);
    expect(calls.error.join('')).toContain('探活不通');
  });

  it('预设未配置 → 直接清除 hotReload(回落 actionName 通道),不探活', async () => {
    const deps = makeDeps();
    const { ui, calls } = makeUi([pickPreset('unset'), infoStep()]);
    deps.ui = ui;
    expect(await run(deps)).toBe(true);
    expect(deps.saved).toEqual([{ id: 'p1', config: undefined }]);
    expect(calls.quickPick).toBe(1);
    expect(calls.inputBox).toBe(0);
  });

  it('预设自研接收器沿用既有 http 参数(不把自定义 URL 冲回默认)', async () => {
    const existing: ReloadChannelConfig = {
      channel: 'http',
      http: { ...DEFAULT_HTTP_CONFIG.http!, url: 'http://10.0.0.7:9000/hotfix', method: 'PUT' }
    };
    const deps = makeDeps({ profiles: [{ ...profile('p1', '主线服'), hotReload: existing }] });
    deps.probe = async () => ({ ok: true, detail: 'ok' });
    const { ui } = makeUi([pickPreset('http-receiver'), infoStep()]);
    deps.ui = ui;
    expect(await run(deps)).toBe(true);
    expect(deps.saved).toHaveLength(1);
    expect(deps.saved[0].config?.http?.url).toBe('http://10.0.0.7:9000/hotfix');
    expect(deps.saved[0].config?.http?.method).toBe('PUT');
  });

  it('命名口径:预设首屏标注「自研接收器」与「依赖引擎 reloadScript」+ 高级配置入口', async () => {
    const deps = makeDeps();
    const { ui, calls } = makeUi([
      async ({ items }) => {
        const labels = items!.map(item => item.label);
        const joined = labels.join('\n');
        expect(joined).toContain('自研接收器');
        expect(joined).toContain('依赖引擎 reloadScript');
        expect(joined).toContain('未配置');
        expect(joined).toContain('高级配置');
        // 旧「第三方」口径退役
        expect(joined).not.toContain('第三方');
        // 三预设 + 高级配置 = 4 项
        expect(labels).toHaveLength(4);
        return undefined;
      }
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(calls.quickPick).toBe(1);
    expect(deps.saved).toHaveLength(0);
  });

  it('entry=advanced + profileId → 首屏直达该 profile 的高级配置通道选择', async () => {
    const deps = makeDeps({ profiles: [profile('p1', '主线服'), profile('p2', '压测服')] });
    const { ui, calls } = makeUi([
      async ({ items }) => {
        const labels = items!.map(item => item.label);
        expect(labels.join('\n')).toContain('自研接收器'); // 高级配置的通道选择
        expect(labels.join('\n')).not.toContain('高级配置(逐项填参数');
        return items![0] as { label: string };
      },
      pickFinal('save'),
      infoStep(message => expect(message).toContain('压测服'))
    ]);
    deps.ui = ui;
    expect(await run(deps, { entry: 'advanced', profileId: 'p2' })).toBe(true);
    // 直达:不弹 profile 选择、不弹预设首屏
    expect(calls.quickPick).toBe(2);
    expect(calls.inputBox).toBe(0);
    expect(deps.saved).toEqual([{ id: 'p2', config: undefined }]);
  });

  it('profileId 不存在 → 如实报错不猜不新建,零写入', async () => {
    const deps = makeDeps({ profiles: [profile('p1', '主线服'), profile('p2', '压测服')] });
    const { ui, calls } = makeUi([errorStep(message => expect(message).toContain('不存在'))]);
    deps.ui = ui;
    expect(await run(deps, { entry: 'advanced', profileId: 'nope' })).toBe(false);
    expect(calls.quickPick).toBe(0);
    expect(deps.saved).toHaveLength(0);
    expect(calls.error.join('')).toContain('不存在');
  });
});

describe('hotReloadChannelConfig 高级配置流程 (IDE-HOT-102)', () => {
  it('无 profile → 提示并返回 false,不写任何 profile', async () => {
    const deps = makeDeps({ profiles: [] });
    const { ui, calls } = makeUi([infoStep()]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
    expect(calls.info.join('')).toContain('无部署 profile');
  });

  it('高级配置 + 选未配通道 + 保存 → 清除 hotReload(回落既有通道)', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([toAdvanced(), pickChannel('unset'), pickFinal('save'), infoStep()]);
    deps.ui = ui;
    expect(await run(deps)).toBe(true);
    expect(deps.saved).toEqual([{ id: 'p1', config: undefined }]);
  });

  it('高级配置 + 选 HTTP 通道 → 收集 url/method/body → 保存', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([
      toAdvanced(),
      pickChannel('http'),
      input('http://127.0.0.1:8000/hotfix'),
      input('put'),
      input('${files}'),
      pickFinal('save'),
      infoStep()
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(true);
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

  it('高级配置 + 选官方通道 → 收集 host/port/密码 → 探测(注入 probe,不写 profile)', async () => {
    const deps = makeDeps();
    const probed: ReloadChannelConfig[] = [];
    deps.probe = async config => {
      probed.push(config);
      return { ok: true, detail: '控制台可连' };
    };
    const { ui } = makeUi([
      toAdvanced(),
      pickChannel('kbengine-official'),
      input('127.0.0.1'),
      input('2560'),
      input('pw'),
      pickFinal('probe'),
      infoStep(message => expect(message).toContain('连通性测试通过'))
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
    expect(probed).toEqual([
      { channel: 'kbengine-official', official: { host: '127.0.0.1', port: 2560, password: 'pw', fullReload: true } }
    ]);
  });

  it('探测失败 → 错误提示,照常不写 profile', async () => {
    const deps = makeDeps();
    deps.probe = async () => ({ ok: false, detail: '端点不可达' });
    const { ui } = makeUi([
      toAdvanced(),
      pickChannel('http'),
      input('http://127.0.0.1:8000/hotfix'),
      input('POST'),
      input('${files}'),
      pickFinal('probe'),
      errorStep(message => expect(message).toContain('连通性测试失败'))
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('未配通道选探测 → 提示无通道可探测,不写', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([
      toAdvanced(),
      pickChannel('unset'),
      pickFinal('probe'),
      infoStep(message => expect(message).toContain('无通道可探测'))
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('官方通道端口非法 → 错误提示并中止(不落参数也不写)', async () => {
    const deps = makeDeps();
    const { ui, calls } = makeUi([
      toAdvanced(),
      pickChannel('kbengine-official'),
      input('127.0.0.1'),
      input('70000'),
      errorStep()
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
    expect(calls.error.join('')).toContain('端口无效');
  });

  it('保存失败(profile 没了)→ 错误提示返回 false', async () => {
    const deps = makeDeps();
    deps.saveHotReload = async () => null;
    const { ui, calls } = makeUi([toAdvanced(), pickChannel('unset'), pickFinal('save'), errorStep()]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(calls.error.join('')).toContain('保存失败');
  });

  it('预设首屏取消 → false 不写 profile', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([async () => undefined]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('高级配置里通道选择取消 → false 不写 profile', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([toAdvanced(), async () => undefined]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('最终一步取消 → false 不写 profile', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([toAdvanced(), pickChannel('unset'), pickFinal('cancel')]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('HTTP 收集取消(url 空)→ false 不写 profile', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([toAdvanced(), pickChannel('http'), input(undefined)]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });
});
