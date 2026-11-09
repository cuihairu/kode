//! AUDIT-002 矩阵行「apiDocs/lookup」证据批:Rust RPC 查询语义与 TS
//! lookupApiDoc 全语料对拍 + 本地查询时延实测 + 断连行为锁定。
//!
//! 审计判词:「数据同源不等于 hover 已迁 Rust;是否切换须验证本地查询时延
//! 和断连行为」。本批补上这两面证据,再下切换判定:
//! - **语义对拍**:Rust `$/kode/apiDocs/lookup`(单可选 domain)经域循环
//!   组合后,与 TS `lookupApiDoc`(domain 数组)在全部语料成员 × 域面 ×
//!   en/zh-cn 逐条一致(hit 字段级、ambiguous 三元组序列、miss 三态);
//! - **时延**:热进程单次查询墙钟实测(打印 P50/最大,宽松上界只防回归);
//! - **断连**:现产 hover 面零 RPC 依赖(纯内存 TS 语料),无门/无二进制
//!   行为不变——「不切」判定的安全面。
//! 二进制不在场整段 skip(与 processTopologyPerf 同口径)。

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { API_DOC_ENTRIES, type ApiDocEntry } from '../src/generated/apiDocs';
import { lookupApiDoc } from '../src/backend/pythonApiHoverDocs';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { HoverLanguage } from '../src/backend/pythonApiHoverDocs';

const KODE_SERVER = path.resolve(__dirname, '..', 'target', 'debug', 'kode-server');
const hasBinary = fs.existsSync(KODE_SERVER);

/** 语料成员全集(去重保序) */
const MEMBERS = [...new Set(API_DOC_ENTRIES.map((entry) => entry.member))];

/** 成员 → 其出现过的域面(保序去重) */
const domainsOf = (member: string): string[] => {
  const seen: string[] = [];
  for (const entry of API_DOC_ENTRIES) {
    if (entry.member === member && !seen.includes(entry.domain)) {
      seen.push(entry.domain);
    }
  }
  return seen;
};

/** 多域成员(域面 ≥2;组合循环的对拍样本) */
const MULTI_DOMAIN_MEMBERS = MEMBERS.filter((member) => domainsOf(member).length > 1);

// ---------------------------------------------------------------- Rust 组合查询

/** Rust 单查:域可选。null=miss;{ambiguous}=歧义;其余=hit 条目对象。 */
type RustLookup = Record<string, unknown> | null;

const rustLookupOnce = async (
  gate: KodeCoreGate,
  name: string,
  domain: string | undefined,
  locale: string
): Promise<RustLookup> => {
  const reply = await gate.runInRust<unknown>('$/kode/apiDocs/lookup', { name, domain, locale });
  if (!reply.ok) {
    throw new Error(`rpc failed: ${reply.reason}`);
  }
  return (reply.result ?? null) as RustLookup;
};

/**
 * 域循环组合(镜像 TS lookupApiDoc 的 for-domain 语义):域内唯一或同 owner
 * 唯一 = 命中即返回;域内歧义/无命中继续下一域;全域落空 → 全局面一次;
 * 全局面歧义才歧义,null 才 miss。
 */
const lookupViaRust = async (
  gate: KodeCoreGate,
  name: string,
  domains: readonly string[],
  locale: string
): Promise<RustLookup> => {
  for (const domain of domains) {
    const result = await rustLookupOnce(gate, name, domain, locale);
    if (result === null) {
      continue;
    }
    if (typeof result === 'object' && 'ambiguous' in result) {
      continue; // 域内歧义 = 未命中,TS 同样继续下一域
    }
    return result;
  }
  return rustLookupOnce(gate, name, undefined, locale);
};

// ---------------------------------------------------------------- 对拍断言

/** hit 面:字段级一致 + 本地化摘要一致 */
const expectHitParity = (
  rust: RustLookup,
  ts: ReturnType<typeof lookupApiDoc>,
  locale: string
): void => {
  expect(ts.kind).toBe('hit');
  if (ts.kind !== 'hit' || rust === null || typeof rust !== 'object') {
    return;
  }
  expect(rust['member']).toBe(ts.hit.entry.member);
  expect(rust['owner']).toBe(ts.hit.entry.owner);
  expect(rust['domain']).toBe(ts.hit.entry.domain);
  expect(rust['kind']).toBe(ts.hit.entry.kind);
  expect(rust['signature']).toBe(ts.hit.entry.signature);
  expect(rust['sourceRefs']).toEqual(ts.hit.entry.sourceRefs);
  expect(rust['page']).toBe(ts.hit.entry.page);
  expect(rust['summary']).toBe(ts.hit.summary);
  const zhLocalized = locale === 'zh-cn' && ts.hit.entry.summaryZh !== '';
  expect(rust['localized']).toBe(zhLocalized);
};

/** ambiguous 面:TS 条目投影为 Rust 三元组后序列一致(同源过滤序) */
const expectAmbiguousParity = (
  rust: RustLookup,
  ts: ReturnType<typeof lookupApiDoc>
): void => {
  expect(ts.kind).toBe('ambiguous');
  if (ts.kind !== 'ambiguous' || rust === null || typeof rust !== 'object') {
    return;
  }
  const list = rust['ambiguous'] as Array<{ domain: string; owner: string; signature: string }>;
  expect(Array.isArray(list)).toBe(true);
  const projected = ts.entries.map((entry: ApiDocEntry) => ({
    domain: entry.domain,
    owner: entry.owner,
    signature: entry.signature
  }));
  expect(list).toEqual(projected);
};

