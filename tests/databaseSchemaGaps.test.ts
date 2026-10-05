import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import { workspace as stubWorkspace } from './helpers/vscodeStub';
import type * as vscode from 'vscode';

// databaseSchema 的守卫与合并缺口(批98 后语义):无工作区/布局解析失败的
// null 早退、父链 def 缺失与坏内容的空属性回落、持久属性不受旗标域/可用性
// 过滤(引擎持久映射无域过滤)、缺 Type 的属性丢弃、父链 identifier 提升、
// CELL_AND_CLIENTS 归一旗标、FIXED_DICT 同名子属性的同列去重、组件规则
// (实体无 cell 内容时无 base 域的组件槽连表跳过)、脚本存在性补域
// (autoMatchCompOwn)。

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
    '  <DirP hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Comp hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Tight hasBase="true"/>',
    '  <Script hasBase="true"/>',
    '  <Inh hasBase="true"/>',
    '  <AliasE hasBase="true" hasCell="true"/>',
    '  <CyE hasBase="true"/>',
    '  <Cel hasBase="true" hasCell="true"/>',
    '</root>'
  ]);

  // 声明 hasCell=false:cellOnly 仍落列(引擎持久映射无域过滤),但不落
  // position/direction 合成列;缺 Type(noType)在收集层跳过
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
    '      <Persistent>true</Persistent>',
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
    '      <Persistent>true</Persistent>',
    '      <Identifier>true</Identifier>',
    '    </id>',
    '  </Properties>',
    '</root>'
  ]);

  // 归一旗标 + FIXED_DICT 同名子属性(FD 子键默认持久,无需显式声明)
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

  // 组件规则:实体无 cell 内容(无声明、无 cell 脚本)时,无 base 域的组件槽
  // (CellOnlyComp 只有 cell 内容)连表跳过;base 域组件槽照常成表
  writeDef('scripts/entity_defs/Tight.def', [
    '<root>',
    '  <Components>',
    '    <x>',
    '      <Type>CellOnlyComp</Type>',
    '    </x>',
    '    <y>',
    '      <Type>BaseComp</Type>',
    '    </y>',
    '  </Components>',
    '  <Properties>',
    '    <only>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </only>',
    '  </Properties>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CellOnlyComp.def', [
    '<root>',
    '  <Properties>',
    '    <xfield>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '      <Persistent>true</Persistent>',
    '    </xfield>',
    '  </Properties>',
    '  <CellMethods>',
    '    <tick/>',
    '  </CellMethods>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/BaseComp.def', [
    '<root>',
    '  <Properties>',
    '    <yfield>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </yfield>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <tick/>',
    '  </BaseMethods>',
    '</root>'
  ]);

  // autoMatchCompOwn 的脚本存在性臂:def 内容为空,但
  // scripts/base/components/KeepComp.py 存在 → 组件槽仍落 base 域
  writeDef('scripts/entity_defs/Script.def', [
    '<root>',
    '  <Components>',
    '    <k>',
    '      <Type>KeepComp</Type>',
    '    </k>',
    '  </Components>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/KeepComp.def', ['<root>', '</root>']);
  writeDef('scripts/base/components/KeepComp.py', ['# script existence only']);

  // autoMatchCompOwn 的两条递归臂:组件自身无方法段时,base 域分别经
  // Parent 组件链(ChainComp 的 BaseMethods)与 Interfaces 混入
  // (IfaceComp 的 BaseMethods)递归获得
  writeDef('scripts/entity_defs/Inh.def', [
    '<root>',
    '  <Components>',
    '    <p>',
    '      <Type>ViaParentComp</Type>',
    '    </p>',
    '    <i>',
    '      <Type>ViaIfaceComp</Type>',
    '    </i>',
    '  </Components>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/ViaParentComp.def', [
    '<root>',
    '  <Parent>',
    '    <ChainComp/>',
    '  </Parent>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/ChainComp.def', [
    '<root>',
    '  <BaseMethods>',
    '    <tick/>',
    '  </BaseMethods>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/ViaIfaceComp.def', [
    '<root>',
    '  <Interfaces>',
    '    <Interface>',
    '      <IfaceComp/>',
    '    </Interface>',
    '  </Interfaces>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/interfaces/IfaceComp.def', [
    '<root>',
    '  <BaseMethods>',
    '    <synced/>',
    '  </BaseMethods>',
    '</root>'
  ]);

  // has* 扫描的接口包装键容忍臂:Iface 包装层不在引擎四拼写内(引擎
  // loadInterfaces 逐条 continue),空 Interface 条目引擎取 getKey(NULL)
  // 为空名(装载失败中止,预览面按容忍超集跳过),GhostIface2 无 def 文件
  // (引擎 openSection 失败中止,预览面跳过)
  writeDef('scripts/entity_defs/components/ViaIfaceComp.def', [
    '<root>',
    '  <Interfaces>',
    '    <Interface>',
    '      <IfaceComp/>',
    '    </Interface>',
    '    <Iface>',
    '      <NotTheWrapper/>',
    '    </Iface>',
    '    <Interface/>',
    '    <Interface>',
    '      <GhostIface2/>',
    '    </Interface>',
    '  </Interfaces>',
    '</root>'
  ]);

  // 组件脚本存在性的 cell 臂:autoMatchCompOwn 的脚本臂同样作用于 cell 侧
  // (CompA 域登记本就有 base 内容,cell 域的登记在 DB 面无输出差异,仅锁
  // 引擎语义:脚本存在即置真)
  writeDef('scripts/cell/components/CompA.py', ['# cell script existence only']);

  // 组件父链互指:has* 扫描的 visitedScopes 环守卫(属性收集的环由共享
  // visitedDefinitions 兜住,这里锁扫描环)
  writeDef('scripts/entity_defs/CyE.def', [
    '<root>',
    '  <Components>',
    '    <x>',
    '      <Type>CyA</Type>',
    '    </x>',
    '  </Components>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CyA.def', [
    '<root>',
    '  <Parent>',
    '    <CyB/>',
    '  </Parent>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CyB.def', [
    '<root>',
    '  <Parent>',
    '    <CyA/>',
    '  </Parent>',
    '</root>'
  ]);

  // types.xml 别名(引擎 DataTypes::loadTypes:指引 = 条目首个文本子节点;
  // FIXED_DICT/ARRAY 条目原地解析结构;别名链复用被指类型的同一实例)
  writeDef('scripts/entity_defs/types.xml', [
    '<root>',
    '  <COIN>UINT16</COIN>',
    '  <CHAIN1>COIN</CHAIN1>',
    '  <SELFLOOP>SELFLOOP</SELFLOOP>',
    '  <NODIR></NODIR>',
    '  <DOLL>',
    '    FIXED_DICT',
    '    <Properties>',
    '      <size>',
    '        <Type>UINT8</Type>',
    '      </size>',
    '      <loot>',
    '        <Type>',
    '          ARRAY',
    '          <of>UINT32</of>',
    '        </Type>',
    '      </loot>',
    '    </Properties>',
    '  </DOLL>',
    '  <STASH>',
    '    ARRAY',
    '    <of>DOLL</of>',
    '  </STASH>',
    '  <BAG>',
    '    ARRAY',
    '    <of>STASH</of>',
    '  </BAG>',
    '  <BADARR>',
    '    ARRAY',
    '  </BADARR>',
    '  <PILE>',
    '    ARRAY',
    '    <of>COIN</of>',
    '  </PILE>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/AliasE.def', [
    '<root>',
    '  <Interfaces>',
    '    <Interface>',
    '      <GhostIface/>',
    '    </Interface>',
    '    <Interface/>',
    '  </Interfaces>',
    '  <Properties>',
    '    <coin>',
    '      <Type>COIN</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </coin>',
    '    <ch>',
    '      <Type>CHAIN1</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </ch>',
    '    <loop>',
    '      <Type>SELFLOOP</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </loop>',
    '    <nope>',
    '      <Type>NODIR</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </nope>',
    '    <doll>',
    '      <Type>DOLL</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </doll>',
    '    <stash>',
    '      <Type>STASH</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </stash>',
    '    <bag>',
    '      <Type>BAG</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </bag>',
    '    <fdarr>',
    '      <Type>FIXED_DICT</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '      <Properties>',
    '        <pouch>',
    '          <Type>STASH</Type>',
    '        </pouch>',
    '        <tag>',
    '          <Type>COIN</Type>',
    '        </tag>',
    '        <doremi>',
    '          <Type>DOLL</Type>',
    '        </doremi>',
    '        <broken>',
    '          <Type>BADARR</Type>',
    '        </broken>',
    '      </Properties>',
    '    </fdarr>',
    '    <deep>',
    '      <Type>',
    '        ARRAY',
    '        <of>ARRAY<of>UINT32</of></of>',
    '      </Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </deep>',
    '    <pile>',
    '      <Type>PILE</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </pile>',
    '  </Properties>',
    '</root>'
  ]);

  // 组件脚本存在性的 cell 臂与 client 域授予:def 内容只有 ClientMethods、
  // 脚本只在 cell 侧 → has.base=false 但 has.cell=true,client 域按
  // (base||cell) 分支落位(引擎 autoMatchCompOwn 按脚本存在性置真)
  writeDef('scripts/entity_defs/Cel.def', [
    '<root>',
    '  <Components>',
    '    <c>',
    '      <Type>CellScriptComp</Type>',
    '    </c>',
    '  </Components>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/components/CellScriptComp.def', [
    '<root>',
    '  <ClientMethods>',
    '    <notify/>',
    '  </ClientMethods>',
    '</root>'
  ]);
  writeDef('scripts/cell/components/CellScriptComp.py', ['# cell script existence only']);

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
  it('keeps every persistent property regardless of flag domain', () => {
    const names = fieldNames('Strict');
    expect(names).toContain('sm_keep');
    // 引擎持久映射不带域过滤:实体声明 hasCell=false 时 cellOnly 照常落列,
    // 只是根表不追加 position/direction 合成列
    expect(names).toContain('sm_cellOnly');
    expect(names).not.toContain('sm_0_position');
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
    // CELL_AND_CLIENTS/CELL_AND_OTHER_CLIENTS 归一到 ALL_CLIENTS/OTHER_CLIENTS
    // 位(域成员 cell+client),持久列照常保留
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

    // 实体声明 hasCell=true:组件规则不生效,def 缺失也建空(结构列)组件表
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_ghost')).toBeDefined();
    // 目录组件(读取抛错)与无 root 组件内容同样落到结构列组件表
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_c')).toBeDefined();
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_d')).toBeDefined();
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_c')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad']);
    expect(snapshot.tables.find(table => table.name === 'tbl_Comp_d')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad']);
    expect(tableNames).toContain('tbl_Comp_a');
  });

  it('drops base-less component tables when the entity has no cell content', () => {
    const snapshot = getDatabaseSchemaSnapshot('Tight', root)!;
    const tableNames = snapshot.tables.map(table => table.name);

    // 实体无 cell 内容(无声明、无 cell 脚本):CellOnlyComp 槽只有 cell 域
    // → 引擎建表循环连表跳过;base 域的 BaseComp 槽照常成表
    expect(tableNames).not.toContain('tbl_Tight_x');
    expect(tableNames).toContain('tbl_Tight_y');
    expect(snapshot.tables.find(table => table.name === 'tbl_Tight_y')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_yfield']);
    // 无 cell 内容:根表不落 position/direction
    expect(fieldNames('Tight')).toEqual(['id', 'sm_autoLoad', 'sm_only']);
  });

  it('infers component base scope from the component script existence', () => {
    const snapshot = getDatabaseSchemaSnapshot('Script', root)!;

    // autoMatchCompOwn 组件臂:def 内容为空,但 scripts/base/components/
    // KeepComp.py 存在 → 槽落 base 域,实体无 cell 内容也保留组件表
    const keepTable = snapshot.tables.find(table => table.name === 'tbl_Script_k');
    expect(keepTable).toBeDefined();
    expect(keepTable!.fields.map(f => f.name)).toEqual(['id', 'parentID', 'sm_autoLoad']);
  });

  it('infers component domains through parent chain and interface mixin', () => {
    const snapshot = getDatabaseSchemaSnapshot('Inh', root)!;

    // ViaParentComp 自身无方法段:base 域经 Parent 组件链(ChainComp 的
    // BaseMethods)递归获得 → 实体无 cell 内容时表仍保留
    const parentTable = snapshot.tables.find(table => table.name === 'tbl_Inh_p');
    expect(parentTable).toBeDefined();
    expect(parentTable!.fields.map(f => f.name)).toEqual(['id', 'parentID', 'sm_autoLoad']);

    // ViaIfaceComp 自身无方法段:base 域经 Interfaces 包装键(IfaceComp 的
    // BaseMethods)递归获得 → 表保留
    const ifaceTable = snapshot.tables.find(table => table.name === 'tbl_Inh_i');
    expect(ifaceTable).toBeDefined();
    expect(ifaceTable!.fields.map(f => f.name)).toEqual(['id', 'parentID', 'sm_autoLoad']);

    expect(snapshot.tables.map(table => table.name)).toEqual([
      'tbl_Inh', 'tbl_Inh_p', 'tbl_Inh_i'
    ]);
    // Inh 的域登记同时走过 has* 扫描的容忍臂:Iface 包装层(非引擎四拼写)、
    // 空 Interface 条目与无 def 的 GhostIface2(引擎逐条 continue 或中止,
    // 预览面按容忍超集跳过),不影响 ViaIfaceComp 的 base 域结论
  });

  it('grants the client scope when a cell-side script exists without base content', () => {
    const snapshot = getDatabaseSchemaSnapshot('Cel', root)!;

    // CellScriptComp:def 内容只有 ClientMethods,脚本仅在 cell 侧 → 域登记
    // {cell, client};实体声明 hasCell → 组件规则不生效,组件表照建
    expect(snapshot.tables.map(table => table.name)).toEqual(['tbl_Cel', 'tbl_Cel_c']);
    expect(snapshot.tables.find(table => table.name === 'tbl_Cel_c')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad']);
  });

  it('terminates on cyclic component parent chains and drops the slot', () => {
    const snapshot = getDatabaseSchemaSnapshot('CyE', root)!;

    // CyA→CyB→CyA:has* 扫描经 visitedScopes 环守卫终止,两组件均无内容
    // → 无 base 域;实体无 cell 内容 → 规则生效,槽连表跳过
    expect(snapshot.tables.map(table => table.name)).toEqual(['tbl_CyE']);
    expect(snapshot.tables[0].fields.map(f => f.name)).toEqual(['id', 'sm_autoLoad']);
  });

  it('resolves alias chains, structures and cycles into engine column/table names', () => {
    const snapshot = getDatabaseSchemaSnapshot('AliasE', root)!;

    expect(snapshot.tables.map(table => table.name)).toEqual([
      'tbl_AliasE',
      'tbl_AliasE_doll_loot',
      'tbl_AliasE_stash',
      'tbl_AliasE_stash_loot',
      'tbl_AliasE_bag',
      'tbl_AliasE_bag_value',
      'tbl_AliasE_bag_value_loot',
      'tbl_AliasE_fdarr_pouch',
      'tbl_AliasE_fdarr_pouch_loot',
      'tbl_AliasE_fdarr_doremi_loot',
      'tbl_AliasE_fdarr_broken',
      'tbl_AliasE_deep',
      'tbl_AliasE_deep_value',
      'tbl_AliasE_pile'
    ]);

    const rootFields = snapshot.tables[0].fields.map(f => f.name);
    // COIN→UINT16 与 CHAIN1→COIN→UINT16:别名按同实例归一到 UINT16
    expect(rootFields).toContain('sm_coin');
    expect(rootFields).toContain('sm_ch');
    // SELFLOOP 自指环解析为 unresolved,容忍超集按原名保留列;NODIR 空指引同
    expect(rootFields).toContain('sm_loop');
    expect(rootFields).toContain('sm_nope');
    // 别名 FIXED_DICT 平铺键前缀列与别名 builtin 子键列
    expect(rootFields).toContain('sm_doll_size');
    expect(rootFields).toContain('sm_fdarr_tag');
    expect(rootFields).toContain('sm_fdarr_doremi_size');

    // 别名数组元素为 FIXED_DICT:Properties 取自 types.xml 条目(引擎同一
    // 实例),元素项名为空串,列不带 value_ 前缀
    expect(snapshot.tables.find(t => t.name === 'tbl_AliasE_stash')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_size']);
    // FD 元素的空名段被子表命名链跳过(loot 直接接容器表名)
    expect(snapshot.tables.find(t => t.name === 'tbl_AliasE_stash_loot')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_value']);
    // 别名数组嵌别名数组:bag → bag_value(数组元素 value)→ bag_value_loot
    expect(snapshot.tables.find(t => t.name === 'tbl_AliasE_bag_value')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_size']);
    // 无 <of> 的别名数组:元素缺省,子表只剩结构列
    expect(snapshot.tables.find(t => t.name === 'tbl_AliasE_fdarr_broken')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad']);
    // 引擎嵌套数组语法(<of>ARRAY<of>UINT32</of></of>):双层子表,内层元素列
    expect(snapshot.tables.find(t => t.name === 'tbl_AliasE_deep')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad']);
    expect(snapshot.tables.find(t => t.name === 'tbl_AliasE_deep_value')!.fields.map(f => f.name))
      .toEqual(['id', 'parentID', 'sm_autoLoad', 'sm_value']);
    // 别名数组元素为别名 builtin(COIN→UINT16):元素列按内建实例落
    // smallint unsigned
    const pileValue = snapshot.tables.find(t => t.name === 'tbl_AliasE_pile')!.fields
      .find(f => f.name === 'sm_value')!;
    expect(pileValue.typeLabel).toBe('smallint unsigned');
    // 接口包装键容忍臂(无 def 的 GhostIface 与空 Interface):不影响建表
    expect(snapshot.tables[0].source.filePath.endsWith('AliasE.def')).toBe(true);
  });

  it('tolerates unreadable or rootless types.xml', () => {
    const build = (typesXmlLines: string[] | null): string => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-alias-'));
      const defDir = path.join(ws, 'scripts', 'entity_defs');
      fs.mkdirSync(defDir, { recursive: true });
      fs.writeFileSync(path.join(defDir, 'Solo.def'), [
        '<root>',
        '  <Properties>',
        '    <hp>',
        '      <Type>UINT32</Type>',
        '      <Flags>BASE</Flags>',
        '      <Persistent>true</Persistent>',
        '    </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(ws, 'scripts', 'entities.xml'), '<root>\n  <Solo/>\n</root>\n', 'utf8');
      if (typesXmlLines === null) {
        // types.xml 是目录:find 命中但读取抛 EISDIR
        fs.mkdirSync(path.join(defDir, 'types.xml'));
      } else {
        fs.writeFileSync(path.join(defDir, 'types.xml'), typesXmlLines.join('\n'), 'utf8');
      }
      return ws;
    };

    const dirWs = build(null);
    try {
      const snapshot = getDatabaseSchemaSnapshot('Solo', dirWs)!;
      expect(snapshot.tables[0].fields.map(f => f.name)).toEqual(['id', 'sm_autoLoad', 'sm_hp']);
    } finally {
      fs.rmSync(dirWs, { recursive: true, force: true });
    }

    const rootlessWs = build(['plain text, no xml elements']);
    try {
      const snapshot = getDatabaseSchemaSnapshot('Solo', rootlessWs)!;
      expect(snapshot.tables[0].fields.map(f => f.name)).toEqual(['id', 'sm_autoLoad', 'sm_hp']);
    } finally {
      fs.rmSync(rootlessWs, { recursive: true, force: true });
    }
  });
});
