import { afterEach, expect, it, vi } from 'vitest';
import { KodeCoreGate, type ShadowClientLike } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { KBEngineDefinitionProvider } from '../src/languageProviders/navigation';
import { Location, Position, Range, Uri, makeTextDocument } from './helpers/vscodeStub';

afterEach(() => setKodeCoreShadowGate(null));

function setup(response: () => Promise<unknown>) {
  const client: ShadowClientLike = {
    start: async () => ({}), request: async () => response(), dispose: async () => undefined,
    openDocument: () => undefined, changeDocument: () => undefined, closeDocument: () => undefined,
  };
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'rust', serverPath: 'stub', shadowTimeoutMs: 500 });
  setKodeCoreShadowGate(gate);
  const provider = new KBEngineDefinitionProvider();
  const fallback = new Location(Uri.file('/workspace/legacy.py'), new Range(1, 0, 1, 2));
  const ts = vi.spyOn(provider as unknown as {
    provideDefinitionImpl: (...args: unknown[]) => unknown;
  }, 'provideDefinitionImpl').mockReturnValue(fallback);
  const document = makeTextDocument('<root/>', {
    fileName: '/workspace/scripts/entity_defs/Avatar.def', languageId: 'kbengine-def', version: 1,
  });
  return { provider, ts, document, fallback };
}

it('Rust success skips the entire TS computation', async () => {
  const { provider, ts, document } = setup(async () => ({
    uri: '/workspace/Avatar.def', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
  }));
  const result = await provider.provideDefinition(document, new Position(0, 1));
  expect((result as Location).uri.fsPath).toBe('/workspace/Avatar.def');
  expect(ts).not.toHaveBeenCalled();
});

it.each(['unsupported', 'failure'])('TS is computed once on Rust %s', async kind => {
  const { provider, ts, document, fallback } = setup(async () => {
    if (kind === 'failure') { throw new Error('server failed'); }
    return null;
  });
  expect(await provider.provideDefinition(document, new Position(0, 1))).toBe(fallback);
  expect(ts).toHaveBeenCalledTimes(1);
});

it('editing while Rust is pending discards the old location without computing TS for it', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const { provider, ts, document } = setup(() => pending);
  const result = provider.provideDefinition(document, new Position(0, 1));
  (document as { version: number }).version = 2;
  finish(null);
  expect(await result).toBeNull();
  expect(ts).not.toHaveBeenCalled();
});
