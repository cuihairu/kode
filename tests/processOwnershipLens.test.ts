import { describe, expect, it } from 'vitest';
import {
  buildDefProcessBreadcrumb,
  buildProcessOwnershipSpec,
  buildPythonProcessBreadcrumb,
  processFromDefSections,
  resolveScriptRole
} from '../src/backend/processOwnershipLens';
import { ProcessBreadcrumbPythonSymbolProvider } from '../src/languageProviders';
import { makeTextDocument, SymbolKind } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// PROC-TAG-001(用户令 2026-11-13)→ PROC-BREADCRUMB-001 改面(2026-11-18):
// 进程归属展示从文件顶部 CodeLens 迁到面包屑合成根节点(头部镜已按用户令
// 移除,设置项连同删除)。纯核半边=目录角色判定 + 跨进程同名互链展开 +
// def/py 两面合成根规格组装;provider 半边=python 面符号输出。判不出不
// 出镜,不猜。def 面 provider 的钉子见 tests/defDocumentSymbols.test.ts。

describe('resolveScriptRole(判定链①:目录角色)', () => {
  it('scripts/<role> 四角色目录映射进程', () => {
    expect(resolveScriptRole('/ws/scripts/base/Hero.py')).toBe('baseapp');
    expect(resolveScriptRole('/ws/scripts/cell/Hero.py')).toBe('cellapp');
    expect(resolveScriptRole('/ws/scripts/client/Hero.py')).toBe('client');
    expect(resolveScriptRole('/ws/scripts/bots/Hero.py')).toBe('bots');
  });

  it('角色目录下的共享子层(interface/interfaces)仍归该角色', () => {
    expect(resolveScriptRole('/ws/scripts/base/interfaces/Activity.py')).toBe('baseapp');
    expect(resolveScriptRole('/ws/scripts/cell/interface/Activity.py')).toBe('cellapp');
  });

  it('Windows 分隔符同判', () => {
    expect(resolveScriptRole('C:\\proj\\scripts\\cell\\Hero.py')).toBe('cellapp');
  });

  it('共享目录/根级文件/无 scripts 段=判不出 null(不猜)', () => {
    expect(resolveScriptRole('/ws/scripts/common/util.py')).toBeNull();
    expect(resolveScriptRole('/ws/scripts/Hero.py')).toBeNull();
    expect(resolveScriptRole('/ws/src/Hero.py')).toBeNull();
    expect(resolveScriptRole('/ws/scripts/entity_defs/Hero.def')).toBeNull();
  });
});

describe('processFromDefSections(判定链②:def 区块佐证)', () => {
  it('单族区块佐证对应进程', () => {
    expect(processFromDefSections(new Set(['BaseMethods']))).toBe('baseapp');
    expect(processFromDefSections(new Set(['CellMethods']))).toBe('cellapp');
    expect(processFromDefSections(new Set(['ClientMethods']))).toBe('client');
  });

  it('跨族并存/空集=歧义如实 null(bots 归属只由目录判,def 区块不区分 client/bots)', () => {
    expect(processFromDefSections(new Set(['BaseMethods', 'CellMethods']))).toBeNull();
    expect(processFromDefSections(new Set())).toBeNull();
  });
});

describe('buildProcessOwnershipSpec(互链展开)', () => {
  const existsAmong = (present: string[]) => (path: string) => present.includes(path);

  it('cell 当前:base/bots 同名文件在列,缺的进程不硬造,顺序稳定', () => {
    const spec = buildProcessOwnershipSpec(
      '/ws/scripts/cell/Hero.py',
      existsAmong(['/ws/scripts/base/Hero.py', '/ws/scripts/bots/Hero.py'])
    );
    expect(spec?.current).toBe('cellapp');
    expect(spec?.siblings).toEqual([
      { process: 'baseapp', path: '/ws/scripts/base/Hero.py' },
      { process: 'bots', path: '/ws/scripts/bots/Hero.py' }
    ]);
  });

  it('bots 当前:client 目录同名文件也列(client 与 bots 是两个物理目录)', () => {
    const spec = buildProcessOwnershipSpec(
      '/ws/scripts/bots/Hero.py',
      existsAmong(['/ws/scripts/base/Hero.py', '/ws/scripts/cell/Hero.py', '/ws/scripts/client/Hero.py'])
    );
    expect(spec?.siblings).toEqual([
      { process: 'baseapp', path: '/ws/scripts/base/Hero.py' },
      { process: 'cellapp', path: '/ws/scripts/cell/Hero.py' },
      { process: 'client', path: '/ws/scripts/client/Hero.py' }
    ]);
  });

  it('互链全缺=siblings 空(只出当前进程展示镜的口径),判不出=null', () => {
    const spec = buildProcessOwnershipSpec('/ws/scripts/cell/Hero.py', () => false);
    expect(spec?.siblings).toEqual([]);
    expect(buildProcessOwnershipSpec('/ws/scripts/common/util.py', () => true)).toBeNull();
  });
});

