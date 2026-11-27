import { describe, expect, it } from 'vitest';

import type { CustomTypeInfo } from '../src/definitionWorkspace';
import {
  TYPE_IMPACT_COMMAND,
  TYPE_IMPACT_ENABLED_DEFAULT,
  TYPE_IMPACT_PY_ACCESS_LIMIT,
  runTypeImpactCommand,
  createTypeImpactIndex,
  type TypeImpactCommandDeps,
  type TypeImpactQuickPickItem,
  type TypeImpactVscodeApi
} from '../src/typeImpactCommand';

const structureNode = (name: string, children: CustomTypeInfo['structure']['children'] = []): CustomTypeInfo['structure'] => ({
  name,
  rawValue: name,
  children,
  line: 1
});

const TYPE_CHILD = (rawValue: string): CustomTypeInfo['structure']['children'][number] => ({
  tag: 'Type',
  value: structureNode(rawValue)
});

const decl = (name: string, refs: string[]): CustomTypeInfo => ({
  name,
  filePath: '/ws/types.xml',
  line: 1,
  implementedByLine: 1,
  startOffset: 0,
  endOffset: 1,
  aliasType: name,
  rawValue: name,
  structure: structureNode(name, refs.map(r => TYPE_CHILD(r))),
  properties: []
});

const DEF_TEXT = `<root>
  <Properties>
    <Property>
      <Name>bag</Name>
      <Type>MyBag</Type>
      <Flags>AllServers</Flags>
    </Property>
  </Properties>
</root>`;

/** Minimal vscode api double recording interactions */
function makeVscodeApi(overrides: Partial<TypeImpactVscodeApi['window']> = {}): {
  api: TypeImpactVscodeApi;
  infoMessages: string[];
  shownDocuments: Array<{ file: string; options: unknown }>;
} {
  const infoMessages: string[] = [];
  const shownDocuments: Array<{ file: string; options: unknown }> = [];
  const api: TypeImpactVscodeApi = {
    window: {
      showQuickPick: async (items, options) => {
        void options;
        return items.find(item => item.target) ?? items[0];
      },
      showInformationMessage: async (message: string) => {
        infoMessages.push(message);
        return undefined;
      },
      showTextDocument: async (uri: unknown, options?: unknown) => {
        shownDocuments.push({ file: String(uri), options });
        return undefined;
      },
      ...overrides
    },
    Uri: { file: (filePath: string) => `file:${filePath}` },
    QuickPickItemKind: { Separator: 10 }
  };
  return { api, infoMessages, shownDocuments };
}

function makeDeps(
  vscodeApi: TypeImpactVscodeApi,
  options: {
    declarations?: CustomTypeInfo[];
    defFiles?: Array<{ path: string; text: string }>;
    accesses?: Record<string, Array<{ filePath: string; line: number; character: number }>>;
    enabled?: boolean;
    overrides?: Partial<TypeImpactCommandDeps>;
  } = {}
): TypeImpactCommandDeps {
  const { declarations = [decl('MyBag', []), decl('Other', ['MyBag'])], defFiles = [{ path: '/ws/entities/Avatar.def', text: DEF_TEXT }], accesses = {}, enabled = true } = options;
  return {
    vscode: vscodeApi,
    readFile: filePath => defFiles.find(file => file.path === filePath)?.text ?? null,
    listDefFiles: async () => defFiles.map(file => file.path),
    getCustomTypes: () => declarations,
    getPythonAccesses: async (defFile: string, propertyName: string) =>
      accesses[`${defFile}#${propertyName}`] ?? [],
    isEnabled: () => enabled,
    index: createTypeImpactIndex(),
    ...options.overrides
  };
}

