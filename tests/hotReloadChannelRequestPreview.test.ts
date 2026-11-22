import { describe, expect, it } from 'vitest';
import {
  defaultPreviewRequest,
  formatChannelRequestPreview,
  runHotReloadChannelConfigCommand
} from '../src/backend/hotReloadChannelConfig';
import type {
  HotReloadChannelConfigDeps,
  HotReloadChannelConfigUi
} from '../src/backend/hotReloadChannelConfig';
import {
  buildReloadHttpRequest,
  HttpReloadTransport,
  type ReloadChannelConfig,
  type ReloadTarget
} from '../src/backend/hotReloadTransport';
import type { HttpRequestEntry } from '../src/backend/httpRequests';
import type { ProjectProfile } from '../src/projectProfiles';

// RUST-358(HR-HTTP-016):HTTP 层「Preview request」——构造将要发送的精确
// 请求(URL/method/参数,不发送、零副作用),用户确认后保存即启用自动热更。
// 预览与 send 共用 buildReloadHttpRequest(逐字节同形,防漂移);预览只支持
// 自研接收器(HTTP)通道,官方通道无 HTTP 请求可预览。

const profile = (id: string, displayName: string): ProjectProfile => ({
  id,
  displayName,
  assetsRoot: '/ws/assets',
  engineRoot: '/ws/engine',
  interpreterPath: null,
  interpreterSource: 'missing'
});

const target: ReloadTarget = { rootId: '/ws/assets', targetId: 'p1' };
const files = ['/ws/assets/scripts/base/Monster.py'];

const entry = (): HttpRequestEntry => ({
  name: 'reload',
  url: 'http://127.0.0.1:8090/hotfix/${targetId}',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"files":${files}}',
  enabled: true,
  keybinding: ''
});

const config = (): ReloadChannelConfig => ({ channel: 'http', http: entry() });

describe('buildReloadHttpRequest(send 与预览共用单一构造)', () => {
  it('URL/headers 变量替换 + ${targetId} 占位解析 + JSON 对象体自动附加 targetId', () => {
    const request = buildReloadHttpRequest(entry(), target, files);
    expect(request.url).toBe('http://127.0.0.1:8090/hotfix/p1');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ 'content-type': 'application/json' });
    // body 变量替换 ${files} → JSON 数组,对象体自动附加 targetId(F4 二轮)
    const body = JSON.parse(request.body) as { files: string[]; targetId: string };
    expect(body.files).toEqual(files);
    expect(body.targetId).toBe('p1');
  });

  it('模板已显式给出 targetId 则不覆盖;非 JSON 对象体无处附加保持原样', () => {
    const explicit = buildReloadHttpRequest(
      { ...entry(), body: '{"files":${files},"targetId":"fixed"}' },
      target,
      files
    );
    expect((JSON.parse(explicit.body) as { targetId: string }).targetId).toBe('fixed');
    const arrayBody = buildReloadHttpRequest(
      { ...entry(), body: '${files}' },
      target,
      files
    );
    // 数组体无处附加 targetId,如实保持 ${files} 替换产物
    expect(arrayBody.body).toBe(JSON.stringify(files));
  });

  it('sender_digests:给出则对象体自动附加,未给出如实不附加(预览不伪造)', () => {
    const digests = new Map([[files[0], 'abc123']]);
    const withDigests = buildReloadHttpRequest(entry(), target, files, undefined, digests);
    expect((JSON.parse(withDigests.body) as { sender_digests: Record<string, string> }).sender_digests).toEqual({
      [files[0]]: 'abc123'
    });
    const without = buildReloadHttpRequest(entry(), target, files);
    expect((JSON.parse(without.body) as Record<string, unknown>).sender_digests).toBeUndefined();
  });

  it('preview 与 send 逐字节同形:同 entry/target/files/digests 下预览 = 实际发出报文', async () => {
    const digests = new Map([[files[0], 'abc123']]);
    const transport = new HttpReloadTransport(entry(), {
      run: async request => {
        captured = request;
        return { status: 200, body: '{}' };
      }
    });
    let captured: unknown;
    await transport.send(target, files, () => undefined, digests);
    const previewed = transport.preview(target, files, digests);
    expect(previewed).toEqual(captured);
    // 再验一份:preview 不带 digests ≠ 带 digests(证明 preview 确实走同构造,
    // 而非一个写死的常量——避免只对上了空集形状)
    const plain = transport.preview(target, files);
    expect((JSON.parse(plain.body) as Record<string, unknown>).sender_digests).toBeUndefined();
  });
});

