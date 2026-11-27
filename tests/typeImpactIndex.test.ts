import { describe, expect, it } from 'vitest';

import type { CustomTypeInfo, CustomTypeStructureNode } from '../src/definitionWorkspace';
import {
  TypeImpactIndex,
  buildDeclReferenceGraph,
  extractDefPropertyEdges,
  impactOf,
  type DefPropertyEdge
} from '../src/backend/typeImpactIndex';

const structureNode = (name: string, children: CustomTypeStructureNode['children'] = []): CustomTypeStructureNode => ({
  name,
  rawValue: name,
  children,
  line: 10
});

const TYPE_CHILD = (rawValue: string): CustomTypeStructureNode['children'][number] => ({
  tag: 'Type',
  value: structureNode(rawValue)
});

const OF_CHILD = (rawValue: string): CustomTypeStructureNode['children'][number] => ({
  tag: 'of',
  value: structureNode(rawValue)
});

let declSeq = 0;

/** Minimal declaration entry carrying the given direct references */
const decl = (name: string, refs: string[]): CustomTypeInfo => {
  declSeq += 1;
  return {
    name,
    filePath: '/path/types.xml',
    line: declSeq,
    implementedByLine: declSeq,
    startOffset: 0,
    endOffset: 1,
    aliasType: name,
    rawValue: name,
    structure: structureNode(name, refs.map(r => TYPE_CHILD(r))),
    properties: []
  };
};

