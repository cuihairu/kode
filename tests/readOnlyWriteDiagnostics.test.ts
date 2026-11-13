// IDE-LINT-007 验收:基于引擎属性表(EntityBuiltinProperty)的只读写入 lint。
// 纯逻辑层单测——实体身份/角色经 resolveEntityBuiltinPropertyHit(与内建属性
// hover/inlay 同一底座),写入形态经掩码文本扫描(普通/增强/注解赋值 + del)。
//
// 验收断言(逐条对应 todo.md:1700):
//   - 确认 Entity 身份及角色后检查普通/增强赋值和 del;
//   - self.id 等只读属性报告(普通/增强/注解赋值与 del 四形);
//   - 合法可写属性(self.position 等)与普通 Python 同名字段(非实体脚本)不报;
//   - 实际 code/开关/测试入规则表(文档对账在 features.md)。
// 反例(不得误报):比较(==/<=)、海象(:=,属性目标非法)、属性续写
// (self.<p>.x)、下标写(self.<p>[i]=x)、字符串/注释内容、字典键/切片。

import { describe, expect, it } from 'vitest';
import {
  findReadOnlyWriteFindings,
  readOnlyWriteDiagnosticItemsAsync,
  READONLY_WRITE_DIAGNOSTIC_CODE
} from '../src/backend/readOnlyWriteDiagnostics';
import type { EntityComponentFace } from '../src/backend/entityBuiltinProperties';

const find = (
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null = null
) => findReadOnlyWriteFindings(text, pathFace, defFaces);

