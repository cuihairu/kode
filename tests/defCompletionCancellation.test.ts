import { expect, it, vi } from 'vitest';
import * as definitions from '../src/definitionWorkspace';
import { KBEngineCompletionProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace } from './helpers/vscodeStub';

vi.mock('../src/definitionWorkspace', { spy: true });

it('取消 def 类型补全后不继续查询实体或别名类型', () => {
  const folders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
  const token = { isCancellationRequested: false };
  const custom = vi.mocked(definitions.getRegisteredCustomTypes).mockImplementation(() => {
    token.isCancellationRequested = true;
    return new Set<string>();
  });
  const entities = vi.mocked(definitions.getRegisteredEntities);
  const aliases = vi.mocked(definitions.getRegisteredAliasTypes);
  entities.mockClear();
  aliases.mockClear();
  try {
    const doc = makeTextDocument('<Type>', { fileName: '/ws/Avatar.def', languageId: 'xml' });
    expect(new KBEngineCompletionProvider().provideCompletionItems(doc as never, new Position(0, 6), token as never)).toBeNull();
    expect(custom).toHaveBeenCalledTimes(1);
    expect(entities).not.toHaveBeenCalled();
    expect(aliases).not.toHaveBeenCalled();
  } finally {
    custom.mockRestore();
    workspace.workspaceFolders = folders;
  }
});
