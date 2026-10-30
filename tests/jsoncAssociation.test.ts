import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  JSONC_ASSOCIATION_CHANNEL_NAME,
  JSONC_ASSOCIATION_LANGUAGE,
  JSONC_ASSOCIATION_MANAGED_KEY,
  JSONC_ASSOCIATION_PATTERN,
  disableJsoncAssociation,
  syncJsoncAssociation
} from '../src/jsoncAssociation';
import {
  channels,
  configurationOverrides,
  messages,
  Uri,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// debug.json 的 jsonc 文件关联(用户令 2026-10-27 ②):托管口径照抄
// pythonExtraPaths——只动 "**/.kbengine/debug.json" 这一个键,已有值不覆盖,
// 写入用 workspaceState 记账,关闭命令只回收「自己写过且值未被改过」的键。
// scope 修正(审计 F18):files.associations 是 window scope,真机确认
// WorkspaceFolder(folder resource)写入被拒,统一走工作区级 Workspace——
// 单根写 <root>/.vscode/settings.json,多根写 .code-workspace settings 段一次写共享;
// 拒绝更新/只读配置记录原因到 OUTPUT 通道,无未处理 Promise。

const memento = new Map<string, unknown>();

const makeContext = (): vscode.ExtensionContext =>
  ({
    subscriptions: [],
    workspaceState: {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      // 真 Memento 语义:update(key, undefined) 是移除;plain Map 会留下
      // has=true 的 undefined 槽,这里对齐真实行为(关闭命令靠它清记账)
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) {
          memento.delete(key);
        } else {
          memento.set(key, value);
        }
      }
    }
  }) as unknown as vscode.ExtensionContext;

const folderOf = (root: string, index = 0) => ({ uri: Uri.file(root), name: root, index });

const singleRoot = '/ws';