describe('defaultPreviewRequest(HTTP 层预览;零副作用)', () => {
  it('http 通道 → ok:true,detail 含方法/URL/body,request 与 send 同形', () => {
    const preview = defaultPreviewRequest(config(), target, files);
    expect(preview.ok).toBe(true);
    expect(preview.request).toBeDefined();
    expect(preview.detail).toContain('POST http://127.0.0.1:8090/hotfix/p1');
    expect(preview.detail).toContain('"targetId":"p1"');
    expect(preview.detail).toContain('代表性文件: ' + files[0]);
  });

  it('空文件集 → 无「代表性文件」行,URL/参数仍解析(预览如实显示无文件载荷)', () => {
    const preview = defaultPreviewRequest(config(), target);
    expect(preview.ok).toBe(true);
    expect(preview.detail).not.toContain('代表性文件');
    expect(preview.detail).toContain('{"files":[]');
  });

  it('官方通道 → ok:false(无 HTTP 请求可预览,不伪造)', () => {
    const preview = defaultPreviewRequest(
      { channel: 'kbengine-official', official: { host: '127.0.0.1', port: 40000, password: 'x' } },
      target
    );
    expect(preview.ok).toBe(false);
    expect(preview.detail).toContain('只支持自研接收器(HTTP)通道');
    expect(preview.request).toBeUndefined();
  });

  it('畸形配置(无 http 段) → ok:false 如实说明', () => {
    const preview = defaultPreviewRequest({ channel: 'http' } as ReloadChannelConfig, target);
    expect(preview.ok).toBe(false);
  });
});

