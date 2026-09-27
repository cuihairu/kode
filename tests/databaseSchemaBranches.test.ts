import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import { workspace as stubWorkspace } from './helpers/vscodeStub';
import type * as vscode from 'vscode';

// databaseSchema 批69 分支补测:组件槽 Persistent=false 的 children 空数组臂、
// 组件类目 Parent 的 component 臂与查找落空的 null 臂、可用性门控下
// registerScope 的假臂(hasClient=false + ClientMethods)、FIXED_DICT 内层
// ENTITY_COMPONENT 的 children 兜底臂、未知旗标的 `|| []` 兜底臂、以及
// 非数值 DatabaseLength 的 NaN 回落臂。`parentPath ?` 模板串臂、FIXED_DICT
// `children || []` 假臂与数组表名 `|| 'values'` 假臂契约性不可达,已以精确
// 单行区间 ignore 定案,理由见源码注记与 TESTING.md 批69 段。

let root = '';

const writeDef = (relative: string, lines: string[]): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-branch-'));

  writeDef('scripts/entities.xml', [
    '<root>',
    '  <SoloP hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Muted hasBase="true" hasCell="true" hasClient="false"/>',
    '  <FixedE hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>'
  ]);

  // 组件槽 pc 正常持久;组件 def 自身带 component 类目 Parent 指向缺失的
  // GhostComp.def:parentCategory='component' 臂 + 查找落空的 null 臂
  writeDef('scripts/entity_defs/SoloP.def', [
    '<root>',
    '  <Components>',
    '    <pc>',
    '      <Type>CompParent</Type>',
    '    </pc>',
    '  </Components>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CompParent.def', [
    '<root>',
    '  <Parent>',
    '    <GhostComp/>',
    '  </Parent>',
    '  <Properties>',
    '    <pcfield>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </pcfield>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <tick/>',
    '  </BaseMethods>',
    '</root>'
  ]);

  // Muted 的 hasClient=false:组件 ClientMethods 触发 registerScope 假臂;
  // 组件槽 off 带 Persistent=false:children 空数组臂 + 不并入属性/不成表
  writeDef('scripts/entity_defs/Muted.def', [
    '<root>',
    '  <Components>',
    '    <m>',
    '      <Type>MutedComp</Type>',
    '    </m>',
    '    <off>',
    '      <Type>CompOff</Type>',
    '      <Persistent>false</Persistent>',
    '    </off>',
    '  </Components>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/MutedComp.def', [
    '<root>',
    '  <Properties>',
    '    <mfield>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </mfield>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <tick/>',
    '  </BaseMethods>',
    '  <ClientMethods>',
    '    <notify/>',
    '  </ClientMethods>',
    '</root>'
  ]);

  // FIXED_DICT 内层 Type=ENTITY_COMPONENT(模块合成名出现在解析面上,
  // children 保持 undefined)→ 追加层 `|| []` 兜底;ARRAY 的 DatabaseLength
  // 非数值 → NaN 回落 undefined;未知旗标 → FLAG_SCOPE_MAP 兜底空数组
  writeDef('scripts/entity_defs/FixedE.def', [
    '<root>',
    '  <Properties>',
    '    <bag>',
    '      <Type>FIXED_DICT</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '      <Properties>',
    '        <comp>',
    '          <Type>ENTITY_COMPONENT</Type>',
    '        </comp>',
    '      </Properties>',
    '    </bag>',
    '    <arr>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '      <DatabaseLength>abc</DatabaseLength>',
    '    </arr>',
    '    <ghosted>',
    '      <Type>UINT32</Type>',
    '      <Flags>TOTALLY_UNKNOWN</Flags>',
    '      <Persistent>true</Persistent>',
    '    </ghosted>',
    '  </Properties>',
    '</root>'
  ]);

  stubWorkspace.workspaceFolders = [
    { uri: { fsPath: root } as vscode.Uri, name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('databaseSchema branch gaps (批69)', () => {
  it('resolves a component-category parent chain even when the parent def is missing', () => {
    const snapshot = getDatabaseSchemaSnapshot('SoloP', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    // 组件槽正常成表,自身属性照常进组件表
    expect(tableNames).toContain('tbl_SoloP_pc');
    expect(snapshot.tables.find(table => table.name === 'tbl_SoloP_pc')!.fields.map(f => f.name))
      .toContain('sm_pcfield');
    // 组件类目 Parent(GhostComp.def 缺失)只损失父链属性,不致崩
    expect(tableNames).toEqual(['tbl_SoloP', 'tbl_SoloP_pc']);
  });

  it('gates component method scopes by availability and skips non-persistent component slots', () => {
    const snapshot = getDatabaseSchemaSnapshot('Muted', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    // hasClient=false 时 ClientMethods 不注册 client 域,组件照常成表
    expect(tableNames).toContain('tbl_Muted_m');
    expect(snapshot.tables.find(table => table.name === 'tbl_Muted_m')!.fields.map(f => f.name))
      .toContain('sm_mfield');
    // Persistent=false 的组件槽:children 走空数组臂且不并入属性,不成表
    expect(tableNames).not.toContain('tbl_Muted_off');
    expect(tableNames).toEqual(['tbl_Muted', 'tbl_Muted_m']);
  });

  it('survives an ENTITY_COMPONENT child inside FIXED_DICT without children', () => {
    const snapshot = getDatabaseSchemaSnapshot('FixedE', root)!;

    // 解析面上的合成类型名:children undefined → 兜底空数组,组件空表照建
    const compTable = snapshot.tables.find(table => table.name === 'tbl_FixedE_comp');
    expect(compTable).toBeDefined();
    expect(compTable!.kind).toBe('component');
    expect(compTable!.fields).toEqual([]);
  });

  it('falls back on unknown flags and non-numeric DatabaseLength', () => {
    const snapshot = getDatabaseSchemaSnapshot('FixedE', root)!;
    const rootFields = snapshot.tables.find(table => table.name === 'tbl_FixedE')!.fields;

    // 未知旗标 → scopes 兜底空数组 → 属性整体丢弃
    expect(rootFields.map(f => f.name)).not.toContain('sm_ghosted');
    // 数组子表照常建;DatabaseLength 'abc' → NaN → undefined 回落且被元素列继承
    const arrTable = snapshot.tables.find(table => table.name === 'tbl_FixedE_arr')!;
    expect(arrTable.kind).toBe('array');
    expect(arrTable.fields.map(f => f.name)).toEqual(['sm_value']);
    expect(arrTable.fields[0].databaseLength).toBeUndefined();
  });
});
