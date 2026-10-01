import { describe, expect, it } from 'vitest';
import {
  analyzeDefDocument,
  formatDefAnalysisReport,
  type DefAnalysisFinding
} from '../src/defAnalyzer';

// defAnalyzer 纯逻辑测试(批91:性能分析建议)。检查项定案见
// COMPLETED_FEATURES「性能分析建议」条目:幻影类型 / 缺类型 / 重复 Type /
// 大字段全体广播 / DetailLevel 冗余 / 非法 Python 名 / 方法属性同名冲突。

const def = (body: string): string => ['<root>', body, '</root>'].join('\n');

const property = (name: string, inner: string): string =>
  [`  <Properties>`, `    <${name}>`, inner, `    </${name}>`, `  </Properties>`].join('\n');

const checksOf = (findings: DefAnalysisFinding[]): string[] => findings.map(item => item.check);
const firstOf = (findings: DefAnalysisFinding[], check: string): DefAnalysisFinding => {
  const hit = findings.find(item => item.check === check);
  if (!hit) {
    throw new Error(`未找到 ${check} 建议: ${JSON.stringify(findings)}`);
  }
  return hit;
};

describe('analyzeDefDocument 基础形态', () => {
  it('空文本与无根文档返回空建议', () => {
    expect(analyzeDefDocument('')).toEqual([]);
    expect(analyzeDefDocument('   ')).toEqual([]);
  });

  it('无 Properties 与方法节的文档返回空建议', () => {
    expect(analyzeDefDocument(def('  <Parent>Monster</Parent>'))).toEqual([]);
  });

  it('Properties 与全部方法节都缺时的 continue 分支无异常', () => {
    expect(analyzeDefDocument(def('  <Properties> </Properties>'))).toEqual([]);
  });
});

describe('类型类检查(幻影/缺失/重复)', () => {
  it('引擎未注册的幻影类型报 error 并定位到类型值', () => {
    const findings = analyzeDefDocument(
      def(property('hp', '      <Type>BOOL</Type>'))
    );
    const hit = firstOf(findings, 'phantom-type');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('hp');
    expect(hit.message).toContain('BOOL');
    expect(hit.line).toBe(4); // <Type> 标签行(1 基)
    expect(hit.length).toBe(4); // 'BOOL'
    expect(hit.offset).toBeGreaterThan(0);
  });

  it('缺 <Type> 标签报 missing-type', () => {
    const findings = analyzeDefDocument(
      def(property('hp', '      <Flags>ALL_CLIENTS</Flags>'))
    );
    const hit = firstOf(findings, 'missing-type');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('hp');
  });

  it('空 <Type> 标签与纯空白 <Type> 同样报 missing-type', () => {
    const empty = analyzeDefDocument(def(property('hp', '      <Type></Type>')));
    expect(firstOf(empty, 'missing-type').name).toBe('hp');

    const blank = analyzeDefDocument(def(property('hp', '      <Type>   </Type>')));
    expect(firstOf(blank, 'missing-type').name).toBe('hp');
  });

  it('重复 <Type> 报 duplicate-type-tag 警告', () => {
    const findings = analyzeDefDocument(
      def(property('hp', '      <Type>UINT8</Type>\n      <Type>INT8</Type>'))
    );
    const hit = firstOf(findings, 'duplicate-type-tag');
    expect(hit.severity).toBe('warning');
    expect(hit.message).toContain('2 个 <Type>');
    expect(checksOf(findings)).not.toContain('phantom-type');
  });
});

describe('同步开销检查(大字段广播 / DetailLevel 冗余)', () => {
  it('ALL_CLIENTS + 大字段报 heavy-sync-broadcast 警告', () => {
    const findings = analyzeDefDocument(
      def(
        property(
          'memo',
          '      <Type>UNICODE</Type>\n      <Flags>ALL_CLIENTS</Flags>'
        )
      )
    );
    const hit = firstOf(findings, 'heavy-sync-broadcast');
    expect(hit.severity).toBe('warning');
    expect(hit.message).toContain('ALL_CLIENTS');
  });

  it('ALL_CLIENTS + 标量小类型不报;客户端可见但非全体旗标不报', () => {
    const small = analyzeDefDocument(
      def(property('hp', '      <Type>UINT8</Type>\n      <Flags>ALL_CLIENTS</Flags>'))
    );
    expect(checksOf(small)).not.toContain('heavy-sync-broadcast');

    const scoped = analyzeDefDocument(
      def(property('memo', '      <Type>STRING</Type>\n      <Flags>CELL_PUBLIC</Flags>'))
    );
    expect(checksOf(scoped)).not.toContain('heavy-sync-broadcast');
  });

  it('DetailLevel 配在无客户端可见性的属性上报冗余提示', () => {
    const findings = analyzeDefDocument(
      def(
        property(
          'serverSeed',
          '      <Type>UINT32</Type>\n      <Flags>CELL_PRIVATE</Flags>\n      <DetailLevel>FAR</DetailLevel>'
        )
      )
    );
    const hit = firstOf(findings, 'redundant-detail-level');
    expect(hit.severity).toBe('info');
  });

  it('无 Flags 的属性配 DetailLevel 同样报冗余;客户端可见旗标下不报', () => {
    const noFlags = analyzeDefDocument(
      def(property('serverSeed', '      <Type>UINT32</Type>\n      <DetailLevel>MEDIUM</DetailLevel>'))
    );
    expect(checksOf(noFlags)).toContain('redundant-detail-level');

    const synced = analyzeDefDocument(
      def(
        property(
          'pos',
          '      <Type>VECTOR3</Type>\n      <Flags>OTHER_CLIENTS</Flags>\n      <DetailLevel>NEAR</DetailLevel>'
        )
      )
    );
    expect(checksOf(synced)).not.toContain('redundant-detail-level');
  });
});

