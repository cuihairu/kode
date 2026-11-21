// RUST-139 批 4 接线(kode-server workspace/symbol def 符号前缀检索面)
// TS 侧钉子:①桥契约——serveWorkspaceSymbolsFromRust 的载荷 {query}、
// 回包 {symbols:[命中面]} 逐键校验(symbolName/kind 二值/section 可空/
// rootName/rootDefFile/defFile/line 正整数),任一畸形 → null 不部分采用;
// 检索面无文档上下文 → 零 mirrorDocument;空集 {symbols:[]} 是合法应答照返
// ([]≠失败回退)。②provider 切流——KBEngineWorkspaceSymbolProvider 消费
// 命中面直构 vscode.SymbolInformation(containerName=`root · 段`),Rust 面
// 不可用时回 TS searchDefSymbolsByPrefix 既有链(无门/serve 抛错皆回退)。
// 决策核真值由 crates/kode-server/tests/workspace_symbol_dispatch.rs
// LSP 级门禁钉 + workspace-symbols golden 双侧对拍(批 2 在案)。
import { afterEach, describe, expect, it } from 'vitest';
import { KBEngineWorkspaceSymbolProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import {
  serveWorkspaceSymbolsFromRust,
  setKodeCoreShadowGate,
  type WorkspaceSymbolHitFace
} from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { SymbolKind } from './helpers/vscodeStub';

/** 桩 gate:serveInRust 按 scripted 回包;记录调用面供载荷断言。 */
const makeServingGate = (
  scripted: unknown,
  options?: { serving?: boolean; serveError?: boolean }
): {
  gate: KodeCoreGate;
  served: Array<{ method: string; params: Record<string, unknown> }>;
  mirrored: number;
} => {
  const served: Array<{ method: string; params: Record<string, unknown> }> = [];
  let mirrored = 0;
  const gate = {
    serveFromRust: () => options?.serving ?? true,
    mirrorDocument: async () => {
      mirrored += 1;
    },
    serveInRust: async (method: string, params: unknown) => {
      served.push({ method, params: params as Record<string, unknown> });
      if (options?.serveError) {
        throw new Error('rust serve failed');
      }
      return scripted;
    }
  } as unknown as KodeCoreGate;
  return { gate, served, mirrored };
};

const HIT: WorkspaceSymbolHitFace = {
  symbolName: 'onTalk',
  kind: 'method',
  section: 'CellMethods',
  rootName: 'Avatar',
  rootDefFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  line: 8
};

const PROPERTY_HIT: WorkspaceSymbolHitFace = {
  symbolName: 'hp',
  kind: 'property',
  section: null,
  rootName: 'Avatar',
  rootDefFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  line: 3
};

describe('serveWorkspaceSymbolsFromRust 桥契约', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('ok:载荷 {query},回包命中面逐键校验,零镜像(检索无文档上下文)', async () => {
    const { gate, served, mirrored } = makeServingGate({ symbols: [PROPERTY_HIT, HIT] });
    setKodeCoreShadowGate(gate);
    const result = await serveWorkspaceSymbolsFromRust('on');
    expect(result).toEqual([PROPERTY_HIT, HIT]);
    expect(served).toHaveLength(1);
    expect(served[0].method).toBe('workspace/symbol');
    expect(served[0].params).toEqual({ query: 'on' });
    expect(mirrored).toBe(0);
  });

  it('空集 {symbols:[]} 是合法应答照返([]≠失败回退)', async () => {
    setKodeCoreShadowGate(makeServingGate({ symbols: [] }).gate);
    expect(await serveWorkspaceSymbolsFromRust('zzz')).toEqual([]);
  });

  it('无门/门关 → null 且零请求', async () => {
    setKodeCoreShadowGate(null);
    expect(await serveWorkspaceSymbolsFromRust('on')).toBeNull();
    const off = makeServingGate({ symbols: [HIT] }, { serving: false });
    setKodeCoreShadowGate(off.gate);
    expect(await serveWorkspaceSymbolsFromRust('on')).toBeNull();
    expect(off.served).toEqual([]);
  });

  it('取消位先判 → null 且零请求', async () => {
    setKodeCoreShadowGate(makeServingGate({ symbols: [HIT] }).gate);
    expect(await serveWorkspaceSymbolsFromRust('on', () => true)).toBeNull();
  });

  it('serve 抛错 → null(调用方回 TS 既有实现)', async () => {
    setKodeCoreShadowGate(makeServingGate({ symbols: [HIT] }, { serveError: true }).gate);
    expect(await serveWorkspaceSymbolsFromRust('on')).toBeNull();
  });

  it('应答畸形(symbols 缺键/非数组/命中面任一键坏)→ 整面作废', async () => {
    const badCases: unknown[] = [
      {},
      { symbols: 'nope' },
      { symbols: null },
      { symbols: ['face'] },
      { symbols: [{ ...HIT, symbolName: 42 }] },
      { symbols: [{ ...HIT, kind: 'both' }] },
      { symbols: [{ ...HIT, section: 7 }] },
      { symbols: [{ ...HIT, rootName: undefined }] },
      { symbols: [{ ...HIT, defFile: null }] },
      { symbols: [{ ...HIT, line: 0 }] },
      { symbols: [{ ...HIT, line: 8.5 }] },
      { symbols: [{ ...HIT, rootDefFile: 3 }] },
      { symbols: [{ ...PROPERTY_HIT, kind: 'method', section: undefined }] }
    ];
    for (const bad of badCases) {
      setKodeCoreShadowGate(makeServingGate(bad).gate);
      expect(await serveWorkspaceSymbolsFromRust('on')).toBeNull();
      setKodeCoreShadowGate(null);
    }
  });

  it('应答 null → null 透传(调用方回 TS 链同判)', async () => {
    setKodeCoreShadowGate(makeServingGate(null).gate);
    expect(await serveWorkspaceSymbolsFromRust('on')).toBeNull();
  });
});