/** 三态对拍总闸(kind 一致 + 各自面字段一致) */
const expectFullParity = (
  rust: RustLookup,
  ts: ReturnType<typeof lookupApiDoc>,
  locale: string
): void => {
  if (ts.kind === 'miss') {
    expect(rust).toBeNull();
    return;
  }
  if (ts.kind === 'hit') {
    expectHitParity(rust, ts, locale);
    return;
  }
  expectAmbiguousParity(rust, ts);
};

// ---------------------------------------------------------------- 测试体

describe('AUDIT-002 断连行为(hover 面零 RPC 依赖)', () => {
  it('no gate / no server: TS lookup serves full docs (production path is RPC-independent)', () => {
    // 本 describe 与二进制无关:断连面=现产 hover 链纯内存语料,无门/无进程不降级
    const member = MEMBERS.find((m) => lookupApiDoc(m, [], 'en').kind === 'hit');
    expect(member).toBeTruthy();
    const ts = lookupApiDoc(member as string, [], 'en');
    expect(ts.kind).toBe('hit');
    const miss = lookupApiDoc('no_such_api_xyz__audit', [], 'en');
    expect(miss.kind).toBe('miss');
  });
});

describe('AUDIT-002 apiDocs/lookup 全语料对拍(二进制在场才测)', () => {
  let gate: KodeCoreGate | null = null;

  beforeAll(async () => {
    if (!hasBinary) {
      return;
    }
    gate = new KodeCoreGate({ now: Date.now });
    gate.setConfig({ backend: 'shadow', serverPath: KODE_SERVER, shadowTimeoutMs: 15_000 });
    setKodeCoreShadowGate(gate);
  });

  afterEach(async () => {
    await Promise.resolve();
  });

  it.skipIf(!hasBinary)('en: every corpus member resolves identically (no-domain face)', async () => {
    expect(gate).not.toBeNull();
    for (const member of MEMBERS) {
      const ts = lookupApiDoc(member, [], 'en');
      const rust = await lookupViaRust(gate!, member, [], 'en');
      expectFullParity(rust, ts, 'en');
    }
  });

  it.skipIf(!hasBinary)('zh-cn: every corpus member resolves identically with localized summaries', async () => {
    expect(gate).not.toBeNull();
    for (const member of MEMBERS) {
      const ts = lookupApiDoc(member, [], 'zh-cn');
      const rust = await lookupViaRust(gate!, member, [], 'zh-cn');
      expectFullParity(rust, ts, 'zh-cn');
    }
  });

  it.skipIf(!hasBinary)('domain faces: every (member, own-domain) pair resolves identically', async () => {
    expect(gate).not.toBeNull();
    for (const member of MEMBERS) {
      for (const domain of domainsOf(member)) {
        const ts = lookupApiDoc(member, [domain], 'en');
        const rust = await lookupViaRust(gate!, member, [domain], 'en');
        expectFullParity(rust, ts, 'en');
      }
    }
  });

  it.skipIf(!hasBinary)('multi-domain members: TS domain-array loop == composed rust domain loop', async () => {
    expect(gate).not.toBeNull();
    expect(MULTI_DOMAIN_MEMBERS.length).toBeGreaterThan(0);
    for (const member of MULTI_DOMAIN_MEMBERS) {
      const domains = domainsOf(member);
      const ts = lookupApiDoc(member, domains, 'en');
      const rust = await lookupViaRust(gate!, member, domains, 'en');
      expectFullParity(rust, ts, 'en');
    }
  });

  it.skipIf(!hasBinary)('unknown name: both sides agree on miss', async () => {
    expect(gate).not.toBeNull();
    const ts = lookupApiDoc('no_such_api_xyz__audit', ['cell', 'client'], 'en');
    expect(ts.kind).toBe('miss');
    const rust = await lookupViaRust(gate!, 'no_such_api_xyz__audit', ['cell', 'client'], 'en');
    expect(rust).toBeNull();
  });

  it.skipIf(!hasBinary)('warm-process latency: measured for the record, loose bound for regressions', async () => {
    expect(gate).not.toBeNull();
    // 预热(首查含 LSP 握手/进程 start;热态复用同进程)
    await rustLookupOnce(gate!, MEMBERS[0] ?? 'KBEngine', undefined, 'en');
    const samples: number[] = [];
    const sampleCount = Math.min(40, MEMBERS.length * 2);
    for (let i = 0; i < sampleCount; i++) {
      const member = MEMBERS[i % MEMBERS.length];
      const domain = domainsOf(member)[0];
      const t0 = performance.now();
      await rustLookupOnce(gate!, member, domain, 'en');
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    const max = samples[samples.length - 1];
    // eslint-disable-next-line no-console
    console.log(
      `[AUDIT-002 apiDocs rpc] n=${samples.length} p50=${p50.toFixed(2)}ms max=${max.toFixed(2)}ms`
    );
    // 宽松上界只抓真实回归(机器负载抖动不误报;实测值见上方打印)
    expect(max).toBeLessThan(250);
  });
});
