import { describe, expect, it } from 'vitest';

import type { CustomTypeInfo } from '../src/definitionWorkspace';
import {
  FIELD_CHANNELS_COMMAND,
  FIELD_CHANNELS_ENABLED_DEFAULT,
  createFieldChannelIndex,
  runFieldChannelsCommand,
  type FieldChannelsCommandDeps,
  type FieldChannelsQuickPickItem,
  type FieldChannelsVscodeApi
} from '../src/fieldChannelCommand';

const fdDecl = (name: string, fields: string[], implFile?: string): CustomTypeInfo => ({
  name,
  filePath: '/ws/types.xml',
  line: 3,
  implementedByLine: 4,
  startOffset: 0,
  endOffset: 100,
  aliasType: name,
  rawValue: name,
  structure: { name, rawValue: name, children: [], line: 3 },
  properties: fields.map((field, index) => ({ name: field, line: 10 + index })),
  implementedBy: implFile ? 'MySer' : undefined,
  pythonFilePath: implFile
});

const IMPL_TEXT = [
  'class MySer:',
  '    def getDictFromObj(self, obj):',
  '        return {"hp": obj["hp"]}',
  '',
  '    def createObjFromDict(self, dct):',
  '        return {"hp": dct["hp"]}',
  ''
].join('\n');

const DEF_TEXT = `<root><Properties>
  <Property><Name>bag</Name><Type>MyBag</Type><Persistent>true</Persistent></Property>
</Properties></root>`;

function makeVscodeApi(options: {
  activeEditor?: { fileName: string; wordAtCursor(): string | null };
  pick?: (items: readonly FieldChannelsQuickPickItem[]) => FieldChannelsQuickPickItem | undefined;
} = {}): {
  api: FieldChannelsVscodeApi;
  infoMessages: string[];
  shownDocuments: Array<{ file: string; options: unknown }>;
} {
  const infoMessages: string[] = [];
  const shownDocuments: Array<{ file: string; options: unknown }> = [];
  const api: FieldChannelsVscodeApi = {
    window: {
      activeTextEditor: options.activeEditor,
      showQuickPick: async items => (options.pick ? options.pick(items) : items.find(item => item.target) ?? items[0]),
      showInformationMessage: async (message: string) => {
        infoMessages.push(message);
        return undefined;
      },
      showTextDocument: async (uri: unknown, opts?: unknown) => {
        shownDocuments.push({ file: String(uri), options: opts });
        return undefined;
      }
    },
    Uri: { file: (filePath: string) => `file:${filePath}` },
    QuickPickItemKind: { Separator: 10 }
  };
  return { api, infoMessages, shownDocuments };
}

function makeDeps(vscode: FieldChannelsVscodeApi, options: {
  declarations?: CustomTypeInfo[];
  enabled?: boolean;
  files?: Record<string, string>;
} = {}): FieldChannelsCommandDeps {
  const declarations = options.declarations ?? [fdDecl('MyBag', ['hp'], '/ws/ser.py')];
  const files = options.files ?? {
    '/ws/ser.py': IMPL_TEXT,
    '/ws/entities/Avatar.def': DEF_TEXT
  };
  return {
    vscode,
    readFile: filePath => files[filePath] ?? null,
    listDefFiles: async () => Object.keys(files).filter(file => file.endsWith('.def')),
    getCustomTypes: () => declarations,
    isEnabled: () => options.enabled ?? true,
    index: createFieldChannelIndex()
  };
}

describe('fieldChannelCommand', () => {
  it('exports the registered command id and toggle default', () => {
    expect(FIELD_CHANNELS_COMMAND).toBe('kbengine.showFieldChannels');
    expect(FIELD_CHANNELS_ENABLED_DEFAULT).toBe(true);
  });

  it('reports disabled when the toggle is off', async () => {
    const { api, infoMessages } = makeVscodeApi();
    const result = await runFieldChannelsCommand(makeDeps(api, { enabled: false }));
    expect(result.disabled).toBe(true);
    expect(infoMessages[0]).toContain('kbengine.fieldChannels.enabled');
  });

  it('cursor on a FD field shows all three channels and navigates on pick', async () => {
    const { api, shownDocuments } = makeVscodeApi({
      activeEditor: { fileName: '/ws/types.xml', wordAtCursor: () => 'hp' }
    });
    const result = await runFieldChannelsCommand(makeDeps(api));
    expect(result.heading).toBe('Channels of MyBag.hp');
    expect(result.anchorCount).toBe(2);
    expect(result.staleCount).toBe(0);
    expect(result.items?.filter(item => item.kind === undefined && item.target)).toHaveLength(2);
    expect(result.items?.some(item => item.description === 'not persisted')).toBe(false);
    expect(shownDocuments).toHaveLength(1);
    expect(shownDocuments[0].file).toBe('file:/ws/ser.py');
    expect(shownDocuments[0].options).toMatchObject({ preview: false });
  });

  it('cursor on a def property maps wire channels and the DB arm', async () => {
    const { api } = makeVscodeApi({
      activeEditor: { fileName: '/ws/entities/Avatar.def', wordAtCursor: () => 'bag' }
    });
    const result = await runFieldChannelsCommand(makeDeps(api));
    expect(result.heading).toBe('Channels of Avatar.bag');
    expect(result.anchorCount).toBe(2);
    expect(result.items?.some(item => item.description === 'not persisted')).toBe(false);
  });

  it('picker fallback lists declared fields; dismissal yields noTarget', async () => {
    const { api } = makeVscodeApi({ pick: () => undefined });
    const result = await runFieldChannelsCommand(makeDeps(api));
    expect(result.noTarget).toBe(true);
  });

  it('stale impl keys are surfaced after a declaration rename', async () => {
    const { api } = makeVscodeApi({
      activeEditor: { fileName: '/ws/types.xml', wordAtCursor: () => 'health' }
    });
    const result = await runFieldChannelsCommand(makeDeps(api, {
      declarations: [fdDecl('MyBag', ['health'], '/ws/ser.py')]
    }));
    expect(result.staleCount).toBe(2);
    expect(result.items?.some(item => item.label === 'hp')).toBe(true);
  });
});
