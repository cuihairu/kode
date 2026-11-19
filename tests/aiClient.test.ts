import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strict as assert } from 'node:assert';

import * as vscode from 'vscode';

import {
  commandRegistry,
  commands,
  configurationOverrides,
  CancellationTokenSource
} from './helpers/vscodeStub';

import {
  AI_API_KEY_SECRET,
  hasConfiguredEndpoint,
  isAiFaceAvailable,
  listLanguageModels,
  resolveAiEndpointConfig,
  sendAiMessage,
  type AiChatMessage,
  type AiEndpointConfig,
  type AiLanguageModelLike
} from '../src/ai/aiClient';
import { registerAiCommands } from '../src/ai/aiRegistration';

// AI-001 底座验收:配置档解析/可用性判据(惰性注册)/OpenAI-compatible
// 客户端(鉴权头·超时·取消·重试上限·4xx 不重试)/vscode.lm 回退(feature
// detect)/key 只进 SecretStorage。fetch/sleep/lm 全部注入,零真实外发。

const ENDPOINT: AiEndpointConfig = {
  baseUrl: 'https://api.example.com/',
  model: 'test-model',
  temperature: 0.1,
  maxTokens: 256,
  requestTimeoutMs: 5000,
  maxRetries: 1
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

const jsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
};

const okBody = { choices: [{ message: { content: 'reply text' } }] };

const endpointConfig = (over: Partial<AiEndpointConfig> = {}): AiEndpointConfig => ({
  ...ENDPOINT,
  ...over
});

/** fetch 替身:按序出牌;记录调用;可挂 signal 监听以验 abort */
function fetchStub(
  responses: Array<(call: FetchCall, signal: AbortSignal) => Response | Promise<never>>
): { calls: FetchCall[]; impl: typeof fetch } {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    const step = responses[Math.min(index, responses.length - 1)];
    index++;
    return step(call, call.init.signal as AbortSignal);
  }) as typeof fetch;
  return { calls, impl };
}

const MESSAGES: AiChatMessage[] = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hello' }
];

beforeEach(() => {
  configurationOverrides.delete('kbengine.ai');
  const vs = vscode as unknown as { lm?: unknown };
  delete vs.lm;
  delete (vs as { LanguageModelChatMessage?: unknown }).LanguageModelChatMessage;
  commandRegistry.reset();
});

afterEach(() => {
  configurationOverrides.delete('kbengine.ai');
  const vs = vscode as unknown as { lm?: unknown };
  delete vs.lm;
  delete (vs as { LanguageModelChatMessage?: unknown }).LanguageModelChatMessage;
  commandRegistry.reset();
});

describe('AI-001:resolveAiEndpointConfig', () => {
  it('零配置回落默认档;非法数值回落默认值', () => {
    const config = resolveAiEndpointConfig();
    expect(config.baseUrl).toBe('');
    expect(config.model).toBe('');
    expect(config.temperature).toBe(0.2);
    expect(config.maxTokens).toBe(1024);
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.maxRetries).toBe(1);
    configurationOverrides.set('kbengine.ai', {
      baseUrl: ' http://host ',
      temperature: Number.NaN,
      maxTokens: 'not-a-number',
      requestTimeoutMs: -5,
      maxRetries: 4
    });
    const seeded = resolveAiEndpointConfig();
    expect(seeded.baseUrl).toBe(' http://host ');
    expect(seeded.temperature).toBe(0.2);
    expect(seeded.maxTokens).toBe(1024);
    expect(seeded.requestTimeoutMs).toBe(-5);
    expect(seeded.maxRetries).toBe(4);
  });

  it('hasConfiguredEndpoint:空白 url=未配置', () => {
    expect(hasConfiguredEndpoint(endpointConfig())).toBe(true);
    expect(hasConfiguredEndpoint(endpointConfig({ baseUrl: '' }))).toBe(false);
    expect(hasConfiguredEndpoint(endpointConfig({ baseUrl: '   ' }))).toBe(false);
  });
});

describe('AI-001:isAiFaceAvailable(惰性注册判据)', () => {
  it('无 endpoint 且宿主无 lm → false(默认全关)', async () => {
    await expect(isAiFaceAvailable(endpointConfig({ baseUrl: '' }))).resolves.toBe(false);
  });

  it('endpoint 已配置 → true(用户显式开)', async () => {
    await expect(isAiFaceAvailable(endpointConfig())).resolves.toBe(true);
  });

  it('无 endpoint 但 lm feature-detect 出模型 → true', async () => {
    (vscode as unknown as { lm: unknown }).lm = {
      selectChatModels: async () => [{ id: 'stub-model' }]
    };
    expect((await listLanguageModels()).length).toBe(1);
    await expect(isAiFaceAvailable(endpointConfig({ baseUrl: '' }))).resolves.toBe(true);
  });

  it('lm.selectChatModels 抛错 → 空集诚实,不外溢', async () => {
    (vscode as unknown as { lm: unknown }).lm = {
      selectChatModels: async () => {
        throw new Error('boom');
      }
    };
    await expect(listLanguageModels()).resolves.toEqual([]);
  });
});

