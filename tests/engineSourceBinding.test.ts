import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activate,
  deactivate
} from '../src/extension';
import { buildKbeStubDocument } from '../src/kbeModuleIndex';
import {
  describeEngineApiConstraint,
  resolveEngineCppDefinition,
  resolveEnginePythonDefinition,
  type EngineSourceScanDeps
} from '../src/backend/engineSourceBinding';
import { commands } from './fake-vscode/commandRegistry';
import { messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { workspace, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { makeContext, resetExtensionTestState } from './extensionTestShared';

// RUST-174 API metadata 与真实 engine source 绑定:策展符号 → 真实引擎检出
// 上的定义锚。验收口径与 tests/kbeModuleIndex.test.ts 引擎源码条件用例同源
// (声明行 startsWith `class|def <declName>`,declName=cppClassName??aliasOf??name);
// 漂移只给文件不声称行,引擎缺席/扫描未见/无锚名各自如实分型。

type PyEntry = Parameters<typeof resolveEnginePythonDefinition>[0];
type CppEntry = Parameters<typeof resolveEngineCppDefinition>[0];

const realDeps = {
  existsSync: (candidate: string) => fs.existsSync(candidate),
  readFileSync: (candidate: string) => fs.readFileSync(candidate, 'utf8')
};

const makeEngineTree = (): { root: string; pyiFile: string; headerFile: string; cppLine: number } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engine-src-'));
  // 2026-11-24 语义:身份锚 res/server/kbengine_defaults.xml(findEngineRoot 向上验锚)
  fs.mkdirSync(path.join(root, 'res', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'res', 'server', 'kbengine_defaults.xml'), '<r>\n', 'utf8');
  fs.mkdirSync(path.join(root, 'src', 'lib', 'common'), { recursive: true });
  fs.mkdirSync(path.join(root, 'typings'), { recursive: true });
  const pad = (line: number, text: string): string =>
    `${Array.from({ length: line - 1 }, () => '# pad').join('\n')}\n${text}\n`;
  fs.writeFileSync(path.join(root, 'src', 'lib', 'common', 'kbeversion.h'), pad(1, '#define KBE_VERSION_MAJOR 2'), 'utf8');
  const pyiFile = path.join(root, 'typings', '_KBEngine_common.pyi');
  fs.writeFileSync(pyiFile, pad(67, 'class Entity:'), 'utf8');
  const headerFile = path.join(root, 'src', 'lib', 'pyscript', 'vector3.h');
  fs.mkdirSync(path.dirname(headerFile), { recursive: true });
  fs.writeFileSync(headerFile, pad(12, 'class ScriptVector3 : public PyObject'), 'utf8');
  return { root, pyiFile, headerFile, cppLine: 12 };
};

const entityEntry = (overrides: Partial<PyEntry> = {}): PyEntry => ({
  name: 'Entity',
  kind: 'class',
  sourceFile: 'typings/_KBEngine_common.pyi',
  sourceLine: 67,
  ...overrides
});

describe('resolveEnginePythonDefinition(RUST-174)', () => {
  it('引擎在且锚点复验通过 → 精确 file:line(声明行 startsWith 口径)', () => {
    const tree = makeEngineTree();
    const hit = resolveEnginePythonDefinition(entityEntry(), tree.root, realDeps);
    expect(hit).toEqual({ kind: 'engine-typings', file: tree.pyiFile, line: 67 });
  });

  it('typings 在仓库根(安装根兄弟位,用户自己的引擎 stub)→ 兄弟候选命中', () => {
    // 2026-11-24 用户令:typings 是用户自己的引擎 stub 包,fork 布局在仓库根
    // (安装根的父目录);engineRoot=kbe 目录本身后锚点从兄弟位解析
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engine-sibtyp-'));
    const root = path.join(repo, 'kbe');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(repo, 'typings'), { recursive: true });
    const pad = (line: number, text: string): string =>
      `${Array.from({ length: line - 1 }, () => '# pad').join('\n')}\n${text}\n`;
    const pyiFile = path.join(repo, 'typings', '_KBEngine_common.pyi');
    fs.writeFileSync(pyiFile, pad(67, 'class Entity:'), 'utf8');
    try {
      const hit = resolveEnginePythonDefinition(entityEntry(), root, realDeps);
      expect(hit).toEqual({ kind: 'engine-typings', file: pyiFile, line: 67 });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('文件在而锚点行漂移 → drifted 只给文件,不声称行号', () => {
    const tree = makeEngineTree();
    const drifted = resolveEnginePythonDefinition(entityEntry({ sourceLine: 68 }), tree.root, realDeps);
    expect(drifted).toEqual({ kind: 'engine-typings-drifted', file: tree.pyiFile });
    expect('line' in drifted).toBe(false);
  });

  it('引擎缺席(null 根/文件缺失)→ engine-absent,不伪造', () => {
    expect(resolveEnginePythonDefinition(entityEntry(), null, realDeps)).toEqual({ kind: 'engine-absent' });
    expect(resolveEnginePythonDefinition(entityEntry(), os.tmpdir(), realDeps)).toEqual({ kind: 'engine-absent' });
  });

  it('别名条目回退链 declName=aliasOf:KBEntity 锚到 class Entity 声明行', () => {
    const tree = makeEngineTree();
    const hit = resolveEnginePythonDefinition(
      entityEntry({ name: 'KBEntity', aliasOf: 'Entity' }),
      tree.root,
      realDeps
    );
    expect(hit).toEqual({ kind: 'engine-typings', file: tree.pyiFile, line: 67 });
  });

  it('cppClassName 参与锚点名:Vector3 头文件锚验 class ScriptVector3', () => {
    const tree = makeEngineTree();
    const hit = resolveEnginePythonDefinition(
      entityEntry({
        name: 'Vector3',
        sourceFile: 'src/lib/pyscript/vector3.h',
        sourceLine: 12,
        cppClassName: 'ScriptVector3'
      }),
      tree.root,
      realDeps
    );
    expect(hit).toEqual({ kind: 'engine-typings', file: tree.headerFile, line: 12 });
  });

  it('kind=function → def 锚;读取抛错按漂移处理(不炸不伪造)', () => {
    const tree = makeEngineTree();
    fs.writeFileSync(tree.pyiFile, `${'# pad\n'.repeat(19)}def addTimer(target, interval):\n`, 'utf8');
    expect(resolveEnginePythonDefinition(
      entityEntry({ kind: 'function', name: 'addTimer', sourceLine: 20 }),
      tree.root,
      realDeps
    )).toEqual({ kind: 'engine-typings', file: tree.pyiFile, line: 20 });
    const throwing = { existsSync: () => true, readFileSync: () => { throw new Error('EIO'); } };
    expect(resolveEnginePythonDefinition(entityEntry(), tree.root, throwing)).toEqual({
      kind: 'engine-typings-drifted',
      file: tree.pyiFile
    });
  });
});

describe('resolveEngineCppDefinition(RUST-174)', () => {
  it('cppClassName 命中头文件 class 声明 → 精确 file:line', () => {
    const tree = makeEngineTree();
    const hit = resolveEngineCppDefinition({ cppClassName: 'ScriptVector3' } as CppEntry, tree.root, {
      ...realDeps,
      readdirSync: (candidate: string) => fs.readdirSync(candidate, { withFileTypes: true })
    } satisfies EngineSourceScanDeps);
    expect(hit).toEqual({ kind: 'engine-cpp', file: tree.headerFile, line: tree.cppLine });
  });

  it('确定性:字母序目录先命中胜出(不随 readdir 序漂移)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engine-cpp-'));
    const early = path.join(root, 'src', 'lib', 'aaa');
    const late = path.join(root, 'src', 'lib', 'zzz');
    fs.mkdirSync(early, { recursive: true });
    fs.mkdirSync(late, { recursive: true });
    fs.writeFileSync(path.join(early, 'first.h'), 'class ScriptVector3 : public PyObject\n', 'utf8');
    fs.writeFileSync(path.join(late, 'second.h'), 'class ScriptVector3 : public PyObject\n', 'utf8');
    const scanDeps: EngineSourceScanDeps = {
      ...realDeps,
      readdirSync: (candidate: string) => fs.readdirSync(candidate, { withFileTypes: true })
    };
    const hit = resolveEngineCppDefinition({ cppClassName: 'ScriptVector3' } as CppEntry, root, scanDeps);
    expect(hit).toEqual({ kind: 'engine-cpp', file: path.join(early, 'first.h'), line: 1 });
  });

  it('无 cppClassName → no-cpp-anchor;引擎缺席 → engine-absent(不猜)', () => {
    const scanDeps: EngineSourceScanDeps = {
      ...realDeps,
      readdirSync: (candidate: string) => fs.readdirSync(candidate, { withFileTypes: true })
    };
    expect(resolveEngineCppDefinition({} as CppEntry, makeEngineTree().root, scanDeps)).toEqual({ kind: 'no-cpp-anchor' });
    expect(resolveEngineCppDefinition({ cppClassName: 'ScriptVector3' } as CppEntry, null, scanDeps)).toEqual({ kind: 'engine-absent' });
  });

  it('扫描未见如实 not-found:类不存在/搜索根缺失/声明只在非 .h 文件', () => {
    const scanDeps: EngineSourceScanDeps = {
      ...realDeps,
      readdirSync: (candidate: string) => fs.readdirSync(candidate, { withFileTypes: true })
    };
    const tree = makeEngineTree();
    expect(resolveEngineCppDefinition({ cppClassName: 'ScriptFoo' } as CppEntry, tree.root, scanDeps)).toEqual({ kind: 'cpp-not-found' });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engine-bare-'));
    expect(resolveEngineCppDefinition({ cppClassName: 'ScriptVector3' } as CppEntry, bare, scanDeps)).toEqual({ kind: 'cpp-not-found' });
    fs.mkdirSync(path.join(bare, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'src', 'lib', 'vector3.cpp'), 'class ScriptVector3 : public PyObject\n', 'utf8');
    expect(resolveEngineCppDefinition({ cppClassName: 'ScriptVector3' } as CppEntry, bare, scanDeps)).toEqual({ kind: 'cpp-not-found' });
  });
});

