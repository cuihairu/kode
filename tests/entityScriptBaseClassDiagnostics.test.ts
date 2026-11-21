/**
 * QA-001a:实体脚本基类面(类名一致性 + 基类合法性)纯检查面单测。
 * 引擎判例源 docs/knowledge/entity-script-base-class.md(引擎头 55a66552):
 * 类名闸(GetAttrString(pyModule, moduleName))与基类闸(isSubClass 对组件名册)。
 * 本面只报可证形态:类名闸对模块命名空间绑定名放行(定义类/实例赋值/
 * import 任一),基类闸只报「无任何直接基类 + 名册非空」;client 名册未取证
 * 与面歧义不猜基类闸,但类名闸照跑(引擎每个进程装载实体都查类名)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import {
  ENTITY_SCRIPT_BASE_CLASS_DIAGNOSTIC_CODE,
  SCRIPT_BASE_ROSTER,
  entityScriptBaseClassFindingsToItems,
  findEntityScriptBaseClassFindings
} from '../src/backend/entityScriptBaseClassDiagnostics';

afterEach(() => {
  setL10nBundle(null);
});

describe('entity script base class diagnostics (pure)', () => {
  it('类名闸:模块无同名类 → 报,行落在首个类定义', () => {
    const findings = findEntityScriptBaseClassFindings(
      'class Player(Base):\n    def onEnterSpace(self):\n        pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('class-name-gate');
    expect(findings[0].line).toBe(0);
    expect(findings[0].definedClasses).toEqual(['Player']);
    expect(findings[0].message).toContain('Avatar');
    expect(findings[0].message).toContain('Player');
    // 引擎在类名闸先失败,基类闸不叠报
    expect(findings.some(f => f.kind === 'base-class-gate')).toBe(false);
  });

  it('类名闸:模块连类都没有(仅函数) → 报,行落 0', () => {
    const findings = findEntityScriptBaseClassFindings(
      'def onCreated(self):\n    pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('class-name-gate');
    expect(findings[0].line).toBe(0);
    expect(findings[0].definedClasses).toEqual([]);
  });

  it('类名闸:模块经 import 绑定同名 → 放行(GetAttrString 取得到,绝不误报)', () => {
    const findings = findEntityScriptBaseClassFindings(
      'from common import Avatar\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('类名闸:模块经模块级实例赋值绑定同名 → 放行', () => {
    const findings = findEntityScriptBaseClassFindings(
      'Avatar = AvatarImpl(\n    "entity_defs/Avatar"\n)\n',
      'Avatar.py',
      'Avatar',
      'baseapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('类名闸:同名类已定义 → 不报类名闸', () => {
    const findings = findEntityScriptBaseClassFindings(
      'class Avatar(Base):\n    def onCreated(self):\n        pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings.some(f => f.kind === 'class-name-gate')).toBe(false);
  });

  it('基类闸:无任何直接基类 + 名册非空(cellapp) → 报', () => {
    const findings = findEntityScriptBaseClassFindings(
      'class Avatar:\n    def onCreated(self):\n        pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('base-class-gate');
    expect(findings[0].roster).toEqual(['KBEngine.Entity', 'KBEngine.EntityComponent']);
    expect(findings[0].message).toContain('KBEngine.Entity');
    expect(findings[0].message).toContain('cellapp');
  });

  it('基类闸:baseapp 名册含 Proxy', () => {
    expect(SCRIPT_BASE_ROSTER.baseapp).toContain('KBEngine.Proxy');
    const findings = findEntityScriptBaseClassFindings(
      'class Avatar:\n    pass\n',
      'Avatar.py',
      'Avatar',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].roster).toEqual([
      'KBEngine.Entity',
      'KBEngine.Proxy',
      'KBEngine.EntityComponent'
    ]);
  });

  it('基类闸:有直接基类(Base) → 不报(无法证明非法)', () => {
    const findings = findEntityScriptBaseClassFindings(
      'from KBEngine import Base\n\nclass Avatar(Base):\n    def onCreated(self):\n        pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('基类闸:间接子类(MRO 链) → 不报', () => {
    const findings = findEntityScriptBaseClassFindings(
      'from KBEngine import Base\n\nclass AccountBase(Base):\n    pass\n\nclass Avatar(AccountBase):\n    def onCreated(self):\n        pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(findings).toHaveLength(0);
  });

  it('client 名册未取证 → 基类闸不跑(不猜);类名闸照跑', () => {
    expect(SCRIPT_BASE_ROSTER.client).toBeNull();
    // 无基类 + client → 不报
    expect(
      findEntityScriptBaseClassFindings('class Avatar:\n    pass\n', 'Avatar.py', 'Avatar', 'client')
    ).toHaveLength(0);
    // 错类名 + client → 类名闸仍报
    const findings = findEntityScriptBaseClassFindings(
      'class Player(Base):\n    pass\n',
      'Avatar.py',
      'Avatar',
      'client'
    );
    expect(findings.map(f => f.kind)).toEqual(['class-name-gate']);
  });

  it('面未知/歧义(null) → 类名闸照跑,基类闸不跑', () => {
    const findings = findEntityScriptBaseClassFindings(
      'class Player(Base):\n    pass\n',
      'Avatar.py',
      'Avatar',
      null
    );
    expect(findings.map(f => f.kind)).toEqual(['class-name-gate']);
    // 无基类 + 面未知 → 不报基类闸
    expect(
      findEntityScriptBaseClassFindings('class Avatar:\n    pass\n', 'Avatar.py', 'Avatar', null)
    ).toHaveLength(0);
  });

  it('诊断项:纯数据带 code/Warning/kbengine,免 vscode', () => {
    const findings = findEntityScriptBaseClassFindings(
      'class Avatar:\n    pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    const items = entityScriptBaseClassFindingsToItems(findings);
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(ENTITY_SCRIPT_BASE_CLASS_DIAGNOSTIC_CODE);
    expect(items[0].severity).toBe('Warning');
    expect(items[0].source).toBe('kbengine');
    expect(items[0].range.start.line).toBe(0);
  });

  it('zh-cn 文案:注入 bundle 后渲染中文', () => {
    setL10nBundle(zhCnBundle);
    const classNameFindings = findEntityScriptBaseClassFindings(
      'class Player(Base):\n    pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(classNameFindings[0].message).toContain('必须定义与模块名同名的类');
    const baseClassFindings = findEntityScriptBaseClassFindings(
      'class Avatar:\n    pass\n',
      'Avatar.py',
      'Avatar',
      'cellapp'
    );
    expect(baseClassFindings[0].message).toContain('没有任何基类');
    expect(baseClassFindings[0].message).toContain('组件名册');
  });
});
