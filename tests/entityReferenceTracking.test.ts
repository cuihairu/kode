import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  analyzeEntityReferenceHolders,
  buildEntityReferenceCacheFix,
  collectHookEntityParams,
  ENTITY_REFERENCE_CACHE_CODE,
  ENTITY_REFERENCE_CACHE_MESSAGE,
  renderEntityReferenceCacheMessage
} from '../src/backend/entityReferenceTracking';

// IDX-REL-002 (KBE-PY-031): entity-reference retention analyzer. The engine
// fact is that after _entities.erase the object lives only as long as the
// remaining Python references; garbages warns after 3600s. Correct code stores
// entity.id and looks it up via KBEngine.entities.get(id).
//
// The corpus-wide zero-false-positive test is the acceptance anchor: a wider
// seed roster (any `entity`-named parameter, createEntity* results, for-loop
// targets) would fire on the demo game scripts and break the rule.
//
// prove-red perturbation points (restore after each run):
//   R1: widen collectHookEntityParams to any parameter named `entity`
//       -> corpus test fails on KodeHotReload.py:332 ensure_heartbeat(entity)
//   R2: seed createEntity* assignments -> corpus fails on Spaces.py:42
//   R3: drop the `for` guard -> corpus fires on entity iteration loops
//   R4: drop `singleLine` guard -> multiline statement column assertions fail
//   R5: treat `entity.id` as an entity RHS -> negative test + corpus fail

const REPO_ROOT = join(__dirname, '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'kbengine-demo-assets');

function collectPythonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { collectPythonFiles(full, out); }
    else if (entry.name.endsWith('.py')) { out.push(full); }
  }
  return out;
}

