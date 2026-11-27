import { afterEach, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { configurationOverrides, Hover, makeTextDocument, Position } from './helpers/vscodeStub';
import type { EntityMappingIndex } from '../src/entityMapping';

// CREATE-06 wiring: the `__init__` declaration-line branch inside
// KBEngineHoverProvider. Pure-core rendering is covered by
// createNamespaceTimeline.test.ts; this file pins the provider branch:
// entity-script resolution, gate on/off, and non-entity fallthrough.

const hoverOn = async (
  text: string,
  line: number,
  character: number,
  manager?: EntityMappingManager,
  fileName = '/ws/scripts/base/Avatar.py'
): Promise<string> => {
  const provider = new KBEngineHoverProvider(manager);
  const document = makeTextDocument(text, { fileName, languageId: 'python' });
  const hover = (await provider.provideHover(document, new Position(line, character))) as Hover | null;
  if (!hover) {
    return '';
  }
  const contents = hover.contents;
  return Array.isArray(contents)
    ? contents.map(item => (typeof item === 'string' ? item : item.value)).join('')
    : typeof contents === 'string'
      ? contents
      : contents.value;
};

const indexFixture = (over: Partial<EntityMappingIndex> = {}): EntityMappingIndex =>
  ({
    rootName: 'Avatar',
    rootCategory: 'entity',
    rootDefFile: '/ws/scripts/entity_defs/Avatar.def',
    semantics: {} as EntityMappingIndex['semantics'],
    propertyDefinitions: [
      {
        defFile: '/ws/scripts/entity_defs/Avatar.def',
        line: 5,
        identity: {
          ownerKind: 'entity',
          ownerName: 'Avatar',
          sourceKind: 'own',
          sourceChain: [],
          symbolName: 'hp'
        },
        typeName: 'UINT32',
        defaultValue: '0',
        domains: ['base'],
        persistent: true
      }
    ],
    methodDefinitions: [],
    pythonOwnerFiles: [],
    pythonMethods: [],
    ...over
  }) as EntityMappingIndex;

const stubManager = (index: EntityMappingIndex | undefined): EntityMappingManager =>
  ({ getIndexForPythonFile: () => index }) as unknown as EntityMappingManager;

const INIT_LINE = '    def __init__(self):\n';

afterEach(() => {
  configurationOverrides.clear();
});

describe('createNamespaceTimeline wiring (CREATE-06)', () => {
  it('renders the timeline on an __init__ declaration in an entity script', async () => {
    configurationOverrides.set('kbengine', { 'hover.createNamespaceTimeline': true });
    const md = await hoverOn(INIT_LINE, 0, 9, stubManager(indexFixture()));
    expect(md).toContain('Avatar · createNamespace 时序');
    expect(md).toContain('`hp` · UINT32 · 域 base · 默认 0');
  });

  it('collects same-file creation params keys into the table', async () => {
    configurationOverrides.set('kbengine', { 'hover.createNamespaceTimeline': true });
    const source = INIT_LINE
      + '    def spawn(self):\n'
      + '        KBEngine.createEntity("Avatar", {"hp": 1})\n';
    const md = await hoverOn(source, 0, 9, stubManager(indexFixture()));
    expect(md).toContain('params 命中→覆盖');
  });

  it('falls back silently outside entity scripts', async () => {
    configurationOverrides.set('kbengine', { 'hover.createNamespaceTimeline': true });
    const md = await hoverOn(INIT_LINE, 0, 9, stubManager(undefined));
    expect(md).not.toContain('createNamespace 时序');
  });

  it('is gated off by kbengine.hover.createNamespaceTimeline=false', async () => {
    configurationOverrides.set('kbengine', { 'hover.createNamespaceTimeline': false });
    const md = await hoverOn(INIT_LINE, 0, 9, stubManager(indexFixture()));
    expect(md).not.toContain('createNamespace 时序');
  });
});