describe('syncJsoncAssociation(装配层)', () => {
  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    channels.length = 0;
    workspaceState.reset();
    memento.clear();
  });

  it('默认开:无现有关联时写 Workspace 级(单根)并记账', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates).toEqual([
      {
        key: 'files.associations',
        value: { [JSONC_ASSOCIATION_PATTERN]: JSONC_ASSOCIATION_LANGUAGE },
        scope: vscode.ConfigurationTarget.Workspace,
        folder: undefined
      }
    ]);
    expect(memento.get(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws`)).toBe(JSONC_ASSOCIATION_LANGUAGE);
    expect(messages.info[0]).toContain('已写入');
    stubWorkspace.workspaceFolders = [];
  });

  it('静默模式(激活期约定):写入照做,全程零提示', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext(), { silent: true });

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('设置关闭时说明并返回,不写任何配置;静默则零提示', async () => {
    configurationOverrides.set('kbengine', { jsoncAssociation: false });
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext());
    expect(messages.info[0]).toContain('已关闭');
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);

    messages.info.length = 0;
    await syncJsoncAssociation(makeContext(), { silent: true });
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('未打开工作区时如实说明;静默跳过', async () => {
    stubWorkspace.workspaceFolders = [];

    await syncJsoncAssociation(makeContext());
    expect(messages.info[0]).toContain('未打开工作区');
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);

    messages.info.length = 0;
    await syncJsoncAssociation(makeContext(), { silent: true });
    expect(messages.info).toHaveLength(0);
  });

  it('pattern 键已有值(用户手填)永不覆盖:零写入零记账', async () => {
    configurationOverrides.set('files', { associations: { [JSONC_ASSOCIATION_PATTERN]: 'json5' } });
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    expect(memento.size).toBe(0);
    // 无事发生不打扰(与「无可发现根」同口径)
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('pattern 键已是 jsonc(上轮写入/用户同值手填)幂等零写入', async () => {
    configurationOverrides.set('files', { associations: { [JSONC_ASSOCIATION_PATTERN]: 'jsonc' } });
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('用户其他键保全:合并写入,旧键一个不丢', async () => {
    configurationOverrides.set('files', { associations: { '*.mytype': 'json5' } });
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates[0].value).toEqual({
      '*.mytype': 'json5',
      [JSONC_ASSOCIATION_PATTERN]: 'jsonc'
    });
    stubWorkspace.workspaceFolders = [];
  });

  it('associations 配置值不是对象时按没有现值处理,不炸(extraPaths 口径)', async () => {
    configurationOverrides.set('files', { associations: 'oops' });
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates[0].value).toEqual({
      [JSONC_ASSOCIATION_PATTERN]: JSONC_ASSOCIATION_LANGUAGE
    });
    stubWorkspace.workspaceFolders = [];
  });

  it('多根工作区:files.associations 是 window scope 共享,写一次 Workspace 级,记账按 .code-workspace 身份', async () => {
    (stubWorkspace as Record<string, unknown>).workspaceFile = Uri.file('/ws.code-workspace');
    stubWorkspace.workspaceFolders = [folderOf('/ws', 0), folderOf('/other', 1)];

    await syncJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(1);
    expect(workspaceState.workspaceConfigurationUpdates[0].scope).toBe(vscode.ConfigurationTarget.Workspace);
    expect(workspaceState.workspaceConfigurationUpdates[0].folder).toBeUndefined();
    expect(memento.get(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws.code-workspace`)).toBe('jsonc');
    expect(memento.size).toBe(1);
    stubWorkspace.workspaceFolders = [];
    delete (stubWorkspace as Record<string, unknown>).workspaceFile;
  });

  it('极简装配上下文(无 workspaceState)照常写配置,只是不记账', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];

    await syncJsoncAssociation({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(1);
    expect(memento.size).toBe(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('F18 收口:Workspace 写入被拒(只读/拒绝)时记录原因到 OUTPUT,不抛,无未处理 Promise', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    const original = stubWorkspace.getConfiguration;
    stubWorkspace.getConfiguration = ((section?: string, scope?: unknown) => {
      const base = original(section, scope);
      return {
        ...base,
        update: async (key: string, value: unknown, target: unknown): Promise<void> => {
          if (target === vscode.ConfigurationTarget.Workspace) {
            throw new Error('read-only settings.json');
          }
          await base.update(key, value, target);
        }
      };
    }) as typeof stubWorkspace.getConfiguration;
    try {
      await syncJsoncAssociation(makeContext());
      const record = channels.find(channel => channel.name === JSONC_ASSOCIATION_CHANNEL_NAME);
      expect(record).toBeDefined();
      expect(record!.lines.some(line => line.includes('read-only settings.json'))).toBe(true);
      expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
      expect(memento.size).toBe(0);
    } finally {
      stubWorkspace.getConfiguration = original;
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('F18 收口:静默模式拒绝也记录 OUTPUT,但不弹窗不抛(激活期约定)', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    const original = stubWorkspace.getConfiguration;
    stubWorkspace.getConfiguration = ((section?: string, scope?: unknown) => {
      const base = original(section, scope);
      return {
        ...base,
        update: async (key: string, value: unknown, target: unknown): Promise<void> => {
          if (target === vscode.ConfigurationTarget.Workspace) {
            throw new Error('configuration is read-only');
          }
          await base.update(key, value, target);
        }
      };
    }) as typeof stubWorkspace.getConfiguration;
    try {
      await syncJsoncAssociation(makeContext(), { silent: true });
      expect(channels.some(channel => channel.lines.some(line => line.includes('configuration is read-only')))).toBe(true);
      expect(messages.info).toHaveLength(0);
      expect(messages.warning).toHaveLength(0);
    } finally {
      stubWorkspace.getConfiguration = original;
      stubWorkspace.workspaceFolders = [];
    }
  });
});

describe('disableJsoncAssociation(关闭命令)', () => {
  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    channels.length = 0;
    workspaceState.reset();
    memento.clear();
  });

  it('回收自己写的键:其余键保留、记账清除、开关翻 false(用户级)', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    const context = makeContext();
    // 模拟上一轮:已写入并记账,当前配置含本扩展键 + 用户键
    memento.set(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws`, 'jsonc');
    configurationOverrides.set('files', {
      associations: { '*.mytype': 'json5', [JSONC_ASSOCIATION_PATTERN]: 'jsonc' }
    });

    await disableJsoncAssociation(context);

    const updates = workspaceState.workspaceConfigurationUpdates;
    expect(updates[0]).toEqual({
      key: 'kbengine.jsoncAssociation',
      value: false,
      scope: vscode.ConfigurationTarget.Global,
      folder: undefined
    });
    expect(updates[1]).toEqual({
      key: 'files.associations',
      value: { '*.mytype': 'json5' },
      scope: vscode.ConfigurationTarget.Workspace,
      folder: undefined
    });
    expect(memento.has(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws`)).toBe(false);
    expect(messages.info[0]).toContain('已移除');
    stubWorkspace.workspaceFolders = [];
  });

  it('回收后 associations 无剩余键时整项移除(undefined),不留空对象', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    memento.set(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws`, 'jsonc');
    configurationOverrides.set('files', { associations: { [JSONC_ASSOCIATION_PATTERN]: 'jsonc' } });

    await disableJsoncAssociation(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates[1].value).toBeUndefined();
    stubWorkspace.workspaceFolders = [];
  });

  it('值被用户改过(≠记账值)不回收:只翻开关,现有值一律未动', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    memento.set(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws`, 'jsonc');
    configurationOverrides.set('files', { associations: { [JSONC_ASSOCIATION_PATTERN]: 'json5' } });

    await disableJsoncAssociation(makeContext());

    const updates = workspaceState.workspaceConfigurationUpdates;
    expect(updates).toHaveLength(1); // 只有开关那一笔
    expect(updates[0].key).toBe('kbengine.jsoncAssociation');
    expect(messages.info[0]).toContain('一律未动');
    stubWorkspace.workspaceFolders = [];
  });

  it('从未写过(无记账)时只翻开关,零回收零误删', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    configurationOverrides.set('files', {
      associations: { [JSONC_ASSOCIATION_PATTERN]: 'jsonc' } // 用户自己手填的同值键
    });

    await disableJsoncAssociation(makeContext());

    const updates = workspaceState.workspaceConfigurationUpdates;
    expect(updates).toHaveLength(1);
    expect(updates[0].key).toBe('kbengine.jsoncAssociation');
    expect(messages.info[0]).toContain('一律未动');
    stubWorkspace.workspaceFolders = [];
  });

  it('未打开工作区:只翻开关,无关联可回收', async () => {
    stubWorkspace.workspaceFolders = [];

    await disableJsoncAssociation(makeContext());

    const updates = workspaceState.workspaceConfigurationUpdates;
    expect(updates).toHaveLength(1);
    expect(updates[0].key).toBe('kbengine.jsoncAssociation');
    expect(messages.info[0]).toContain('未打开工作区');
  });

  it('回收写入被拒(只读)时记录原因到 OUTPUT,不抛,开关已翻 false', async () => {
    stubWorkspace.workspaceFolders = [folderOf(singleRoot)];
    memento.set(`${JSONC_ASSOCIATION_MANAGED_KEY}:/ws`, 'jsonc');
    configurationOverrides.set('files', { associations: { [JSONC_ASSOCIATION_PATTERN]: 'jsonc' } });
    const original = stubWorkspace.getConfiguration;
    stubWorkspace.getConfiguration = ((section?: string, scope?: unknown) => {
      const base = original(section, scope);
      return {
        ...base,
        update: async (key: string, value: unknown, target: unknown): Promise<void> => {
          if (target === vscode.ConfigurationTarget.Workspace) {
            throw new Error('settings.json is read-only');
          }
          await base.update(key, value, target);
        }
      };
    }) as typeof stubWorkspace.getConfiguration;
    try {
      await disableJsoncAssociation(makeContext());
      expect(channels.some(channel => channel.lines.some(line => line.includes('settings.json is read-only')))).toBe(true);
      // 开关仍翻 false(用户意图),回收失败有记录,不吞不抛
      expect(workspaceState.workspaceConfigurationUpdates[0].key).toBe('kbengine.jsoncAssociation');
      expect(messages.info[0]).toContain('已移除');
    } finally {
      stubWorkspace.getConfiguration = original;
      stubWorkspace.workspaceFolders = [];
    }
  });
});
