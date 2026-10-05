import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import { workspace as stubWorkspace } from './helpers/vscodeStub';
import type * as vscode from 'vscode';

// databaseSchema 分支补测(批69 建,批98 随引擎语义对齐改写):组件类目
// Parent 的 component 臂与查找落空的 null 臂、组件槽 Persistent=false 的
// children 空数组臂(槽不成表)、def 内容法(方法段非空)与脚本存在性法
// (autoMatchCompOwn)并行的域登记、FIXED_DICT 内层 ENTITY_COMPONENT 的
// children 兜底臂、未知旗标的 `|| []` 兜底臂(容忍超集:列保留)、非数值
// DatabaseLength 的 NaN 回落臂。`parentPath ?` 模板串臂、FIXED_DICT
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

  // Muted 的 hasClient=false 声明不压制组件域登记(域登记只看 def 内容与
  // 组件脚本存在性);组件槽 off 带 Persistent=false:children 空数组臂 +
  // 不并入属性/不成表
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

describe('databaseSchema branch gaps (批69/批98)', () => {
  it('resolves a component-category parent chain even when the parent def is missing', () => {
    const snapshot = getDatabaseSchemaSnapshot('SoloP', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    // 组件槽正常成表(实体声明 hasCell → 组件规则不生效),结构列 + 自身属性
    expect(tableNames).toContain('tbl_SoloP_pc');
    expect(snapshot.tables.find(table => table.name === 'tbl_SoloP_pc')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_pcfield']);
    // 组件类目 Parent(GhostComp.def 缺失)只损失父链属性,不致崩
    expect(tableNames).toEqual(['tbl_SoloP', 'tbl_SoloP_pc']);
  });

  it('registers component scopes from def content and keeps all persistent slots', () => {
    const snapshot = getDatabaseSchemaSnapshot('Muted', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    // ClientMethods 非空 → 组件登记 client 域(def 内容法,实体 hasClient
    // 声明不干预);域不再过滤持久列,组件照常成表
    expect(tableNames).toContain('tbl_Muted_m');
    expect(snapshot.tables.find(table => table.name === 'tbl_Muted_m')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_mfield']);
    // Persistent=false 的组件槽:children 走空数组臂且不并入属性,不成表
    expect(tableNames).not.toContain('tbl_Muted_off');
    expect(tableNames).toEqual(['tbl_Muted', 'tbl_Muted_m']);
  });

  it('survives an ENTITY_COMPONENT child inside FIXED_DICT without children', () => {
    const snapshot = getDatabaseSchemaSnapshot('FixedE', root)!;

    // 解析面上的合成类型名:children undefined → 兜底空数组,组件表照建,
    // 落结构列(id + parentID + sm_autoLoad)
    const compTable = snapshot.tables.find(table => table.name === 'tbl_FixedE_comp');
    expect(compTable).toBeDefined();
    expect(compTable!.kind).toBe('component');
    expect(compTable!.fields.map(f => f.name)).toEqual(['id', 'parentID', 'sm_autoLoad']);
  });

  it('falls back on unknown flags and non-numeric DatabaseLength', () => {
    const snapshot = getDatabaseSchemaSnapshot('FixedE', root)!;
    const rootFields = snapshot.tables.find(table => table.name === 'tbl_FixedE')!.fields;

    // 未知旗标 → scopes 兜底空数组;域不再过滤持久列,列按容忍超集保留
    expect(rootFields.map(f => f.name)).toContain('sm_ghosted');
    // 数组子表照常建;DatabaseLength 'abc' → NaN → undefined 回落且被元素列继承
    const arrTable = snapshot.tables.find(table => table.name === 'tbl_FixedE_arr')!;
    expect(arrTable.kind).toBe('array');
    expect(arrTable.fields.map(f => f.name)).toEqual([
      'id', 'parentID', 'sm_autoLoad', 'sm_value'
    ]);
    expect(arrTable.fields.find(f => f.name === 'sm_value')!.databaseLength).toBeUndefined();
  });
});
