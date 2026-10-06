import { describe, expect, it } from 'vitest';
import {
  analyzeDefDocument,
  formatDefAnalysisReport,
  type DefAnalysisFinding
} from '../src/defAnalyzer';

// defAnalyzer 纯逻辑测试(批91:性能分析建议)。检查项定案见
// COMPLETED_FEATURES「性能分析建议」条目:幻影类型 / 缺类型 / 重复 Type /
// 大字段全体广播 / DetailLevel 冗余 / 非法 Python 名 / 方法属性同名冲突。
// 批96 引擎复核锁:客户端可见旗标取 common.h ENTITY_CLIENT_DATA_FLAGS 真值
// (ALL_CLIENTS/CELL_PUBLIC_AND_OWN/OWN_CLIENT/BASE_AND_CLIENT/OTHER_CLIENTS;
// 引擎无 ANY_CLIENT,CELL_PUBLIC 是纯 cell 广播位),关键字的口径改为
// 「引擎不失败、脚本不可访问」,方法属性同名与缺 Type 按「装载失败」表述。

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
    // 引擎 loadDefPropertys 找不到 Type 直接报错返回——按装载失败表述
    expect(hit.message).toContain('实体加载会失败');
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
    // 引擎 enterNode 只取首个匹配——按首取语义表述,不再宣称"取值歧义"
    expect(hit.message).toContain('只装载首个');
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

  it('ALL_CLIENTS + 标量小类型不报;非全体广播旗标不报', () => {
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

  it('客户端可见旗标集取引擎真值:OWN_CLIENT/BASE_AND_CLIENT/CELL_PUBLIC_AND_OWN 下 DetailLevel 不冗余', () => {
    // common.h L45 ENTITY_CLIENT_DATA_FLAGS 位集展开;旧名单缺这三项时会把
    // 有意义的 DetailLevel 误报为冗余(假阳性),此处负向锁
    for (const flag of ['OWN_CLIENT', 'BASE_AND_CLIENT', 'CELL_PUBLIC_AND_OWN']) {
      const findings = analyzeDefDocument(
        def(
          property(
            'pos',
            `      <Type>VECTOR3</Type>\n      <Flags>${flag}</Flags>\n      <DetailLevel>NEAR</DetailLevel>`
          )
        )
      );
      expect(checksOf(findings), flag).not.toContain('redundant-detail-level');
    }
  });

  it('CELL_PUBLIC 不携带客户端位:配 DetailLevel 报冗余;引擎无 ANY_CLIENT 旗标', () => {
    // CELL_PUBLIC = 0x1,不在 ENTITY_CLIENT_DATA_FLAGS——旧名单把它当客户端
    // 可见会漏报(假阴性);ANY_CLIENT 是引擎旗标注册表(common.cpp 8 个名单)
    // 里不存在的名字,不得出现在客户端可见集合中
    const cellPublic = analyzeDefDocument(
      def(
        property(
          'tick',
          '      <Type>UINT32</Type>\n      <Flags>CELL_PUBLIC</Flags>\n      <DetailLevel>FAR</DetailLevel>'
        )
      )
    );
    expect(checksOf(cellPublic)).toContain('redundant-detail-level');

    const anyClient = analyzeDefDocument(
      def(
        property(
          'pos',
          '      <Type>VECTOR3</Type>\n      <Flags>ANY_CLIENT</Flags>\n      <DetailLevel>FAR</DetailLevel>'
        )
      )
    );
    expect(checksOf(anyClient)).toContain('redundant-detail-level');
  });
});

