/**
 * KODE-DICTTYPE-001: ordinary dict literal key→value type inference.
 *
 * prove-red perturbations (restore after each run):
 *   R1: drop literal-container recognition in analyzeDictValueTypeFile →
 *       case 1 (single init, frozen) fails.
 *   R2: change mergeType union to last-write-wins → case 2 (union+provenance)
 *       fails.
 *   R3: fold key signatures with toLowerCase in resolveKeySignature → case 3
 *       (case sensitivity) fails.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  analyzeDictValueTypeFile,
  dictValueKeyCompletionContext,
  findDictValueAccessesOnLine,
  queryDictValueTypeAtPosition
} from '../src/backend/dictValueTypeCore';

const FILE = '/demo/scripts/cell/Test.py';

describe('KODE-DICTTYPE-001 ordinary dict value types', () => {
  it('1. module-level config dict: single init → exact type + frozen on read', () => {
    const text = [
      'CONFIG = {',
      "    'PORT': 7000,",
      "    'NAME': 'test',",
      '}',
      'port = CONFIG["PORT"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    const container = analysis.containers.get('module::CONFIG');
    expect(container).toBeDefined();
    expect(container!.frozen).toBe(true);
    const port = container!.keys.get('PORT');
    expect(port?.types).toEqual(['int']);
    expect(port?.sites).toEqual([{ file: FILE, line: 1, kind: 'init', type: 'int' }]);
    const query = queryDictValueTypeAtPosition(analysis, 'port = CONFIG["PORT"]', 4, 17);
    expect(query?.types).toEqual(['int']);
    expect(query?.frozen).toBe(true);
  });

  it('2. multi-write union with per-type file:line provenance', () => {
    const text = [
      'SETTINGS = {"MODE": 1}',
      'SETTINGS["MODE"] = "fast"',
      'SETTINGS["MODE"] = 3.5',
      'x = SETTINGS["MODE"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    const container = analysis.containers.get('module::SETTINGS');
    expect(container!.frozen).toBe(false);
    const entry = container!.keys.get('MODE')!;
    expect(entry.types).toEqual(['int', 'str', 'float']);
    expect(entry.sites.map(site => `${site.type}@${site.line}:${site.kind}`)).toEqual([
      'int@0:init',
      'str@1:write',
      'float@2:write'
    ]);
    const query = queryDictValueTypeAtPosition(analysis, 'x = SETTINGS["MODE"]', 3, 16);
    expect(query?.types).toEqual(['int', 'str', 'float']);
  });

  it('3. case-sensitive keys: Config["Name"] and Config["name"] stay separate', () => {
    const text = [
      'Config = {"Name": 1, "name": "x"}',
      'a = Config["Name"]',
      'b = Config["name"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    const container = analysis.containers.get('module::Config')!;
    expect(container.keys.get('Name')?.types).toEqual(['int']);
    expect(container.keys.get('name')?.types).toEqual(['str']);
    expect(queryDictValueTypeAtPosition(analysis, 'a = Config["Name"]', 1, 13)?.types).toEqual(['int']);
    expect(queryDictValueTypeAtPosition(analysis, 'b = Config["name"]', 2, 13)?.types).toEqual(['str']);
  });

  it('4. frozen breaks on subscript write / delete / tainted reassign', () => {
    const write = analyzeDictValueTypeFile('C = {"A": 1}\nC["A"] = 2\n', FILE);
    expect(write.containers.get('module::C')!.frozen).toBe(false);
    const del = analyzeDictValueTypeFile('C = {"A": 1}\ndel C["A"]\n', FILE);
    expect(del.containers.get('module::C')!.frozen).toBe(false);
    const taint = analyzeDictValueTypeFile('C = {"A": 1}\nC = make()\n', FILE);
    expect(taint.containers.get('module::C')!.frozen).toBe(false);
    const annotated = analyzeDictValueTypeFile('C: dict[str, int] = {"A": 1}\n', FILE);
    expect(annotated.containers.get('module::C')!.frozen).toBe(true);
  });

  it('5. one nested level: CONFIG["a"]["b"] resolves inner key', () => {
    const text = [
      'CONFIG = {',
      "  'a': {'b': 42},",
      '}',
      'v = CONFIG["a"]["b"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    const container = analysis.containers.get('module::CONFIG')!;
    expect(container.nested.get('a')?.get('b')?.types).toEqual(['int']);
    const query = queryDictValueTypeAtPosition(analysis, 'v = CONFIG["a"]["b"]', 3, 18);
    expect(query?.types).toEqual(['int']);
    expect(query?.nestedKey).toBe('b');
  });

  it('6. honest null: dynamic key, unknown key, unknown RHS, deeper chain', () => {
    const text = [
      'CONFIG = {"a": 1, "dyn": unknown_fn()}',
      'x = CONFIG[k]',
      'y = CONFIG["missing"]',
      'z = CONFIG["dyn"]',
      'w = CONFIG["a"]["b"]["c"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    expect(queryDictValueTypeAtPosition(analysis, 'x = CONFIG[k]', 1, 12)).toBeNull();
    expect(queryDictValueTypeAtPosition(analysis, 'y = CONFIG["missing"]', 2, 13)).toBeNull();
    expect(queryDictValueTypeAtPosition(analysis, 'z = CONFIG["dyn"]', 3, 12)).toBeNull();
    expect(queryDictValueTypeAtPosition(analysis, 'w = CONFIG["a"]["b"]["c"]', 4, 23)).toBeNull();
    expect(analysis.containers.get('module::CONFIG')!.keys.get('dyn')?.untypedWrites).toBe(1);
  });

  it('7. self.<attr> container is class-scoped; local dicts merge only in-function', () => {
    const text = [
      'class A:',
      '    def __init__(self):',
      '        self.config = {"HP": 10}',
      '    def read(self):',
      '        return self.config["HP"]',
      '',
      'def f():',
      '    local = {"K": "v"}',
      '    return local["K"]',
      '',
      'def g():',
      '    return local["K"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    expect(analysis.containers.get('self:A:self.config')?.keys.get('HP')?.types).toEqual(['int']);
    const local = analysis.containers.get('local:f@6:local');
    expect(local?.keys.get('K')?.types).toEqual(['str']);
    expect(queryDictValueTypeAtPosition(analysis, '        return self.config["HP"]', 4, 29)?.types).toEqual(['int']);
    expect(queryDictValueTypeAtPosition(analysis, '    return local["K"]', 8, 18)?.types).toEqual(['str']);
    expect(queryDictValueTypeAtPosition(analysis, '    return local["K"]', 11, 18)).toBeNull();
  });

  it('8. KBEngine global dict accesses are excluded (GLOBDATA-002 owns them)', () => {
    const text = [
      'import KBEngine',
      'x = KBEngine.globalData["k"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    expect(analysis.containers.size).toBe(0);
    const hits = findDictValueAccessesOnLine(analysis, 'x = KBEngine.globalData["k"]', 1);
    expect(hits).toEqual([]);
  });

  it('9. completion context: quoted / bare, get and subscript, KBEngine excluded', () => {
    expect(dictValueKeyCompletionContext('x = CONFIG["HO', 14)).toMatchObject({
      receiver: 'CONFIG',
      partial: 'HO',
      replaceStart: 12,
      viaGet: false
    });
    // 'x = self.config.get("HO' is 24 chars; cursor at end leaves both letters
    expect(dictValueKeyCompletionContext('x = self.config.get("HO', 24)).toMatchObject({
      receiver: 'self.config',
      partial: 'HO',
      viaGet: true
    });
    expect(dictValueKeyCompletionContext('x = CONFIG[', 11)).toMatchObject({
      receiver: 'CONFIG',
      partial: '',
      viaGet: false
    });
    expect(dictValueKeyCompletionContext('x = KBEngine.globalData["', 25)).toBeNull();
  });

  it('10. comments and string literals never produce containers or reads', () => {
    const text = [
      '# CONFIG = {"A": 1}',
      's = "CONFIG[\'A\']"',
      'CONFIG = {"A": 1}  # real init',
      'x = CONFIG["A"]  # CONFIG["B"]',
      ''
    ].join('\n');
    const analysis = analyzeDictValueTypeFile(text, FILE);
    expect(analysis.containers.get('module::CONFIG')?.keys.size).toBe(1);
    expect(queryDictValueTypeAtPosition(analysis, 'x = CONFIG["A"]  # CONFIG["B"]', 3, 12)?.types).toEqual(['int']);
  });

  it('11. prove-red pin: core source contains no case-folding of keys/symbols', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'backend', 'dictValueTypeCore.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/to(?:Lower|Upper)Case\s*\(/);
    expect(source).not.toMatch(/localeCompare\s*\(/);
  });
});
