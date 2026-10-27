import { expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { EntityMappingManager } from '../src/entityMapping';
import { PropertyCodeLensProvider, RpcCodeLensProvider } from '../src/languageProviders';
import { makeTextDocument } from './helpers/vscodeStub';

it.each([
  ['property', 'cancel'], ['rpc', 'cancel'], ['property', 'close'], ['rpc', 'close']
] as const)('%s CodeLens 在 %s 后不继续解析其他点位', async (kind, stop) => {
  let release!: (value: null) => void;
  const pendingLookup = new Promise<null>(resolve => { release = resolve; });
  const resolve = vi.fn(() => pendingLookup);
  const manager = {
    resolvePropertyDefinitionInfo: resolve,
    resolveMethodDefinition: resolve
  } as unknown as EntityMappingManager;
  const provider = kind === 'property' ? new PropertyCodeLensProvider(manager) : new RpcCodeLensProvider(manager);
  const text = kind === 'property' ? 'self.hp\nself.gold\n' : 'def first(self):\n    pass\ndef second(self):\n    pass\n';
  const doc = makeTextDocument(text, { fileName: '/ws/entity.py', languageId: 'python' }) as unknown as vscode.TextDocument;
  let closed = false;
  Object.defineProperty(doc, 'isClosed', { get: () => closed });
  const token = { isCancellationRequested: false } as vscode.CancellationToken;
  const pending = provider.provideCodeLenses(doc, token);
  expect(resolve).toHaveBeenCalledTimes(1);
  if (stop === 'cancel') (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
  else closed = true;
  release(null);
  expect(await pending).toEqual([]);
  expect(resolve).toHaveBeenCalledTimes(1);
});
