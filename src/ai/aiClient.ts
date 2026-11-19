// AI 底座(AI-001,方案 C,用户令 2026-11-17):OpenAI-compatible
// /v1/chat/completions,自带 fetch,零新依赖;未配置 baseUrl 时回退
// vscode.lm(LanguageModelChat,feature-detect —— engines.vscode 1.82 早于
// 1.90 引入的 lm API,存在性探测不可省,kodeMcpHost 同口径)。API key 只存
// SecretStorage,绝不落 settings.json(configuration 面无 key 字段)。默认
// 全关:未配置 endpoint 且无可用 lm 模型时不注册任何 AI 命令(惰性激活,
// 零成本)。请求带超时/取消(CancellationToken 贯穿 abort)/重试上限;
// 遥测零——除用户显式触发外零代码外发,只发该命令所需片段。
import * as vscode from 'vscode';

/** SecretStorage 键名;对应命令 kbengine.ai.setApiKey / kbengine.ai.clearApiKey */
export const AI_API_KEY_SECRET = 'kbengine.ai.apiKey';

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** kbengine.ai.* endpoint 档(全部走 settings;key 不在此列) */
export interface AiEndpointConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

/**
 * vscode.lm LanguageModelChat 面的注入形状(生产=feature-detect 后的实例)。
 * KODE-FULL-011:按宿主真实契约对齐——sendRequest(messages, options?, token?)
 * 三参,token 是第三参(旧两参形态把 token 塞进了 options 位);response.text
 * 逐片产出 string 本体,不是 { content } 对象(旧读法把真实字符串片全读成 '',
 * 回复被吞成空串)。替身(测试)也按宿主 API 构造。
 */
export interface AiLanguageModelLike {
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: vscode.CancellationToken
  ): { text: AsyncIterable<string> };
}

/** SecretStorage 注入形状(vscode context.secrets 即合此形;Thenable=vscode.d.ts 全局面) */
export interface AiSecretsStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const DEFAULTS: AiEndpointConfig = {
  baseUrl: '',
  model: '',
  temperature: 0.2,
  maxTokens: 1024,
  requestTimeoutMs: 30000,
  maxRetries: 1
};

/** 读 kbengine.ai.* 组;非法数值回落默认值,不做隐式钳制 */
export function resolveAiEndpointConfig(): AiEndpointConfig {
  const config = vscode.workspace.getConfiguration('kbengine.ai');
  const num = (key: string, fallback: number): number => {
    const raw = config.get<unknown>(key, fallback);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  };
  return {
    baseUrl: typeof config.get<string>('baseUrl') === 'string' ? config.get<string>('baseUrl', '') : '',
    model: config.get<string>('model', DEFAULTS.model),
    temperature: num('temperature', DEFAULTS.temperature),
    maxTokens: num('maxTokens', DEFAULTS.maxTokens),
    requestTimeoutMs: num('requestTimeoutMs', DEFAULTS.requestTimeoutMs),
    maxRetries: Math.max(0, num('maxRetries', DEFAULTS.maxRetries))
  };
}

/** endpoint 已配置(baseUrl 非空)——key 可空,本地兼容服务常免鉴权 */
export function hasConfiguredEndpoint(config: AiEndpointConfig): boolean {
  return config.baseUrl.trim().length > 0;
}

/** vscode.lm feature-detect:API 不在(engines 1.82<1.90)或探测失败=空集 */
export async function listLanguageModels(): Promise<AiLanguageModelLike[]> {
  const lm = (vscode as Partial<typeof vscode> & { lm?: { selectChatModels?: (o?: unknown) => Promise<unknown[]> } }).lm;
  if (!lm || typeof lm.selectChatModels !== 'function') {
    return [];
  }
  try {
    const models = await lm.selectChatModels({});
    return Array.isArray(models) ? (models as AiLanguageModelLike[]) : [];
  } catch {
    return [];
  }
}

/**
 * AI 面可用性=注册判据:baseUrl 已配置(用户显式开)或存在任一 lm 模型
 * (宿主侧已有 BYOK provider)。两者皆无 → false → 不注册命令。
 */
export async function isAiFaceAvailable(config?: AiEndpointConfig): Promise<boolean> {
  const endpoint = config ?? resolveAiEndpointConfig();
  if (hasConfiguredEndpoint(endpoint)) {
    return true;
  }
  return (await listLanguageModels()).length > 0;
}