describe('AI-001:sendAiMessage endpoint 路线', () => {
  it('POST /v1/chat/completions:Bearer 头+body 档+content 提取;尾斜杠归一', async () => {
    const { calls, impl } = fetchStub([() => jsonResponse(200, okBody)]);
    const text = await sendAiMessage({
      messages: MESSAGES,
      endpoint: endpointConfig(),
      apiKey: 'sk-test',
      fetchImpl: impl
    });
    expect(text).toBe('reply text');
    assert.equal(calls.length, 1);
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect((body.messages as unknown[]).length).toBe(2);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(256);
  });

  it('无 key 不带 Authorization 头(免鉴权本地服务)', async () => {
    const { calls, impl } = fetchStub([() => jsonResponse(200, okBody)]);
    await sendAiMessage({ messages: MESSAGES, endpoint: endpointConfig(), fetchImpl: impl });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('400 一次都不重试', async () => {
    const { calls, impl } = fetchStub([() => jsonResponse(400, { error: 'bad' })]);
    await assert.rejects(
      sendAiMessage({
        messages: MESSAGES,
        endpoint: endpointConfig({ maxRetries: 3 }),
        fetchImpl: impl,
        sleepImpl: async () => undefined
      }),
      /status 400/
    );
    assert.equal(calls.length, 1);
  });

  it('500/429 按 maxRetries 上限重试后报错', async () => {
    for (const status of [500, 429]) {
      const { calls, impl } = fetchStub([() => jsonResponse(status, {})]);
      await assert.rejects(
        sendAiMessage({
          messages: MESSAGES,
          endpoint: endpointConfig({ maxRetries: 2 }),
          fetchImpl: impl,
          sleepImpl: async () => undefined
        }),
        new RegExp(`status ${status}`)
      );
      assert.equal(calls.length, 3, `status ${status} 重试上限`);
    }
  });

  it('请求超时 abort 报 timed out,不悬挂', async () => {
    const { impl } = fetchStub([
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        }) as never
    ]);
    await assert.rejects(
      sendAiMessage({
        messages: MESSAGES,
        endpoint: endpointConfig({ requestTimeoutMs: 10, maxRetries: 3 }),
        fetchImpl: impl
      }),
      /timed out/
    );
  });

  it('token 预置取消零外发;请求中取消中止报 cancelled', async () => {
    const { calls, impl } = fetchStub([() => jsonResponse(200, okBody)]);
    const source = new CancellationTokenSource();
    source.token.cancel();
    await assert.rejects(
      sendAiMessage({
        messages: MESSAGES,
        endpoint: endpointConfig(),
        apiKey: 'sk-test',
        token: source.token,
        fetchImpl: impl
      }),
      /cancelled/
    );
    assert.equal(calls.length, 0);

    const live = fetchStub([
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        }) as never
    ]);
    const running = new CancellationTokenSource();
    const pending = sendAiMessage({
      messages: MESSAGES,
      endpoint: endpointConfig({ requestTimeoutMs: 5000 }),
      token: running.token,
      fetchImpl: live.impl
    });
    const assertion = assert.rejects(pending, /cancelled/);
    running.cancel();
    await assertion;
  });

  it('响应缺 content=抛错不假成功', async () => {
    const { impl } = fetchStub([() => jsonResponse(200, { choices: [{ message: {} }] })]);
    await assert.rejects(
      sendAiMessage({ messages: MESSAGES, endpoint: endpointConfig(), fetchImpl: impl }),
      /missing message content/
    );
  });

  it('KODE-FULL-012:ok 但缺 content 进重试后 deadline 仍在役,第二轮悬挂按 timed out 截止', async () => {
    const { calls, impl } = fetchStub([
      () => jsonResponse(200, { choices: [{ message: {} }] }),
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          // 第二轮悬挂,仅 abort 时拒绝(真实 fetch 对 signal 的行为);
          // 旧实现第一轮 finish() 已清定时器,这里会永不截止
          signal.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        }) as never
    ]);
    await assert.rejects(
      sendAiMessage({
        messages: MESSAGES,
        endpoint: endpointConfig({ requestTimeoutMs: 60, maxRetries: 1 }),
        fetchImpl: impl,
        sleepImpl: () => Promise.resolve()
      }),
      /timed out/
    );
    expect(calls.length).toBe(2);
  });
});

