// DebugConfigManager 的批112 核心用面:startDebugging 的 modal 提示两分支
// (有/无 telnet 命令)、attachToComponent 的进程选择(按组件名过滤的 quick
// pick,选中 PID 直接写入 DebugConfiguration)、createExampleConfig/
// updateLaunchJson 的写盘失败通道、attachRemote + readRemoteTargets 远程
// 目标装载。模式分派/截止取消/端口探测/远程分派见
// debugConfigAttachModes.test.ts 与 debugConfigAttachConnect.test.ts。

import { describe, expect, it } from 'vitest';
import { DebugConfigManager, readRemoteTargets } from '../src/debugConfig';
import type * as vscode from 'vscode';
import {
  seededMemento,
  windowish,
  inputOptions,
  infoQueue,
  pickQueue,
  pickOffers,
  messages,
  debugCalls,
  QuickPickLike,
  makeManager,
  setWorkspaceAt,
  flushAsync,
  setDebugResult,
  setDebugThrows,
  stubWorkspace,
  memoryFileSystem,
  registerAttachTestHooks
} from './helpers/debugConfigAttachHarness';
import { configurationOverrides } from './fake-vscode/workspaceState';

registerAttachTestHooks();

describe('DebugConfigManager.startDebugging', () => {
  it('shows the modal briefing with telnet commands and attaches on confirm', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    // KR-AUD-41:简报里的密码/命令行来自用户配置,不再有默认密码可引用——
    // 该用例显式配置以锁定「配置了就如实展示」的既有语义
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            baseapp: { telnetPassword: 's3cret', telnetEnableCommands: ['# 开调试命令'] }
          }
        }
      })
    );
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }]);
    await flushAsync();
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });
    const config = manager.getComponentConfig('baseapp');
    infoQueue.push('继续附加');

    const result = await manager.startDebugging('baseapp');

    expect(result).toBe(true);
    expect(messages.info).toHaveLength(1);
    const message = messages.info[0];
    expect(message).toContain('telnet 控制端口');
    expect(message).toContain(`telnet ${config.telnetHost} ${config.telnetPort}`);
    // 配置了的密码如实展示(不改动用户现有配置语义)
    expect(message).toContain(`password: ${config.telnetPassword}`);
    expect(message).toContain(`default layer: ${config.telnetDefaultLayer}`);
    for (const command of config.telnetEnableCommands ?? []) {
      expect(message).toContain(command);
    }
    // 密码已配置:不发缺配置警告
    expect(messages.warn).toHaveLength(0);

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach to baseapp');
    expect(attachConfig.request).toBe('attach');
    // 批112 用户令:附加前经进程选择器选进程,PID 直接写入配置(不再走
    // ${command:pickProcess} 原生选择器)
    expect(attachConfig.processId).toBe(4321);
    expect(attachConfig.pathMappings).toEqual(config.pathMappings);
    expect(attachConfig.justMyCode).toBe(false);
    // 选择器形态下扩展自身不再弹输入框
    expect(inputOptions).toHaveLength(0);
  }, 8000);

  it('shows the short briefing when the component has no telnet commands', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const config = manager.getComponentConfig('cellapp');
    infoQueue.push(undefined);

    const result = await manager.startDebugging('cellapp');

    expect(result).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain(`telnet ${config.telnetHost} ${config.telnetPort}`);
  }, 8000);

  it('lists configured telnet enable commands in the long briefing', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            baseapp: { telnetEnableCommands: ['layer 1', 'lookup 123'] }
          }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    const result = await manager.startDebugging('baseapp');

    // 长 briefing 分支:逐条列出开启调试的 telnet 命令;看完即取消不进附加
    expect(result).toBe(false);
    expect(debugCalls).toHaveLength(0);
    const message = messages.info[0];
    expect(message).toContain('以 telnet 控制端口为前提');
    expect(message).toContain('telnet 127.0.0.1 0');
    expect(message).toContain('layer 1');
    expect(message).toContain('lookup 123');
  }, 8000);

  it('keeps host/port/layer defaults but reports missing telnet password explicitly', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            cellapp: { telnetHost: '', telnetPort: 0, telnetPassword: '', telnetDefaultLayer: '' }
          }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    const result = await manager.startDebugging('cellapp');

    // KR-AUD-41:主机/端口/层级仍走文档默认,但密码无默认回落——显式空值
    // 与缺省同观感,简报如实报未配置并另发显式警告,不再编造 pwd123456
    expect(result).toBe(false);
    expect(messages.info[0]).toContain('telnet 127.0.0.1 0');
    expect(messages.info[0]).toContain('password: 未配置');
    expect(messages.info[0]).not.toContain('pwd123456');
    expect(messages.info[0]).toContain('default layer: python');
    expect(messages.warn[0]).toContain('未配置 telnet 密码');
    expect(messages.warn[0]).toContain('telnetPassword');
  }, 8000);

  it('uses the literal host fallback when the merged host is empty', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    // 合并层 defaultTelnetHost 置空串:getComponentConfig 吐出空主机,
    // 提示层的 '127.0.0.1' 字面量兜底由此可达
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          defaultTelnetHost: '',
          components: { cellapp: {} }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    expect(await manager.startDebugging('cellapp')).toBe(false);
    expect(messages.info[0]).toContain('telnet 127.0.0.1 0');
  }, 8000);

  it('propagates a false startDebugging result', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'loginapp' }]);
    pickQueue.push({ label: '$(check) loginapp', description: '4321' });
    infoQueue.push('继续附加');
    setDebugResult(false);

    expect(await manager.startDebugging('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('reports startDebugging failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'loginapp' }]);
    pickQueue.push({ label: '$(check) loginapp', description: '4321' });
    infoQueue.push('继续附加');
    setDebugThrows(new Error('no debugpy'));

    const result = await manager.startDebugging('loginapp');

    expect(result).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);
});