describe('formatChannelRequestPreview(可读呈现)', () => {
  it('headers 逐行、body 尾行', () => {
    const text = formatChannelRequestPreview({
      url: 'http://127.0.0.1:8090/hotfix',
      method: 'POST',
      headers: { a: '1', b: '2' },
      body: '{"files":[]}'
    });
    expect(text).toContain('POST http://127.0.0.1:8090/hotfix');
    expect(text).toContain('    a: 1');
    expect(text).toContain('    b: 2');
    expect(text.endsWith('{"files":[]}')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 面板流:预览 → 确认(保存=启用自动热更)                                 */
/* ------------------------------------------------------------------ */

type UiStep = (
  args: {
    items?: Array<{ label: string }>;
    prompt?: string;
    value?: string;
    message?: string;
  }
) => Promise<unknown>;

const makeUi = (steps: UiStep[]): { ui: HotReloadChannelConfigUi; info: string[]; error: string[] } => {
  const info: string[] = [];
  const error: string[] = [];
  const next = (where: string): UiStep => {
    const step = steps.shift();
    if (!step) {
      throw new Error(`ui script exhausted at ${where}`);
    }
    return step;
  };
  const ui: HotReloadChannelConfigUi = {
    showQuickPick: <T extends { label: string }>(items: T[]): Promise<T | undefined> =>
      next('quickPick')({ items }) as Promise<T | undefined>,
    showInputBox: options => next('inputBox')({ prompt: options.prompt, value: options.value }) as Promise<string | undefined>,
    showInformationMessage: message => {
      info.push(message);
      return next('info')({ message }) as Promise<unknown>;
    },
    showErrorMessage: message => {
      error.push(message);
      return next('error')({ message }) as Promise<unknown>;
    }
  };
  return { ui, info, error };
};

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
    ui: overrides.ui ?? makeUi([]).ui,
    ...(overrides.previewRequest ? { previewRequest: overrides.previewRequest } : {}),
    ...(overrides.probe ? { probe: overrides.probe } : {})
  };
};

const pickChannel = (value: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { value?: string }).value === value) ?? items![0];
const pickFinal = (action: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { action?: string }).action === action) ?? items![0];
const input = (value: string | undefined): UiStep => async () => value;
const infoStep = (assert?: (message: string) => void): UiStep => async ({ message }) => {
  assert?.(message ?? '');
  return undefined;
};

describe('runHotReloadChannelConfigCommand × 预览确认流(HR-HTTP-016)', () => {
  it('高级配置 → 预览请求(不发送) → 显示精确报文 → 回到下一步 → 保存即启用自动热更', async () => {
    const { ui, info } = makeUi([
      pickChannel('http'),
      input('http://127.0.0.1:8090/hotfix'),
      input('POST'),
      input('{"files":${files}}'),
      pickFinal('preview'),
      infoStep(message => {
        expect(message).toContain('将发送的请求');
        expect(message).toContain('POST http://127.0.0.1:8090/hotfix');
        expect(message).toContain('"targetId":"p1"');
      }),
      pickFinal('save'),
      infoStep()
    ]);
    const deps = makeDeps({ ui });
    const saved = await runHotReloadChannelConfigCommand(deps, { entry: 'advanced' });

    expect(saved).toBe(true);
    expect(deps.saved).toHaveLength(1);
    const savedHttp = deps.saved[0].config?.http;
    expect(savedHttp?.enabled).toBe(true); // 确认保存=启用自动热更
    expect(savedHttp?.url).toBe('http://127.0.0.1:8090/hotfix');
    // 预览信息里精确报文在保存前已可见
    expect(info.some(m => m.includes('"targetId":"p1"'))).toBe(true);
  });

  it('预览在官方通道 → 报「无 HTTP 请求可预览」,不保存,可取消', async () => {
    const { ui, error } = makeUi([
      pickChannel('kbengine-official'),
      input('127.0.0.1'),
      input('40000'),
      input('pwd123456'),
      pickFinal('preview'),
      errorStepLike(message => {
        expect(message).toContain('只支持自研接收器(HTTP)通道');
      }),
      pickFinal('cancel')
    ]);
    const deps = makeDeps({ ui });
    const saved = await runHotReloadChannelConfigCommand(deps, { entry: 'advanced' });
    expect(saved).toBe(false);
    expect(deps.saved).toHaveLength(0); // 预览不保存
    expect(error.some(m => m.includes('只支持自研接收器(HTTP)通道'))).toBe(true);
  });

  it('注入 previewRequest 替身被尊重(激活层带活动文件)', async () => {
    const { ui, info } = makeUi([
      pickChannel('http'),
      input('http://127.0.0.1:8090/hotfix'),
      input('POST'),
      input('{"files":${files}}'),
      pickFinal('preview'),
      infoStep(message => {
        expect(message).toContain('CANNED');
      }),
      pickFinal('cancel')
    ]);
    const deps = makeDeps({
      ui,
      previewRequest: () => ({ ok: true, detail: 'CANNED', request: { url: 'x', method: 'GET', headers: {}, body: '' } })
    });
    await runHotReloadChannelConfigCommand(deps, { entry: 'advanced' });
    expect(info.some(m => m.includes('CANNED'))).toBe(true);
  });

  it('预览后可改再预览(循环),取消不写 profile', async () => {
    const { ui } = makeUi([
      pickChannel('http'),
      input('http://127.0.0.1:8090/hotfix'),
      input('POST'),
      input('{"files":${files}}'),
      pickFinal('preview'),
      infoStep(),
      pickFinal('cancel')
    ]);
    const deps = makeDeps({ ui });
    const saved = await runHotReloadChannelConfigCommand(deps, { entry: 'advanced' });
    expect(saved).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });
});

/** 官方通道预览的 error 步骤(断言后返回) */
function errorStepLike(assert?: (message: string) => void): UiStep {
  return async ({ message }) => {
    assert?.(message ?? '');
    return undefined;
  };
}