describe('AI-001:sendAiMessage lm 回退路线', () => {
  // KODE-FULL-011:替身按宿主真实契约构造——sendRequest 三参
  // (messages, options, token),text 逐片产出 string 本体。
  const lmModel = (chunks: string[], calls?: { args: unknown[][] }): AiLanguageModelLike => ({
    sendRequest: async (messages: unknown[], options?: unknown, token?: unknown) => {
      calls?.args.push([messages, options, token]);
      return {
        text: (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      };
    }
  });

  it('endpoint 未配置+注入模型 → 字符串片流式聚合(真实契约形状)', async () => {
    const text = await sendAiMessage({
      messages: MESSAGES,
      endpoint: endpointConfig({ baseUrl: '' }),
      models: [lmModel(['a', 'b', 'c'])]
    });
    expect(text).toBe('abc');
  });

  it('KODE-FULL-011:token 走 sendRequest 第三参,不进 options 位', async () => {
    const calls: { args: unknown[][] } = { args: [] };
    const source = new CancellationTokenSource();
    await sendAiMessage({
      messages: MESSAGES,
      endpoint: endpointConfig({ baseUrl: '' }),
      models: [lmModel(['ok'], calls)],
      token: source.token
    });
    expect(calls.args.length).toBe(1);
    const [messages, options, token] = calls.args[0] as [unknown[], unknown, unknown];
    expect(Array.isArray(messages)).toBe(true);
    expect(token).toBe(source.token);
    expect(options).not.toBe(source.token);
    source.dispose();
  });

  it('endpoint 未配置且无模型 → 抛错不静默假成功', async () => {
    await assert.rejects(
      sendAiMessage({ messages: MESSAGES, endpoint: endpointConfig({ baseUrl: '' }), models: [] }),
      /no AI endpoint configured/
    );
  });
});

describe('AI-001:registerAiCommands(惰性注册+key 只进 SecretStorage)', () => {
  const secretsLog = (): {
    store: AiSecretsStore['store'];
    get: AiSecretsStore['get'];
    delete: AiSecretsStore['delete'];
    stored: Array<[string, string]>;
    deleted: string[];
  } => {
    const stored: Array<[string, string]> = [];
    const deleted: string[] = [];
    return {
      stored,
      deleted,
      store: async (key, value) => {
        stored.push([key, value]);
      },
      get: async () => undefined,
      delete: async key => {
        deleted.push(key);
      }
    };
  };

  it('无 endpoint 且无 lm → 不注册任何命令', async () => {
    const secrets = secretsLog();
    const result = await registerAiCommands({ subscriptions: [] } as never, secrets);
    expect(result.registered).toBe(false);
    expect(result.commands).toEqual([]);
    expect(commandRegistry.registeredCommandIds()).toEqual([]);
  });

  it('lm 可用 → 注册两命令;setApiKey 存 SecretStorage;clearApiKey 删;空 key 不落盘', async () => {
    (vscode as unknown as { lm: unknown }).lm = {
      selectChatModels: async () => [{ id: 'stub-model' }]
    };
    const secrets = secretsLog();
    const subscriptions: unknown[] = [];
    const result = await registerAiCommands({ subscriptions } as never, secrets);
    expect(result.registered).toBe(true);
    expect(commandRegistry.registeredCommandIds()).toEqual([
      'kbengine.ai.setApiKey',
      'kbengine.ai.clearApiKey',
      'kbengine.ai.chat',
      'kbengine.ai.explainFix',
      'kbengine.ai.suggestStub',
      'kbengine.ai.analyzeArchitecture'
    ]);
    // 3 命令 + AI-003 建议层四件(python/kbengine-def 两 CodeAction provider+
    // explainFix 命令+只读虚拟 scheme provider)+ AI-004 建议层两件
    // (suggestStub 命令+只读虚拟 scheme provider)+ AI-005 分析面一件
    // (analyzeArchitecture 命令;scheme provider 由分析首次惰性注册)
    expect(subscriptions.length).toBe(10);

    const originalInput = (vscode.window as { showInputBox?: unknown }).showInputBox;
    (vscode.window as { showInputBox: unknown }).showInputBox = async () => 'sk-secret';
    await commands.executeCommand('kbengine.ai.setApiKey');
    expect(secrets.stored).toEqual([[AI_API_KEY_SECRET, 'sk-secret']]);

    (vscode.window as { showInputBox: unknown }).showInputBox = async () => '';
    await commands.executeCommand('kbengine.ai.setApiKey');
    expect(secrets.stored.length).toBe(1);

    await commands.executeCommand('kbengine.ai.clearApiKey');
    expect(secrets.deleted).toEqual([AI_API_KEY_SECRET]);
    (vscode.window as { showInputBox?: unknown }).showInputBox = originalInput;
  });

  it('configuration 面无 key 字段(package.json 结构断言:key 不落 settings)', async () => {
    const { readFileSync } = await import('fs');
    const manifest = JSON.parse(
      readFileSync(joinPackageJson(), 'utf8')
    ) as { contributes: { configuration: Array<{ properties: Record<string, unknown> }> } };
    const aiKeys = manifest.contributes.configuration
      .flatMap(group => Object.keys(group.properties))
      .filter(key => key.startsWith('kbengine.ai.'));
    expect(aiKeys.sort()).toEqual([
      'kbengine.ai.baseUrl',
      'kbengine.ai.maxRetries',
      'kbengine.ai.maxTokens',
      'kbengine.ai.model',
      'kbengine.ai.requestTimeoutMs',
      'kbengine.ai.temperature'
    ]);
  });
});

function joinPackageJson(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path') as { join: (...parts: string[]) => string };
  return join(__dirname, '..', 'package.json');
}
