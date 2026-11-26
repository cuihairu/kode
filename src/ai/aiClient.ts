// AI foundation (AI-001, plan C, user ruling 2026-11-17): OpenAI-compatible
// /v1/chat/completions, ships its own fetch, zero new dependencies; falls back
// to vscode.lm (LanguageModelChat, feature-detect — engines.vscode 1.82
// predates the lm API introduced in 1.90, so existence probing cannot be
// skipped; kodeMcpHost follows the same contract). The API key is stored only
// in SecretStorage and never in settings.json (the configuration surface has no
// key field). Off by default: when no endpoint is configured and no lm model
// is available, no AI command is registered (lazy activation, zero cost).
// Requests carry a timeout/cancel (CancellationToken threads through abort) and
// a retry cap; telemetry is nil — no outbound traffic unless a user explicitly
// triggers it, and only the snippet the command needs is sent.
import * as vscode from 'vscode';

/** SecretStorage key name; paired commands kbengine.ai.setApiKey / kbengine.ai.clearApiKey */
export const AI_API_KEY_SECRET = 'kbengine.ai.apiKey';

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** kbengine.ai.* endpoint knobs (all served from settings; the key is not among them) */
export interface AiEndpointConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

/**
 * Injection shape for the vscode.lm LanguageModelChat surface (production = the
 * instance found by feature-detect).
 * KODE-FULL-011: aligned to the host's real contract — sendRequest(messages,
 * options?, token?) takes three arguments, token being the third (the old
 * two-argument shape stuffed token into the options slot); response.text yields
 * the raw string piece by piece, not a { content } object (the old reader
 * parsed every real string piece as '' and the reply was swallowed into an
 * empty string). The stand-in (tests) is built against the host API as well.
 */
export interface AiLanguageModelLike {
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: vscode.CancellationToken
  ): { text: AsyncIterable<string> };
}

/** SecretStorage injection shape (vscode context.secrets already fits it; Thenable = the global in vscode.d.ts) */
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

/** Read the kbengine.ai.* group; invalid numbers fall back to the defaults, with no implicit clamping */
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

/** Endpoint is configured (baseUrl non-empty) — the key may be empty, local compatible services often skip auth */
export function hasConfiguredEndpoint(config: AiEndpointConfig): boolean {
  return config.baseUrl.trim().length > 0;
}

/** vscode.lm feature-detect: API absent (engines 1.82<1.90) or probe failure = empty set */
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
 * AI surface availability = registration criterion: baseUrl is configured (user
 * explicitly opted in) or at least one lm model exists (the host already has a
 * BYOK provider). Neither → false → no command is registered.
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
  /** Resolved endpoint; null/omitted = fall back to the lm route */
  endpoint?: AiEndpointConfig | null;
  /** Key read from SecretStorage; may be empty (no-auth services) */
  apiKey?: string | null;
  token?: vscode.CancellationToken;
  /** Injected lm fallback model set (production = default to listLanguageModels) */
  models?: AiLanguageModelLike[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 429/5xx and network failures are retryable; other 4xx are never retried */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * Send one round of conversation and return the full reply text. Endpoint route:
 * POST {baseUrl}/v1/chat/completions with Authorization Bearer <key> (the header
 * is omitted when the key is empty); aborts after requestTimeoutMs; cancellation
 * threads through abort. lm fallback route: model.sendRequest aggregated from
 * the stream. No available surface = throw (the caller turns it into a
 * user-visible message); never fail silently as a false success.
 */
export async function sendAiMessage(options: AiSendOptions): Promise<string> {
  const endpoint = options.endpoint ?? resolveAiEndpointConfig();
  if (hasConfiguredEndpoint(endpoint)) {
    return sendViaEndpoint(options, endpoint);
  }
  return sendViaLanguageModel(options);
}

/**
 * Streaming variant (AI-002 chat panel): onChunk is called piece by piece. The
 * lm route passes each chunk through and stops collecting immediately on
 * cancel (the already-received part is kept and returned); the endpoint
 * compatible surface renders the reply once in a single shot when the whole
 * body has arrived (this batch does not force SSE, interruption = abort is
 * already threaded through) — the caller notes both arrival shapes in the panel.
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
  // KODE-FULL-012: the timeout timer / cancellation subscription lifecycle is
  // closed out in the finally of the whole retry round — previously an ok
  // response missing content called finish() (clearing the timer) and then threw
  // into the retry, so the next round reused a dead timer and an unsubscribed
  // cancellation listener, and a hung request could never expire.
  // Keep the deadline live inside the retry round: shape/network-failure retries
  // are still bound by the total timeout and cancellation.
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
        // A status error thrown inside the try can only be a non-retryable 4xx
        // (the fetch branch already filtered it) — pass it straight out of the
        // function, no retry loop; everything else (network failure / bad
        // response shape) is accounted for as retryable
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
      break; // cancel stops collecting at once, the received part is kept (AI-002 interruption semantics)
    }
    const piece = typeof chunk === 'string' ? chunk : '';
    text += piece;
    if (piece && onChunk) {
      onChunk(piece);
    }
  }
  return text;
}
