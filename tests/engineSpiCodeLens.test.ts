// KODE-CFG-015 验收:引擎 SPI 实现函数单独 CodeLens 标注。
//
// 被引擎以 SPI 模式调用的函数(getEntryScript() 36 方法,KODE-CFG-012 权威
// 表)在 Python 定义处出「引擎 SPI · <方法> · <触发时机>」镜;普通函数(表外)
// 不出;开关 kbengine.codeLens.engineSpi 关闭后不出;入口脚本(kbemain.py)
// 与组件脚本两向测试绿。
//
// 纯函数面(componentRoleForPath / buildEngineSpiCodeLenses /
// ENGINE_SPI_METHODS / engineSpiCodeLensTitle)直测;provider 面为薄壳,
// 逻辑全部落纯函数。

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import {
  buildEngineSpiCodeLenses,
  componentRoleForPath,
  ENGINE_SPI_METHODS,
  engineSpiCodeLensTitle,
  EngineSpiCodeLensProvider,
  findModuleLevelMethodDeclarations
} from '../src/engineSpiCodeLens';
import { configurationOverrides } from './fake-vscode/workspaceState';
import { makeTextDocument } from './fake-vscode/core';
import { resetConfigDerivedScanRootForTests } from '../src/configDerive';

describe('ENGINE_SPI_METHODS 权威表(KODE-CFG-012 真值)', () => {
  it('不同名方法共 36 个,引擎调用 36 名', () => {
    expect(Object.keys(ENGINE_SPI_METHODS)).toHaveLength(36);
  });

  it('可选方法恰为 4 个(HasAttr 守卫)', () => {
    const optional = Object.entries(ENGINE_SPI_METHODS)
      .filter(([, entry]) => !entry.required)
      .map(([name]) => name)
      .sort();
    expect(optional).toEqual(['onAutoLoadEntityCreate', 'onLogWrote', 'onReadyForLogin', 'onReadyForShutDown']);
  });

  it('每个方法至少绑定一个组件,组件名均在已知角色集内', () => {
    const roles = new Set(['baseapp', 'cellapp', 'loginapp', 'dbmgr', 'interfaces', 'logger', 'client', 'bots']);
    for (const [name, entry] of Object.entries(ENGINE_SPI_METHODS)) {
      expect(entry.components.length, name).toBeGreaterThanOrEqual(1);
      for (const c of entry.components) {
        expect(roles.has(c), `${name}->${c}`).toBe(true);
      }
      expect(entry.trigger.length, name).toBeGreaterThan(0);
    }
  });

  it('onInit 覆盖 baseapp/cellapp/bots/client 四组件', () => {
    expect(ENGINE_SPI_METHODS.onInit.components).toEqual(['baseapp', 'cellapp', 'bots', 'client']);
  });
});

describe('componentRoleForPath(组件角色判定)', () => {
  it('脚本根优先:首段组件目录名定角色', () => {
    expect(componentRoleForPath('/a/scripts/base/kbemain.py', '/a/scripts')).toBe('baseapp');
    expect(componentRoleForPath('/a/scripts/cell/entity.py', '/a/scripts')).toBe('cellapp');
    expect(componentRoleForPath('/a/scripts/interface/if.py', '/a/scripts')).toBe('interfaces');
  });

  it('有脚本根但首段非组件目录 → null(不回落启发式,防 common/base 误判)', () => {
    expect(componentRoleForPath('/a/scripts/common/base/foo.py', '/a/scripts')).toBeNull();
    expect(componentRoleForPath('/a/scripts/base/foo.py', '/a/scripts')).toBe('baseapp');
  });

  it('有脚本根但文件在根外 → null(不出镜)', () => {
    expect(componentRoleForPath('/a/other/base/foo.py', '/a/scripts')).toBeNull();
    expect(componentRoleForPath('/a/scripts.py', '/a/scripts')).toBeNull();
  });

  it('无脚本根启发式:取最后一个已知组件目录段', () => {
    expect(componentRoleForPath('/proj/assets/scripts/login/kbemain.py')).toBe('loginapp');
    expect(componentRoleForPath('/proj/assets/scripts/bots/kbemain.py')).toBe('bots');
  });

  it('不在组件目录/空路径 → null(不出镜)', () => {
    expect(componentRoleForPath('/proj/src/foo.py')).toBeNull();
    expect(componentRoleForPath('')).toBeNull();
  });
});

describe('findModuleLevelMethodDeclarations(模块级识别)', () => {
  it('只取列 0 def,类方法/嵌套函数不取', () => {
    const text = [
      'def onInit(isReload):',
      '    pass',
      '',
      'class Handler:',
      '    def onBaseAppReady(self):',
      '        pass',
      '',
      'def outer():',
      '    def onCellAppDeath():',
      '        pass',
      ''
    ].join('\n');
    const decls = findModuleLevelMethodDeclarations(text);
    // 列 0 def(onInit/outer)命中;类方法 onBaseAppReady 与嵌套 onCellAppDeath 不取
    expect(decls.map(d => d.methodName)).toEqual(['onInit', 'outer']);
  });

  it('async 模块级 def 也命中', () => {
    const decls = findModuleLevelMethodDeclarations('async def onInit(x):\n    pass\n');
    expect(decls.map(d => d.methodName)).toEqual(['onInit']);
  });
});

