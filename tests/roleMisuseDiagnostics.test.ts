// IDE-LINT-009 验收:已确认角色的引擎内建属性错用 lint(KBE-PY-008 诊断面)。
// 纯逻辑层单测——角色面经 resolveEntityComponentFaceFromPath(目录域)+def
// 归属(与内建属性 hover/inlay 同一底座),属性面表复用 getEntityBuiltin
// PropertiesForFace(与 hover 元数据同源)。
//
// 验收断言(逐条对应 todo.md:721):
//   - 按源码 baseapp/cellapp/client 分面判断:当前面无该内建属性但注册于
//     其他面 → 报 Warning(引注册面取证);
//   - 角色不明(pathFace null + defFaces 空/多面歧义)和普通 Python 类
//     (无 def 归属)不猜;
//   - hover 元数据与 lint 共用来源(同张属性表,测试断言 source 一致)。
// 反例(不得误报):当前面合法属性、非内建字段、注释/字符串内容、
// 多段访问(self.cell.position 是 EntityCall 成员面,由 receiver/段错配负责)。

import { describe, expect, it } from 'vitest';
import {
  findRoleMisuseFindings,
  roleMisuseDiagnosticItemsAsync,
  ROLE_MISUSE_DIAGNOSTIC_CODE
} from '../src/roleMisuseDiagnostics';
import { getEntityBuiltinPropertiesForFace } from '../src/entityBuiltinProperties';
import type { EntityComponentFace } from '../src/entityBuiltinProperties';

const find = (
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null = null
) => findRoleMisuseFindings(text, pathFace, defFaces);