export interface AiSendOptions {
  messages: AiChatMessage[];
  /** 已解析 endpoint;null/省略=回退 lm 路线 */
  endpoint?: AiEndpointConfig | null;
  /** SecretStorage 读出的 key;可空(免鉴权服务) */
  apiKey?: string | null;
  token?: vscode.CancellationToken;
  /** lm 回退模型集注入(生产=缺省走 listLanguageModels) */
  models?: AiLanguageModelLike[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 429/5xx 与网络失败可重试;其余 4xx 一次都不试 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * 发一轮对话并取整段回复文本。endpoint 路线:POST {baseUrl}/v1/chat/completions,
 * Authorization Bearer <key>(key 可空则不带头);超时 requestTimeoutMs abort;
 * 取消贯穿 abort。lm 回退路线:model.sendRequest 流式聚合。无可用面=抛错
 * (调用方转用户可见信息),不静默假成功。
 */
export async function sendAiMessage(options: AiSendOptions): Promise<string> {
  const endpoint = options.endpoint ?? resolveAiEndpointConfig();
  if (hasConfiguredEndpoint(endpoint)) {
    return sendViaEndpoint(options, endpoint);
  }
  return sendViaLanguageModel(options);
}

/**
 * 流式变体(AI-002 对话面板):onChunk 逐片回调,lm 路线逐 chunk 透传且
 * 取消即刻停收(已收部分保留返回);endpoint 兼容面按整段到达上屏一次
 * (本批不强制 SSE,中断=abort 已贯穿)——调用方在面板注记两种到达形态。
 */
export async function sendAiMessageStream(
  options: AiSendOptions,
  onChunk: (text: string) => void
): Promise<string> {
  const endpoint = options.endpoint ?? resolveAiEndpointConfig();
  if (hasConfiguredEndpoint(endpoint)) {
    const full = await sendViaEndpoint(options, endpoint);
    onChunk(full);
    return full;
  }
  return sendViaLanguageModel(options, onChunk);
}

async function sendViaEndpoint(options: AiSendOptions, endpoint: AiEndpointConfig): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const doSleep = options.sleepImpl ?? sleep;
  const controller = new AbortController();
  const disposables: vscode.Disposable[] = [];
  let settled = false;
  const finish = (): void => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      disposables.forEach(d => d.dispose());
    }
  };
  const timer = setTimeout(() => controller.abort(), Math.max(1, endpoint.requestTimeoutMs));
  if (options.token) {
    if (options.token.isCancellationRequested) {
      finish();
      throw new Error('AI request cancelled');
    }
    disposables.push(options.token.onCancellationRequested(() => controller.abort()));
  }
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = options.apiKey ?? null;
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  const body = JSON.stringify({
    model: endpoint.model,
    messages: options.messages.map(m => ({ role: m.role, content: m.content })),
    temperature: endpoint.temperature,
    max_tokens: endpoint.maxTokens
  });
  let lastError = 'AI request failed';
  // KODE-FULL-012:超时定时器/取消订阅的生命周期收口到整个重试轮的
  // finally——此前 ok 但缺 content 的响应先 finish() 清掉定时器再抛错进
  // 重试,下一轮用已死的定时器与已退订的取消监听,悬挂请求可永不截止。
  // 重试轮内保持 deadline 在役:形状坏/网络失败重试仍受总超时与取消约束。
  try {
    for (let attempt = 0; attempt <= endpoint.maxRetries; attempt++) {
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal
        });
        if (response.ok) {
          const payload = (await response.json()) as ChatCompletionResponse;
          const content = payload?.choices?.[0]?.message?.content;
          if (typeof content === 'string') {
            return content;
          }
          lastError = 'AI response missing message content';
        } else if (!isRetryableStatus(response.status)) {
          throw new Error(`AI request failed with status ${response.status}`);
        } else {
          lastError = `AI request failed with status ${response.status}`;
        }
      } catch (error) {
        if (options.token?.isCancellationRequested) {
          throw new Error('AI request cancelled');
        }
        if (controller.signal.aborted) {
          throw new Error('AI request timed out');
        }
        // try 内抛出的 status error 只可能是非重试 4xx(fetch 分支已筛)——
        // 直通出函数,不进重试循环;其余(网络失败/响应形状坏)按可重试记账
        const statusMatch = error instanceof Error && /^AI request failed with status (\d+)$/.exec(error.message);
        if (statusMatch && !isRetryableStatus(Number(statusMatch[1]))) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : lastError;
      }
      if (attempt < endpoint.maxRetries) {
        await doSleep(Math.min(250 * 2 ** attempt, 4000));
      }
    }
    throw new Error(lastError);
  } finally {
    finish();
  }
}

async function sendViaLanguageModel(options: AiSendOptions, onChunk?: (text: string) => void): Promise<string> {
  const models = options.models ?? (await listLanguageModels());
  const model = models[0];
  if (!model) {
    throw new Error('no AI endpoint configured and no language model available');
  }
  const lmApi = (
    vscode as Partial<typeof vscode> & {
      LanguageModelChatMessage?: { User: (t: string) => unknown; Assistant: (t: string) => unknown };
    }
  ).LanguageModelChatMessage;
  const toMessage = (m: AiChatMessage): unknown => {
    if (lmApi) {
      return m.role === 'assistant' ? lmApi.Assistant(m.content) : lmApi.User(m.content);
    }
    return { role: m.role, content: m.content };
  };
  const response = await model.sendRequest(options.messages.map(toMessage), {}, options.token);
  let text = '';
  for await (const chunk of response.text) {
    if (options.token?.isCancellationRequested) {
      break; // 取消即刻停收,已收部分保留(AI-002 中断语义)
    }
    const piece = typeof chunk === 'string' ? chunk : '';
    text += piece;
    if (piece && onChunk) {
      onChunk(piece);
    }
  }
  return text;
}