describe('buildEngineSpiCodeLenses(命中筛)', () => {
  const kbemain = `
def onInit(isReload):
    pass

def onBaseAppReady():
    pass

def onRequestLogin(account, password):
    pass

def ordinaryHelper():
    pass
`;
  const declarations = findModuleLevelMethodDeclarations(kbemain);

  it('入口脚本(baseapp)命中 onInit/onBaseAppReady,表外普通函数不出', () => {
    const specs = buildEngineSpiCodeLenses(declarations, 'baseapp');
    const names = specs.map(s => s.methodName).sort();
    // onRequestLogin 属 loginapp,不在 baseapp 组件集 → 不出
    expect(names).toEqual(['onBaseAppReady', 'onInit']);
  });

  it('组件角色不匹配的方法不出(loginapp 的 onRequestLogin 在 baseapp 面不标)', () => {
    const specs = buildEngineSpiCodeLenses(declarations, 'loginapp');
    expect(specs.map(s => s.methodName)).toEqual(['onRequestLogin']);
  });

  it('角色为 null → 全部不出', () => {
    expect(buildEngineSpiCodeLenses(declarations, null)).toEqual([]);
  });

  it('镜标题:必选「方法 · 触发」,可选触发后加「 · 可选」', () => {
    expect(engineSpiCodeLensTitle('onBaseAppReady')).toBe('引擎 SPI · onBaseAppReady · 组件就绪');
    expect(engineSpiCodeLensTitle('onReadyForLogin')).toBe(
      '引擎 SPI · onReadyForLogin · 轮询 ≥0.9999 放行登录 · 可选'
    );
    expect(engineSpiCodeLensTitle('onLogWrote')).toContain('· 可选');
  });

  it('命中规格携带声明行与必选标记', () => {
    const specs = buildEngineSpiCodeLenses(declarations, 'baseapp');
    const onInit = specs.find(s => s.methodName === 'onInit');
    expect(onInit?.declaration.line).toBe(1); // 0-based 第 1 行
    expect(onInit?.required).toBe(true);
  });
});

describe('EngineSpiCodeLensProvider(开关与挂载)', () => {
  const source = `def onInit(isReload):
    pass

def onBaseAppReady():
    pass

def helper():
    pass
`;

  const makeDoc = (fileName: string) =>
    makeTextDocument(source, { fileName, languageId: 'python' }) as unknown as vscode.TextDocument;

  beforeEach(() => {
    configurationOverrides.clear();
    resetConfigDerivedScanRootForTests();
  });

  afterEach(() => {
    configurationOverrides.clear();
    resetConfigDerivedScanRootForTests();
  });

  it('组件脚本(base)出 SPI 镜,普通函数无镜', () => {
    const provider = new EngineSpiCodeLensProvider();
    const lenses = provider.provideCodeLenses(makeDoc('/proj/assets/scripts/base/kbemain.py'));
    const titles = lenses.map(lens => String(lens.command?.title ?? ''));
    expect(titles).toEqual(['引擎 SPI · onInit · 首回调,0=启动 1=热载', '引擎 SPI · onBaseAppReady · 组件就绪']);
    provider.dispose();
  });

  it('同名类方法/嵌套函数不标 SPI(引擎调入口模块属性,非任意缩进 def)', () => {
    const withClass = [
      'class Handler:',
      '    def onInit(self):',
      '        pass',
      '',
      'def onBaseAppReady():',
      '    pass',
      ''
    ].join('\n');
    const provider = new EngineSpiCodeLensProvider();
    const doc = makeTextDocument(withClass, {
      fileName: '/proj/assets/scripts/base/kbemain.py',
      languageId: 'python'
    }) as unknown as vscode.TextDocument;
    const titles = provider.provideCodeLenses(doc).map(lens => String(lens.command?.title ?? ''));
    // 类方法 onInit(缩进)不标;模块级 onBaseAppReady 标
    expect(titles).toEqual(['引擎 SPI · onBaseAppReady · 组件就绪']);
    provider.dispose();
  });

  it('开关 codeLens.engineSpi=false → 不出镜(默认开)', () => {
    configurationOverrides.set('kbengine', { 'codeLens.engineSpi': false });
    const provider = new EngineSpiCodeLensProvider();
    expect(provider.provideCodeLenses(makeDoc('/proj/assets/scripts/base/kbemain.py'))).toEqual([]);
    provider.dispose();
  });

  it('非组件目录文件 → 不出镜', () => {
    const provider = new EngineSpiCodeLensProvider();
    expect(provider.provideCodeLenses(makeDoc('/proj/src/util.py'))).toEqual([]);
    provider.dispose();
  });

  it('取消/已关闭文档 → 不出镜', () => {
    const provider = new EngineSpiCodeLensProvider();
    const doc = makeDoc('/proj/assets/scripts/base/kbemain.py');
    expect(provider.provideCodeLenses(doc, { isCancellationRequested: true } as vscode.CancellationToken)).toEqual([]);
    Object.defineProperty(doc, 'isClosed', { get: () => true });
    expect(provider.provideCodeLenses(doc)).toEqual([]);
    provider.dispose();
  });

  it('开关变更 fire 触发 onDidChangeCodeLenses', () => {
    const provider = new EngineSpiCodeLensProvider();
    let fired = 0;
    const sub = provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });
    provider.fireConfigurationChanged();
    expect(fired).toBe(1);
    sub.dispose();
    provider.dispose();
  });
});