describe('IDE-LINT-009 引擎内建属性角色错用 lint(纯逻辑)', () => {
  it('base 面访问 cell 专属 position 报告(注册面=cellapp/client 取证)', () => {
    const findings = find('self.position = (1, 2, 3)\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('position');
    expect(findings[0].currentFace).toBe('baseapp');
    expect(findings[0].registeredFaces).toEqual(['cellapp', 'client']);
    expect(findings[0].source).toBe('server/cellapp/entity.cpp:83');
    expect(findings[0].line).toBe(0);
    expect(findings[0].character).toBe(0);
    expect(findings[0].length).toBe('self.position'.length);
    expect(findings[0].message).toContain('role misuse');
    expect(findings[0].message).toContain('cellapp/client');
  });

  it('base 面访问 client 专属 velocity 报告', () => {
    const findings = find('print(self.velocity)\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('velocity');
    expect(findings[0].registeredFaces).toEqual(['client']);
    expect(findings[0].source).toBe('lib/client_lib/entity.cpp:46');
  });

  it('base 面访问 cell 专属 allClients 报告(非客户端向多客户端广播)', () => {
    // 单段访问才参与(多段 self.allClients.onMove 是 EntityCall 成员面,不报)
    const findings = find('self.allClients\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('allClients');
    expect(findings[0].registeredFaces).toEqual(['cellapp']);
  });

  it('cell 面访问 base 专属 databaseID 报告', () => {
    const findings = find('x = self.databaseID\n', 'cellapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('databaseID');
    expect(findings[0].registeredFaces).toEqual(['baseapp']);
    expect(findings[0].source).toBe('server/baseapp/entity.cpp:38');
  });

  it('cell 面访问 client 专属 velocity 报告', () => {
    const findings = find('self.velocity = 1.0\n', 'cellapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('velocity');
    expect(findings[0].registeredFaces).toEqual(['client']);
  });

  it('client 面访问 cell 专属 layer 报告', () => {
    const findings = find('print(self.layer)\n', 'client');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('layer');
    expect(findings[0].registeredFaces).toEqual(['cellapp']);
    expect(findings[0].source).toBe('server/cellapp/entity.cpp:82');
  });

  it('当前面合法属性不报(self.client 于 base / self.base 于 cell)', () => {
    expect(find('self.client.cell.call()\n', 'baseapp')).toHaveLength(0);
    expect(find('self.base.cell.call()\n', 'cellapp')).toHaveLength(0);
  });

  it('client 面合法属性不报(position/velocity/clientapp/self.cell)', () => {
    expect(find('self.position = (1, 2, 3)\nself.velocity = 1.0\n', 'client')).toHaveLength(0);
    expect(find('self.clientapp\nself.cell.call()\n', 'client')).toHaveLength(0);
  });

  it('宏公共三项各面都注册 → 永不报', () => {
    expect(find('self.id\nself.isDestroyed\nself.className\n', 'baseapp')).toHaveLength(0);
    expect(find('self.id\nself.className\n', 'cellapp')).toHaveLength(0);
    expect(find('self.id\nself.isDestroyed\nself.className\n', 'client')).toHaveLength(0);
  });

  it('非内建字段不报(落回 def/普通符号)', () => {
    const findings = find('self.customProp = 1\nself.hp = 100\n', 'baseapp');
    expect(findings).toHaveLength(0);
  });

  it('普通 Python 类(无 def 归属)不猜', () => {
    expect(find('self.position = (1, 2, 3)\n', null, null)).toHaveLength(0);
  });

  it('角色不明(pathFace null 且 defFaces 空)不猜', () => {
    expect(find('self.velocity = 1.0\n', null, [])).toHaveLength(0);
  });

  it('多面歧义 defFaces 不猜', () => {
    expect(find('self.velocity = 1.0\n', null, ['baseapp', 'cellapp'])).toHaveLength(0);
  });

  it('def 归属唯一面生效(无目录域,cellapp 面)', () => {
    const findings = find('print(self.databaseID)\n', null, ['cellapp']);
    expect(findings).toHaveLength(1);
    expect(findings[0].currentFace).toBe('cellapp');
    expect(findings[0].propertyName).toBe('databaseID');
  });

  it('注释/字符串内的 self.<prop> 不报(掩码)', () => {
    // layer 是 cellapp 专属(baseapp 无),仅真实访问应报
    const text = '# self.layer\ns = "self.layer"\nprint(self.layer)  # self.layer\n';
    const findings = find(text, 'baseapp');
    // 只有第 3 行真实访问 self.layer 报,其余在注释/字符串被掩码
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('layer');
    expect(findings[0].line).toBe(2);
  });

  it('多段访问 self.cell.position 不参与(EntityCall 成员面)', () => {
    expect(find('self.cell.position\n', 'baseapp')).toHaveLength(0);
  });

  it('一行多处错用各自成条', () => {
    const findings = find('self.velocity = self.layer\n', 'baseapp');
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.propertyName)).toEqual(['velocity', 'layer']);
  });

  it('hover 元数据与 lint 共用来源(同张属性表断言 source 一致)', () => {
    // lint 报的 source 必须与 hover 属性表取到的完全一致
    const table = getEntityBuiltinPropertiesForFace('client')
      .find(p => p.name === 'velocity')!.source;
    const findings = find('self.velocity\n', 'cellapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe(table);
  });

  it('异步入口:enabled=false 零产出', async () => {
    const items = await roleMisuseDiagnosticItemsAsync(
      'self.velocity = 1.0\n',
      '/proj/scripts/base/foo.py',
      async () => null,
      false
    );
    expect(items).toHaveLength(0);
  });

  it('异步入口:目录域定面产出诊断项(code/severity/range)', async () => {
    const items = await roleMisuseDiagnosticItemsAsync(
      'self.velocity = 1.0\n',
      '/proj/scripts/base/foo.py',
      async () => null,
      true
    );
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(ROLE_MISUSE_DIAGNOSTIC_CODE);
    expect(items[0].severity).toBe('Warning');
    expect(items[0].source).toBe('kbengine');
    expect(items[0].range.start).toEqual({ line: 0, character: 0 });
    expect(items[0].range.end).toEqual({ line: 0, character: 'self.velocity'.length });
    expect(items[0].message).toContain('velocity');
  });

  it('异步入口:无目录域时经 fetchDefFaces 取 def 归属面', async () => {
    const fetch = async () => ['cellapp'] as EntityComponentFace[];
    const items = await roleMisuseDiagnosticItemsAsync(
      'print(self.databaseID)\n',
      '/proj/scripts/avatar.py',
      fetch,
      true
    );
    expect(items).toHaveLength(1);
    expect(items[0].message).toContain('cellapp');
  });

  it('异步入口:fetchDefFaces 失败兜底非实体零产出', async () => {
    const items = await roleMisuseDiagnosticItemsAsync(
      'self.velocity = 1.0\n',
      '/proj/scripts/avatar.py',
      async () => { throw new Error('boom'); },
      true
    );
    expect(items).toHaveLength(0);
  });

  it('异步入口:def 归属为空(非实体脚本)零产出', async () => {
    const items = await roleMisuseDiagnosticItemsAsync(
      'self.velocity = 1.0\n',
      '/proj/scripts/avatar.py',
      async () => null,
      true
    );
    expect(items).toHaveLength(0);
  });
});
