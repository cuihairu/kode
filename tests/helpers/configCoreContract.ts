// KODE-CFG-009 门替身契约镜像:
// `$/kode/config/resolve` 的响应契约替身——实现自 AUDIT-007 起取自生产回落核
// src/serverConfigFallbackCore.ts(单一事实源:替身 ≡ TS 回落 ≡ Rust,语义
// 由 tests/serverConfigFallbackParity.test.ts 以真实二进制 RPC 输出为 golden
// 锁定)。消费端接线测试(serverConfigMerge.test.ts 等)用本替身伪造门响应,
// 与 configDeriveScanRoot.test.ts 的 contractDerive 同一先例:替身只按契约回
// 数,TS 侧接线(送达原文→消费 core 树→缓存/降级)是真被验面。

import type { KodeCoreGate } from '../../src/backend/kodeCoreGate';
import {
  ENGINE_DEFAULT_TELNET_PORTS,
  extractDatabaseInterfaceConfig,
  mergeConfigXml,
  parseConfigXml,
  resolveConfigProductsInTs,
  type ConfigResolveProducts
} from '../../src/serverConfigFallbackCore';
import type { ConfigXmlNode } from '../../src/serverConfigMerge';

export {
  ENGINE_DEFAULT_TELNET_PORTS,
  extractDatabaseInterfaceConfig,
  mergeConfigXml,
  parseConfigXml
};
export type { ConfigXmlNode };

// ---- 门替身工厂:按 `$/kode/config/resolve` 契约回数(调用序可断言) ----

export interface ContractGateCall {
  method: string;
  params: {
    defaultsXml: string | null;
    customXml: string | null;
  };
}

/** resolve 契约响应体(生产回落核产物;导出供各门替身复用) */
export function contractResolveResult(
  defaultsXml: string | null,
  customXml: string | null
): ConfigResolveProducts {
  return resolveConfigProductsInTs(defaultsXml, customXml);
}

/** 契约门替身:resolve 按镜像语义回数;其余方法调用方自行在 calls 里核对 */
export function makeContractGate(calls: ContractGateCall[]): KodeCoreGate {
  return {
    runInRust: async (method: string, params: unknown) => {
      calls.push({
        method,
        params: params as ContractGateCall['params']
      });
      if (method !== '$/kode/config/resolve') {
        return { ok: true as const, result: {} };
      }
      const p = params as { defaultsXml: string | null; customXml: string | null };
      return {
        ok: true as const,
        result: contractResolveResult(p.defaultsXml, p.customXml)
      };
    }
  } as unknown as KodeCoreGate;
}
