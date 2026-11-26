/**
 * HR-EXT-007 (RUST-411) SDK example face: the two shortest paths for a
 * third party to write a hot reload provider. Pure logic, zero vscode/IO —
 * the examples are the code and are also their own integration test
 * subjects.
 *
 * No parallel abstraction is built; both examples are folded into the
 * existing faces:
 * ① stub = a zero-IO recording provider. It demonstrates the provider shape
 *   that "touches no capability face": it only records the requests it
 *   receives — no network, no disk, no spawned processes — and honestly
 *   returns ok;
 * ② mock HTTP = the same `createTemplateHotfixSendProvider` factory + a
 *   scripted `HttpTransport`. It demonstrates that an HTTP provider's
 *   implementation = a template (HR-EXT-006) + the transport channel, with
 *   the same contract as the built-in `kbengine.http-hotfix` — only the
 *   transport is swapped for a script.
 *
 * Permission conventions are honest (HR-EXT-004): the stub declares nothing
 * -> the default policy yields granted=false for the send face and names
 * network as the missing capability (it truly declared no capability, and
 * the policy does not guess for it either); the mock declares
 * workspace+network (same contract as the built-in) -> granted=true for the
 * send face.
 * Resolution and permissions are **layered**, not one gate:
 * `registry.resolve*` carries no permission assumption (resolution order =
 * registration order, first come first answered), and the permission verdict
 * is the host explicitly invoking the policy at mount time — the examples
 * juxtapose the two and assert them separately, never conflating them.
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

/** Example provider id prefix: its own namespace apart from the built-in `kbengine.*`, so registration never collides on id */
export const EXAMPLE_STUB_PROVIDER_ID = 'example.stub-hotfix';

/**
 * stub provider: zero-IO recording kind. Integration tests use it to assert
 * "which provider the host handed the request to" — every send records one
 * raw request, answers ok verbatim, and never pretends to have touched the
 * network.
 * `calls` grows with every send (accumulated within the same instance) for
 * assertions to consume.
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

/** Each real HTTP outgoing request the mock transport records (the url is the template expansion result) */
export interface MockHttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface MockHttpHotfixOptions {
  /** The template entry; defaults to the built-in example (same contract shape as the built-in HTTP hotfix) */
  readonly entry?: HttpRequestEntry;
  /** Scripted responses: taken in call order, the nth call uses responses[n-1]; out of range falls back to defaultResponse */
  readonly responses?: readonly HttpExecutionResult[];
  readonly defaultResponse?: HttpExecutionResult;
  /**
   * The remaining send deps (scriptRoot / timeoutMs / ...); the transport is
   * taken over by the mock, so passing one in has no effect — the whole point
   * of the mock is that the transport is replaced by a script.
   */
  readonly sendDeps?: Omit<DefaultHotfixSendDeps, 'transport'>;
}

/** mock HTTP provider: the same factory + a scripted transport, same contract as the built-in */
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
 * The side-by-side verdicts for the two examples under the default
 * permission policy (the integration test assertion face):
 * - stub declares nothing -> granted=false for the send face,
 *   missing=['network'], and the reason names the id;
 * - mock declares workspace+network -> granted=true for the send face.
 * The policy itself is not implemented here; it just uses the existing
 * `createDefaultHotReloadPermissionPolicy` directly, gathering the
 * juxtaposed conclusions into a single function without inventing new
 * verdict logic.
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