describe('typeImpactIndex', () => {
  describe('extractDefPropertyEdges', () => {
    it('extracts name, declaredType, ofRef and line from a .def with mixed properties', () => {
      const text = `<root>
        <Properties>
          <Property>
            <Name>hp</Name>
            <Type>UINT16</Type>
          </Property>
          <Property>
            <Name>position</Name>
            <Type>ARRAY</Type>
            <of>MyVector</of>
          </Property>
        </Properties>
      </root>`;
      const edges: DefPropertyEdge[] = extractDefPropertyEdges(text, 'Entity', 'entity.def');
      expect(edges).toHaveLength(2);
      expect(edges[0]).toEqual(expect.objectContaining({ property: 'hp', declaredType: 'UINT16', ofRef: null, line: 3, entity: 'Entity', filePath: 'entity.def' }));
      expect(edges[1]).toEqual(expect.objectContaining({ property: 'position', declaredType: 'ARRAY', ofRef: 'MyVector', line: 7, entity: 'Entity', filePath: 'entity.def' }));
    });

    it('returns empty when the document has no Properties section', () => {
      const edges = extractDefPropertyEdges('<root/>', 'E', 'E.def');
      expect(edges).toHaveLength(0);
    });

    it('reads the DB persistence flag (default off, literal "true" persists)', () => {
      const edges = extractDefPropertyEdges(
        '<root><Properties>' +
          '<Property><Name>a</Name><Type>UINT16</Type></Property>' +
          '<Property><Name>b</Name><Type>UINT16</Type><Persistent>true</Persistent></Property>' +
          '<Property><Name>c</Name><Type>UINT16</Type><Persistent>True</Persistent></Property>' +
          '</Properties></root>',
        'E', 'E.def'
      );
      expect(edges.map(edge => edge.persistent)).toEqual([false, true, true]);
    });

    it('skips malformed Property entries missing a name', () => {
      const edges = extractDefPropertyEdges(
        '<root><Properties><Property><Type>Foo</Type></Property></Properties></root>',
        'E', 'E.def'
      );
      expect(edges).toHaveLength(0);
    });
  });

  describe('buildDeclReferenceGraph', () => {
    it('maps declared custom type names to their direct references', () => {
      const graph = buildDeclReferenceGraph([decl('MyFD', ['AliasX']), decl('AliasX', ['BaseFD']), decl('BaseFD', [])]);
      expect(graph.get('MyFD')!.references).toEqual(new Set(['AliasX']));
      expect(graph.get('AliasX')!.references).toEqual(new Set(['BaseFD']));
      expect(graph.get('BaseFD')!.references).toEqual(new Set<string>());
    });

    it('ignores builtin names (not in declared set)', () => {
      const graph = buildDeclReferenceGraph([decl('MyFD', ['STRING'])]);
      expect(graph.get('MyFD')!.references).toEqual(new Set<string>());
    });

    it('collects references from property structure tokens (typeStructure)', () => {
      const entries: CustomTypeInfo[] = [
        {
          ...decl('Wrapper', []),
          structure: structureNode('Wrapper', [TYPE_CHILD('ARRAY'), OF_CHILD('Inner')]),
          properties: [{
            name: 'items',
            typeName: 'ARRAY',
            typeStructure: structureNode('ARRAY', [OF_CHILD('Inner')]),
            line: 2,
            typeLine: 2
          }]
        },
        decl('Inner', [])
      ];
      const graph = buildDeclReferenceGraph(entries);
      expect(graph.get('Wrapper')!.references).toEqual(new Set(['Inner']));
    });
  });

  describe('impactOf', () => {
    const makeGraph = (): Map<string, { references: Set<string> }> =>
      buildDeclReferenceGraph([decl('A', ['B']), decl('B', ['C']), decl('C', []), decl('D', ['C'])]);

    it('returns direct references', () => {
      const edges: DefPropertyEdge[] = [
        { entity: 'E1', filePath: 'e1.def', property: 'data', declaredType: 'A', ofRef: null, persistent: false, line: 5 }
      ];
      const result = impactOf('A', makeGraph(), new Map([['e1.def', edges]]));
      expect(result).toEqual([expect.objectContaining({ entity: 'E1', filePath: 'e1.def', property: 'data', line: 5, via: [] })]);
    });

    it('resolves transitive closure through alias chains', () => {
      const edges: DefPropertyEdge[] = [
        { entity: 'E1', filePath: 'e1.def', property: 'data', declaredType: 'A', ofRef: null, persistent: false, line: 5 }
      ];
      const result = impactOf('C', makeGraph(), new Map([['e1.def', edges]]));
      expect(result).toHaveLength(1);
      expect(result[0].via).toEqual(['A', 'B']);
      expect(result[0].property).toBe('data');
    });

    it('matches ARRAY element type', () => {
      const edges: DefPropertyEdge[] = [
        { entity: 'E1', filePath: 'e1.def', property: 'list', declaredType: 'ARRAY', ofRef: 'C', persistent: false, line: 8 }
      ];
      const result = impactOf('C', makeGraph(), new Map([['e1.def', edges]]));
      expect(result).toHaveLength(1);
      expect(result[0].via).toEqual([]);
      expect(result[0].property).toBe('list');
    });

    it('propagates to types that reference the queried type; builtin never matches', () => {
      const edges: DefPropertyEdge[] = [
        { entity: 'E1', filePath: 'e1.def', property: 'hp', declaredType: 'UINT16', ofRef: null, line: 2 },
        { entity: 'E2', filePath: 'e2.def', property: 'flag', declaredType: 'D', ofRef: null, persistent: false, line: 3 }
      ];
      const result = impactOf('C', makeGraph(), new Map([['e1.def', edges.slice(0, 1)], ['e2.def', edges.slice(1)]]));
      // D references C, so a property typed D is affected; UINT16 is not declared.
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ property: 'flag', via: ['D'] }));
    });

    it('returns entries sorted by filePath then line then property', () => {
      const edges: DefPropertyEdge[] = [
        { entity: 'E2', filePath: 'b.def', property: 'beta', declaredType: 'C', ofRef: null, persistent: false, line: 10 },
        { entity: 'E1', filePath: 'a.def', property: 'alpha', declaredType: 'C', ofRef: null, persistent: false, line: 5 },
        { entity: 'E1', filePath: 'a.def', property: 'gamma', declaredType: 'C', ofRef: null, persistent: false, line: 5 }
      ];
      const result = impactOf('C', makeGraph(), new Map([['a.def', edges.slice(1, 3)], ['b.def', edges.slice(0, 1)]]));
      expect(result).toHaveLength(3);
      expect(result[0].filePath).toBe('a.def');
      expect(result[0].property).toBe('alpha');
      expect(result[1].filePath).toBe('a.def');
      expect(result[1].property).toBe('gamma');
      expect(result[2].filePath).toBe('b.def');
    });
  });

  describe('TypeImpactIndex (incremental)', () => {
    it('setDefFile replaces edges on content change and leaves others intact', () => {
      const index = new TypeImpactIndex();
      index.setDefFile('e1.def', 'E1', 'text-a');
      expect(index.getDefFileCount()).toBe(1);
      index.setDefFile('e2.def', 'E2', 'text-b');
      expect(index.getDefFileCount()).toBe(2);
      index.setDefFile('e1.def', 'E1', 'text-a-2');
      expect(index.getDefFileCount()).toBe(2);
    });

    it('setDefFile with identical text is a no-op', () => {
      const index = new TypeImpactIndex();
      index.setDefFile('e1.def', 'E1', 'same');
      expect(index.setDefFile('e1.def', 'E1', 'same')).toBe(false);
    });

    it('removeDefFile drops the file', () => {
      const index = new TypeImpactIndex();
      index.setDefFile('e1.def', 'E1', 'text');
      index.removeDefFile('e1.def');
      expect(index.getDefFileCount()).toBe(0);
    });

    it('retainDefFiles drops files absent from the keep set (deleted on disk)', () => {
      const index = new TypeImpactIndex();
      index.setDefFile('e1.def', 'E1', '<root><Properties><Property><Name>p</Name><Type>C</Type></Property></Properties></root>');
      index.setDefFile('e2.def', 'E2', 'text');
      index.retainDefFiles(new Set(['e2.def']));
      expect(index.getDefFileCount()).toBe(1);
      expect(index.impactOf('C')).toHaveLength(0);
    });

    it('ignores unparsable def files (no crash)', () => {
      const index = new TypeImpactIndex();
      expect(() => index.setDefFile('empty.def', 'E', '')).not.toThrow();
      expect(index.getDefFileCount()).toBe(1);
      expect(index.impactOf('X')).toHaveLength(0);
    });

    it('declaration graph drives transitive closure end to end', () => {
      const index = new TypeImpactIndex();
      index.setCustomTypes([decl('A', ['B']), decl('B', ['C']), decl('C', [])]);
      index.setDefFile('e1.def', 'E1', '<root><Properties><Property><Name>p</Name><Type>A</Type></Property></Properties></root>');
      const result = index.impactOf('C');
      expect(result.map(e => ({ p: e.property, v: e.via }))).toEqual([{ p: 'p', v: ['A', 'B'] }]);
    });

    it('replaced declaration snapshot recomputes without losing def edges', () => {
      const index = new TypeImpactIndex();
      index.setCustomTypes([decl('A', [])]);
      index.setDefFile('e1.def', 'E1', '<root><Properties><Property><Name>p</Name><Type>A</Type></Property></Properties></root>');
      expect(index.impactOf('A')).toHaveLength(1);

      // A removed from the snapshot: the property still references A by name
      // (now a dangling reference, which is precisely the affected surface).
      index.setCustomTypes([decl('B', [])]);
      expect(index.impactOf('A')).toHaveLength(1);
      expect(index.getDefFileCount()).toBe(1);
    });
  });
});
