import { describe, expect, it } from 'vitest';
import {
  resolveEntityTypeStubSource,
  resolvePythonTypeStubSource
} from '../src/generatedSourceMap';
import type { EntityTypeStubEntry } from '../src/entityTypeStubs';
import type {
  PythonTypeStubAliasEntry,
  PythonTypeStubClassEntry
} from '../src/pythonTypeStubs';

const pythonClass: PythonTypeStubClassEntry = {
  kind: 'class',
  name: 'ITEM_INFO',
  properties: [{ name: 'ownerId', annotation: 'PLAYER_ID' }],
  propertySourceLines: { ownerId: 8 },
  sourceLine: 4
};

const pythonAlias: PythonTypeStubAliasEntry = {
  kind: 'alias',
  name: 'ITEM_IDS',
  annotation: 'List[ITEM_ID]',
  sourceLine: 12
};

const entityEntry: EntityTypeStubEntry = {
  entity: 'Avatar',
  properties: [{
    name: 'profile',
    annotation: 'ITEM_INFO',
    sourceLine: 24,
    customTypeLine: 4
  }]
};

describe('generated source map', () => {
  it('maps TypedDict fields to original types.xml lines', () => {
    expect(resolvePythonTypeStubSource([pythonClass], 2)).toEqual({
      origin: 'ITEM_INFO',
      line: 4
    });
  });

  it('maps module aliases to their original declarations', () => {
    expect(resolvePythonTypeStubSource([pythonAlias], 0)).toEqual({
      origin: 'ITEM_IDS',
      line: 12
    });
  });

  it('prefers a custom types.xml line over the .def line for entity properties', () => {
    expect(resolveEntityTypeStubSource([entityEntry], 0)).toEqual({
      origin: 'Avatar',
      line: 4
    });
  });

  it('falls back to the .def line when no custom type is referenced', () => {
    expect(resolveEntityTypeStubSource([{
      ...entityEntry,
      properties: [{ ...entityEntry.properties[0], customTypeLine: undefined }]
    }], 0)).toEqual({
      origin: 'Avatar',
      line: 24
    });
  });
});
