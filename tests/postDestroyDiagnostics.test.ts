// IDE-LINT-010 验收:Entity 销毁后访问 lint(KBE-PY-010)。纯逻辑层单测——
// 同函数可确定的 `self.destroy()` 后直接访问 `self.<成员>` 报 Warning;
// 跨回调/异常/动态分派/跨块/条件销毁不报(不冒充已实现)。
//
// 验收断言(逐条对应 todo.md:722):
//   - 从 getter 的 destroyed 行为核验(引擎 entity_macro.h:20 destroy 宏公共,
//     pyGetCellEntityCall 等检查 destroyed);
//   - 先覆盖同函数可确定的 destroy 后直接访问;
//   - 跨回调/异常/动态分派标未分析,不能全文件误报。
// 反例(不得误报):访问在销毁前、条件销毁(if 内)、不同块(嵌套/祖先块)、
// 同层早退后死码、安全成员(id/isDestroyed/className/destroy)、非实体脚本、
// 角色不明、def 声明 destroy(动态分派)。

import { describe, expect, it } from 'vitest';
import {
  findPostDestroyFindings,
  postDestroyDiagnosticItemsAsync,
  POST_DESTROY_DIAGNOSTIC_CODE
} from '../src/postDestroyDiagnostics';
import type { EntityComponentFace } from '../src/entityBuiltinProperties';

const find = (
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null = null,
  isDestroyDeclared = false
) => findPostDestroyFindings(text, pathFace, defFaces, isDestroyDeclared);

describe('IDE-LINT-010 Entity 销毁后访问 lint(纯逻辑)', () => {
  it('同函数同块 destroy 后访问 self.cell 报告', () => {
    const findings = find(
      'class Avatar:\n  def onRequest(self):\n    self.destroy()\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('cell');
    expect(findings[0].line).toBe(3);
    expect(findings[0].character).toBe(4);
    expect(findings[0].length).toBe('self.cell'.length);
    expect(findings[0].destroyLine).toBe(2);
    expect(findings[0].message).toContain('destroy');
  });

  it('销毁后访问自定义属性 self.hp 也报告(实体已失效)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    print(self.hp)\n',
      'cellapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('hp');
  });

  it('赋值调用 x = self.destroy() 也视为销毁语句', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    x = self.destroy()\n    self.position\n',
      'cellapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('position');
  });

  it('同一语句多处访问各自成条', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send(self.position)\n',
      'baseapp'
    );
    expect(findings.map(f => f.member)).toEqual(['cell', 'position']);
  });

  it('跨多行调用后的访问(语句拼接不破坏判定)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.client.teleport(\n      1, 2\n    )\n',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('client');
  });

  it('访问在销毁之前不报(顺序敏感)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.cell.send()\n    self.destroy()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('条件销毁(if 内)不报(销毁可能未执行)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    if self.flag:\n      self.destroy()\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('销毁在嵌套块、访问在外层不报(跨块未分析)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    for x in items:\n      self.destroy()\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('销毁在外层、访问在嵌套块不报(跨块未分析)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    for x in items:\n      self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('同层无条件早退后的访问是死码,不报', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    return\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('条件早退(if 内 return)不使访问成死码,仍报', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    if items:\n      return\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('cell');
  });

  it('销毁后条件里的 self.<prop> 访问本身也报(读属性即错用)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    if self.flag:\n      return\n',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('flag');
  });

  it('安全成员 id/isDestroyed/className/destroy 不报', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    print(self.id, self.isDestroyed, self.className)\n    self.destroy()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('字符串/注释内的 self.cell 不报(掩码)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    s = "self.cell"\n    # self.position\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('非实体脚本(无 def 归属)不报', () => {
    const findings = find(
      'class Foo:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      null, null
    );
    expect(findings).toHaveLength(0);
  });

  it('角色不明(pathFace null 且 defFaces 空)不报', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      null, []
    );
    expect(findings).toHaveLength(0);
  });

  it('多面歧义 defFaces 不报', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      null, ['baseapp', 'cellapp']
    );
    expect(findings).toHaveLength(0);
  });

  it('def 归属唯一面生效(无目录域,cellapp)', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.position\n',
      null, ['cellapp']
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('position');
  });

  it('def 声明 destroy(动态分派)整文件不分析', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      'baseapp', null, true
    );
    expect(findings).toHaveLength(0);
  });

  it('跨函数不报(另一函数销毁不波及本函数)', () => {
    const findings = find(
      'class Avatar:\n  def a(self):\n    self.destroy()\n  def b(self):\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('嵌套函数同块内销毁后访问报(自身函数分析)', () => {
    const findings = find(
      'class Avatar:\n  def outer(self):\n    def inner(self):\n      self.destroy()\n      self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].member).toBe('cell');
  });

  it('一行销毁后同块访问(分号语句)报', () => {
    const findings = find(
      'class Avatar:\n  def go(self):\n    self.destroy(); self.cell.send()\n',
      'baseapp'
    );
    // self.destroy(); self.cell.send() 是一条语句(分号不拆)——既非销毁语句
    // 也非其后访问,保守不报(分号形态未分析)
    expect(findings).toHaveLength(0);
  });

  it('异步入口:enabled=false 零产出', async () => {
    const items = await postDestroyDiagnosticItemsAsync(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      '/proj/scripts/base/avatar.py',
      async () => null,
      () => false,
      false
    );
    expect(items).toHaveLength(0);
  });

  it('异步入口:目录域定面产出诊断项(code/severity/range)', async () => {
    const items = await postDestroyDiagnosticItemsAsync(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      '/proj/scripts/base/avatar.py',
      async () => null,
      () => false,
      true
    );
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(POST_DESTROY_DIAGNOSTIC_CODE);
    expect(items[0].severity).toBe('Warning');
    expect(items[0].source).toBe('kbengine');
    expect(items[0].range.start).toEqual({ line: 3, character: 4 });
    expect(items[0].range.end).toEqual({ line: 3, character: 4 + 'self.cell'.length });
    expect(items[0].message).toContain('destroy');
  });

  it('异步入口:isDestroyDeclared true 零产出', async () => {
    const items = await postDestroyDiagnosticItemsAsync(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      '/proj/scripts/base/avatar.py',
      async () => null,
      () => true,
      true
    );
    expect(items).toHaveLength(0);
  });

  it('异步入口:fetchDefFaces 失败兜底非实体零产出', async () => {
    const items = await postDestroyDiagnosticItemsAsync(
      'class Avatar:\n  def go(self):\n    self.destroy()\n    self.cell.send()\n',
      '/proj/scripts/avatar.py',
      async () => { throw new Error('boom'); },
      () => false,
      true
    );
    expect(items).toHaveLength(0);
  });
});