describe('analyzeEntityReferenceHolders(KBE-PY-031)', () => {
  it('four hook seeds: onTeleportSuccess/onEnterTrap/onLeaveTrap/onEnteredView only', () => {
    // Seed roster is pinned by NAME, not by count: a future hook-table change
    // must not silently add a new entity-bearing seed.
    expect([...collectHookEntityParams().entries()].sort()).toEqual([
      ['onEnterTrap', 'entity'],
      ['onEnteredView', 'entity'],
      ['onLeaveTrap', 'entity'],
      ['onTeleportSuccess', 'nearbyEntity']
    ]);
  });

  it('positive: class attr holds an entity from a hook seed', () => {
    const text = [
      'class Avatar:',
      '    def onEnterTrap(self, entity, range_xz, range_y, controllerID, userArg=None):',
      '        self.trapped = entity',
      ''
    ].join('\n');
    const findings = analyzeEntityReferenceHolders(text);
    expect(findings.map(f => [f.line, f.character, f.length])).toEqual([[2, 13, 7]]);
    expect(findings[0].message).toBe(renderEntityReferenceCacheMessage());
    expect(ENTITY_REFERENCE_CACHE_CODE).toBe('kbengine.entityReferenceCache');
  });

  it('positive: entities query seeds a class attr and a module container', () => {
    const text = [
      'CACHE = []',
      'class Monster:',
      '    def remember(self, entity_id):',
      '        self.target = KBEngine.entities.get(entity_id)',
      '        CACHE.append(self.target)',
      ''
    ].join('\n');
    const findings = analyzeEntityReferenceHolders(text);
    expect(findings.map(f => [f.line, f.character])).toEqual([[3, 13], [4, 21]]);
  });

  it('positive: cross-function assignment chain reports both assignments', () => {
    const text = [
      'class Avatar:',
      '    def onEnteredView(self, entity):',
      '        self.tmp = entity',
      '',
      '    def work(self):',
      '        self.ref = self.tmp',
      ''
    ].join('\n');
    expect(analyzeEntityReferenceHolders(text).map(f => f.line)).toEqual([2, 5]);
  });

  it('positive: variable chain propagation inside one def and across defs', () => {
    const text = [
      'class Avatar:',
      '    def onEnterTrap(self, entity, range_xz, range_y, controllerID, userArg=None):',
      '        e = entity',
      '        self.ref = e',
      '',
      '    def later(self):',
      '        self.laterRef = e',
      ''
    ].join('\n');
    // `e` is a per-def local; the cross-def read in `later` is NOT seeded.
    expect(analyzeEntityReferenceHolders(text).map(f => f.line)).toEqual([3]);
  });

  it('positive: module container subscript store of an entity', () => {
    const text = [
      'INDEX = {}',
      'class Avatar:',
      '    def onEnteredView(self, entity):',
      "        INDEX[entity.id] = entity",
      ''
    ].join('\n');
    // R5: treating `entity.id` as the entity RHS would move the reported
    // column to the key and break this anchor.
    expect(analyzeEntityReferenceHolders(text).map(f => [f.line, f.character, f.length])).toEqual([
      [3, 27, 6]
    ]);
  });

  it('positive: module-level KBEngine.addTimer closure capture', () => {
    const text = [
      'def schedule(entity):',
      '    self_ref = entity',
      'KBEngine.addTimer(1, 0, lambda: entity.id)',
      ''
    ].join('\n');
    // No hook seed here: the bare `entity` parameter of a user def is NOT a
    // seed, so only the self-attr/assignment and the timer read after the
    // chain are reportable accordingly.
    expect(analyzeEntityReferenceHolders(text).map(f => f.line)).toEqual([]);
  });

  it('positive: entity seed captured in a module-level engine timer', () => {
    const text = [
      'class Avatar:',
      '    def onEnteredView(self, entity):',
      '        KBEngine.addTimer(1, 0, lambda: entity.id)',
      ''
    ].join('\n');
    // lambda arg stays on one statement line; capture token is `entity`
    expect(analyzeEntityReferenceHolders(text).map(f => [f.line, f.character, f.length])).toEqual([
      [2, 40, 6]
    ]);
  });

  it('positive: nested def body referencing an enclosing hook entity', () => {
    const text = [
      'class Avatar:',
      '    def onEnteredView(self, entity):',
      '        def later():',
      '            log(entity.id)',
      ''
    ].join('\n');
    expect(analyzeEntityReferenceHolders(text).map(f => [f.line, f.character, f.length])).toEqual([
      [3, 16, 6]
    ]);
  });

  it('negative: .id reads, ints, dynamic calls and bare unseeded names', () => {
    const text = [
      'CACHE = []',
      'class Avatar:',
      '    def work(self, target):',
      '        self.targetId = target.id',
      '        self.count = 3',
      '        self.dynamic = someFn(target)',
      '        self.unknown = other',
      '        CACHE.append(target.id)',
      '        CACHE.append(7)',
      ''
    ].join('\n');
    expect(analyzeEntityReferenceHolders(text)).toEqual([]);
  });

  it('negative: safe self.addTimer, for-loop targets, comments and strings', () => {
    const text = [
      'CACHE = []',
      'class Avatar:',
      '    def onEnteredView(self, entity):',
      '        self.timerID = self.addTimer(1, 0, 0)',
      '        for e in KBEngine.entities.values():',
      '            CACHE.append(e)',
      '        # self.ref = entity',
      '        self.note = "self.ref = entity"',
      ''
    ].join('\n');
    expect(analyzeEntityReferenceHolders(text)).toEqual([]);
  });

  it('negative: createEntity* results are not guessed as entity seeds', () => {
    const text = [
      'spaceByIndex = {}',
      'class Space:',
      '    def create(self):',
      '        space = KBEngine.createEntityLocally("Space", {})',
      '        spaceByIndex[1] = space',
      ''
    ].join('\n');
    expect(analyzeEntityReferenceHolders(text)).toEqual([]);
  });

  it('negative: non-entity lifecycle hooks are not seeded', () => {
    const text = [
      'class Avatar:',
      '    def onLeaveTrapID(self, entityID, range_xz, range_y, controllerID, userArg=None):',
      '        self.ret = entityID',
      ''
    ].join('\n');
    expect(analyzeEntityReferenceHolders(text)).toEqual([]);
  });

  it('demo corpus: zero false positives across all 52 python files', () => {
    const files = collectPythonFiles(FIXTURE_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(52);
    const offenders: string[] = [];
    for (const file of files) {
      const findings = analyzeEntityReferenceHolders(readFileSync(file, 'utf8'));
      if (findings.length > 0) {
        offenders.push(`${file.replace(REPO_ROOT + '/', '')}:${findings.map(f => f.line + 1).join(',')}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(`unexpected entity-reference findings in demo corpus:\n${offenders.join('\n')}`);
    }
  });

  it('message template is en-l10n source string', () => {
    expect(ENTITY_REFERENCE_CACHE_MESSAGE).toContain('entity_garbages');
    expect(ENTITY_REFERENCE_CACHE_MESSAGE).toContain('KBEngine.entities.get(id)');
  });
});

describe('buildEntityReferenceCacheFix(KBE-PY-031 quick fix)', () => {
  it('direct entity assignment becomes id storage', () => {
    expect(buildEntityReferenceCacheFix('        self.ref = entity')).toBe('        self.ref_id = entity.id');
    expect(buildEntityReferenceCacheFix('        self.ref = KBEngine.entities.get(entity_id)'))
      .toBe('        self.ref_id = entity_id');
  });

  it('does not produce _id_id for an attribute already ending in _id', () => {
    expect(buildEntityReferenceCacheFix('        self.target_id = entity'))
      .toBe('        self.target_id = entity.id');
  });

  it('returns null for non-direct assignments', () => {
    expect(buildEntityReferenceCacheFix('        self.ref += entity')).toBeNull();
    expect(buildEntityReferenceCacheFix('        self.ref = compute(entity)')).toBeNull();
    expect(buildEntityReferenceCacheFix('        ref = entity')).toBeNull();
  });
});