describe('DebugConfigManager.attachToComponent (批112 进程选择器)', () => {
  it('进程选择后以数字 PID 组装附加配置,不带输入框', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([
      { pid: 1, name: 'systemd' },
      { pid: 4321, name: 'baseapp' }
    ]);
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach to baseapp');
    expect(attachConfig.type).toBe('debugpy');
    expect(attachConfig.request).toBe('attach');
    expect(attachConfig.processId).toBe(4321);
    expect(attachConfig.justMyCode).toBe(false);
    expect(inputOptions).toHaveLength(0);
  }, 8000);

  it('匹配组件名的进程置顶并带 $(check) 标记', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([
      { pid: 1, name: 'systemd' },
      { pid: 40001, name: 'BASEAPP' }, // 大小写不敏感命中
      { pid: 4321, name: 'baseapp' },
      { pid: 4322, name: 'cellapp' }
    ]);
    let offered: QuickPickLike[] = [];
    windowish.showQuickPick = async (items: QuickPickLike[]) => {
      offered = items;
      return pickQueue.shift();
    };
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });

    await manager.attachToComponent('baseapp');

    expect(offered.map(item => item.label)).toEqual([
      '$(check) BASEAPP',
      '$(check) baseapp',
      'systemd',
      'cellapp'
    ]);
    windowish.showQuickPick = async (items: QuickPickLike[]) => {
      pickOffers.push(items);
      return pickQueue.shift();
    };
  }, 8000);

  it('选择器取消 → 不附加(false 且无 startDebugging)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }]);
    pickQueue.push(undefined);

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('进程清单为空 → 错误提示且不附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([]);

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.error[0]).toContain('未获取到进程列表');
  }, 8000);

  it('reports failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4322, name: 'cellapp' }]);
    pickQueue.push({ label: '$(check) cellapp', description: '4322' });
    setDebugThrows(new Error('no debugpy'));

    expect(await manager.attachToComponent('cellapp')).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);

  it('propagates a false startDebugging result without error spam', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'loginapp' }]);
    pickQueue.push({ label: '$(check) loginapp', description: '4321' });
    setDebugResult(false);

    expect(await manager.attachToComponent('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('default 清单器走真 ps(注入缺省臂),选择取消收尾', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const bareManager = new DebugConfigManager(
      { subscriptions: [], workspaceState: seededMemento('process-attach') } as unknown as vscode.ExtensionContext
    );
    pickQueue.push(undefined);

    // 真机 ps 至少能看到 ps 自身/node 测试进程;取消选择即整体不附加
    expect(await bareManager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
  }, 8000);
});

