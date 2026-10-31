// DO NOT EDIT — Rust golden 的派生镜像,勿手改。
// 单一来源 = crates/kode-parser/src/model.rs normalize_flag_tokens + flag_domains;
// golden 快照 = crates/kode-server/tests/golden/flag-domains-parity.json
//   (重生成: cargo run -p kode-server --bin dump-flag-domains-golden
//    > crates/kode-server/tests/golden/flag-domains-parity.json)。
// 锁步门禁 = tests/flagDomainsParity.test.ts 断言本模块与 golden 一致。

export type FlagDomain = 'base' | 'cell' | 'client';

/** 规范旗标 token 全集(Rust KNOWN 同集)。 */
export const CANONICAL_FLAG_TOKENS: readonly string[] = [
  'BASE',
  'BASE_AND_CLIENT',
  'CELL_PUBLIC',
  'CELL_PRIVATE',
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'OTHER_CLIENTS'
];

/** 旗标 token → 三域位(common.h L19-45 真值;Rust flag_domains 派生)。 */
export const FLAG_TOKEN_DOMAINS: Readonly<Record<string, readonly FlagDomain[]>> = {
  BASE: ['base'],
  BASE_AND_CLIENT: ['base', 'client'],
  CELL_PUBLIC: ['cell'],
  CELL_PRIVATE: ['cell'],
  ALL_CLIENTS: ['cell', 'client'],
  CELL_PUBLIC_AND_OWN: ['cell', 'client'],
  OWN_CLIENT: ['client'],
  OTHER_CLIENTS: ['client']
};

/** 旗标别名归一(g_entityFlagMapping,entitydef.cpp L161:CELL → CELL_PUBLIC)。 */
export const FLAG_DOMAIN_ALIAS: Readonly<Record<string, string>> = {
  CELL: 'CELL_PUBLIC'
};

/**
 * 旗标原文 → 规范化 token 列表(镜像 Rust normalize_flag_tokens:trim+大写、
 * CELL 别名、遗留拼写折叠——去空白/下划线/连字符后对照规范形;未知保留
 * 大写;去重保序)。
 */
export function normalizeFlagTokens(raw: string): string[] {
  const out: string[] = [];
  for (const token of raw.split('|')) {
    const upper = token.trim().toUpperCase();
    if (upper === '') {
      continue;
    }
    let canonical: string;
    if (upper === 'CELL') {
      canonical = 'CELL_PUBLIC';
    } else if (CANONICAL_FLAG_TOKENS.includes(upper)) {
      canonical = upper;
    } else {
      const compact = upper.replace(/[\t _-]/g, '');
      canonical = CANONICAL_FLAG_TOKENS.find(k => k.replace(/_/g, '') === compact) ?? upper;
    }
    if (!out.includes(canonical)) {
      out.push(canonical);
    }
  }
  return out;
}