describe('workspaceSymbol provider 切流', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  const managerOf = (hits: unknown[]): EntityMappingManager =>
    ({
      searchDefSymbolsByPrefix: (prefix: string) => {
        void prefix;
        return hits;
      }
    }) as unknown as EntityMappingManager;

  it('Rust 命中 → SymbolInformation 直构(containerName root · 段),零 manager 请求', async () => {
    const provider = new KBEngineWorkspaceSymbolProvider(managerOf([]));
    setKodeCoreShadowGate(makeServingGate({ symbols: [PROPERTY_HIT, HIT] }).gate);
    const symbols = await provider.provideWorkspaceSymbols('on');
    expect(symbols).not.toBeNull();
    expect(symbols).toHaveLength(2);
    const [property, method] = symbols!;
    expect(property.name).toBe('hp');
    expect(property.kind).toBe(SymbolKind.Field);
    expect(property.containerName).toBe('Avatar');
    expect(method.name).toBe('onTalk');
    expect(method.kind).toBe(SymbolKind.Method);
    expect(method.containerName).toBe('Avatar · CellMethods');
    expect(property.location).toBeDefined();
    expect(method.location).toBeDefined();
  });

  it('Rust 空集 → 空数组(不是回退:manager 零请求)', async () => {
    const provider = new KBEngineWorkspaceSymbolProvider(managerOf([
      { symbolName: 'hp', kind: 'property', rootName: 'Avatar', defFile: '/a.def', line: 3 }
    ]));
    setKodeCoreShadowGate(makeServingGate({ symbols: [] }).gate);
    expect(await provider.provideWorkspaceSymbols('zzz')).toEqual([]);
  });

  it('serve 抛错 → 回 TS searchDefSymbolsByPrefix 既有链(同构直构)', async () => {
    const provider = new KBEngineWorkspaceSymbolProvider(managerOf([
      {
        symbolName: 'onTalk',
        kind: 'method',
        section: 'CellMethods',
        rootName: 'Avatar',
        rootDefFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
        defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
        line: 8
      }
    ]));
    setKodeCoreShadowGate(makeServingGate({ symbols: [HIT] }, { serveError: true }).gate);
    const symbols = await provider.provideWorkspaceSymbols('on');
    expect(symbols).not.toBeNull();
    expect(symbols).toHaveLength(1);
    expect(symbols![0].name).toBe('onTalk');
    expect(symbols![0].containerName).toBe('Avatar · CellMethods');
  });

  it('无门 → 回 TS 既有链(行为与既有用例同链)', async () => {
    const provider = new KBEngineWorkspaceSymbolProvider(managerOf([
      {
        symbolName: 'hp',
        kind: 'property',
        rootName: 'Avatar',
        rootDefFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
        defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
        line: 3
      }
    ]));
    setKodeCoreShadowGate(null);
    const symbols = await provider.provideWorkspaceSymbols('hp');
    expect(symbols).not.toBeNull();
    expect(symbols![0].containerName).toBe('Avatar');
    expect(symbols![0].kind).toBe(SymbolKind.Field);
  });

  it('取消位 → null 且零请求(入口闸,原有门)', async () => {
    const { gate, served } = makeServingGate({ symbols: [HIT] });
    setKodeCoreShadowGate(gate);
    const provider = new KBEngineWorkspaceSymbolProvider(managerOf([]));
    expect(
      await provider.provideWorkspaceSymbols('on', { isCancellationRequested: true })
    ).toBeNull();
    expect(served).toEqual([]);
  });
});
