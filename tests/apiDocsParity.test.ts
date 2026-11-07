/**
 * C-21 单一事实源锁:src/generated/apiDocs.ts(TS hover 面)与
 * crates/kode-server/assets/api-docs.json(kode-server 嵌入面)必须逐条
 * 一致——两份产物由 scripts/generate-api-docs.mjs 同源生成,任何漂移都
 * 意味着有人手改了其中一份或生成器不确定。
 *
 * 另锁生成器防漂移:--check 模式在当前知识页上重算必须零漂移。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  API_DOC_ENTRIES,
  API_DOC_ENTRY_COUNT,
  API_DOC_LIBRARY_VERSION
} from '../src/generated/apiDocs';

interface AssetEntry {
  member: string;
  owner: string;
  domain: string;
  kind: 'method' | 'callback' | 'attr' | 'constant';
  signature: string;
  qualifier: string;
  summaryEn: string;
  summaryZh: string;
  sourceRefs: string[];
  page: string;
}

describe('api-docs single source of truth (C-21)', () => {
  const assetPath = path.join(__dirname, '..', 'crates', 'kode-server', 'assets', 'api-docs.json');
  const manifest = JSON.parse(readFileSync(assetPath, 'utf8')) as {
    version: number;
    entryCount: number;
    entries: AssetEntry[];
  };

  it('TS 镜像与 kode-server 嵌入 json 逐条一致', () => {
    expect(API_DOC_LIBRARY_VERSION).toBe(manifest.version);
    expect(API_DOC_ENTRY_COUNT).toBe(manifest.entryCount);
    expect(API_DOC_ENTRIES.length).toBe(manifest.entries.length);
    for (let i = 0; i < manifest.entries.length; i += 1) {
      expect({ ...API_DOC_ENTRIES[i] }).toEqual(manifest.entries[i]);
    }
  });

  it('生成器在当前知识页上零漂移(--check)', () => {
    const repoRoot = path.join(__dirname, '..');
    // 生成物受 --check 门禁:知识页改动后必须重新生成并同 commit 提交
    const out = execFileSync('node', ['scripts/generate-api-docs.mjs', '--check'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(out).toContain('ok: api-docs');
  });

  it('质量地板:条目规模、kind 枚举、回调 onXxx 形态', () => {
    expect(manifest.entries.length).toBeGreaterThanOrEqual(200);
    const kinds = new Set(manifest.entries.map(e => e.kind));
    for (const kind of ['method', 'callback', 'attr', 'constant'] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
    // 裸名 callback 只允许 onXxx 生命周期形态(生成器纪律)
    for (const entry of manifest.entries) {
      if (entry.kind === 'callback' && !entry.signature.includes('.')) {
        expect(entry.member).toMatch(/^on[A-Z]/);
      }
    }
  });

  it('hover/RPC 消费面用到的成员都可解析', () => {
    // A/C/B 触发面与 Rust 测试共享的样本:逐一确保库内可查
    for (const [name, domains] of [
      ['fireEvent', ['base']],
      ['onTimer', ['base']],
      ['createEntity', []],
      ['addTimer', ['base']]
    ] as const) {
      const hit = API_DOC_ENTRIES.find(e => e.member === name && (domains.length === 0 || domains.includes(e.domain as never)));
      expect(hit, `${name}@${domains.join('|')}`).toBeTruthy();
    }
  });
});
