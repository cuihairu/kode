import { describe, expect, it } from 'vitest';
import {
  resolveEntityTypeStubSource,
  resolvePythonTypeStubSource
} from '../src/backend/generatedSourceMap';
import { buildPythonTypeStubLineMap } from '../src/pythonTypeStubs';
import { buildEntityTypeStubLineMap } from '../src/entityTypeStubs';
import type { EntityTypeStubEntry } from '../src/entityTypeStubs';
import type {
  PythonTypeStubAliasEntry,
  PythonTypeStubClassEntry
} from '../src/pythonTypeStubs';

// KR-AUD-78:来源映射按渲染期记录的真实生成行分配——旧实现硬编码 line 0/2
// 且多条目覆盖 map key 0,只有后写条目能出镜。

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
  methods: [],
  properties: [{
    name: 'profile',
    annotation: 'ITEM_INFO',
    sourceLine: 24,
    customTypeLine: 4
  }]
};

describe('generated source map (KR-AUD-78 real generated lines)', () => {
  it('maps each class/alias to its real generated line, not a hardcoded 0/2', () => {
    // 两条目:旧实现 key 0 相互覆盖,只有后写者(别名)存活
    const entries = [pythonClass, pythonAlias];
    const map = buildPythonTypeStubLineMap(entries)!;

    const classLine = map.entryLines.get('ITEM_INFO')!;
    const aliasLine = map.entryLines.get('ITEM_IDS')!;
    expect(classLine).not.toBe(aliasLine);

    expect(resolvePythonTypeStubSource(entries, map, classLine)).toEqual({
      origin: 'ITEM_INFO',
      line: 4
    });
    expect(resolvePythonTypeStubSource(entries, map, aliasLine)).toEqual({
      origin: 'ITEM_IDS',
      line: 12
    });
    // 行 0 不再是魔法键:两条目都不在行 0 时无映射
    if (classLine !== 0 && aliasLine !== 0) {
      expect(resolvePythonTypeStubSource(entries, map, 0)).toBeNull();
    }
  });

  it('maps TypedDict property fields to their own source lines', () => {
    const entries = [pythonClass];
    const map = buildPythonTypeStubLineMap(entries)!;
    const ownerLine = map.propertyLines.get('ITEM_INFO')!['ownerId'];
    expect(ownerLine).toBeDefined();
    expect(resolvePythonTypeStubSource(entries, map, ownerLine)).toEqual({
      origin: 'ITEM_INFO',
      line: 8
    });
  });

  it('returns null without a rendered line map (no invented lines)', () => {
    expect(resolvePythonTypeStubSource([pythonClass], null, 0)).toBeNull();
    expect(resolveEntityTypeStubSource([entityEntry], null, 0)).toBeNull();
  });

  it('maps entity stub properties via real generated lines', () => {
    const entries = [entityEntry];
    const map = buildEntityTypeStubLineMap(entries);
    const profileLine = map.propertyLines.get('Avatar')!['profile'];
    expect(profileLine).toBeGreaterThan(0);

    expect(resolveEntityTypeStubSource(entries, map, profileLine)).toEqual({
      origin: 'Avatar',
      line: 4
    });
    // 无自定义类型时回落 .def 行
    const fallbackEntry: EntityTypeStubEntry = {
      ...entityEntry,
      properties: [{ ...entityEntry.properties[0], customTypeLine: undefined }]
    };
    expect(resolveEntityTypeStubSource([fallbackEntry], buildEntityTypeStubLineMap([fallbackEntry]), profileLine))
      .toEqual({
        origin: 'Avatar',
        line: 24
      });
  });
});
