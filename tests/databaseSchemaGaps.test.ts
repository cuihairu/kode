import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import { workspace as stubWorkspace } from './helpers/vscodeStub';
import type * as vscode from 'vscode';

// databaseSchema 的守卫与合并缺口:无工作区/布局解析失败的 null 早退、
// 父链 def 缺失与坏内容的空属性回落、scope 全被可用性拒绝或缺 Type 的
// 属性丢弃、父链 identifier 提升、CELL_AND_CLIENTS 归一旗标、FIXED_DICT
// 同名子属性的同列去重、组件 def 缺失/无方法段/ClientMethods 注册。

let root = '';

const writeDef = (relative: string, lines: string[]): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-gap-'));

  writeDef('scripts/entities.xml', [
    '<root>',
    '  <Strict hasBase="true" hasCell="false" hasClient="false"/>',
    '  <Merge hasBase="true" hasCell="true" hasClient="false"/>',
    '  <Norm hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Lost hasBase="true" hasCell="true" hasClient="true"/>',
    '  <BadP hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Comp hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>'
  ]);

  // scope 全被可用性拒绝(cellOnly)+ 缺 Type(noType)
  writeDef('scripts/entity_defs/Strict.def', [
    '<root>',
    '  <Properties>',
    '    <keep>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </keep>',
    '    <cellOnly>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '      <Persistent>true</Persistent>',
    '    </cellOnly>',
    '    <noType>',
    '      <Flags>BASE</Flags>',
    '    </noType>',
    '  </Properties>',
    '</root>'
  ]);

  // 父链 identifier 提升:父带 Identifier,自身同名属性不带
  writeDef('scripts/entity_defs/Merge.def', [
    '<root>',
    '  <Parent>',
    '    <MergeP/>',
    '  </Parent>',
    '  <Properties>',
    '    <id>',
    '      <Type>UINT8</Type>',
    '      <Flags>BASE</Flags>',
    '    </id>',
    '  </Properties>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/MergeP.def', [
    '<root>',
    '  <Properties>',
    '    <id>',
    '      <Type>UINT8</Type>',
    '      <Flags>BASE</Flags>',
    '      <Identifier>true</Identifier>',
    '    </id>',
    '  </Properties>',
    '</root>'
  ]);

  // 归一旗标 + FIXED_DICT 同名子属性
  writeDef('scripts/entity_defs/Norm.def', [
    '<root>',
    '  <Properties>',
    '    <cc1>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_AND_CLIENTS</Flags>',
    '      <Persistent>true</Persistent>',
    '    </cc1>',
    '    <cc2>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_AND_OTHER_CLIENTS</Flags>',
    '      <Persistent>true</Persistent>',
    '    </cc2>',
    '    <dup>',
    '      <Type>FIXED_DICT</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '      <Properties>',
    '        <x>',
    '          <Type>UINT8</Type>',
    '        </x>',
    '        <x>',
    '          <Type>UINT16</Type>',
    '        </x>',
    '        <noTypeX/>',
    '        <nope>',
    '          <Type>UINT8</Type>',
    '          <Persistent>false</Persistent>',
    '        </nope>',
    '      </Properties>',
    '    </dup>',
    '  </Properties>',
    '</root>'
  ]);

  // 父 def 缺失:读取 catch → 空属性回落
  writeDef('scripts/entity_defs/Lost.def', [

    '<root>',
    '  <Parent>',
    '    <NoSuchParent/>',
    '  </Parent>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ]);

  // 父 def 无 root:root 缺失 → 空属性回落
  writeDef('scripts/entity_defs/BadP.def', [
    '<root>',
    '  <Parent>',
    '    <BadParent/>',
    '  </Parent>',
    '  <Properties>',
    '    <ok>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </ok>',
    '  </Properties>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/BadParent.def', ['not xml at all']);

  // 父 def 是目录:find 命中但读取抛 EISDIR → readTextDocument catch
  writeDef('scripts/entity_defs/DirP.def', [
    '<root>',
    '  <Parent>',
    '    <DirParent/>',
    '  </Parent>',
    '  <Properties>',
    '    <ok>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </ok>',
    '  </Properties>',
    '</root>'
  ]);
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'DirParent.def'), { recursive: true });

  // 组件:CompA 无 Cell/Client 方法段;CompB 带 ClientMethods;
  // ghost 缺 def;CompC 是目录(读取抛错);CompD 内容无 root
  writeDef('scripts/entity_defs/Comp.def', [
    '<root>',
    '  <Components>',
    '    <a>',
    '      <Type>CompA</Type>',
    '    </a>',
    '    <b>',
    '      <Type>CompB</Type>',
    '    </b>',
    '    <ghost>',
    '      <Type>MissingComp</Type>',
    '    </ghost>',
    '    <c>',
    '      <Type>CompC</Type>',
    '    </c>',
    '    <d>',
    '      <Type>CompD</Type>',
    '    </d>',
    '  </Components>',
    '  <Properties>',
    '    <base>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </base>',
    '  </Properties>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CompD.def', ['not xml']);
  // CompC.def 是目录:find 命中但读取抛 EISDIR
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'components', 'CompC.def'), { recursive: true });
  // 实体 def 是目录:snapshot 入口的实体内容读取 catch
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'EReadFail.def'), { recursive: true });
  writeDef('scripts/entity_defs/components/CompA.def', [
    '<root>',
    '  <Properties>',
    '    <afield>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </afield>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <tick/>',
    '  </BaseMethods>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CompB.def', [
    '<root>',
    '  <Properties>',
    '    <bfield>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '      <Persistent>true</Persistent>',
    '    </bfield>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <run/>',
    '  </BaseMethods>',
    '  <ClientMethods>',
    '    <notify/>',
    '  </ClientMethods>',
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

const fieldNames = (entity: string): string[] => {
  const snapshot = getDatabaseSchemaSnapshot(entity, root)!;
  const rootTable = snapshot.tables.find(table => table.name === `tbl_${entity}`);
  return rootTable ? rootTable.fields.map(field => field.name) : [];
};

describe('snapshot guards', () => {
  it('returns null without a workspace folder', () => {
    stubWorkspace.workspaceFolders = [];
    try {
      expect(getDatabaseSchemaSnapshot('Strict')).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = [
        { uri: { fsPath: root } as vscode.Uri, name: 'ws', index: 0 }
      ];
    }
  });

  it('returns null when the entity def cannot be read', () => {
    // EReadFail.def 是目录:find 命中(existsSync)但 readFileSync 抛 EISDIR
    expect(getDatabaseSchemaSnapshot('EReadFail', root)).toBeNull();
  });

  it('returns null when the workspace has no entity_defs directory', () => {
    const missing = path.join(root, 'gone');
    expect(getDatabaseSchemaSnapshot('Strict', missing)).toBeNull();
  });
});

describe('property collection guards', () => {
  it('drops properties whose scopes are fully rejected by availability', () => {
    const names = fieldNames('Strict');
    expect(names).toContain('sm_keep');
    // hasCell=false:CELL_PUBLIC 的 scopes 为空 → 属性整体丢弃
    expect(names).not.toContain('sm_cellOnly');
    // 无 Type 子元素 → 收集层跳过
    expect(names).not.toContain('sm_noType');
  });

  it('promotes identifier from the parent chain property', () => {
    const snapshot = getDatabaseSchemaSnapshot('Merge', root)!;
    const id = snapshot.tables
      .find(table => table.name === 'tbl_Merge')!
      .fields.find(field => field.name === 'sm_id')!;
    // 自身不带 Identifier,父链同名属性带 → 合并时提升
    expect(id.identifier).toBe(true);
  });

  it('normalizes CELL_AND_CLIENTS family flags into usable scopes', () => {
    const names = fieldNames('Norm');
    expect(names).toContain('sm_cc1');
    expect(names).toContain('sm_cc2');
  });

  it('deduplicates same-named FIXED_DICT child columns', () => {
    const names = fieldNames('Norm');
    // 两条同名 x:第二列命中同列去重 continue
    expect(names.filter(name => name === 'sm_dup_x')).toHaveLength(1);
    // 无 Type 子属性与 Persistent false 子属性在 children 层被跳过
    expect(names).not.toContain('sm_dup_noTypeX');
    expect(names).not.toContain('sm_dup_nope');
  });

  it('falls back to empty properties when the parent def is missing', () => {
    const snapshot = getDatabaseSchemaSnapshot('Lost', root)!;
    const names = fieldNames('Lost');
    expect(names).toContain('sm_hp');
    // 父 def 缺失只损失父链属性,实体自身照常成表
    expect(snapshot.tables.map(table => table.name)).toContain('tbl_Lost');
  });

  it('falls back to empty properties when the parent def has no root', () => {
    const names = fieldNames('BadP');
    expect(names).toContain('sm_ok');
  });

  it('falls back to empty properties when the parent def cannot be read', () => {
    const names = fieldNames('DirP');
    expect(names).toContain('sm_ok');
  });
});

describe('component definition guards', () => {
  it('registers only the method sections the component defines', () => {
    const snapshot = getDatabaseSchemaSnapshot('Comp', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    expect(tableNames).toContain('tbl_Comp_a');
    expect(tableNames).toContain('tbl_Comp_b');

    const tableA = snapshot.tables.find(table => table.name === 'tbl_Comp_a')!;
    expect(tableA.fields.map(field => field.name)).toContain('sm_afield');
  });

  it('keeps an empty component table for a missing component def', () => {
    const snapshot = getDatabaseSchemaSnapshot('Comp', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    // 组件 def 缺失也建空组件表(组件槽去重之外的守卫路径)
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_ghost')).toBeDefined();
    // 目录组件(读取抛错)与无 root 组件内容同样落到空组件表
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_c')).toBeDefined();
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_d')).toBeDefined();
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_c')!.fields).toEqual([]);
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_d')!.fields).toEqual([]);
    expect(tableNames).toContain('tbl_Comp_a');
  });
});
