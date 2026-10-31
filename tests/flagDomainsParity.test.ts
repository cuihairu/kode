// flag→domain 真值表对拍:src/generated/flagDomains.ts(派生镜像)与
// Rust golden(crates/kode-server/tests/golden/flag-domains-parity.json,
// 源 crates/kode-parser/src/model.rs normalize_flag_tokens+flag_domains)
// 逐 token 一致,构成双向门禁(Rust 重生成比对 + vitest 复算)。
//
// 只读 fixture 与 golden,不改 src/,对拍语义 = 双实现同真值表。

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, test } from 'vitest';
import {
  CANONICAL_FLAG_TOKENS,
  FLAG_DOMAIN_ALIAS,
  FLAG_TOKEN_DOMAINS,
  normalizeFlagTokens
} from '../src/generated/flagDomains';
import { propertyFlagDomainList } from '../src/defAnalyzer';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(
  REPO_ROOT,
  'crates/kode-server/tests/golden/flag-domains-parity.json'
);

interface FlagDomainsGolden {
  source: string;
  canonical: string[];
  flagDomains: Record<string, string[]>;
  alias: Record<string, string>;
  normalizeCases: [string, string[]][];
}

const readGolden = (): FlagDomainsGolden =>
  JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as FlagDomainsGolden;

describe('flagDomains generated mirror matches Rust golden', () => {
  const golden = readGolden();

  test('canonical token list matches golden in order', () => {
    expect([...CANONICAL_FLAG_TOKENS]).toEqual(golden.canonical);
  });

  test('flag→domain table matches golden exactly', () => {
    expect(JSON.parse(JSON.stringify(FLAG_TOKEN_DOMAINS))).toEqual(golden.flagDomains);
  });

  test('CELL alias normalization matches golden', () => {
    expect({ ...FLAG_DOMAIN_ALIAS }).toEqual(golden.alias);
  });

  test('every canonical token has a domain mapping', () => {
    for (const token of golden.canonical) {
      expect(FLAG_TOKEN_DOMAINS[token], `missing domain mapping for ${token}`).toBeDefined();
    }
  });

  test('normalizeFlagTokens matches Rust normalize matrix exactly', () => {
    for (const [input, expected] of golden.normalizeCases) {
      expect(normalizeFlagTokens(input), `normalize mismatch for ${JSON.stringify(input)}`).toEqual(
        expected
      );
    }
  });
});

describe('propertyFlagDomainList delegates to the generated mirror', () => {
  test('single canonical flags resolve to the documented domains', () => {
    expect(propertyFlagDomainList('BASE')).toEqual(['base']);
    expect(propertyFlagDomainList('BASE_AND_CLIENT')).toEqual(['base', 'client']);
    expect(propertyFlagDomainList('CELL_PUBLIC')).toEqual(['cell']);
    expect(propertyFlagDomainList('CELL_PRIVATE')).toEqual(['cell']);
    expect(propertyFlagDomainList('ALL_CLIENTS')).toEqual(['cell', 'client']);
    expect(propertyFlagDomainList('CELL_PUBLIC_AND_OWN')).toEqual(['cell', 'client']);
    expect(propertyFlagDomainList('OWN_CLIENT')).toEqual(['client']);
    expect(propertyFlagDomainList('OTHER_CLIENTS')).toEqual(['client']);
  });

  test('CELL alias and legacy spellings resolve like the engine', () => {
    expect(propertyFlagDomainList('CELL')).toEqual(['cell']);
    expect(propertyFlagDomainList('ALL CLIENTS')).toEqual(['cell', 'client']);
    expect(propertyFlagDomainList('cell_public')).toEqual(['cell']);
  });

  test('multi-flag union is ordered by base/cell/client', () => {
    expect(propertyFlagDomainList('ALL_CLIENTS|BASE')).toEqual(['base', 'cell', 'client']);
    expect(propertyFlagDomainList('BASE|CELL_PUBLIC')).toEqual(['base', 'cell']);
  });

  test('unknown/empty flags yield no domains', () => {
    expect(propertyFlagDomainList('BOGUS')).toEqual([]);
    expect(propertyFlagDomainList('')).toEqual([]);
    expect(propertyFlagDomainList(undefined)).toEqual([]);
  });
});