describe('typeImpactCommand', () => {
  it('exports the registered command id and toggle default', () => {
    expect(TYPE_IMPACT_COMMAND).toBe('kbengine.showTypeImpact');
    expect(TYPE_IMPACT_ENABLED_DEFAULT).toBe(true);
  });

  it('reports disabled when the toggle is off', async () => {
    const { api, infoMessages } = makeVscodeApi();
    const result = await runTypeImpactCommand(makeDeps(api, { enabled: false }));
    expect(result.disabled).toBe(true);
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toContain('kbengine.typeImpact.enabled');
  });

  it('lists def properties (direct and transitive) and navigates on pick', async () => {
    const { api, shownDocuments } = makeVscodeApi();
    const result = await runTypeImpactCommand(makeDeps(api, {
      declarations: [decl('MyBag', []), decl('Other', ['MyBag'])],
      defFiles: [
        { path: '/ws/entities/Avatar.def', text: DEF_TEXT },
        { path: '/ws/entities/Monster.def', text: DEF_TEXT.replace('MyBag', 'Other') }
      ]
    }));
    expect(result.noImpact).toBeUndefined();
    expect(result.defPropertyCount).toBe(2);
    expect(result.pyAccessCount).toBe(0);

    const items = (result.items ?? []) as TypeImpactQuickPickItem[];
    // Separators carry no target; property rows do.
    const rows = items.filter(item => item.target);
    expect(rows.map(row => row.label)).toEqual(['Avatar.bag', 'Monster.bag']);
    expect(rows[1].detail).toContain('Other');
    // Navigation: the picked row opened its file with preview:false
    expect(shownDocuments).toHaveLength(1);
    expect(String(shownDocuments[0].file)).toContain('Avatar.def');
    expect((shownDocuments[0].options as { preview?: boolean }).preview).toBe(false);
  });

  it('includes .py access points from the injected access face', async () => {
    const { api } = makeVscodeApi();
    const result = await runTypeImpactCommand(makeDeps(api, {
      accesses: { '/ws/entities/Avatar.def#bag': [{ filePath: '/ws/base/Avatar.py', line: 42, character: 8 }] }
    }));
    expect(result.pyAccessCount).toBe(1);
    const items = (result.items ?? []) as TypeImpactQuickPickItem[];
    const accessRow = items.filter(item => item.target).find(row => row.description?.includes('Avatar.py'));
    expect(accessRow).toBeDefined();
    expect(accessRow?.label).toBe('bag');
    expect(accessRow?.target?.line).toBe(41);
    expect(accessRow?.target?.character).toBe(8);
  });

  it('reports no impact when no def property references the type', async () => {
    const { api, infoMessages } = makeVscodeApi();
    const result = await runTypeImpactCommand(makeDeps(api, {
      declarations: [decl('Lonely', [])],
      defFiles: [{ path: '/ws/entities/Avatar.def', text: DEF_TEXT }]
    }));
    expect(result.noImpact).toBe(true);
    expect(infoMessages[0]).toContain('Lonely');
  });

  it('falls back to the declaration picker when no cursor type resolves', async () => {
    const picks: string[] = [];
    const { api } = makeVscodeApi({
      showQuickPick: async (items, options) => {
        picks.push(options.placeHolder);
        return items[0];
      }
    });
    const result = await runTypeImpactCommand(makeDeps(api));
    // Two pickers: the name picker (no cursor) plus the impact panel.
    expect(picks).toHaveLength(2);
    // First sorted declared name picked; its impact surface resolves.
    expect(result.noTarget).toBeUndefined();
    expect(result.heading).toBeDefined();
  });

  it('aborts as noTarget when the picker is dismissed', async () => {
    const { api } = makeVscodeApi({
      showQuickPick: async () => undefined
    });
    const result = await runTypeImpactCommand(makeDeps(api));
    expect(result.noTarget).toBe(true);
  });

  it('reports noTarget when no declarations exist at all', async () => {
    const { api, infoMessages } = makeVscodeApi();
    const result = await runTypeImpactCommand(makeDeps(api, { declarations: [] }));
    expect(result.noTarget).toBe(true);
    expect(infoMessages).toHaveLength(1);
  });

  it('caps access queries and records the truncation honestly', async () => {
    const { api } = makeVscodeApi();
    const declarations: CustomTypeInfo[] = [decl('Wide', [])];
    const defFiles: Array<{ path: string; text: string }> = [];
    for (let i = 0; i < TYPE_IMPACT_PY_ACCESS_LIMIT + 3; i += 1) {
      defFiles.push({ path: `/ws/entities/E${i}.def`, text: DEF_TEXT.replace('MyBag', 'Wide') });
    }
    const result = await runTypeImpactCommand(makeDeps(api, { declarations, defFiles }));
    expect(result.defPropertyCount).toBe(TYPE_IMPACT_PY_ACCESS_LIMIT + 3);
    expect(result.accessQueriesTruncated).toBe(true);
  });

  it('cursor word on types.xml resolves the target without the picker', async () => {
    const { api } = makeVscodeApi({
      activeTextEditor: {
        fileName: '/ws/types.xml',
        wordAtCursor: () => 'MyBag'
      }
    });
    const picks: unknown[] = [];
    const deps = makeDeps(api, {
      overrides: {
        vscode: {
          ...api,
          window: {
            ...api.window,
            showQuickPick: async (items, options) => {
              picks.push(options.placeHolder);
              return items[0];
            }
          }
        }
      }
    });
    const result = await runTypeImpactCommand(deps);
    // The name picker (first call) is skipped; only the impact panel shows.
    expect(picks).toHaveLength(1);
    expect(picks[0]).toContain('MyBag');
    expect(result.heading).toContain('MyBag');
  });
});
