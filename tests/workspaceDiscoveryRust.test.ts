import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setKodeCoreShadowGate, type KodeCoreGate } from '../src/kodeCoreShadowFaces';
import { KodeCoreClient } from '../src/kodeCoreClient';
import { collectDiscoveryCandidates, preheatDiscoveryScanInRust, resetDiscoveryState, runWorkspaceDiscovery } from '../src/workspaceDiscovery';

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-rust-'));
  roots.push(root);
  return root;
}
function scan(entityDefs: string[]) {
  return { entityDefs, entitiesXml: [], typesXml: [], kbeSourceRoots: [], messagesXml: [], configRoots: [], scanVisited: 2, scanTruncated: false };
}
afterEach(() => {
  setKodeCoreShadowGate(null);
  resetDiscoveryState();
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

describe('workspace discovery Rust consumption', () => {
  it.skipIf(!process.env.KODE_DISCOVERY_TEST_SERVER)('uses the real server RPC for workspace discovery', async () => {
    const root = tempRoot();
    const first = path.join(root, 'one', 'entity_defs');
    const second = path.join(root, 'two', 'entity_defs');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const client = new KodeCoreClient({ binaryPath: process.env.KODE_DISCOVERY_TEST_SERVER! });
    await client.start();
    setKodeCoreShadowGate({ runInRust: async (method: string, params: unknown) => ({
      ok: true, result: await client.request('$/kode/rpc', { method, params })
    }) } as unknown as KodeCoreGate);
    try {
      const pick = vi.fn(async () => undefined);
      await runWorkspaceDiscovery({ recall: () => undefined, remember: () => undefined, showQuickPick: pick }, root);
      expect(pick).toHaveBeenCalledTimes(1);
      expect(pick.mock.calls[0][0]).toEqual(expect.arrayContaining([first, second]));
    } finally {
      await client.dispose();
    }
  });

  it('uses Rust candidates in the actual async discovery command', async () => {
    const root = tempRoot();
    const first = path.join(root, 'x', 'entity_defs');
    const second = path.join(root, 'y', 'entity_defs');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const runInRust = vi.fn(async () => ({ ok: true as const, result: scan([first, second]) }));
    setKodeCoreShadowGate({ runInRust } as unknown as KodeCoreGate);
    const pick = vi.fn(async () => undefined);
    await runWorkspaceDiscovery({ recall: () => undefined, remember: () => undefined, showQuickPick: pick }, root);
    expect(runInRust).toHaveBeenCalledWith('$/kode/workspace/scanAnchors', { root }, { timeoutMs: 5000 });
    expect(pick).toHaveBeenCalledWith([first, second], expect.any(String));
  });

  it('falls back to the TS scan for malformed Rust output', async () => {
    const root = tempRoot();
    const actual = path.join(root, 'nested', 'entity_defs');
    mkdirSync(actual, { recursive: true });
    setKodeCoreShadowGate({ runInRust: async () => ({ ok: true, result: { entityDefs: ['bad'] } }) } as unknown as KodeCoreGate);
    await preheatDiscoveryScanInRust(root);
    expect(collectDiscoveryCandidates(root).candidates.entityDefs).toContain(actual);
  });

  it('does not publish an old result after discovery state is reset', async () => {
    const root = tempRoot();
    let resolve!: (value: unknown) => void;
    const pending = new Promise(resolvePromise => { resolve = resolvePromise; });
    setKodeCoreShadowGate({ runInRust: () => pending } as unknown as KodeCoreGate);
    const request = preheatDiscoveryScanInRust(root);
    resetDiscoveryState();
    resolve({ ok: true, result: scan([path.join(root, 'stale', 'entity_defs')]) });
    await request;
    expect(collectDiscoveryCandidates(root).candidates.entityDefs).toEqual([]);
  });
});
