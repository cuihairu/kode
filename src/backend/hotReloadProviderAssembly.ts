/**
 * Hot reload send provider host assembly core (HR-PR-08 wiring batch):
 * - The fork-side concrete implementation = createHttpHotfixSendProvider:
 *   it delegates to the existing sendDefaultHotfix core (request
 *   construction / dual-name resolution / per-file execution / result
 *   mapping are all reused — zero second send semantics, HR-MOD-005's
 *   single string-handling discipline inherited verbatim) and passes
 *   {ok, detail} through transport-faithfully;
 * - The host = createHotReloadProviderHost: registry creation + batch
 *   registration (registration happens at host assembly time); duplicate
 *   ids and mismatched apiVersions are honestly reported via onRejection
 *   (never silently absorbed); dispose clears the roster (lifecycle face;
 *   the registry can be rebuilt along with the host); a runtime plugin
 *   crash (canSend throwing) is honestly reported via onProviderError and
 *   skipped so the next provider gets asked (RUST-426 crash isolation: a
 *   single plugin crash must not break the core / main thread);
 * - Resolution order = registration order, first come first answered:
 *   the fork-side injected implementation comes first and the built-in one
 *   last (the assembly face is responsible for registering in that order,
 *   so the fork-specific channel outranks the built-in generic channel);
 * - Pure logic, zero vscode; neither the canSend probe nor send interprets
 *   profile contents (the version gate belongs to the registry API version
 *   face), and send orchestration still belongs to the existing face (same
 *   convention as the HR-PR-08 core comment).
 */

import {
  HOT_RELOAD_PLUGIN_API_VERSION,
  HotReloadProviderRegistry,
  type HotReloadProvider,
  type HotReloadProviderError,
  type HotReloadRegistryRejection
} from './hotReloadPluginApi';
import {
  BUILTIN_HTTP_REQUEST_EXAMPLE,
  type HttpRequestEntry
} from './httpRequests';
import { sendDefaultHotfix, type DefaultHotfixSendDeps } from './hotReloadDefaultHotfix';

/** Built-in fork-side provider id (cross-checked against the registry's duplicate-id rejection) */
export const KBENGINE_HTTP_HOTFIX_PROVIDER_ID = 'kbengine.http-hotfix';

/**
 * HR-EXT-006: template -> runtime adapter implementation. Any user template
 * entry is a swappable HTTP send adapter (it delegates to sendDefaultHotfix
 * and the whole template goes into request construction: the reload URL
 * lives only in the template and is not hard-bound to the built-in one).
 * A user-defined entry = one implementation that can replace the built-in —
 * registration order = resolution answer order (assembly face), so a
 * fork-side template may register first to take priority.
 * HR-EXT-004: the template adapter likewise declares its capabilities
 * explicitly (a template may read the workspace for ${module} probes plus
 * send over the network), same convention as the built-in, no privileged
 * exemption.
 */
export function createTemplateHotfixSendProvider(
  entry: HttpRequestEntry,
  deps: DefaultHotfixSendDeps
): HotReloadProvider {
  return {
    providerId: `kbengine.template-hotfix:${entry.name}`,
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: `KBEngine HTTP hotfix (${entry.name})`,
    permissions: ['workspace', 'network'],
    canSend: () => deps.transport !== undefined,
    send: request =>
      sendDefaultHotfix([...request.files], {
        ...deps,
        template: entry,
        ...(request.moduleIdentities !== undefined
          ? { moduleIdentities: request.moduleIdentities }
          : {}),
        ...(request.revision !== undefined && request.revision.length > 0
          ? { revision: request.revision }
          : {}),
        ...(request.correlationId !== undefined && request.correlationId.length > 0
          ? { correlationId: request.correlationId }
          : {})
      })
  };
}

/**
 * Built-in HTTP hotfix provider: it delegates to sendDefaultHotfix and
 * honestly refuses the job when no transport has been injected.
 * HR-HTTP-002: the request's module identities / revision / correlation id
 * are each passed through item by item (defaults to the pre-increment
 * behavior), and the structured outcome rides back with the result (an
 * optional interface field, produced natively by the HTTP channel).
 * HR-EXT-004: the built-in provider likewise declares its capabilities
 * explicitly (network = POST sending, workspace = reading the workspace for
 * the ${module} fallback-face boundary probe), no privileged exemption —
 * declaring is accounting, and the default policy verdict follows the same
 * convention as any third-party provider.
 * HR-EXT-006: the built-in provider = the adapter implementation of the
 * built-in example template (the same factory, not a special channel); user
 * templates going through createTemplateHotfixSendProvider can replace it
 * wholesale.
 */
export function createHttpHotfixSendProvider(deps: DefaultHotfixSendDeps): HotReloadProvider {
  return {
    ...createTemplateHotfixSendProvider(BUILTIN_HTTP_REQUEST_EXAMPLE, deps),
    providerId: KBENGINE_HTTP_HOTFIX_PROVIDER_ID,
    displayName: 'KBEngine HTTP hotfix'
  };
}

export interface HotReloadProviderHostInput {
  /** Fork-side concrete implementations (registration order = resolution answer order, first come first answered) */
  readonly providers?: readonly HotReloadProvider[];
  /** Honest reporting face when a registration is rejected (duplicate id / apiVersion mismatch); never silently absorbed */
  readonly onRejection?: (rejection: HotReloadRegistryRejection) => void;
  /** Honest reporting face for a runtime provider crash (canSend throwing) (RUST-426 crash isolation) */
  readonly onProviderError?: (error: HotReloadProviderError) => void;
}

export interface HotReloadProviderHost {
  readonly registry: HotReloadProviderRegistry;
  /** Lifecycle: clear all registrations (the assembly face hooks this onto context dispose) */
  dispose(): void;
}

/** Host assembly: registry creation + ordered registration + honest rejection reporting; dispose clears the roster with no half-state */
export function createHotReloadProviderHost(input: HotReloadProviderHostInput = {}): HotReloadProviderHost {
  const registry = new HotReloadProviderRegistry({
    ...(input.onProviderError ? { onProviderError: input.onProviderError } : {})
  });
  for (const provider of input.providers ?? []) {
    const rejection = registry.registerSendProvider(provider);
    if (rejection) {
      input.onRejection?.(rejection);
    }
  }
  return {
    registry,
    dispose: () => {
      registry.clear();
    }
  };
}
