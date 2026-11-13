/**
 * 热更发送 provider 宿主装配核(HR-PR-08 接线批):
 * - fork 侧具体实现=createHttpHotfixSendProvider:委托既有 sendDefaultHotfix
 *   核(请求构造/双名解析/逐文件执行/结果映射全部复用,零第二套发送语义
 *   ——HR-MOD-005 单一字符串处理纪律原样继承),transport-faithful 透传
 *   {ok, detail};
 * - 宿主=createHotReloadProviderHost:注册表创建+批量注册(注册时机=
 *   宿主装配时),重复 id/apiVersion 不符经 onRejection 如实上报(不静默
 *   收编),dispose 清册(生命周期面;注册表可随宿主重建);
 * - 解析序=注册序先到先应答:fork 侧注入实现在前、内置实现在后(装配面
 *   负责以该序注册,fork 专属通道优先于内置通用通道);
 * - 纯逻辑零 vscode;canSend 探测与 send 都不解释 profile 内容(版本闸
 *   归注册表 API 版本面),发送编排仍归既有面(HR-PR-08 核注释同口径)。
 */

import {
  HOT_RELOAD_PLUGIN_API_VERSION,
  HotReloadProviderRegistry,
  type HotReloadProvider,
  type HotReloadRegistryRejection
} from './hotReloadPluginApi';
import { sendDefaultHotfix, type DefaultHotfixSendDeps } from './hotReloadDefaultHotfix';

/** 内置 fork 侧 provider id(与注册表重复 id 拒绝对账) */
export const KBENGINE_HTTP_HOTFIX_PROVIDER_ID = 'kbengine.http-hotfix';

/** 内置 HTTP hotfix provider:委托 sendDefaultHotfix,transport 未注入时如实不接单 */
export function createHttpHotfixSendProvider(deps: DefaultHotfixSendDeps): HotReloadProvider {
  return {
    providerId: KBENGINE_HTTP_HOTFIX_PROVIDER_ID,
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: 'KBEngine HTTP hotfix',
    canSend: () => deps.transport !== undefined,
    send: request => sendDefaultHotfix([...request.files], deps)
  };
}

export interface HotReloadProviderHostInput {
  /** fork 侧具体实现(注册序=解析应答序,先到先应答) */
  readonly providers?: readonly HotReloadProvider[];
  /** 注册被拒(重复 id/apiVersion 不符)如实上报面;不静默收编 */
  readonly onRejection?: (rejection: HotReloadRegistryRejection) => void;
}

export interface HotReloadProviderHost {
  readonly registry: HotReloadProviderRegistry;
  /** 生命周期:清空全部注册(装配面挂 context dispose) */
  dispose(): void;
}

/** 宿主装配:注册表创建+按序注册+被拒如实上报;dispose 清册不半态 */
export function createHotReloadProviderHost(input: HotReloadProviderHostInput = {}): HotReloadProviderHost {
  const registry = new HotReloadProviderRegistry();
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
