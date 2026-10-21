import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDefReferenceGraphFromFile,
  buildProjectDoctorReport,
  formatProjectDoctorReport
} from '../src/defReferenceGraph';

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-def-graph-'));
  const write = (relative: string, content: string): string => {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
  };

  write('scripts/entities.xml', '<root>\n  <Hero> <hasBase/> </Hero>\n</root>\n');
  write('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp> <Type> UINT32 </Type> <Flags> ALL_CLIENTS </Flags> </hp>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <move> <Arg> UINT8 </Arg> </move>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Parent> Hero </Parent>',
    '  <Properties>',
    '    <hp> <Type> UINT16 </Type> </hp>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <move/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Boss.def', [
    '<root>',
    '  <Parent> Monster </Parent>',
    '  <Properties>',
    '    <armor> <Type> UINT8 </Type> </armor>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Orphan.def', [
    '<root>',
    '  <Parent> Missing </Parent>',
    '  <Properties>\n    <own> <Type> UINT8 </Type> </own>\n  </Properties>',
    '</root>'
  ].join('\n'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('def reference graph', () => {
  it('shares rename-safe declarations across inherited files', () => {
    const graph = buildDefReferenceGraphFromFile(path.join(root, 'scripts/entity_defs/Boss.def'));
    expect(graph).not.toBeNull();

    const edges = graph!.edges.map(edge => ({
      source: path.basename(edge.source),
      target: path.basename(edge.target),
      relation: edge.relation,
      names: edge.references.map(reference => reference.name)
    }));
    expect(edges).toContainEqual({
      source: 'Monster.def',
      target: 'Hero.def',
      relation: 'inherit',
      names: expect.arrayContaining(['hp', 'move'])
    });

    const references = graph!.references;
    expect(references.filter(reference => reference.name === 'hp')).toHaveLength(2);
    expect(references.filter(reference => reference.name === 'hp').map(reference => `${reference.sourceOwner}->${reference.targetOwner}`))
      .toEqual(['Monster->Hero', 'Monster->Hero']);

    const definitions = graph!.definitions.map(definition => `${definition.ownerName}.${definition.name}`);
    expect(definitions).toContain('Hero.hp');
    expect(definitions).toContain('Boss.armor');
    expect(definitions).not.toContain('Orphan.own');
  });

  it('reports project doctor diagnostics and connected edges', () => {
    const graph = buildDefReferenceGraphFromFile(path.join(root, 'scripts/entity_defs/Hero.def'))!;
    const report = buildProjectDoctorReport(graph);
    expect(report.checkedDefinitions).toBeGreaterThan(0);
    expect(report.checkedFiles).toBe(3);
    expect(report.errors.map(issue => issue.code)).toContain('dangling-parent');
    expect(report.warnings.map(issue => issue.code)).toContain('duplicate-symbol');
    expect(formatProjectDoctorReport(report)).toMatch(/^Project Doctor:/);
  });
});