describe('DebugConfigManager write-failure channels', () => {
  it('reports example config write failures', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('read-only fs');
    };

    const result = await manager.createExampleConfig();
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(result).toBe(false);
    expect(messages.error[0]).toContain('创建调试配置失败');
    expect(messages.error[0]).toContain('read-only fs');
  });

  it('reports launch.json write failures', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('disk full');
    };

    const result = await manager.updateLaunchJson();
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(result).toBe(false);
    expect(messages.error[0]).toContain('更新 launch.json 失败');
    expect(messages.error[0]).toContain('disk full');
  });
});

describe('DebugConfigManager.attachRemote + readRemoteTargets (批112 远程调试)', () => {
  it('未配置 remoteTargets:提示去设置,false 且无调试会话', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();

    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.info[0]).toContain('kbengine.debug.remoteTargets');
  });

  it('选择目标 + 模态确认后以 debugpy connect 配置附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [
        { name: '外网 baseapp', host: '10.0.0.8', port: 5678 },
        { name: '', host: '10.0.0.9' }, // name 空:不收
        { name: '内网', host: '' }, // host 空:不收
        { name: 123, host: '10.0.0.10' }, // name 非字符串:不收
        { name: '内网', host: null }, // host 非字符串:不收
        null, // 条目非对象:optional chain 短路,不收
        undefined, // 同上
        {}, // 无 name 键:undefined → 空名不收
        { name: '内网', host: '192.168.1.5' } // port 缺省落 5678
      ]
    });
    const manager = makeManager();
    pickQueue.push({ label: '外网 baseapp', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');

    expect(await manager.attachRemote()).toBe(true);

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach 外网 baseapp (remote)');
    expect(attachConfig.type).toBe('debugpy');
    expect(attachConfig.request).toBe('attach');
    expect(attachConfig.connect).toEqual({ host: '10.0.0.8', port: 5678 });
    expect(attachConfig.justMyCode).toBe(false);
    expect(messages.info[0]).toContain('10.0.0.8:5678');
    configurationOverrides.clear();
  });

  it('选择取消 / 模态取消 / startDebugging 失败三态', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8' }]
    });
    const manager = makeManager();

    // quick pick 取消
    pickQueue.push(undefined);
    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);

    // 模态确认取消
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push(undefined);
    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);

    // startDebugging 异常走错误通道
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');
    setDebugThrows(new Error('no route'));
    expect(await manager.attachRemote()).toBe(false);
    expect(messages.error).toEqual(['附加远程调试失败: Error: no route']);

    // startDebugging 返回 false 不刷错误
    setDebugThrows(null);
    setDebugResult(false);
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');
    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual(['附加远程调试失败: Error: no route']);
    configurationOverrides.clear();
  });

  it('选中项 PID 描述非法:不附加(pid 校验拒绝)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }]);
    pickQueue.push({ label: '$(check) baseapp', description: 'not-a-pid' });

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
  });

  it('选择项不在目标列表:不附加(false 且无 startDebugging)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8' }]
    });
    const manager = makeManager();
    pickQueue.push({ label: '不存在', description: '10.0.0.9:5678' });

    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);
    configurationOverrides.clear();
  });

  it('remoteTargets 显式 null:?? 兜底空数组,返回空清单', () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', { 'debug.remoteTargets': null });

    expect(readRemoteTargets()).toEqual([]);
    configurationOverrides.clear();
  });

  it('generateLaunchConfigurations 把远程目标追加为 order 2 的 connect 配置', () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8', port: 6666 }]
    });
    const manager = makeManager();

    const configurations = manager.generateLaunchConfigurations();
    const remote = configurations.filter(
      (item: { name: string }) => item.name === 'KBEngine: Python attach 外网 (remote)'
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].connect).toEqual({ host: '10.0.0.8', port: 6666 });
    expect(remote[0].presentation).toEqual({ group: 'KBEngine', order: 2 });
    expect(remote[0].pathMappings).toBeUndefined();
    // 本地组件配置照旧在前
    expect(configurations[0].processId).toBe('${command:pickProcess}');
    configurationOverrides.clear();
  });
});
