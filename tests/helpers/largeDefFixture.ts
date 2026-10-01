// 批92 性能基准与回归锁共用的确定性大 .def 生成器:800 属性 + 600 方法 +
// 每 40 个属性混一个缺 <Type>/幻影类型样本,约 170KB。无随机数,同一份
// 文本同时喂给 tests/perf/defPerf.bench.ts(计时)与
// tests/perfRegression.test.ts(行为回归锁)。

export const LARGE_DEF_PROPERTY_COUNT = 800;
export const LARGE_DEF_METHOD_COUNT = 600;

export function buildLargeDefFixture(): string {
  const types = ['UINT8', 'INT32', 'STRING', 'VECTOR3', 'FLOAT', 'UNICODE', 'DOUBLE', 'INT64'];
  const flags = ['ALL_CLIENTS', 'CELL_PUBLIC|ANY_CLIENTS', 'CELL_PRIVATE', 'BASE_PUBLIC|CELL_PUBLIC'];
  const detailLevels = ['NEAR', 'MEDIUM', 'FAR'];
  const lines: string[] = ['<root>', '  <Parent>Avatar</Parent>', '  <Properties>'];

  for (let i = 0; i < LARGE_DEF_PROPERTY_COUNT; i += 1) {
    const type = types[i % types.length];
    const flag = flags[i % flags.length];
    const detail = detailLevels[i % detailLevels.length];
    lines.push(`    <field${i}>`);
    lines.push(`      <Type>${type}</Type>`);
    lines.push(`      <Flags>${flag}</Flags>`);
    lines.push(`      <DetailLevel>${detail}</DetailLevel>`);
    lines.push(`      <Default>0</Default>`);
    lines.push(`    </field${i}>`);
    // 混入少量缺陷样本:defAnalyzer/validateDocument 的「有发现」分支也能被基准覆盖
    if (i % 40 === 0) {
      lines.push(`    <broken${i}>`);
      lines.push(`      <Type>BOOL</Type>`);
      lines.push(`      <Flags>ALL_CLIENTS</Flags>`);
      lines.push(`    </broken${i}>`);
    }
  }
  lines.push('  </Properties>');

  const sections = ['BaseMethods', 'CellMethods', 'ClientMethods'];
  for (const section of sections) {
    lines.push(`  <${section}>`);
    for (let i = 0; i < LARGE_DEF_METHOD_COUNT / sections.length; i += 1) {
      lines.push(`    <op${i}>`);
      lines.push('      <IsExposed>1</IsExposed>');
      lines.push('      <Arg>INT32</Arg>');
      lines.push(`    </op${i}>`);
    }
    lines.push(`  </${section}>`);
  }
  lines.push('</root>');
  return lines.join('\n');
}
