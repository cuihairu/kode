import * as http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// HTTP 快捷请求装配层(批105):activate 注册两条命令、quick pick 列表
// 驱动、args.name 具名运行、模板变量经活动编辑器提取落到真 TCP 服务端、
// 输出通道在位与 dispose 链拆除。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const setEntries = (entries: unknown[]): void => {
  configurationOverrides.set('kbengine', {
    ...configurationOverrides.get('kbengine'),
    httpRequests: entries
  });
};

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: '热更',
  url: 'http://127.0.0.1:9/never',
  method: 'GET',
  headers: {},
  body: '',
  enabled: true,
  keybinding: '',
  ...over
});

const servers: http.Server[] = [];

const listen = (handler: http.RequestListener): Promise<number> =>
  new Promise(resolve => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as http.AddressInfo).port);
    });
  });

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
});

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  configurationOverrides.clear();
  workspace.workspaceFolders = [];
  // 活动编辑器默认无:模板变量如实落空串
  (fakeWindow as unknown as Record<string, unknown>).activeTextEditor = undefined;
});

describe('kbengine.httpRequests 命令装配', () => {
  it('两条命令注册在位;输出通道就绪', () => {
    const context = makeContext();
    activate(context);

    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.httpRequests.run');
    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.httpRequest.run');
    expect(windowState.channels.map(channel => channel.name)).toContain('KBEngine HTTP 快捷请求');

    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
    expect(commandRegistry.registeredCommandIds()).not.toContain('kbengine.httpRequests.run');
    const channel = windowState.channels.find(item => item.name === 'KBEngine HTTP 快捷请求');
    expect(channel?.disposed).toBe(true);
  });

  it('无启用条目:quick pick 前置拦截并如实提示', async () => {
    const context = makeContext();
    activate(context);
    setEntries([entry({ enabled: false })]);

    await commands.executeCommand('kbengine.httpRequests.run');

    expect(messages.info[0]).toContain('没有已启用的 HTTP 快捷请求');
    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('quick pick 选中条目 → 真执行(URL 命中真 TCP 服务端);取消不执行', async () => {
    const port = await listen((_req, res) => {
      res.end('hotfix-ok');
    });
    const context = makeContext();
    activate(context);
    setEntries([
      entry({ url: `http://127.0.0.1:${port}/hotfix`, keybinding: 'ctrl+alt+h' }),
      entry({ name: '第二条', url: `http://127.0.0.1:${port}/hotfix`, keybinding: '' })
    ]);
    const quickItems: Array<{ label: string; description: string; detail?: string }> = [];
    (fakeWindow as unknown as Record<string, unknown>).showQuickPick = async (items: unknown) => {
      quickItems.push(...(items as Array<{ label: string; description: string }>));
      return undefined; // 先取消
    };

    await commands.executeCommand('kbengine.httpRequests.run');
    expect(quickItems[0].label).toBe('热更');
    expect(quickItems[0].description).toBe(`GET http://127.0.0.1:${port}/hotfix`);
    expect(quickItems[0].detail).toBe('键位: ctrl+alt+h');
    expect(quickItems[1].label).toBe('第二条');
    expect(quickItems[1].detail).toBeUndefined(); // 空键位不出 detail
    const channel = windowState.channels.find(item => item.name === 'KBEngine HTTP 快捷请求')!;
    expect(channel.lines).toHaveLength(0); // 取消:无请求无流水

    (fakeWindow as unknown as Record<string, unknown>).showQuickPick = async (items: unknown) =>
      (items as Array<unknown>)[0]; // 选中首项

    await commands.executeCommand('kbengine.httpRequests.run');
    expect(channel.lines.join('')).toContain('hotfix-ok');

    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('args.name 具名运行:模板变量经活动编辑器提取后命中服务端', async () => {
    let seenUrl = '';
    const port = await listen((req, res) => {
      seenUrl = req.url ?? '';
      res.end('done');
    });
    const context = makeContext();
    activate(context);
    setEntries([entry({
      url: `http://127.0.0.1:${port}/hotfix?module_name=\${module}&line=\${line}&sel=\${sel}`
    })]);
    workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } } as never];
    (fakeWindow as unknown as Record<string, unknown>).activeTextEditor = {
      document: {
        uri: { fsPath: '/ws/entities/fight/FightAI.py' },
        getText: () => 'self.hp'
      },
      selection: { active: { line: 9 } }
    };

    await commands.executeCommand('kbengine.httpRequest.run', { name: '热更' });

    expect(seenUrl).toBe(
      '/hotfix?module_name=entities.fight.FightAI&line=10&sel=self.hp'
    );
    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('无工作区(workspaceFolders 未定义):${module} 如实退文件名,请求照发', async () => {
    let seenUrl = '';
    const port = await listen((req, res) => {
      seenUrl = req.url ?? '';
      res.end('done');
    });
    const context = makeContext();
    activate(context);
    setEntries([entry({ url: `http://127.0.0.1:${port}/hotfix?module_name=\${module}` })]);
    (workspace as unknown as Record<string, unknown>).workspaceFolders = undefined;

    await commands.executeCommand('kbengine.httpRequest.run', { name: '热更' });
    // /tmp 之外的文件不在任何根下:退文件名去 .py
    (fakeWindow as unknown as Record<string, unknown>).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/other/Foo.py' }, getText: () => '' },
      selection: { active: { line: 0 } }
    };
    await commands.executeCommand('kbengine.httpRequest.run', { name: '热更' });

    expect(seenUrl).toBe('/hotfix?module_name=Foo');
    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('无 args.name:警告指路;未知名:错误回执', async () => {
    const context = makeContext();
    activate(context);
    setEntries([entry()]);

    await commands.executeCommand('kbengine.httpRequest.run');
    expect(messages.warning[0]).toContain('args.name');

    await commands.executeCommand('kbengine.httpRequest.run', { name: '没有这条' });
    expect(messages.error[0]).toContain('「没有这条」不存在或已停用');

    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });
});