describe('IDE-LINT-007 引擎只读属性写入 lint(纯逻辑)', () => {
  it('普通赋值 self.id = x 报告(实体 base 面)', () => {
    const findings = find('self.id = 1\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('id');
    expect(findings[0].kind).toBe('assign');
    expect(findings[0].line).toBe(0);
    expect(findings[0].character).toBe(0);
    expect(findings[0].length).toBe('self.id'.length);
    expect(findings[0].face).toBe('baseapp');
    expect(findings[0].severity).toBe('Warning');
    expect(findings[0].code).toBe(READONLY_WRITE_DIAGNOSTIC_CODE);
    expect(findings[0].message).toContain('read-only');
  });

  it('增强赋值 self.id += 1 报告', () => {
    const findings = find('self.id += 1\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('augmented');
  });

  it('三字符增强赋值 **= //= <<= >>= 报告;移位/幂值上下文不误报(审核发现修复)', () => {
    for (const op of ['**=', '//=', '<<=', '>>=']) {
      const findings = find(`self.id ${op} 1\n`, 'baseapp');
      expect(findings, op).toHaveLength(1);
      expect(findings[0].kind, op).toBe('augmented');
      expect(findings[0].propertyName, op).toBe('id');
    }
    // 值上下文(移位/幂/整除)不是写目标,不得误报
    expect(find('y = self.id << 2\n', 'baseapp')).toHaveLength(0);
    expect(find('y = self.id >> 2\n', 'baseapp')).toHaveLength(0);
    expect(find('y = self.id ** 2\n', 'baseapp')).toHaveLength(0);
    expect(find('y = self.id // 2\n', 'baseapp')).toHaveLength(0);
  });

  it('注解赋值 self.id: int = 5 报告', () => {
    const findings = find('self.id: int = 5\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('annotated');
  });

  it('删除 del self.id 报告', () => {
    const findings = find('del self.id\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('del');
  });

  it('只读宏公共项 isDestroyed/className 也报告(各面共通)', () => {
    expect(find('self.isDestroyed = True\n', 'cellapp')).toHaveLength(1);
    expect(find('self.className = "X"\n', 'client')).toHaveLength(1);
  });

  it('合法可写属性不报:cell 面 self.position / base 面 self.shouldAutoBackup', () => {
    expect(find('self.position = v\n', 'cellapp')).toHaveLength(0);
    expect(find('self.shouldAutoBackup = True\n', 'baseapp')).toHaveLength(0);
  });

  it('普通 Python 同名字段不报:非实体脚本(pathFace null + defFaces null)', () => {
    expect(find('self.id = 1\n', null, null)).toHaveLength(0);
  });

  it('面歧义(pathFace null,defFaces 多面)只兜底宏公共 3 项:id 报、layer 不报', () => {
    const ambiguous: readonly EntityComponentFace[] = ['baseapp', 'cellapp'];
    expect(find('self.id = 1\n', null, ambiguous)).toHaveLength(1);
    expect(find('self.layer = 1\n', null, ambiguous)).toHaveLength(0);
  });

  it('面专属性按面生效:cell 面 spaceID 只读报、base 面无 spaceID 不报', () => {
    expect(find('self.spaceID = 1\n', 'cellapp')).toHaveLength(1);
    expect(find('self.spaceID = 1\n', 'baseapp')).toHaveLength(0);
  });

  it('反例:比较/海象/续写/下标/算术均不报', () => {
    expect(find('x = self.id == 5\n', 'baseapp')).toHaveLength(0);
    expect(find('if self.id <= 5:\n    pass\n', 'baseapp')).toHaveLength(0);
    expect(find('y = self.id\n', 'baseapp')).toHaveLength(0); // 读值
    expect(find('self.id.attr = 1\n', 'baseapp')).toHaveLength(0);
    expect(find('del self.id.attr\n', 'baseapp')).toHaveLength(0);
    expect(find('self.id[0] = 1\n', 'baseapp')).toHaveLength(0);
    expect(find('z = self.id + 1\n', 'baseapp')).toHaveLength(0);
  });

  it('反例:字符串/注释内容掩码,不误认', () => {
    expect(find('s = "self.id = 1"\n', 'baseapp')).toHaveLength(0);
    expect(find('# self.id = 1\n', 'baseapp')).toHaveLength(0);
    expect(find("t = 'del self.id'\n", 'baseapp')).toHaveLength(0);
  });

  it('反例:字典键/切片形态不报(注解扫描无顶层 =)', () => {
    expect(find("d = {self.id: 'x'}\n", 'baseapp')).toHaveLength(0);
    expect(find('d = self.id[0:2]\n', 'baseapp')).toHaveLength(0);
  });

  it('链式赋值 a = self.id = 5 报告(写目标)', () => {
    const findings = find('a = self.id = 5\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('assign');
  });

  it('del 逗号第二项不报(前缀形态边界,保留第一项)', () => {
    const findings = find('del self.id, self.className\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('id');
  });

  it('多行续接普通赋值 = 同行,仍报', () => {
    const findings = find('self.id = \\\n  1\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('assign');
  });

  it('单行复合语句(if/while/for 一行体)不把体内顶层 = 误判为注解赋值', () => {
    // 审核发现:冒号分支自 `:` 起对 `=` 无括号深度/语句边界判定,`if self.isDestroyed: self.counter = 0`
    // 等把体里的 `=` 当成对只读内建属性的注解赋值 → 误报。修复后体语句的 `=` 不再牵连条件里的属性。
    expect(find('if self.id: self.counter = 0\n', 'baseapp')).toHaveLength(0);
    expect(find('if self.isDestroyed: self.counter = 0\n', 'baseapp')).toHaveLength(0);
    expect(find('if self.cell: self.x = 1\n', 'baseapp')).toHaveLength(0);
    expect(find('while self.id: self.counter = 0\n', 'baseapp')).toHaveLength(0);
    expect(find('for x in self.id: self.counter = 0\n', 'baseapp')).toHaveLength(0);
  });

  it('单行复合语句多行形态对照(证伪):同样不报', () => {
    expect(find('if self.isDestroyed:\n    self.counter = 0\n', 'baseapp')).toHaveLength(0);
    expect(find('while self.id:\n    self.counter = 0\n', 'baseapp')).toHaveLength(0);
  });

  it('单行复合语句体内的真实注解赋值仍报(注解冒号≠套件冒号)', () => {
    const findings = find('if self.isDestroyed: self.id: int = 5\n', 'baseapp');
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('id');
    expect(findings[0].kind).toBe('annotated');
  });

  it('注解赋值语句边界:; 后的 = 不冒充注解赋值', () => {
    // `self.id: int`(仅注解无赋值)+ `x = 1`:不是对 id 的写 → 不报。
    expect(find('self.id: int; x = 1\n', 'baseapp')).toHaveLength(0);
    // `self.id: int = 5; x = 1`:自身注解赋值在 ; 前 → 仍报。
    expect(find('self.id: int = 5; x = 1\n', 'baseapp')).toHaveLength(1);
  });
});

describe('IDE-LINT-007 异步入口(面预取 + 开关)', () => {
  const noDefFaces = async (): Promise<readonly EntityComponentFace[] | null> => null;

  it('enabled=false 零产出', async () => {
    const items = await readOnlyWriteDiagnosticItemsAsync('self.id = 1\n', '/x/scripts/base/foo.py', noDefFaces, false);
    expect(items).toHaveLength(0);
  });

  it('pathFace 命中(base 段)不取 defFaces,出只读项', async () => {
    let fetched = 0;
    const items = await readOnlyWriteDiagnosticItemsAsync('self.id = 1\n', '/x/scripts/base/foo.py', async () => {
      fetched += 1;
      return ['cellapp'] as const;
    }, true);
    expect(items).toHaveLength(1);
    expect(fetched).toBe(0); // 目录域已定面,不查 def 归属
    expect(items[0].range.start.character).toBe(0);
    expect(items[0].range.end.character).toBe('self.id'.length);
  });

  it('pathFace 判不出 → 经 defFaces 定面出项', async () => {
    const items = await readOnlyWriteDiagnosticItemsAsync(
      'self.id = 1\n', '/x/scripts/common/foo.py', async () => ['baseapp'] as const, true
    );
    expect(items).toHaveLength(1);
  });

  it('defFaces 解析失败 → 兜底 null(非实体)零产出', async () => {
    const items = await readOnlyWriteDiagnosticItemsAsync(
      'self.id = 1\n', '/x/scripts/common/foo.py', async () => { throw new Error('boom'); }, true
    );
    expect(items).toHaveLength(0);
  });
});
