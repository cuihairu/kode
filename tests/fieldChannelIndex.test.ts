import { describe, expect, it } from 'vitest';

import { FieldChannelIndex, DB_BLOB_CITE, WIRE_DECODE_ENGINE_CITE, WIRE_ENCODE_ENGINE_CITE } from '../src/backend/fieldChannelIndex';
import type { CustomTypeInfo } from '../src/definitionWorkspace';

const fdDecl = (name: string, fields: string[], implFile?: string): CustomTypeInfo => ({
  name,
  filePath: '/workspace/types.xml',
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

const implText = (encodeKeys: string[], decodeKeys: string[]): string => [
  'class MySer:',
  '    def getDictFromObj(self, obj):',
  `        return {${encodeKeys.map(key => `"${key}": obj["${key}"]`).join(', ')}}`,
  '',
  '    def createObjFromDict(self, dct):',
  `        return {${decodeKeys.map(key => `"${key}": dct["${key}"]`).join(', ')}}`,
  ''
].join('\n');

const defText = `<root><Properties>
  <Property><Name>data</Name><Type>MyFD</Type><Persistent>true</Persistent></Property>
  <Property><Name>temp</Name><Type>MyFD</Type></Property>
</Properties></root>`;

describe('fieldChannelIndex', () => {
  it('reports impl anchors for both wire channels and the DB blob cite', () => {
    const index = new FieldChannelIndex();
    index.setCustomTypes([fdDecl('MyFD', ['hp', 'mp'], '/workspace/ser.py')]);
    index.setPythonFile('/workspace/ser.py', implText(['hp', 'mp'], ['hp', 'mp']));
    const result = index.channelsForField('MyFD', 'hp');
    expect(result?.target).toBe('MyFD.hp');
    expect(result?.anchors).toEqual([
      { channel: 'wire-encode', origin: 'impl', file: '/workspace/ser.py', line: 3, character: 16 },
      { channel: 'wire-decode', origin: 'impl', file: '/workspace/ser.py', line: 6, character: 27 },
      { channel: 'db', origin: 'engine', cite: DB_BLOB_CITE }
    ]);
    expect(result?.stale).toEqual([]);
  });

  it('engine-cites channels when the type has no impl and reports stale impl keys after a rename', () => {
    const index = new FieldChannelIndex();
    index.setCustomTypes([fdDecl('MyFD', ['hp', 'mp'], '/workspace/ser.py')]);
    index.setPythonFile('/workspace/ser.py', implText(['hp', 'mp'], ['hp', 'mp']));

    // Rename hp -> health in the declaration snapshot; python text is unchanged.
    index.setCustomTypes([fdDecl('MyFD', ['health', 'mp'], '/workspace/ser.py')]);
    const renamed = index.channelsForField('MyFD', 'health');
    expect(renamed?.anchors.map(anchor => anchor.origin)).toEqual(['engine', 'engine', 'engine']);
    expect(renamed?.anchors.map(anchor => anchor.cite)).toEqual([
      WIRE_ENCODE_ENGINE_CITE, WIRE_DECODE_ENGINE_CITE, DB_BLOB_CITE
    ]);
    expect(renamed?.stale.map(entry => entry.key).sort()).toEqual(['hp', 'hp']);

    // Restoring the declaration restores the impl anchors with no python reparse.
    index.setCustomTypes([fdDecl('MyFD', ['hp', 'mp'], '/workspace/ser.py')]);
    expect(index.channelsForField('MyFD', 'hp')?.anchors[0].origin).toBe('impl');
    expect(index.getShapeComputeCount()).toBe(1);
  });

  it('maps def properties with persistent/engine/no-persist DB arms', () => {
    const index = new FieldChannelIndex();
    index.setCustomTypes([fdDecl('MyFD', ['hp'], '/workspace/ser.py')]);
    index.setPythonFile('/workspace/ser.py', implText(['hp'], ['hp']));
    index.setDefFile('/workspace/Avatar.def', 'Avatar', defText);
    const persistent = index.channelsForProperty('/workspace/Avatar.def', 'data');
    expect(persistent?.target).toBe('Avatar.data');
    expect(persistent?.anchors.map(anchor => anchor.channel)).toEqual(['wire-encode', 'wire-decode', 'db']);
    expect(persistent?.anchors[2]).toEqual({ channel: 'db', origin: 'engine', cite: DB_BLOB_CITE });
    const transient = index.channelsForProperty('/workspace/Avatar.def', 'temp');
    expect(transient?.anchors[2]).toEqual({ channel: 'db', origin: 'none', cite: 'not persisted' });
    expect(index.channelsForProperty('/workspace/Avatar.def', 'missing')).toBeNull();
  });

  it('content identity: unchanged files never recompute shapes or def rows', () => {
    const index = new FieldChannelIndex();
    index.setCustomTypes([fdDecl('MyFD', ['hp'], '/workspace/ser.py')]);
    expect(index.setPythonFile('/workspace/ser.py', implText(['hp'], ['hp']))).toBe(true);
    expect(index.setPythonFile('/workspace/ser.py', implText(['hp'], ['hp']))).toBe(false);
    expect(index.setPythonFile('/workspace/ser.py', implText(['hp', 'mp'], ['hp']))).toBe(true);
    expect(index.getShapeComputeCount()).toBe(2);
    expect(index.setDefFile('/workspace/Avatar.def', 'Avatar', defText)).toBe(true);
    expect(index.setDefFile('/workspace/Avatar.def', 'Avatar', defText)).toBe(false);
    expect(index.getDefFileCount()).toBe(1);
  });

  it('rename in the python file invalidates its cached shapes', () => {
    const index = new FieldChannelIndex();
    index.setCustomTypes([fdDecl('MyFD', ['hp'], '/workspace/ser.py')]);
    index.setPythonFile('/workspace/ser.py', implText(['hp'], ['hp']));
    // The impl source renamed hp to health; same class, same declaration.
    index.setPythonFile('/workspace/ser.py', implText(['health'], ['health']));
    const result = index.channelsForField('MyFD', 'health');
    expect(result?.anchors[0].origin).toBe('impl');
    expect(index.channelsForField('MyFD', 'hp')?.anchors[0].origin).toBe('engine');
    expect(index.getShapeComputeCount()).toBe(2);
  });

  it('retain faces drop deleted def and python files', () => {
    const index = new FieldChannelIndex();
    index.setCustomTypes([fdDecl('MyFD', ['hp'], '/workspace/ser.py')]);
    index.setPythonFile('/workspace/ser.py', implText(['hp'], ['hp']));
    index.setDefFile('/workspace/Avatar.def', 'Avatar', defText);
    index.retainDefFiles(new Set());
    index.retainPythonFiles(new Set());
    expect(index.getDefFileCount()).toBe(0);
    expect(index.getPythonFileCount()).toBe(0);
    expect(index.channelsForField('MyFD', 'hp')?.anchors.map(anchor => anchor.origin))
      .toEqual(['engine', 'engine', 'engine']);
  });
});
