/**
 * HR-EXT-007(RUST-411)SDK 示例面:第三方写热更 provider 的两条最短路径。
 * 纯逻辑零 vscode/IO——示例即代码,也是它的集成测试对象。
 *
 * 不建平行抽象,两例都收编既有 face:
 * ① stub=零 IO 记录型 provider。证明「不触任何能力面」的 provider 形态:
 *   只把收到的请求记账,不联网不读盘不起进程,返回如实 ok;
 * ② mock HTTP=同一 `createTemplateHotfixSendProvider` 工厂 + 脚本化
 *   `HttpTransport`。证明 HTTP provider 的实现=模板(HR-EXT-006)+ 传输通道,
 *   与内置 `kbengine.http-hotfix` 同契约——只是 transport 换成脚本。
 *
 * 权限口径如实(HR-EXT-004):stub 零声明 → 缺省策略对 send 面 granted=false
 * 并点名缺 network(它确实没声明任何能力,策略也不替它猜);mock 声明
 * workspace+network(与内置同契约)→ send 面 granted=true。
 * 解析与权限是**分层**不是同一道闸:`registry.resolve*` 不含权限假设
 * (解析序=注册序先到先应答),权限判定由宿主挂载期显式调用策略——示例把
 * 两者并置分别断言,不混判。
 */

import {
  HOT_RELOAD_PLUGIN_API_VERSION,
  type HotReloadPermissionPolicy,
  type HotReloadProvider,
  type HotReloadProviderSendRequest
} from './hotReloadPluginApi';
import {
  BUILTIN_HTTP_REQUEST_EXAMPLE,
  type HttpRequestEntry
} from './httpRequests';
import {
  createTemplateHotfixSendProvider
} from './hotReloadProviderAssembly';
import type {
  DefaultHotfixSendDeps
} from './hotReloadDefaultHotfix';
import type {
  HttpExecutionResult,
  OutgoingHttpRequest
} from './httpRequestService';

/** 示例 provider id 前缀:与内置 `kbengine.*` 分命名空间,注册不撞 id */
export const EXAMPLE_STUB_PROVIDER_ID = 'example.stub-hotfix';

/**
 * stub provider:零 IO 记录型。集成测试用它断言「宿主把请求递给了谁」——
 * 每次 send 记一条原始请求,原样回 ok,绝不假装发过网络。
 * `calls` 随每次 send 增长(同一实例内累积),供断言取用。
 */
export interface StubHotReloadProvider extends HotReloadProvider {
  readonly calls: readonly HotReloadProviderSendRequest[];
}

export function createStubHotReloadProvider(): StubHotReloadProvider {
  const calls: HotReloadProviderSendRequest[] = [];
  return {
    providerId: EXAMPLE_STUB_PROVIDER_ID,
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: 'KBEngine stub hotfix (example)',
    canSend: () => true,
    send: request => {
      calls.push(request);
      return { ok: true, detail: '' };
    },
    calls
  };
}

/** mock transport 记录到的每条真实 HTTP 出口请求(url 即模板展开结果) */
export interface MockHttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface MockHttpHotfixOptions {
  /** 模板条目;缺省=内置示例(与内置 HTTP hotfix 同契约形态) */
  readonly entry?: HttpRequestEntry;
  /** 脚本化应答:按调用序取,第 n 次用 responses[n-1];越界回退 defaultResponse */
  readonly responses?: readonly HttpExecutionResult[];
  readonly defaultResponse?: HttpExecutionResult;
  /**
   * 其余发送 deps(scriptRoot/timeoutMs/...);transport 由 mock 接管,
   * 传进来也不生效——mock 的整点就是 transport 被脚本替掉。
   */
  readonly sendDeps?: Omit<DefaultHotfixSendDeps, 'transport'>;
}

/** mock HTTP provider:同一工厂 + 脚本 transport,与内置同契约 */
export interface MockHttpHotfixProvider extends HotReloadProvider {
  readonly calls: readonly MockHttpCall[];
}

export function createMockHttpHotfixProvider(
  options: MockHttpHotfixOptions = {}
): MockHttpHotfixProvider {
  const calls: MockHttpCall[] = [];
  const defaultResponse =
    options.defaultResponse ??
    ({ ok: true, status: 200, durationMs: 1, body: 'ok' } satisfies HttpExecutionResult);
  const transport = async (request: OutgoingHttpRequest): Promise<HttpExecutionResult> => {
    calls.push({
      url: request.url,
      method: request.method,
      headers: { ...request.headers },
      body: request.body
    });
    return options.responses?.[calls.length - 1] ?? defaultResponse;
  };
  const sendDeps = options.sendDeps ?? {};
  return {
    ...createTemplateHotfixSendProvider(options.entry ?? BUILTIN_HTTP_REQUEST_EXAMPLE, {
      ...sendDeps,
      transport
    }),
    calls
  };
}

/**
 * 缺省权限策略下两例的判定并置(集成测试断言面):
 * - stub 零声明 → send 面 granted=false,missing=['network'],reason 点名 id;
 * - mock 声明 workspace+network → send 面 granted=true。
 * 策略本身不在此实现,直接用既有 `createDefaultHotReloadPermissionPolicy`,
 * 只把并置结论收成一枚函数,不另造判定逻辑。
 */
export function examplePermissionVerdicts(
  policy: HotReloadPermissionPolicy,
  stub: StubHotReloadProvider,
  mock: MockHttpHotfixProvider
) {
  return {
    stubSend: policy.check(stub, 'send'),
    mockSend: policy.check(mock, 'send'),
    stubSpawn: policy.check(stub, 'spawn-process'),
    mockSpawn: policy.check(mock, 'spawn-process')
  };
}