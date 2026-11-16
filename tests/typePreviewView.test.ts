import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  registerTypePreviewView,
  TYPE_PREVIEW_VIEW_ID,
  TYPE_PREVIEW_JUMP_COMMAND,
  TYPE_PREVIEW_REFRESH_COMMAND,
  type TypePreviewViewDeps
} from '../src/typePreviewView';
import { buildTypePreviewModel, type TypePreviewInput, type TypePreviewJump, type TypePreviewNode } from '../src/backend/typePreviewModel';
import type { EntityTypeStubEntry } from '../src/entityTypeStubs';

// RUST-167 适配层:TreeItem 面(跳转命令参数/折叠态/描述)、注册面、刷新事件、
// 跳转执行面接线。

const makeInput = (): TypePreviewInput => ({
  entities: [
    {
      entity: 'Avatar',
      properties: [{ name: 'hp', annotation: 'int', sourceLine: 4 }],
      methods: []
    }
  ] as unknown as EntityTypeStubEntry[],
  entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']]),
  customTypes: [],
  typeEntries: [],
  typeSkipped: []
});

const makeDeps = (overrides: Partial<TypePreviewViewDeps> = {}): TypePreviewViewDeps & {
  registered: Array<{ id: string; provider: unknown }>;
  commandHandlers: Map<string, (...args: never[]) => unknown>;
  opened: TypePreviewJump[];
} => {
  const registered: Array<{ id: string; provider: unknown }> = [];
  const commandHandlers = new Map<string, (...args: never[]) => unknown>();
  const opened: TypePreviewJump[] = [];
  return {
    registered,
    commandHandlers,
    opened,
    registerTreeDataProvider: (viewId, provider) => {
      registered.push({ id: viewId, provider });
      return { dispose: (): void => undefined };
    },
    registerCommand: (id, callback) => {
      commandHandlers.set(id, callback);
      return { dispose: (): void => undefined };
    },
    openSource: (jump) => {
      opened.push(jump);
    },
    getModel: () => buildTypePreviewModel(makeInput()),
    ...overrides
  } as TypePreviewViewDeps & { registered: Array<{ id: string; provider: unknown }>; commandHandlers: Map<string, (...args: never[]) => unknown>; opened: TypePreviewJump[] };
};

describe('typePreviewView 适配层', () => {
  it('注册面:视图 id 与两条命令各就位', () => {
    const deps = makeDeps();
    registerTypePreviewView(deps);
    expect(deps.registered.map(entry => entry.id)).toEqual([TYPE_PREVIEW_VIEW_ID]);
    expect(deps.commandHandlers.has(TYPE_PREVIEW_JUMP_COMMAND)).toBe(true);
    expect(deps.commandHandlers.has(TYPE_PREVIEW_REFRESH_COMMAND)).toBe(true);
  });

  it('TreeItem 面:叶子带跳转命令参数;分组可展开;描述透传', () => {
    const deps = makeDeps();
    const handle = registerTypePreviewView(deps);
    const provider = deps.registered[0].provider as vscode.TreeDataProvider<TypePreviewNode>;
    const rootChildren = provider.getChildren!();
    expect(rootChildren.length).toBeGreaterThanOrEqual(2);
    const entityGroup = rootChildren.find(node => node.label.startsWith('实体'))!;
    const item = provider.getTreeItem!(entityGroup);
    expect(item.label).toBe(entityGroup.label);
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(item.command).toBeUndefined();

    const leaf = entityGroup.children![0].children![0];
    const leafItem = provider.getTreeItem!(leaf);
    expect(leafItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(leafItem.command).toEqual({
      command: TYPE_PREVIEW_JUMP_COMMAND,
      title: '跳转来源',
      arguments: [{ uri: '/ws/scripts/entity_defs/Avatar.def', line: 4 }]
    });
    handle.dispose();
  });

  it('覆盖叶子带描述;跳转命令执行落 openSource;刷新命令触发事件', async () => {
    const deps = makeDeps();
    const handle = registerTypePreviewView(deps);
    const provider = deps.registered[0].provider as vscode.TreeDataProvider<TypePreviewNode>;
    const coverageLeaf = provider.getChildren!()[0];
    expect(coverageLeaf.label).toContain('typing 覆盖');
    expect(provider.getTreeItem!(coverageLeaf).description).toContain('Any');

    const fired: unknown[] = [];
    provider.onDidChangeTreeData!((): void => {
      fired.push(1);
    });
    await deps.commandHandlers.get(TYPE_PREVIEW_JUMP_COMMAND)!({ uri: '/ws/a.def', line: 7 } as never);
    expect(deps.opened).toEqual([{ uri: '/ws/a.def', line: 7 }]);
    expect(fired).toHaveLength(0);
    await deps.commandHandlers.get(TYPE_PREVIEW_REFRESH_COMMAND)!();
    expect(fired).toHaveLength(1);
    handle.refresh();
    expect(fired).toHaveLength(2);
    handle.dispose();
  });

  it('dispose 后登记替身的 dispose 面被收口', () => {
    const deps = makeDeps();
    const disposer = vi.fn();
    deps.registerTreeDataProvider = ((_viewId: string, _provider: unknown) => ({ dispose: disposer })) as never;
    const handle = registerTypePreviewView(deps);
    handle.dispose();
    expect(disposer).toHaveBeenCalled();
  });

  it('getModel 在根 getChildren 现算:两次取根各自调用', () => {
    const getModel = vi.fn(() => buildTypePreviewModel(makeInput()));
    const deps = makeDeps({ getModel } as Partial<TypePreviewViewDeps>);
    const handle = registerTypePreviewView(deps);
    const provider = deps.registered[0].provider as vscode.TreeDataProvider<TypePreviewNode>;
    provider.getChildren!();
    provider.getChildren!();
    expect(getModel).toHaveBeenCalledTimes(2);
    handle.dispose();
  });
});