describe('buildDefProcessBreadcrumb(def 面合成根,钉子1/2/3)', () => {
  const existsAmong = (present: string[]) => (path: string) => present.includes(path);

  it('钉子1:单进程 def → name=实体·单段(无▸),无 children', () => {
    const spec = buildDefProcessBreadcrumb(
      '/ws/scripts/entity_defs/Login.def',
      [{ section: 'CellMethods', startLine: 3, endLine: 9 }],
      () => false
    );
    expect(spec?.name).toBe('Login · cellapp');
    expect(spec?.entityName).toBe('Login');
    expect(spec?.processes).toEqual(['cellapp']);
    expect(spec?.children).toEqual([]);
  });

  it('钉子2:双进程 def → 全列+锚定段▸排首位+children 挂其余段(对端路径+本文件锚点)', () => {
    const spec = buildDefProcessBreadcrumb(
      '/ws/scripts/entity_defs/Login.def',
      [
        { section: 'BaseMethods', startLine: 3, endLine: 8 },
        { section: 'CellMethods', startLine: 9, endLine: 14 }
      ],
      existsAmong(['/ws/scripts/cell/Login.py'])
    );
    expect(spec?.name).toBe('Login · baseapp▸·cellapp');
    expect(spec?.processes).toEqual(['baseapp', 'cellapp']);
    expect(spec?.children).toEqual([
      {
        process: 'cellapp',
        section: 'CellMethods',
        anchor: { startLine: 9, endLine: 14 },
        siblingPath: '/ws/scripts/cell/Login.py'
      }
    ]);
  });

  it('三段全列=文档序(锚定段=首段),对端 py 缺位如实 siblingPath=null', () => {
    const spec = buildDefProcessBreadcrumb(
      '/ws/scripts/entity_defs/Avatar.def',
      [
        { section: 'BaseMethods', startLine: 2, endLine: 5 },
        { section: 'CellMethods', startLine: 6, endLine: 9 },
        { section: 'ClientMethods', startLine: 10, endLine: 12 }
      ],
      () => false
    );
    expect(spec?.name).toBe('Avatar · baseapp▸·cellapp·client');
    expect(spec?.children.map(child => child.process)).toEqual(['cellapp', 'client']);
    expect(spec?.children.every(child => child.siblingPath === null)).toBe(true);
  });

  it('钉子3:无方法段(仅 Properties/空) → null 不插节点;非 scripts 树对端推导不出', () => {
    expect(
      buildDefProcessBreadcrumb('/ws/scripts/entity_defs/X.def', [{ section: 'Properties', startLine: 1, endLine: 4 }], () => true)
    ).toBeNull();
    expect(buildDefProcessBreadcrumb('/ws/scripts/entity_defs/X.def', [], () => true)).toBeNull();
    const offTree = buildDefProcessBreadcrumb(
      '/root/entity_defs/Login.def',
      [{ section: 'BaseMethods', startLine: 1, endLine: 3 }],
      () => true
    );
    expect(offTree?.name).toBe('Login · baseapp');
    expect(offTree?.children).toEqual([]);
  });
});

describe('buildPythonProcessBreadcrumb(python 面合成根,钉子6 半边)', () => {
  const existsAmong = (present: string[]) => (path: string) => present.includes(path);

  it('目录命中:当前段▸排首位+互链段 children;单段(互链全缺)无▸无 children', () => {
    const spec = buildPythonProcessBreadcrumb(
      '/ws/scripts/cell/Hero.py',
      existsAmong(['/ws/scripts/base/Hero.py', '/ws/scripts/bots/Hero.py'])
    );
    expect(spec?.name).toBe('Hero · cellapp▸·baseapp·bots');
    expect(spec?.processes).toEqual(['cellapp', 'baseapp', 'bots']);
    expect(spec?.children.map(child => [child.process, child.siblingPath])).toEqual([
      ['baseapp', '/ws/scripts/base/Hero.py'],
      ['bots', '/ws/scripts/bots/Hero.py']
    ]);
    expect(spec?.children.every(child => child.anchor === null && child.section === null)).toBe(true);

    const alone = buildPythonProcessBreadcrumb('/ws/scripts/cell/Hero.py', () => false);
    expect(alone?.name).toBe('Hero · cellapp');
    expect(alone?.children).toEqual([]);
  });

  it('布局未命中(共享目录/根级/非 scripts) → null 零干扰', () => {
    expect(buildPythonProcessBreadcrumb('/ws/scripts/common/util.py', () => true)).toBeNull();
    expect(buildPythonProcessBreadcrumb('/ws/src/Hero.py', () => true)).toBeNull();
  });
});

describe('ProcessBreadcrumbPythonSymbolProvider(python 面符号输出)', () => {
  const pyDoc = (fileName: string): MinimalTextDocument =>
    makeTextDocument('class Hero:\n    pass\n', { fileName, languageId: 'python' });

  it('目录命中出合成根(Namespace,全文档 range),children=对端段(Event,detail 携路径)', () => {
    const provider = new ProcessBreadcrumbPythonSymbolProvider({
      fileExists: path => path.endsWith('base/Hero.py')
    });
    const symbols = provider.provideDocumentSymbols(pyDoc('/ws/scripts/cell/Hero.py') as never, undefined);
    expect(symbols).not.toBeNull();
    expect(symbols!).toHaveLength(1);
    const [root] = symbols!;
    expect(root.name).toBe('Hero · cellapp▸·baseapp');
    expect(root.kind).toBe(SymbolKind.Namespace);
    expect(root.range.start).toEqual({ line: 0, character: 0 });
    expect(root.selectionRange.start).toEqual({ line: 0, character: 0 });
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe('baseapp');
    expect(root.children[0].kind).toBe(SymbolKind.Event);
    expect(root.children[0].detail).toContain('/ws/scripts/base/Hero.py');
    expect(root.children[0].detail).toContain('ctrl+alt+shift');
  });

  it('布局未命中 → null(零干扰 Pylance)', () => {
    const provider = new ProcessBreadcrumbPythonSymbolProvider({ fileExists: () => true });
    expect(provider.provideDocumentSymbols(pyDoc('/ws/scripts/common/util.py') as never, undefined)).toBeNull();
    expect(provider.provideDocumentSymbols(pyDoc('/ws/lib/Hero.py') as never, undefined)).toBeNull();
  });
});
