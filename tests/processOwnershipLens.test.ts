import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  buildProcessOwnershipSpec,
  processFromDefSections,
  resolveScriptRole
} from '../src/backend/processOwnershipLens';
import { ProcessOwnershipCodeLensProvider } from '../src/languageProviders';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../src/sourceRevealCommand';
import { EntityMappingManager } from '../src/entityMapping';
import { configurationOverrides, makeTextDocument, Uri, workspaceEvents } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// PROC-TAG-001(用户令 2026-11-13):文件顶部进程归属 CodeLens。
// 纯核半边=目录角色判定 + 跨进程同名互链展开 + def 区块佐证裁定;
// provider 半边=开关闸/命令装配/文件事件刷新。判不出不出镜,不猜。

interface CodeLensLike {
  range: { start: { line: number; character: number } };
  command?: { title: string; command?: string; arguments?: Array<unknown> };
}

const doc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

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

describe('ProcessOwnershipCodeLensProvider', () => {
  const makeManager = (
    resolve?: (fileName: string, methodName: string) => unknown
  ): EntityMappingManager =>
    ({ resolveMethodDefinition: resolve ?? (() => null) }) as unknown as EntityMappingManager;

  it('目录角色:当前进程纯展示镜(无命令)+其他进程可点击 tag 走 reveal 命令', async () => {
    const provider = new ProcessOwnershipCodeLensProvider(makeManager(), {
      fileExists: path => path.endsWith('base/Hero.py') || path.endsWith('bots/Hero.py')
    });
    const document = doc('class Hero:\n    def tick(self):\n        pass\n', '/ws/scripts/cell/Hero.py');
    const lenses = (await provider.provideCodeLenses(document as unknown as vscode.TextDocument)) as unknown as CodeLensLike[];
    expect(lenses).toHaveLength(3);
    // 首镜=当前进程纯展示(无 command,不可点击)
    expect(lenses[0].command?.title).toBe('⚙ cellapp（当前）');
    // 纯展示=空命令 id(不可点击执行),tooltip 补判据说明
    expect(lenses[0].command?.command).toBe('');
    // 其他进程 tag:reveal 命令 + 文件 Uri + line 0 selection
    expect(lenses[1].command?.title).toBe('⚙ baseapp');
    expect(lenses[1].command?.command).toBe(KBENGINE_SOURCE_REVEAL_COMMAND);
    const [uri, opts] = lenses[1].command!.arguments!;
    expect((uri as { fsPath: string }).fsPath).toBe('/ws/scripts/base/Hero.py');
    expect((opts as { selection: { start: { line: number } } }).selection.start.line).toBe(0);
    expect(lenses[2].command?.title).toBe('⚙ bots');
    // 镜都在 line 0
    for (const lens of lenses) {
      expect(lens.range.start.line).toBe(0);
    }
    provider.dispose();
  });

  it('codeLens.processOwnership 关闭时整类不出镜,默认开启不受影响', async () => {
    const provider = new ProcessOwnershipCodeLensProvider(makeManager(), {
      fileExists: () => true
    });
    const document = doc('class Hero:\n    pass\n', '/ws/scripts/cell/Hero.py');
    const lenses = await provider.provideCodeLenses(document as unknown as vscode.TextDocument);
    // fileExists 恒真:baseapp/client/bots 三个兄弟目录同名文件全在,1+3
    expect(lenses).toHaveLength(4);

    configurationOverrides.set('kbengine', { 'codeLens.processOwnership': false });
    try {
      expect(await provider.provideCodeLenses(document as unknown as vscode.TextDocument)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
    provider.dispose();
  });

  it('目录判不出时 def 区块佐证:单族出镜、跨族/无解析不出镜,佐证镜无互链', async () => {
    // 文件在 scripts 根级(无角色目录),声明的两个方法都解析到 CellMethods
    const provider = new ProcessOwnershipCodeLensProvider(
      makeManager((_f, method) =>
        method === 'tick' || method === 'move'
          ? { section: 'CellMethods', defFile: '/ws/scripts/entity_defs/Hero.def', line: 3, exposed: true }
          : null
      ),
      { fileExists: () => true }
    );
    const document = doc('def tick(self):\n    pass\ndef move(self):\n    pass\n', '/ws/scripts/Hero.py');
    const lenses = (await provider.provideCodeLenses(document as unknown as vscode.TextDocument)) as unknown as CodeLensLike[];
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toBe('⚙ cellapp（当前）');

    // 跨族(Base+Cell)=歧义,如实不出镜
    const ambiguous = new ProcessOwnershipCodeLensProvider(
      makeManager((_f, method) =>
        method === 'tick'
          ? { section: 'BaseMethods', defFile: '/ws/scripts/entity_defs/Hero.def', line: 3, exposed: true }
          : { section: 'CellMethods', defFile: '/ws/scripts/entity_defs/Hero.def', line: 9, exposed: true }
      ),
      { fileExists: () => true }
    );
    expect(
      await ambiguous.provideCodeLenses(document as unknown as vscode.TextDocument)
    ).toEqual([]);

    // 无可解析方法=无证据,不出镜
    const noEvidence = new ProcessOwnershipCodeLensProvider(makeManager(), { fileExists: () => true });
    expect(await noEvidence.provideCodeLenses(document as unknown as vscode.TextDocument)).toEqual([]);
    provider.dispose();
    ambiguous.dispose();
    noEvidence.dispose();
  });

  it('.py 文件新建/删除事件触发重取,非 .py 不触发', () => {
    const provider = new ProcessOwnershipCodeLensProvider(makeManager(), { fileExists: () => true });
    const fired = vi.fn();
    provider.onDidChangeCodeLenses(fired);
    workspaceEvents.filesCreated.fire({ files: [Uri.file('/ws/scripts/base/Hero.py')] });
    expect(fired).toHaveBeenCalledTimes(1);
    workspaceEvents.filesCreated.fire({ files: [Uri.file('/ws/notes.txt')] });
    expect(fired).toHaveBeenCalledTimes(1);
    workspaceEvents.filesDeleted.fire({ uris: [Uri.file('/ws/scripts/base/Hero.py')] });
    expect(fired).toHaveBeenCalledTimes(2);
    provider.dispose();
  });
});
