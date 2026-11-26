import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildEntityReferenceCacheItems,
  EntityReferenceCacheCodeActionProvider,
  ENTITY_REFERENCE_CACHE_DIAGNOSTIC_COLLECTION
} from '../src/entityReferenceWiring';
import { ENTITY_REFERENCE_CACHE_CODE } from '../src/backend/entityReferenceTracking';
import {
  Position,
  Range,
  configurationOverrides,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';

// IDX-REL-002 (KBE-PY-031) wiring surface: pure item conversion, diagnostic
// collection registration parity with extension.test.ts, quick fix provider
// filtering and toggle-default registration. The wiring deliberately owns a
// separate collection: trap Rust aggregation only recognizes three codes and
// would drop 031 under the shadow gate.
//
// prove-red perturbation points (restore after each run):
//   R1: return the wrong code from the provider filter -> code-mismatch test fails
//   R2: remove the toggle key from package.json -> toggle registration test fails
//   R3: change collection constant -> parity tests fail

const REPO_ROOT = join(__dirname, '..');
const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8'));

const ENTITY_TEXT = [
  'class Avatar:',
  '    def onEnteredView(self, entity):',
  '        self.ref = entity',
  ''
].join('\n');

describe('buildEntityReferenceCacheItems(KBE-PY-031 wiring)', () => {
  it('converts analyzer findings to diagnostic items with message', () => {
    const items = buildEntityReferenceCacheItems(ENTITY_TEXT);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ line: 2, character: 13, length: 3 });
    expect(items[0].message).toContain('entity_garbages');
  });

  it('toggle default is registered and enabled', () => {
    const pkg = readJson('package.json');
    const configuration = pkg.contributes as { configuration: Array<{ properties: Record<string, { type: string; default: unknown }> }> };
    const properties = Object.assign({}, ...configuration.configuration.map(section => section.properties));
    expect(properties['kbengine.entityReferenceCacheDiagnostics']).toMatchObject({ type: 'boolean', default: true });
    configurationOverrides.set('kbengine', { entityReferenceCacheDiagnostics: false });
    expect(workspace.getConfiguration('kbengine').get('entityReferenceCacheDiagnostics', true)).toBe(false);
    configurationOverrides.clear();
  });

  it('collection name is self-held and registered in extension list', () => {
    expect(ENTITY_REFERENCE_CACHE_DIAGNOSTIC_COLLECTION).toBe('kbengine-entity-reference-cache');
    const suite = readFileSync(join(REPO_ROOT, 'tests', 'extension.test.ts'), 'utf8');
    expect(suite).toContain(`'${ENTITY_REFERENCE_CACHE_DIAGNOSTIC_COLLECTION}'`);
  });

  it('main wiring registers the collection after trap wiring', () => {
    const utility = readFileSync(join(REPO_ROOT, 'src', 'activate', 'utilityCommands.ts'), 'utf8');
    expect(utility).toContain('wireEntityReferenceCacheDiagnostics(context, entityMappingManager)');
    expect(utility.indexOf('wireTrapLintDiagnostics(')).toBeLessThan(
      utility.indexOf('wireEntityReferenceCacheDiagnostics(')
    );
  });
});

describe('EntityReferenceCacheCodeActionProvider(KBE-PY-031 quick fix)', () => {
  const provider = new EntityReferenceCacheCodeActionProvider();

  const actionsOf = (lineText: string, code: unknown, line = 0): unknown[] => {
    const document = makeTextDocument(`${lineText}\n`, { fileName: '/p/scripts/cell/a.py', languageId: 'python' });
    const diagnostic = {
      code,
      range: new Range(new Position(line, 12), new Position(line, 12 + 3))
    } as never;
    return provider.provideCodeActions(
      document as never,
      new Range(new Position(line, 0), new Position(line, 16)) as never,
      { diagnostics: [diagnostic] } as never
    ) as unknown[];
  };

  it('offers direct assignment quick fix with downstream-read caveat in the title', () => {
    const actions = actionsOf('        self.ref = entity', ENTITY_REFERENCE_CACHE_CODE);
    expect(actions).toHaveLength(1);
    expect((actions[0] as { title: string }).title).toContain('downstream reads');
  });

  it('skips diagnostics from other rules (code filter)', () => {
    expect(actionsOf('        self.ref = entity', ENTITY_REFERENCE_CACHE_CODE + '.other')).toHaveLength(0);
    expect(actionsOf('        self.ref = entity', undefined)).toHaveLength(0);
  });

  it('skips non-rewritable lines', () => {
    expect(actionsOf('        self.ref = compute(entity)', ENTITY_REFERENCE_CACHE_CODE)).toHaveLength(0);
  });
});
