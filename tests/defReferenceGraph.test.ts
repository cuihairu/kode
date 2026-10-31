import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDefReferenceGraphFromFile,
  buildProjectDoctorReport,
  formatDefReferenceGraphPreview,
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
  // AUD-059:无链接当前实体(Solo 只有 hp,无 Parent 无后代)——选中它时
  // 引用图必须保留 Solo.hp,Doctor 统计含当前文件
  write('scripts/entity_defs/Solo.def', [
    '<root>',
    '  <Properties>',
    '    <hp> <Type> UINT32 </Type> </hp>',
    '  </Properties>',
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
    // AUD-058:单个正常开闭标签零重复警告(此前 rename 开+闭两编辑位置被
    // 误当两份声明)
    expect(report.warnings.map(issue => issue.code)).not.toContain('duplicate-symbol');
    expect(formatProjectDoctorReport(report)).toMatch(/^Project Doctor:/);
  });

  it('AUD-058 同段真实重复声明仍定位正确且经 Project Doctor 同结果', () => {
    // 自成一根的连边 def 树(Dup->DupBase),避免混入主 fixture 的
    // Hero/Monster/Boss 分量影响 checkedFiles=3
    const dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-def-dup-'));
    try {
      const write = (relative: string, content: string): void => {
        const target = path.join(dupRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
      };
      write('scripts/entities.xml', '<root>\n  <Dup hasBase="true"/>\n</root>\n');
      write('scripts/entity_defs/DupBase.def', ['<root>', '</root>'].join('\n'));
      write('scripts/entity_defs/Dup.def', [
        '<root>',
        '  <Parent> DupBase </Parent>',
        '  <Properties>',
        '    <hp> <Type> UINT32 </Type> </hp>',
        '    <hp> <Type> UINT16 </Type> </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'));

      const graph = buildDefReferenceGraphFromFile(path.join(dupRoot, 'scripts/entity_defs/Dup.def'))!;
      const report = buildProjectDoctorReport(graph);
      const duplicates = report.warnings.filter(issue => issue.code === 'duplicate-symbol');
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].filePath).toContain('Dup.def');
      expect(duplicates[0].name).toBe('hp');
      expect(formatProjectDoctorReport(report)).toMatch(/declared more than once/);
    } finally {
      fs.rmSync(dupRoot, { recursive: true, force: true });
    }
  });

  it('AUD-059 无链接的当前实体(seed)仍保留:图含 Solo.hp,Doctor 统计含当前文件', () => {
    const graph = buildDefReferenceGraphFromFile(path.join(root, 'scripts/entity_defs/Solo.def'))!;
    expect(graph.definitions.map(definition => `${definition.ownerName}.${definition.name}`))
      .toContain('Solo.hp');

    const report = buildProjectDoctorReport(graph);
    // Solo.hp 在 definitions => Solo.def 计入统计;既有 union 行为仍把
    // 有链接的 Hero/Monster/Boss 一并纳入,不因新增 seed 而改变
    expect(report.checkedFiles).toBeGreaterThan(0);
    expect(report.checkedDefinitions).toBeGreaterThan(0);

    // 既有约束:无关孤立实体(Orphan)不误纳入——非 seed 的孤点仍被排除
    const orphanGraph = buildDefReferenceGraphFromFile(path.join(root, 'scripts/entity_defs/Hero.def'))!;
    expect(orphanGraph.definitions.map(definition => `${definition.ownerName}.${definition.name}`))
      .not.toContain('Orphan.own');
  });

  it('renders graph symbols, edges and unresolved targets in both forms', () => {
    const graph = buildDefReferenceGraphFromFile(path.join(root, 'scripts/entity_defs/Boss.def'))!;
    const preview = formatDefReferenceGraphPreview(graph);

    expect(preview.mermaid).toContain('Hero.def\\nmethod move\\nproperty hp');
    expect(preview.mermaid).toMatch(/F\d+\ -->\|inherit: hp, move\| F\d+/);
    expect(preview.mermaid).toMatch(/F\d+ -\.dangling-parent\.-> U\d+\["Unresolved Missing"\]/);
    expect(preview.text).toContain('Monster.def -> Hero.def (inherit): hp, move');
    expect(preview.text).toContain('Orphan.def -> Unresolved Missing (dangling-parent)');
  });
});