describe('describeEngineApiConstraint(RUST-174)', () => {
  it('baseline → 无标注;fork 档在官方语境 → 带「需 fork」标注', () => {
    expect(describeEngineApiConstraint({}, '3.7.3')).toEqual({
      layer: 'baseline',
      annotated: false,
      annotation: null
    });
    const forked = describeEngineApiConstraint({ version: 'fork' }, '3.7.3');
    expect(forked.layer).toBe('fork');
    expect(forked.annotated).toBe(true);
    expect(forked.annotation).toContain('fork');
  });

  it('fork 语境(fork- 设置)→ 标注关闭;pending → 待取证标注恒在', () => {
    const forkContext = describeEngineApiConstraint({ version: 'fork' }, 'fork-3.12');
    expect(forkContext).toEqual({ layer: 'fork', annotated: false, annotation: null });
    const pending = describeEngineApiConstraint({ version: 'pending' }, '3.7.3');
    expect(pending.layer).toBe('pending');
    expect(pending.annotated).toBe(true);
    expect(pending.annotation).not.toBeNull();
  });
});

describe('kbengine.api.engineSource 命令装配(RUST-174)', () => {
  beforeEach(resetExtensionTestState);

  const activateWithRoot = (root: string): ExtensionContext => {
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context: ExtensionContext = makeContext();
    activate(context);
    return context;
  };

  const pickByLabel = (label: string): void => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string }>;
      return resolved.find(item => item.label === label);
    };
    return () => { windowish.showQuickPick = originalQuickPick; };
  };

  it('引擎在 + pyi 锚 → 选中 Python 定义项,reveal 精确 file:line(0 基 selection)', async () => {
    const tree = makeEngineTree();
    const context = activateWithRoot(tree.root);
    const restore = pickByLabel('Engine Python definition (typings)');
    try {
      await commands.executeCommand('kbengine.api.engineSource', 'Entity');
      const opened = workspaceState.openTextDocumentCalls.at(-1) as { fsPath: string } | undefined;
      expect(opened?.fsPath).toBe(tree.pyiFile);
      const shown = windowState.showTextDocumentCalls.at(-1);
      expect((shown?.options as { selection?: { start: { line: number } } } | undefined)?.selection?.start.line).toBe(66);
    } finally {
      restore();
      deactivate();
      void context;
    }
  });

  it('Vector3:头文件锚标签如实分型 + C++ 面同列;选中 C++ 项开头文件', async () => {
    const tree = makeEngineTree();
    const context = activateWithRoot(tree.root);
    let seenLabels: string[] = [];
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string }>;
      seenLabels = resolved.map(item => item.label);
      return resolved.find(item => item.label === 'Engine C++ declaration');
    };
    try {
      await commands.executeCommand('kbengine.api.engineSource', 'Vector3');
      expect(seenLabels).toContain('Engine source anchor (header)');
      expect(seenLabels).toContain('Engine C++ declaration');
      expect(seenLabels).toContain('Built-in stub document');
      const opened = workspaceState.openTextDocumentCalls.at(-1) as { fsPath: string } | undefined;
      expect(opened?.fsPath).toBe(tree.headerFile);
    } finally {
      windowish.showQuickPick = originalQuickPick;
      deactivate();
      void context;
    }
  });

  it('引擎缺席 → 不出 QuickPick,如实提示并直接开内置桩(锚到桩内符号行)', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-engine-none-'));
    const context = activateWithRoot(bare);
    let quickPickCalled = 0;
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    windowish.showQuickPick = async (): Promise<undefined> => {
      quickPickCalled += 1;
      return undefined;
    };
    const infoBaseline = messages.info.length;
    try {
      await commands.executeCommand('kbengine.api.engineSource', 'Entity');
      expect(quickPickCalled).toBe(0);
      expect(messages.info.length).toBe(infoBaseline + 1);
      const opened = workspaceState.openTextDocumentCalls.at(-1) as { scheme?: string } | undefined;
      expect(opened?.scheme).toBe('kbe-stub');
      const shown = windowState.showTextDocumentCalls.at(-1);
      const stubLine = buildKbeStubDocument(null).symbolLines['Entity'] ?? 0;
      expect((shown?.options as { selection?: { start: { line: number } } } | undefined)?.selection?.start.line).toBe(stubLine);
    } finally {
      windowish.showQuickPick = originalQuickPick;
      deactivate();
      void context;
    }
  });

  it('锚点漂移 → 项如实标注不声称行号,reveal 只开文件无 selection', async () => {
    const tree = makeEngineTree();
    fs.writeFileSync(tree.pyiFile, `${'# pad\n'.repeat(65)}class Entity:\n`, 'utf8');
    const context = activateWithRoot(tree.root);
    const restore = pickByLabel('Engine typings file (anchor drifted; line not claimed)');
    try {
      await commands.executeCommand('kbengine.api.engineSource', 'Entity');
      const opened = workspaceState.openTextDocumentCalls.at(-1) as { fsPath: string } | undefined;
      expect(opened?.fsPath).toBe(tree.pyiFile);
      const shown = windowState.showTextDocumentCalls.at(-1);
      expect(shown?.options).toBeUndefined();
    } finally {
      restore();
      deactivate();
      void context;
    }
  });

  it('非 KBEngine 符号参数 → 诚实警告拒绝,零导航零 QuickPick', async () => {
    const tree = makeEngineTree();
    const context = activateWithRoot(tree.root);
    let quickPickCalled = 0;
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    windowish.showQuickPick = async (): Promise<undefined> => {
      quickPickCalled += 1;
      return undefined;
    };
    const warnBaseline = messages.warning.length;
    try {
      await commands.executeCommand('kbengine.api.engineSource', 'NoSuchKbeSymbol');
      expect(quickPickCalled).toBe(0);
      expect(messages.warning.length).toBe(warnBaseline + 1);
      expect(workspaceState.openTextDocumentCalls.length).toBe(0);
    } finally {
      windowish.showQuickPick = originalQuickPick;
      deactivate();
      void context;
    }
  });
});