describe('命名检查(非法标识符 / 关键字 / 方法属性冲突)', () => {
  it('Python 关键字属性名报 error', () => {
    const findings = analyzeDefDocument(def(property('class', '      <Type>UINT8</Type>')));
    const hit = firstOf(findings, 'invalid-identifier');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('class');
    expect(hit.message).toContain('Python 关键字');
  });

  it('方法名为关键字同样报 error', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <BaseMethods>',
          '    <class>',
          '      <Arg>INT8</Arg>',
          '    </class>',
          '  </BaseMethods>'
        ].join('\n')
      )
    );
    const hit = firstOf(findings, 'invalid-identifier');
    expect(hit.name).toBe('class');
  });

  it('方法与属性同名报 method-property-collision', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <hp>',
          '      <Type>UINT8</Type>',
          '    </hp>',
          '  </Properties>',
          '  <BaseMethods>',
          '    <hp>',
          '      <Arg>INT8</Arg>',
          '    </hp>',
          '  </BaseMethods>'
        ].join('\n')
      )
    );
    const hit = firstOf(findings, 'method-property-collision');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('hp');
  });

  it('方法名合法且无冲突时不报;缺的方法节走 continue 分支', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <hp>',
          '      <Type>UINT8</Type>',
          '    </hp>',
          '  </Properties>',
          '  <ClientMethods>',
          '    <onHpChanged>',
          '      <Arg>UINT8</Arg>',
          '    </onHpChanged>',
          '  </ClientMethods>'
        ].join('\n')
      )
    );
    expect(findings).toEqual([]);
  });
});

describe('formatDefAnalysisReport 报告格式', () => {
  it('无建议时输出单行未发现', () => {
    expect(formatDefAnalysisReport('a.def', [])).toBe('a.def: 未发现可优化项');
  });

  it('有建议时逐条列出并附三类计数汇总', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <hp>',
          '      <Type>BOOL</Type>',
          '      <Flags>ALL_CLIENTS</Flags>',
          '      <DetailLevel>FAR</DetailLevel>',
          '    </hp>',
          '  </Properties>'
        ].join('\n')
      )
    );
    // hp: 幻影类型(error)+ 缺失类型豁免(有 Type)+ ALL_CLIENTS 但 UINT8
    // 不在重字段名单(无 heavy-sync)+ DetailLevel 在 ALL_CLIENTS 下不冗余
    expect(checksOf(findings)).toEqual(['phantom-type']);

    const report = formatDefAnalysisReport('/ws/Monster.def', findings);
    const lines = report.split('\n');
    expect(lines[0]).toMatch(/^  \[错误\] L\d+ phantom-type:/);
    expect(lines.at(-1)).toBe('/ws/Monster.def: 共 1 条建议(错误 1 / 警告 0 / 提示 0)');
  });

  it('三类严重度计数各归其位', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <hp>',
          '      <Type>BOOL</Type>',
          '    </hp>',
          '    <memo>',
          '      <Type>STRING</Type>',
          '      <Flags>ALL_CLIENTS</Flags>',
          '    </memo>',
          '    <seed>',
          '      <Type>UINT32</Type>',
          '      <Flags>CELL_PRIVATE</Flags>',
          '      <DetailLevel>FAR</DetailLevel>',
          '    </seed>',
          '  </Properties>'
        ].join('\n')
      )
    );
    const report = formatDefAnalysisReport('x.def', findings);
    expect(report.split('\n').at(-1)).toBe('x.def: 共 3 条建议(错误 1 / 警告 1 / 提示 1)');
  });
});