describe('命名检查(非法标识符 / 关键字 / 方法属性冲突)', () => {
  it('Python 关键字属性名报 error', () => {
    const findings = analyzeDefDocument(def(property('class', '      <Type>UINT8</Type>')));
    const hit = firstOf(findings, 'invalid-identifier');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('class');
    expect(hit.message).toContain('Python 关键字');
    // 引擎 C 层 setattr 挂关键字名不报错——不得宣称"实体类无法生成该成员"
    expect(hit.message).toContain('装载不失败');
    expect(hit.message).not.toContain('无法生成');
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
    // 引擎装载时按名冲突直接拒绝——不得宣称"Python 类中互相覆盖"
    expect(hit.message).toContain('实体加载会失败');
    expect(hit.message).not.toContain('互相覆盖');
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

describe('引擎受限名检查(engine-limited-name)', () => {
  it('属性命中受限名单报 error 并定位到标签名', () => {
    const findings = analyzeDefDocument(
      def(property('position', '      <Type>VECTOR3</Type>'))
    );
    const hit = firstOf(findings, 'engine-limited-name');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('position');
    expect(hit.message).toContain('ENTITY_LIMITED_PROPERTYS');
    expect(hit.message).toContain('实体加载会失败');
    expect(hit.line).toBe(3); // 属性标签行(1 基)
    expect(hit.length).toBe('position'.length);
  });

  it('方法名同样受受限名单约束', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <BaseMethods>',
          '    <id>',
          '      <Arg>UINT8</Arg>',
          '    </id>',
          '  </BaseMethods>'
        ].join('\n')
      )
    );
    const hit = firstOf(findings, 'engine-limited-name');
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('id');
    expect(hit.message).toContain('方法 id');
  });

  it('Components 槽名命中受限名单同样报错(loadComponents 拒绝)', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Components>',
          '    <position>',
          '      <Type>HealthComp</Type>',
          '    </position>',
          '    <movement>',
          '      <Type>MovementComp</Type>',
          '    </movement>',
          '  </Components>'
        ].join('\n')
      )
    );
    // 普通槽名(非受限名)不报,只命中受限的那一个
    const limited = findings.filter(item => item.check === 'engine-limited-name');
    expect(limited.map(item => item.name)).toEqual(['position']);
    const hit = limited[0];
    expect(hit.message).toContain('组件 position');
  });

  it('引擎清单的 C 字面拼接怪癖按编译后真值收录:component/databaseID 不被拒,拼接名被拒', () => {
    // 引擎源清单 "component" 行尾缺逗号、与 "databaseID" 拼成单个条目
    // "componentdatabaseID"(entitydef/common.h L138-139)——两个名字
    // 单独不在 validDefPropertyName 拒绝名单
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <component>',
          '      <Type>UINT32</Type>',
          '    </component>',
          '    <databaseID>',
          '      <Type>UINT64</Type>',
          '    </databaseID>',
          '    <componentdatabaseID>',
          '      <Type>UINT32</Type>',
          '    </componentdatabaseID>',
          '  </Properties>'
        ].join('\n')
      )
    );
    const limited = findings.filter(item => item.check === 'engine-limited-name');
    expect(limited.map(item => item.name)).toEqual(['componentdatabaseID']);
  });

  it('"interface" 与终止哨兵拼接后仍在名单内', () => {
    const findings = analyzeDefDocument(
      def(property('interface', '      <Type>UINT32</Type>'))
    );
    expect(firstOf(findings, 'engine-limited-name').name).toBe('interface');
  });

  it('FIXED_DICT 子键不受限(engine DC_TYPE_FIXED_ITEM 分支明写放开)', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <meta>',
          '      <Type>FIXED_DICT</Type>',
          '      <Properties>',
          '        <id>',
          '          <Type>UINT32</Type>',
          '        </id>',
          '      </Properties>',
          '    </meta>',
          '  </Properties>'
        ].join('\n')
      )
    );
    expect(checksOf(findings)).not.toContain('engine-limited-name');
  });

  it('普通属性与方法不受影响(负向锁)', () => {
    const findings = analyzeDefDocument(
      def(
        [
          '  <Properties>',
          '    <hp>',
          '      <Type>UINT8</Type>',
          '    </hp>',
          '  </Properties>',
          '  <BaseMethods>',
          '    <onTick>',
          '      <Arg>UINT8</Arg>',
          '    </onTick>',
          '  </BaseMethods>'
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
