/**
 * 热更发送 provider 宿主装配核(HR-PR-08 接线批):
 * - fork 侧具体实现=createHttpHotfixSendProvider:委托既有 sendDefaultHotfix
 *   核(请求构造/双名解析/逐文件执行/结果映射全部复用,零第二套发送语义
 *   ——HR-MOD-005 单一字符串处理纪律原样继承),transport-faithful 透传
 *   {ok, detail};
 * - 宿主=createHotReloadProviderHost:注册表创建+批量注册(注册时机=
 *   宿主装配时),重复 id/apiVersion 不符经 onRejection 如实上报(不静默
 *   收编),dispose 清册(生命周期面;注册表可随宿主重建);运行时插件崩溃
 *   (canSend 抛错)经 onProviderError 如实上报并跳过继续问下一个(RUST-426
 *   崩溃隔离:单插件崩溃不打断核心/主线程);
 * - 解析序=注册序先到先应答:fork 侧注入实现在前、内置实现在后(装配面
 *   负责以该序注册,fork 专属通道优先于内置通用通道);
 * - 纯逻辑零 vscode;canSend 探测与 send 都不解释 profile 内容(版本闸
 *   归注册表 API 版本面),发送编排仍归既有面(HR-PR-08 核注释同口径)。
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

/** 内置 fork 侧 provider id(与注册表重复 id 拒绝对账) */
export const KBENGINE_HTTP_HOTFIX_PROVIDER_ID = 'kbengine.http-hotfix';

/**
 * HR-EXT-006:模板→runtime adapter 实现。任何用户模板条目都是一份可替换的
 * HTTP 发送 adapter(委托 sendDefaultHotfix,模板整条进请求构造:reload URL
 * 只活在模板里,不与内置绑死)。用户自定义条目=一份实现,可替换内置——
 * 注册序=解析应答序(装配面),fork 侧模板可先注册优先。
 * HR-EXT-004:模板 adapter 同样显式声明能力(模板可能读工作区做 ${module}
 * 探针 + 联网发送),与内置同口径,不做特权豁免。
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
 * 内置 HTTP hotfix provider:委托 sendDefaultHotfix,transport 未注入时如实不接单。
 * HR-HTTP-002:请求上的模块身份/版本/关联 id 逐项透传(缺省=行为与增量前一致),
 * 结构化 outcome 随结果回传(接口可选字段,HTTP 通道即产)。
 * HR-EXT-004:内置 provider 同样显式声明能力(network=POST 发送,
 * workspace=${module} 回落面包边界探针读工作区),不做特权豁免——
 * 声明即对账,缺省策略判定与第三方同口径。
 * HR-EXT-006:内置 provider=内置示例模板的 adapter 实现(同一工厂,
 * 不是特殊通道);用户模板走 createTemplateHotfixSendProvider 可整体替换。
 */
export function createHttpHotfixSendProvider(deps: DefaultHotfixSendDeps): HotReloadProvider {
  return {
    ...createTemplateHotfixSendProvider(BUILTIN_HTTP_REQUEST_EXAMPLE, deps),
    providerId: KBENGINE_HTTP_HOTFIX_PROVIDER_ID,
    displayName: 'KBEngine HTTP hotfix'
  };
}

export interface HotReloadProviderHostInput {
  /** fork 侧具体实现(注册序=解析应答序,先到先应答) */
  readonly providers?: readonly HotReloadProvider[];
  /** 注册被拒(重复 id/apiVersion 不符)如实上报面;不静默收编 */
  readonly onRejection?: (rejection: HotReloadRegistryRejection) => void;
  /** 运行时 provider 崩溃(canSend 抛错)如实上报面(RUST-426 崩溃隔离) */
  readonly onProviderError?: (error: HotReloadProviderError) => void;
}

export interface HotReloadProviderHost {
  readonly registry: HotReloadProviderRegistry;
  /** 生命周期:清空全部注册(装配面挂 context dispose) */
  dispose(): void;
}

/** 宿主装配:注册表创建+按序注册+被拒如实上报;dispose 清册不半态 */
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
